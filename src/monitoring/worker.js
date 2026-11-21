/**
 * The monitoring worker: one bounded pass over a project's telemetry.
 *
 * It is designed to be started by a scheduler (Windows Task Scheduler), not
 * to stay running, and not to depend on an open Copilot CLI session. Each pass:
 *
 *   1. finishes work left pending by earlier passes (approved tickets,
 *      interrupted writes, unqueued handoffs)
 *   2. reads the next time window(s) after the saved checkpoint
 *   3. normalises, correlates and deduplicates what it found
 *   4. maps incidents to repositories and proposes defects for approval
 *   5. saves the checkpoint
 *
 * A pass that crashes at any point can simply be run again: windows merge
 * idempotently, ticket creation is keyed by an idempotency marker, and the
 * handoff queue is keyed by defect id.
 */

import fs from 'node:fs';
import path from 'node:path';

import { Actions, consumeApproval, getApproval, Policy, requestApproval } from '../core/approvals.js';
import { appendAudit } from '../core/audit.js';
import { AutoDevError, ErrorCodes, toAutoDevError } from '../core/errors.js';
import { nullLogger } from '../core/logger.js';
import { isMissing, loadManifest } from '../core/manifest.js';
import { findService } from '../core/project-context.js';
import { redactString } from '../core/redact.js';
import { resolveInside, withLock } from '../core/state-store.js';
import { stateDirFor } from '../core/workspace.js';
import { buildCandidates, serviceResolver } from './correlate.js';
import { buildDefectDraft, idempotencyMarker } from './defect-draft.js';
import { enqueueHandoff } from './handoff.js';
import { applyEvent, signalFromProblem, signalFromSplunk, Status, thresholdSignals } from './incident-model.js';
import { getIncident, listIncidents, readCheckpoint, saveIncident, upsertIncident, writeCheckpoint } from './incident-store.js';

const MAX_BACKOFF_MS = 60 * 60_000;
const DEFAULT_MAX_CHUNKS = 4;
const RUN_DEADLINE_MS = 10 * 60_000;

/**
 * @typedef {object} Sources
 * @property {{ searchErrors: (window: { from: string, to: string }) => Promise<{ events: Array<Record<string, any>>, link?: string | null }> } | null} splunk
 * @property {{ listProblems: (window: { from: string, to: string }) => Promise<{ problems: Array<Record<string, any>> }>, queryMetrics: (window: { from: string, to: string }) => Promise<{ series: Array<Record<string, any>> }> } | null} dynatrace
 * @property {{ findDefectsByMarker: (marker: string) => Promise<Array<Record<string, any>>>, createDefect: (draft: Record<string, any>) => Promise<Record<string, any>> }} agility
 * @property {(repoPath: string, since: string) => Promise<Array<Record<string, any>>>} [recentCommits]
 * @property {() => Promise<void>} [close]
 */

/**
 * The stricter of the two ticket policies wins.
 * @param {Record<string, any>} manifest
 */
export function ticketPolicy(manifest) {
  const values = [manifest.policies.createDefect, manifest.monitoring.incidentPolicy.createTicket];
  if (values.includes(Policy.PROHIBITED)) return Policy.PROHIBITED;
  if (values.every((value) => value === Policy.ALLOWED)) return Policy.ALLOWED;
  return Policy.APPROVAL_REQUIRED;
}

/**
 * Split the time since the checkpoint into windows no longer than the
 * configured maximum, oldest first, limited per pass so a long outage of the
 * worker is caught up gradually instead of in one large query.
 * @param {string | null} lastWindowEnd
 * @param {Date} now
 * @param {number} maxWindowMinutes
 * @param {number} maxChunks
 */
export function planWindows(lastWindowEnd, now, maxWindowMinutes, maxChunks = DEFAULT_MAX_CHUNKS) {
  const sizeMs = maxWindowMinutes * 60_000;
  const end = now.getTime();
  let cursor = lastWindowEnd ? Date.parse(lastWindowEnd) : end - sizeMs;
  if (!Number.isFinite(cursor) || cursor > end) cursor = end - sizeMs;
  /** @type {Array<{ from: string, to: string, id: string }>} */
  const windows = [];
  while (cursor < end && windows.length < maxChunks) {
    const to = Math.min(cursor + sizeMs, end);
    if (to - cursor < 1000) break;
    const from = new Date(cursor).toISOString();
    windows.push({ from, to: new Date(to).toISOString(), id: `${from}/${new Date(to).toISOString()}` });
    cursor = to;
  }
  return { windows, behind: cursor < end };
}

/**
 * Read both sources for one window and turn the results into signals.
 * @param {Record<string, any>} manifest
 * @param {Sources} sources
 * @param {{ from: string, to: string }} window
 */
export async function collectSignals(manifest, sources, window) {
  const monitoring = manifest.monitoring;
  const resolve = serviceResolver(manifest);
  /** @type {import('./incident-model.js').Signal[]} */
  const signals = [];
  const counts = { splunkEvents: 0, dynatraceProblems: 0, metricSeries: 0, unparsedEvents: 0 };

  if (sources.splunk && monitoring.splunk.indexes.length > 0) {
    const result = await sources.splunk.searchErrors(window);
    counts.splunkEvents = result.events.length;
    for (const event of result.events) {
      const signal = signalFromSplunk(event, monitoring.correlation, { evidenceLink: result.link ?? null });
      if (!signal) {
        counts.unparsedEvents += 1;
        continue;
      }
      signal.service = findService(manifest, signal.service)?.name ?? signal.service;
      signals.push(signal);
    }
  }
  if (sources.dynatrace && monitoring.dynatrace.entitySelectors.length > 0) {
    const problems = await sources.dynatrace.listProblems(window);
    counts.dynatraceProblems = problems.problems.length;
    for (const problem of problems.problems) signals.push(signalFromProblem(problem, resolve));
    const hasThreshold = monitoring.thresholds.errorRatePercent !== null || monitoring.thresholds.p95LatencyMs !== null;
    if (hasThreshold && monitoring.dynatrace.metricSelectors.length > 0) {
      const metrics = await sources.dynatrace.queryMetrics(window);
      counts.metricSeries = metrics.series.length;
      signals.push(...thresholdSignals(metrics.series, monitoring.thresholds, resolve, window.to));
    }
  }
  return { signals, counts };
}

/**
 * Map an incident to repositories and schemas, and gather leads. Returns
 * false when the service has no repository mapping.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {Record<string, any>} manifest
 * @param {string} projectDir
 * @param {Record<string, any>} incident
 * @param {Sources} sources
 */
async function enrich(workspace, manifest, projectDir, incident, sources) {
  const service = findService(manifest, incident.service);
  const repo = service && !isMissing(service.repository)
    ? manifest.repositories.find((/** @type {any} */ candidate) => candidate.name === service.repository)
    : null;
  if (!repo) {
    incident.candidateRepos = [];
    incident.mappingNote = incident.service
      ? `Service "${incident.service}" is not mapped to a repository in project.yaml (services[].repository).`
      : 'The source data did not identify a service.';
    return false;
  }
  incident.mappingNote = null;
  incident.candidateRepos = [repo.name];
  incident.relatedSchemas = [...new Set([...(service?.schemas ?? []), ...(repo.schemas ?? [])])];

  // Recent commits are leads to inspect, never evidence of cause by themselves.
  if (sources.recentCommits) {
    const repoPath = resolveInside(projectDir, repo.localPath);
    if (fs.existsSync(path.join(repoPath, '.git'))) {
      const since = new Date(Date.parse(incident.firstSeen) - 7 * 24 * 60 * 60_000).toISOString();
      try {
        incident.recentCommits = (await sources.recentCommits(repoPath, since)).slice(0, 10);
      } catch {
        incident.recentCommits = [];
      }
    }
  }
  const hypotheses = [];
  if (incident.recentCommits?.length > 0) {
    hypotheses.push({
      statement: `${incident.recentCommits.length} commit(s) landed in ${repo.name} in the 7 days before the first occurrence; one of them may have introduced this.`,
      verified: false,
      evidence: incident.recentCommits.slice(0, 5).map((/** @type {any} */ commit) => `${String(commit.sha).slice(0, 10)} ${commit.subject}`),
    });
  }
  if (incident.deploymentVersions?.length > 0) {
    hypotheses.push({
      statement: `Seen on deployment version(s) ${incident.deploymentVersions.join(', ')}; compare with the previous version.`,
      verified: false,
      evidence: [],
    });
  }
  // Keep anything an investigator recorded; the worker only adds unverified leads.
  const manual = (incident.hypotheses ?? []).filter((/** @type {any} */ h) => h.recordedBy);
  incident.hypotheses = [...manual, ...hypotheses];
  if (incident.classification !== 'verified-root-cause') {
    incident.classification = incident.hypotheses.some((/** @type {any} */ h) => h.evidence?.length > 0)
      ? 'evidence-backed-hypothesis'
      : 'insufficient-evidence';
  }
  return true;
}

/**
 * Record a remote defect on the incident and queue the handoff.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {Record<string, any>} manifest
 * @param {Record<string, any>} incident
 * @param {Record<string, any>} defect
 * @param {'defect-created' | 'existing-defect-linked'} event
 */
async function recordDefect(workspace, manifest, incident, defect, event) {
  incident.defect = {
    ...(incident.defect ?? {}),
    state: 'created',
    id: defect.id,
    url: defect.url ?? null,
    idempotencyKey: idempotencyMarker(incident),
    linkedExisting: event === 'existing-defect-linked',
    draft: undefined,
  };
  applyEvent(incident, event, { defectId: defect.id });
  saveIncident(workspace, incident);
  await appendAudit(workspace, incident.projectId, {
    action: event === 'defect-created' ? 'agility.defect.created' : 'agility.defect.linked',
    outcome: 'success',
    details: { incidentId: incident.incidentId, defectId: defect.id, idempotencyKey: incident.defect.idempotencyKey },
  });
  await queueHandoff(workspace, manifest, incident);
}

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {Record<string, any>} manifest
 * @param {Record<string, any>} incident
 */
async function queueHandoff(workspace, manifest, incident) {
  const { task } = await enqueueHandoff(workspace, {
    projectId: incident.projectId,
    defectId: incident.defect.id,
    defectUrl: incident.defect.url,
    incidentId: incident.incidentId,
    candidateRepos: incident.candidateRepos,
    manifest,
  });
  incident.handoff = { taskId: task.taskId, status: task.status };
  applyEvent(incident, 'handoff-queued', { taskId: task.taskId });
  saveIncident(workspace, incident);
}

/**
 * Propose (or, where policy allows, create) a defect for a detected incident.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {Record<string, any>} manifest
 * @param {Record<string, any>} incident
 * @param {Sources} sources
 * @returns {Promise<string>} what happened
 */
async function propose(workspace, manifest, incident, sources) {
  const policy = ticketPolicy(manifest);
  if (policy === Policy.PROHIBITED) {
    incident.ticketNote = 'Ticket creation is prohibited by policy; incident recorded only.';
    saveIncident(workspace, incident);
    return 'recorded-only';
  }
  const marker = idempotencyMarker(incident);
  try {
    const existing = await sources.agility.findDefectsByMarker(marker);
    if (existing.length > 0) {
      await recordDefect(workspace, manifest, incident, existing[0], 'existing-defect-linked');
      return 'linked-existing-defect';
    }
    incident.existingDefectCheck = 'none found';
  } catch (error) {
    // Could not check now. Creation repeats the check, so a duplicate still cannot be created.
    incident.existingDefectCheck = `not checked (${toAutoDevError(error).code})`;
  }

  const draft = buildDefectDraft(incident, manifest);
  if (policy === Policy.ALLOWED) {
    incident.defect = { state: 'creating', approvalId: null, idempotencyKey: marker, draft };
    saveIncident(workspace, incident);
    const created = await sources.agility.createDefect(draft);
    await recordDefect(workspace, manifest, incident, created, 'defect-created');
    return 'defect-created';
  }
  const approval = await requestApproval(workspace, {
    projectId: incident.projectId,
    action: Actions.CREATE_DEFECT,
    summary: `Create Agility defect for incident ${incident.incidentId}: ${draft.title}`,
    payload: draft,
    requestedBy: 'monitoring-worker',
    ttlMinutes: 7 * 24 * 60,
  });
  incident.defect = { state: 'proposed', approvalId: approval.id, idempotencyKey: marker, draft };
  applyEvent(incident, 'defect-proposed', { approvalId: approval.id });
  saveIncident(workspace, incident);
  return 'defect-proposed';
}

/**
 * Finish whatever earlier passes left pending for one incident.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {Record<string, any>} manifest
 * @param {string} projectDir
 * @param {Record<string, any>} incident
 * @param {Sources} sources
 * @returns {Promise<string | null>}
 */
async function advance(workspace, manifest, projectDir, incident, sources) {
  if (incident.status === Status.NEEDS_ONBOARDING) {
    if (!(await enrich(workspace, manifest, projectDir, incident, sources))) return null;
    applyEvent(incident, 'mapping-resolved');
    saveIncident(workspace, incident);
    return `mapping-resolved; ${await propose(workspace, manifest, incident, sources)}`;
  }

  if (incident.status === Status.DEFECT_CREATED) {
    await queueHandoff(workspace, manifest, incident); // interrupted between ticket and queue
    return 'handoff-queued';
  }

  if (incident.defect?.state === 'creating') {
    // A previous pass was interrupted mid-write. Find out whether it landed.
    const found = await sources.agility.findDefectsByMarker(incident.defect.idempotencyKey);
    if (found.length > 0) {
      await recordDefect(workspace, manifest, incident, found[0], 'defect-created');
      return 'recovered-created-defect';
    }
    if (incident.defect.approvalConsumed || incident.defect.approvalId === null) {
      // The approval for exactly this draft was already spent (or none was
      // needed) and the lookup shows nothing landed: finish the write. If it
      // fails again the state stays "creating" and the next pass retries.
      const created = await sources.agility.createDefect(incident.defect.draft);
      await recordDefect(workspace, manifest, incident, created, 'defect-created');
      return 'retried-interrupted-create';
    }
    incident.defect = null;
    if (incident.status === Status.DEFECT_PROPOSED) {
      applyEvent(incident, 'approval-lapsed', { reason: 'Interrupted before the approval was used; a fresh approval is needed.' });
    }
    saveIncident(workspace, incident);
    return 'interrupted-write-not-found';
  }

  if (incident.status === Status.DETECTED && !incident.defect && incident.candidateRepos?.length > 0) {
    // Mapped but never proposed (an earlier pass stopped early, or an approval
    // lapsed). Propose again only while the incident is still current.
    const windowMs = manifest.monitoring.incidentPolicy.dedupeWindowMinutes * 60_000;
    if (Date.now() - Date.parse(incident.lastSeen) > windowMs || ticketPolicy(manifest) === Policy.PROHIBITED) return null;
    return propose(workspace, manifest, incident, sources);
  }

  if (incident.status !== Status.DEFECT_PROPOSED || !incident.defect) return null;

  const approval = getApproval(workspace, incident.projectId, incident.defect.approvalId);
  if (approval.status === 'pending') return null;
  if (approval.status === 'denied') {
    applyEvent(incident, 'defect-denied', { reason: approval.reason ?? null });
    saveIncident(workspace, incident);
    return 'defect-denied';
  }
  if (approval.status !== 'approved') {
    incident.defect = null;
    applyEvent(incident, 'approval-lapsed', { reason: `Approval ${approval.status}.` });
    saveIncident(workspace, incident);
    return 'approval-lapsed';
  }

  if (isMissing(manifest.agility.defectScope)) {
    // Checked before the approval is spent: without a scope the create cannot succeed.
    throw new AutoDevError(ErrorCodes.NOT_CONFIGURED, 'agility.defectScope is not set, so the approved defect cannot be created yet.');
  }
  // Write-ahead: record the intent before spending the approval or calling out.
  const draft = incident.defect.draft;
  incident.defect.state = 'creating';
  saveIncident(workspace, incident);
  await consumeApproval(workspace, { projectId: incident.projectId, id: approval.id, action: Actions.CREATE_DEFECT, payload: draft });
  incident.defect.approvalConsumed = true;
  saveIncident(workspace, incident);
  const created = await sources.agility.createDefect(draft);
  await recordDefect(workspace, manifest, incident, created, 'defect-created');
  return 'defect-created';
}

/**
 * One monitoring pass for one project.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {{ sources: Sources, now?: Date, dryRun?: boolean, logger?: import('../core/logger.js').Logger, maxChunks?: number, ignoreBackoff?: boolean }} options
 */
export async function runOnce(workspace, projectId, options) {
  const logger = (options.logger ?? nullLogger).child({ projectId, component: 'monitoring-worker' });
  const now = options.now ?? new Date();
  const { manifest, dir: projectDir } = loadManifest(workspace, projectId);
  const monitoring = manifest.monitoring;

  if (!monitoring.enabled) return { projectId, status: 'disabled', reason: 'monitoring.enabled is false in project.yaml.' };
  if (isMissing(monitoring.environment)) {
    throw new AutoDevError(ErrorCodes.NOT_CONFIGURED, 'monitoring.environment is not set; refusing to query without an explicit environment.');
  }
  if (monitoring.splunk.indexes.length === 0 && monitoring.dynatrace.entitySelectors.length === 0) {
    throw new AutoDevError(
      ErrorCodes.NOT_CONFIGURED,
      'Neither Splunk indexes nor Dynatrace entity selectors are configured; there is nothing scoped to query.',
    );
  }

  const lockFile = path.join(stateDirFor(workspace, 'monitor', projectId), 'worker.lock');
  try {
    return await withLock(lockFile, () => pass(), { waitMs: 0, staleMs: 30 * 60_000 });
  } catch (error) {
    if (error instanceof AutoDevError && error.code === ErrorCodes.LOCKED) {
      return { projectId, status: 'already-running', reason: 'Another monitoring pass holds the lock for this project.' };
    }
    throw error;
  }

  async function pass() {
    const checkpoint = readCheckpoint(workspace, projectId);
    if (!options.ignoreBackoff && !options.dryRun && checkpoint.nextAttemptAfter && Date.parse(checkpoint.nextAttemptAfter) > now.getTime()) {
      return { projectId, status: 'backing-off', nextAttemptAfter: checkpoint.nextAttemptAfter, lastError: checkpoint.lastError };
    }
    const deadline = Date.now() + RUN_DEADLINE_MS;
    /** @type {Record<string, any>} */
    const report = {
      projectId,
      environment: monitoring.environment,
      status: 'completed',
      dryRun: options.dryRun === true,
      startedAt: now.toISOString(),
      windows: [],
      pending: [],
      incidents: { created: [], merged: [], recurrences: [], needsOnboarding: [] },
      actions: [],
      behind: false,
    };

    try {
      if (!options.dryRun) {
        for (const incident of listIncidents(workspace, projectId)) {
          try {
            const outcome = await advance(workspace, manifest, projectDir, incident, options.sources);
            if (outcome) report.pending.push({ incidentId: incident.incidentId, outcome });
          } catch (error) {
            // One stuck incident must not stop detection; it is retried next pass.
            const failure = toAutoDevError(error);
            report.pending.push({ incidentId: incident.incidentId, outcome: 'retry-next-pass', code: failure.code, message: failure.message });
          }
        }
      }

      const plan = planWindows(checkpoint.lastWindowEnd, now, monitoring.limits.maxWindowMinutes, options.maxChunks);
      report.behind = plan.behind;
      for (const window of plan.windows) {
        if (Date.now() > deadline) {
          report.behind = true;
          break;
        }
        const { signals, counts } = await collectSignals(manifest, options.sources, window);
        const candidates = buildCandidates(signals, monitoring);
        report.windows.push({ ...window, ...counts, signals: signals.length, candidates: candidates.length });

        if (options.dryRun) {
          for (const candidate of candidates) {
            report.actions.push({
              wouldRecord: { service: candidate.service, fingerprint: candidate.fingerprint, occurrences: candidate.occurrences, sources: candidate.sources, triggers: candidate.triggers, summary: candidate.summary },
            });
          }
          continue;
        }

        for (const candidate of candidates) {
          const { incident, created, merged, recurrence } = upsertIncident(workspace, {
            projectId,
            environment: monitoring.environment,
            candidate,
            windowId: window.id,
            dedupeWindowMinutes: monitoring.incidentPolicy.dedupeWindowMinutes,
          });
          if (created) report.incidents.created.push(incident.incidentId);
          else if (merged) report.incidents.merged.push(incident.incidentId);
          if (recurrence) report.incidents.recurrences.push(incident.incidentId);
          if (incident.status !== Status.DETECTED || incident.defect) continue;

          const mapped = await enrich(workspace, manifest, projectDir, incident, options.sources);
          if (!mapped) {
            applyEvent(incident, 'mapping-missing', { note: incident.mappingNote });
            saveIncident(workspace, incident);
            report.incidents.needsOnboarding.push(incident.incidentId);
            report.actions.push({ incidentId: incident.incidentId, outcome: 'needs-onboarding', note: incident.mappingNote });
            continue;
          }
          saveIncident(workspace, incident);
          try {
            const outcome = await propose(workspace, manifest, incident, options.sources);
            report.actions.push({ incidentId: incident.incidentId, outcome, approvalId: incident.defect?.approvalId ?? null });
          } catch (error) {
            const failure = toAutoDevError(error);
            report.actions.push({ incidentId: incident.incidentId, outcome: 'retry-next-pass', code: failure.code, message: failure.message });
          }
        }

        checkpoint.lastWindowEnd = window.to;
        writeCheckpoint(workspace, projectId, checkpoint);
      }

      if (!options.dryRun) {
        writeCheckpoint(workspace, projectId, {
          ...checkpoint,
          consecutiveFailures: 0,
          nextAttemptAfter: null,
          lastError: null,
          lastRunAt: new Date().toISOString(),
          runs: checkpoint.runs + 1,
        });
        await appendAudit(workspace, projectId, {
          action: 'monitoring.pass',
          actor: 'monitoring-worker',
          outcome: 'success',
          details: { windows: report.windows.length, created: report.incidents.created.length, merged: report.incidents.merged.length, actions: report.actions.length },
        });
      }
      return report;
    } catch (error) {
      const failure = toAutoDevError(error);
      const failureMessage = redactString(failure.message, { pii: true });
      logger.error('monitoring pass failed', { code: failure.code, message: failureMessage });
      if (options.dryRun) throw failure;
      const failures = checkpoint.consecutiveFailures + 1;
      const backoff = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (failures - 1));
      writeCheckpoint(workspace, projectId, {
        ...checkpoint,
        consecutiveFailures: failures,
        nextAttemptAfter: new Date(Date.now() + backoff).toISOString(),
        lastError: `${failure.code}: ${failureMessage}`,
        lastRunAt: new Date().toISOString(),
        runs: checkpoint.runs + 1,
      });
      await appendAudit(workspace, projectId, {
        action: 'monitoring.pass',
        actor: 'monitoring-worker',
        outcome: 'failure',
        details: { code: failure.code, consecutiveFailures: failures },
      });
      return { ...report, status: 'failed', error: { code: failure.code, message: failureMessage }, consecutiveFailures: failures, nextAttemptAfter: new Date(Date.now() + backoff).toISOString() };
    }
  }
}

/**
 * Run passes for several projects with bounded concurrency. Each project is
 * loaded and processed in isolation.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string[]} projectIds
 * @param {(projectId: string) => Promise<Record<string, any>>} runProject
 * @param {number} [concurrency]
 */
export async function runMany(workspace, projectIds, runProject, concurrency = 2) {
  /** @type {Array<Record<string, any>>} */
  const results = new Array(projectIds.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, projectIds.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= projectIds.length) return;
      try {
        results[index] = await runProject(projectIds[index]);
      } catch (error) {
        const failure = toAutoDevError(error);
        results[index] = { projectId: projectIds[index], status: 'failed', error: { code: failure.code, message: failure.message } };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * After an approved deployment, check telemetry for the incident's signature.
 * Resolution is marked verified only when a full dedupe window after the
 * deployment shows no recurrence. Otherwise it stays "validation pending".
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {string} incidentId
 * @param {{ sources: Sources, deployedAt?: string | null, deploymentRef?: string | null, now?: Date }} options
 */
export async function verifyResolution(workspace, projectId, incidentId, options) {
  const { manifest } = loadManifest(workspace, projectId);
  const monitoring = manifest.monitoring;
  const incident = getIncident(workspace, projectId, incidentId);
  const now = options.now ?? new Date();

  if (incident.status === Status.PR_CREATED) {
    if (!options.deployedAt || Number.isNaN(Date.parse(options.deployedAt))) {
      return { incidentId, status: incident.status, verified: false, reason: 'No deployment time was supplied. Validation is pending until an approved deployment is recorded.' };
    }
    const deployed = Date.parse(options.deployedAt);
    const prLinked = incident.history.findLast((/** @type {any} */ entry) => entry.event === 'pr-created')?.at;
    if (deployed > now.getTime() || deployed < Date.parse(incident.firstSeen) || (prLinked && deployed < Date.parse(prLinked))) {
      throw new AutoDevError(
        ErrorCodes.INVALID_ARGUMENT,
        'The deployment time must be after the incident was first seen and after its pull request was linked, and not in the future.',
        { details: { firstSeen: incident.firstSeen, pullRequestLinkedAt: prLinked ?? null } },
      );
    }
    incident.links.deployments.push({ at: new Date(options.deployedAt).toISOString(), ref: options.deploymentRef ?? null });
    applyEvent(incident, 'deployment-recorded', { deployedAt: options.deployedAt });
    saveIncident(workspace, incident);
  }
  if (incident.status !== Status.VALIDATION_PENDING) {
    throw new AutoDevError(ErrorCodes.CONFLICT, `Incident is "${incident.status}"; resolution can be verified only after a PR and a recorded deployment.`);
  }
  const deployedAt = Date.parse(incident.links.deployments.at(-1).at);
  const requiredMs = monitoring.incidentPolicy.dedupeWindowMinutes * 60_000;
  if (now.getTime() - deployedAt < requiredMs) {
    return {
      incidentId,
      status: incident.status,
      verified: false,
      reason: `Only ${Math.floor((now.getTime() - deployedAt) / 60_000)} minute(s) since deployment; ${monitoring.incidentPolicy.dedupeWindowMinutes} are needed before resolution can be judged.`,
    };
  }

  const sizeMs = monitoring.limits.maxWindowMinutes * 60_000;
  /** @type {Array<{ from: string, to: string }>} */
  const windows = [];
  // Check the period ending now. For an old deployment that is the most recent
  // stretch, which is what shows whether the problem is still happening.
  const maxWindows = Math.max(24, Math.ceil(requiredMs / sizeMs));
  const start = Math.max(deployedAt, now.getTime() - maxWindows * sizeMs);
  for (let cursor = start; cursor < now.getTime() && windows.length < maxWindows; cursor += sizeMs) {
    windows.push({ from: new Date(cursor).toISOString(), to: new Date(Math.min(cursor + sizeMs, now.getTime())).toISOString() });
  }
  let recurrences = 0;
  let signalsChecked = 0;
  try {
    for (const window of windows) {
      const { signals } = await collectSignals(manifest, options.sources, window);
      signalsChecked += signals.length;
      recurrences += signals.filter((signal) => signal.service === incident.service && signal.fingerprint === incident.errorFingerprint).length;
    }
  } catch (error) {
    const failure = toAutoDevError(error);
    return { incidentId, status: incident.status, verified: false, reason: `Telemetry could not be read (${failure.code}). Validation remains pending.` };
  }
  const evidence = { checkedFrom: windows[0].from, checkedTo: windows.at(-1)?.to, windows: windows.length, signalsChecked, recurrences };
  applyEvent(incident, recurrences === 0 ? 'resolution-verified' : 'still-occurring', evidence);
  saveIncident(workspace, incident);
  await appendAudit(workspace, projectId, {
    action: 'incident.resolution-check',
    outcome: recurrences === 0 ? 'success' : 'failure',
    details: { incidentId, ...evidence },
  });
  return { incidentId, status: incident.status, verified: recurrences === 0, evidence };
}
