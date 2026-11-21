/**
 * Durable incident records and worker checkpoints, one folder per project.
 *
 *   state/incidents/<project>/<incidentId>.json
 *   state/monitor/<project>/checkpoint.json
 *
 * Merging is idempotent per query window: reprocessing a window after a crash
 * does not double-count occurrences or create a second incident.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AutoDevError, ErrorCodes } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { atomicWriteJson, ensureDir, readJson, safeId } from '../core/state-store.js';
import { stateDirFor } from '../core/workspace.js';
import { confidenceOf, dedupeKeyOf } from './correlate.js';
import { maxSeverity, Status } from './incident-model.js';

const OPEN_FOR_MERGE = new Set([
  Status.DETECTED, Status.NEEDS_ONBOARDING, Status.DEFECT_PROPOSED, Status.DEFECT_DENIED, Status.DEFECT_CREATED,
  Status.HANDOFF_QUEUED, Status.DEVELOPMENT_STARTED, Status.PR_CREATED, Status.VALIDATION_PENDING,
]);

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 */
function dir(workspace, projectId) {
  return stateDirFor(workspace, 'incidents', projectId);
}

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @returns {Array<Record<string, any>>}
 */
export function listIncidents(workspace, projectId) {
  const folder = dir(workspace, projectId);
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(folder, name)))
    .sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
}

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {string} incidentId
 * @returns {Record<string, any>}
 */
export function getIncident(workspace, projectId, incidentId) {
  const incident = readJson(path.join(dir(workspace, projectId), `${safeId(incidentId, 'incident id')}.json`), /** @type {Record<string, any> | null} */ (null));
  if (!incident) throw new AutoDevError(ErrorCodes.NOT_FOUND, `No incident ${incidentId} in project ${projectId}.`);
  if (incident.projectId !== projectId) {
    throw new AutoDevError(ErrorCodes.PROJECT_SCOPE_VIOLATION, 'Incident belongs to a different project.');
  }
  return incident;
}

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {Record<string, any>} incident
 */
export function saveIncident(workspace, incident) {
  ensureDir(dir(workspace, incident.projectId));
  incident.updatedAt = new Date().toISOString();
  atomicWriteJson(path.join(dir(workspace, incident.projectId), `${safeId(incident.incidentId, 'incident id')}.json`), incident);
  return incident;
}

/**
 * Create or update the incident for a candidate.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {{ projectId: string, environment: string | null, candidate: import('./correlate.js').Candidate, windowId: string, dedupeWindowMinutes: number }} input
 * @returns {{ incident: Record<string, any>, created: boolean, merged: boolean, recurrence: boolean }}
 */
export function upsertIncident(workspace, input) {
  const { projectId, environment, candidate, windowId } = input;
  const dedupeKey = dedupeKeyOf(projectId, environment, candidate.service, candidate.fingerprint);
  const windowMs = input.dedupeWindowMinutes * 60_000;
  // A telemetry signal that was correlated into an incident earlier (for
  // example a Dynatrace problem that stays open) is the same incident when it
  // shows up alone in a later window, so it is matched through its alias key.
  const aliasKeys = candidate.absorbedFingerprints.map((fingerprint) => dedupeKeyOf(projectId, environment, candidate.service, fingerprint));
  const existing = listIncidents(workspace, projectId)
    .filter(
      (incident) =>
        OPEN_FOR_MERGE.has(incident.status) &&
        (incident.dedupeKey === dedupeKey || (incident.aliasKeys ?? []).includes(dedupeKey) || aliasKeys.includes(incident.dedupeKey)),
    )
    .at(-1);
  const confidence = confidenceOf(candidate);

  if (existing) {
    if (existing.windowsProcessed.includes(windowId)) {
      return { incident: existing, created: false, merged: false, recurrence: false };
    }
    const withinWindow = Date.parse(candidate.firstSeen) - Date.parse(existing.lastSeen) <= windowMs;
    // Past the window but still tracked (for example a defect is open): it is
    // a recurrence of the same incident, not grounds for a second ticket.
    existing.windowsProcessed = [...existing.windowsProcessed, windowId].slice(-200);
    // Occurrences count log events. A standing problem or a still-breached
    // threshold seen again is the same occurrence, not a new one.
    if (candidate.sources.includes('splunk')) existing.occurrences += candidate.occurrences;
    // Remember every key this incident is known by, so later signals of
    // either kind (the log error or the telemetry problem) find it again.
    existing.aliasKeys = [...new Set([...(existing.aliasKeys ?? []), ...aliasKeys, dedupeKey])].filter((key) => key !== existing.dedupeKey);
    existing.exceptionClass = existing.exceptionClass ?? candidate.exceptionClass;
    existing.samples = [...new Set([...(existing.samples ?? []), ...candidate.samples])].slice(0, 5);
    if (candidate.firstSeen < existing.firstSeen) existing.firstSeen = candidate.firstSeen;
    if (candidate.lastSeen > existing.lastSeen) existing.lastSeen = candidate.lastSeen;
    existing.sources = [...new Set([...existing.sources, ...candidate.sources])];
    existing.traceIds = [...new Set([...existing.traceIds, ...candidate.traceIds])].slice(0, 20);
    existing.traceId = existing.traceId ?? candidate.traceIds[0] ?? null;
    existing.spanId = existing.spanId ?? candidate.spanId;
    existing.requestId = existing.requestId ?? candidate.requestId;
    existing.evidenceLinks = [...new Set([...existing.evidenceLinks, ...candidate.evidenceLinks])].slice(0, 20);
    existing.deploymentVersions = [...new Set([...(existing.deploymentVersions ?? []), ...candidate.deploymentVersions])];
    existing.severity = maxSeverity(existing.severity, candidate.severity);
    existing.triggers = [...new Set([...existing.triggers, ...candidate.triggers])];
    if (candidate.metric) {
      existing.observedMetric = candidate.metric;
      existing.metricBaseline = candidate.metric.baseline;
    }
    if (confidence.score > existing.confidence.score) existing.confidence = confidence;
    if (existing.correlation.method !== 'trace-id' && candidate.correlation.method !== 'none') existing.correlation = candidate.correlation;
    if (!withinWindow) existing.recurrences = (existing.recurrences ?? 0) + 1;
    saveIncident(workspace, existing);
    return { incident: existing, created: false, merged: true, recurrence: !withinWindow };
  }

  const day = candidate.firstSeen.slice(0, 10).replaceAll('-', '');
  const incidentId = `INC-${day}-${sha256(`${dedupeKey}|${candidate.firstSeen}`).slice(0, 8)}`;
  const now = new Date().toISOString();
  /** @type {Record<string, any>} */
  const incident = {
    incidentId,
    projectId,
    environment,
    service: candidate.service,
    severity: candidate.severity,
    firstSeen: candidate.firstSeen,
    lastSeen: candidate.lastSeen,
    sourceTimeZones: candidate.sourceTimeZones,
    errorFingerprint: candidate.fingerprint,
    dedupeKey,
    aliasKeys,
    summary: candidate.summary,
    exceptionClass: candidate.exceptionClass,
    traceId: candidate.traceIds[0] ?? null,
    traceIds: candidate.traceIds,
    spanId: candidate.spanId,
    requestId: candidate.requestId,
    evidenceLinks: candidate.evidenceLinks,
    deploymentVersions: candidate.deploymentVersions,
    metricBaseline: candidate.metric?.baseline ?? null,
    observedMetric: candidate.metric ?? null,
    sources: candidate.sources,
    triggers: candidate.triggers,
    correlation: candidate.correlation,
    occurrences: candidate.occurrences,
    recurrences: 0,
    samples: candidate.samples,
    candidateRepos: [],
    relatedSchemas: [],
    recentCommits: [],
    hypotheses: [],
    classification: 'insufficient-evidence',
    confidence,
    status: Status.DETECTED,
    defect: null,
    handoff: null,
    links: { pullRequests: [], deployments: [] },
    windowsProcessed: [windowId],
    history: [{ at: now, event: 'detected', from: null, to: Status.DETECTED }],
    createdAt: now,
    updatedAt: now,
  };
  saveIncident(workspace, incident);
  return { incident, created: true, merged: false, recurrence: false };
}

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 */
function checkpointFile(workspace, projectId) {
  return path.join(stateDirFor(workspace, 'monitor', projectId), 'checkpoint.json');
}

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @returns {{ lastWindowEnd: string | null, consecutiveFailures: number, nextAttemptAfter: string | null, lastRunAt: string | null, lastError: string | null, runs: number }}
 */
export function readCheckpoint(workspace, projectId) {
  return {
    lastWindowEnd: null,
    consecutiveFailures: 0,
    nextAttemptAfter: null,
    lastRunAt: null,
    lastError: null,
    runs: 0,
    ...readJson(checkpointFile(workspace, projectId), {}),
  };
}

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {ReturnType<typeof readCheckpoint>} checkpoint
 */
export function writeCheckpoint(workspace, projectId, checkpoint) {
  atomicWriteJson(checkpointFile(workspace, projectId), checkpoint);
}
