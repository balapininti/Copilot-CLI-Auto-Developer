/**
 * Commands for the monitoring-to-development pipeline: splunk, dynatrace,
 * monitor, incident, handoff, learn, mock and demo.
 */

import * as dynatrace from '../../adapters/dynatrace/client.js';
import * as splunk from '../../adapters/splunk/client.js';
import { appendAudit } from '../../core/audit.js';
import { createTransport } from '../../core/auth.js';
import { AutoDevError, ErrorCodes } from '../../core/errors.js';
import { loadManifest } from '../../core/manifest.js';
import { getActiveProject, listProjectIds } from '../../core/project-context.js';
import { redact, redactString } from '../../core/redact.js';
import { startMockServer, demoScenario } from '../../mocks/server.js';
import { buildDefectDraft } from '../../monitoring/defect-draft.js';
import { authorizeStart, claimNext, completeTask, listTasks } from '../../monitoring/handoff.js';
import { applyEvent, Status } from '../../monitoring/incident-model.js';
import { getIncident, listIncidents, readCheckpoint, saveIncident } from '../../monitoring/incident-store.js';
import { createLiveSources } from '../../monitoring/sources.js';
import { runMany, runOnce, verifyResolution } from '../../monitoring/worker.js';
import { runDemo } from '../../workflow/demo.js';
import { applyLearning, KNOWLEDGE_AREAS, listProposals, proposeLearning, verifyKnowledge } from '../../workflow/learning.js';

/**
 * @param {import('../main.js').CommandContext} ctx
 * @param {number} maxWindowMinutes
 */
function windowOf(ctx, maxWindowMinutes) {
  const to = ctx.flags.to ? new Date(ctx.flags.to) : new Date();
  const minutes = ctx.flags.minutes ? Number(ctx.flags.minutes) : Math.min(15, maxWindowMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, '--minutes must be a positive number.');
  const from = ctx.flags.from ? new Date(ctx.flags.from) : new Date(to.getTime() - minutes * 60_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * @template T
 * @param {import('../main.js').CommandContext} ctx
 * @param {string} service
 * @param {(transport: import('../../core/auth.js').Transport, manifest: Record<string, any>) => Promise<T>} fn
 */
async function withTransport(ctx, service, fn) {
  const { projectId, manifest } = ctx.project();
  const transport = await createTransport(service, manifest, { projectId, env: ctx.env, logger: ctx.logger, interactive: false });
  try {
    return await fn(transport, manifest);
  } finally {
    await transport.close();
  }
}

/**
 * @param {import('../main.js').CommandContext} ctx
 */
function incidentOf(ctx) {
  const { projectId, manifest } = ctx.project();
  const id = ctx.flags.incident ?? ctx.args[0];
  if (!id) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'Give the incident id (--incident INC-...).');
  return { projectId, manifest, incident: getIncident(ctx.workspace, projectId, id) };
}

/** @type {Record<string, import('../main.js').Command>} */
export const monitoringCommands = {
  'splunk search': {
    summary: 'Search the project\'s Splunk indexes for errors in a bounded window (read-only, scoped).',
    usage: 'splunk search [--minutes 15 | --from <iso> --to <iso>] [--service <name>] [--filter "text"]',
    run: (ctx) =>
      withTransport(ctx, 'splunk', async (transport, manifest) => {
        const window = windowOf(ctx, manifest.monitoring.limits.maxWindowMinutes);
        const result = await splunk.searchErrors(transport, manifest.monitoring, {
          ...window, extraFilter: ctx.flags.filter, services: ctx.flags.service ? [ctx.flags.service] : undefined,
        });
        return {
          ...result,
          link: splunk.searchLink(transport.baseUrl, result.search, result.window),
          events: redact(result.events.slice(0, 100), { pii: true }),
          eventsShown: Math.min(result.events.length, 100),
        };
      }),
  },
  'dynatrace problems': {
    summary: 'List Dynatrace problems for the project\'s entities in a bounded window.',
    usage: 'dynatrace problems [--minutes 15 | --from <iso> --to <iso>]',
    run: (ctx) =>
      withTransport(ctx, 'dynatrace', (transport, manifest) =>
        dynatrace.listProblems(transport, manifest.monitoring, windowOf(ctx, manifest.monitoring.limits.maxWindowMinutes)),
      ),
  },
  'dynatrace metrics': {
    summary: 'Query the project\'s configured Dynatrace metric selectors.',
    usage: 'dynatrace metrics [--metric "<selector from project.yaml>"] [--minutes 15]',
    run: (ctx) =>
      withTransport(ctx, 'dynatrace', (transport, manifest) =>
        dynatrace.queryMetrics(transport, manifest.monitoring, {
          ...windowOf(ctx, manifest.monitoring.limits.maxWindowMinutes), metricSelector: ctx.flags.metric,
        }),
      ),
  },

  'monitor run': {
    summary: 'Run one monitoring pass (what the scheduled task calls). Use --all for every enabled project.',
    usage: 'monitor run [--project <id> | --all] [--dry-run] [--ignore-backoff]',
    run: async (ctx) => {
      /** @param {string} projectId */
      const runProject = async (projectId) => {
        const { manifest } = loadManifest(ctx.workspace, projectId);
        const sources = createLiveSources(manifest, { logger: ctx.logger, env: ctx.env, interactive: false });
        try {
          return await runOnce(ctx.workspace, projectId, { sources, dryRun: ctx.dryRun, logger: ctx.logger, ignoreBackoff: ctx.flags['ignore-backoff'] === true });
        } finally {
          await sources.close?.();
        }
      };
      if (ctx.flags.all) {
        if (getActiveProject(ctx.workspace, ctx.env).projectId) {
          throw new AutoDevError(ErrorCodes.PROJECT_SCOPE_VIOLATION, '--all cannot be used inside a session bound to one project.');
        }
        return { passes: await runMany(ctx.workspace, listProjectIds(ctx.workspace), runProject) };
      }
      return runProject(ctx.project().projectId);
    },
  },
  'monitor status': {
    summary: 'Show the worker checkpoint and incident counts for the scoped project.',
    run: (ctx) => {
      const { projectId, manifest } = ctx.project();
      /** @type {Record<string, number>} */
      const byStatus = {};
      for (const incident of listIncidents(ctx.workspace, projectId)) byStatus[incident.status] = (byStatus[incident.status] ?? 0) + 1;
      return {
        projectId,
        enabled: manifest.monitoring.enabled,
        environment: manifest.monitoring.environment,
        schedule: manifest.monitoring.schedule,
        checkpoint: readCheckpoint(ctx.workspace, projectId),
        incidentsByStatus: byStatus,
        handoffTasks: listTasks(ctx.workspace, projectId).map((task) => ({ taskId: task.taskId, defectId: task.defectId, status: task.status })),
      };
    },
  },
  'monitor verify-resolution': {
    summary: 'After an approved deployment, check telemetry and mark the incident resolved only on evidence.',
    usage: 'monitor verify-resolution --incident <INC-...> [--deployed-at <iso>] [--deployment-ref <text>]',
    run: async (ctx) => {
      const { projectId, manifest, incident } = incidentOf(ctx);
      const sources = createLiveSources(manifest, { logger: ctx.logger, env: ctx.env, interactive: false });
      try {
        return await verifyResolution(ctx.workspace, projectId, incident.incidentId, {
          sources, deployedAt: ctx.flags['deployed-at'], deploymentRef: ctx.flags['deployment-ref'],
        });
      } finally {
        await sources.close?.();
      }
    },
  },

  'incident list': {
    summary: 'List incidents for the scoped project.',
    usage: 'incident list [--status <status>]',
    run: (ctx) => ({
      incidents: listIncidents(ctx.workspace, ctx.project().projectId)
        .filter((incident) => !ctx.flags.status || incident.status === ctx.flags.status)
        .map((incident) => ({
          incidentId: incident.incidentId, status: incident.status, severity: incident.severity, service: incident.service,
          summary: incident.summary, occurrences: incident.occurrences, firstSeen: incident.firstSeen, lastSeen: incident.lastSeen,
          classification: incident.classification, confidence: incident.confidence.label, candidateRepos: incident.candidateRepos,
          defectId: incident.defect?.id ?? null, approvalId: incident.defect?.approvalId ?? null,
        })),
    }),
  },
  'incident show': {
    summary: 'Show one incident in full, with evidence, hypotheses and history.',
    usage: 'incident show <INC-...>',
    run: (ctx) => {
      const { incident, manifest } = incidentOf(ctx);
      return { ...incident, proposedDefect: incident.defect?.draft ?? (incident.status === Status.DETECTED ? buildDefectDraft(incident, manifest) : null) };
    },
  },
  'incident classify': {
    summary: 'Record an investigator\'s finding: a hypothesis, or a root cause verified with evidence.',
    usage: 'incident classify --incident <INC-...> --classification verified-root-cause|evidence-backed-hypothesis|insufficient-evidence --statement "..." [--evidence "..."]...',
    run: async (ctx) => {
      const { projectId, incident } = incidentOf(ctx);
      const classification = ctx.need('classification');
      const allowed = ['verified-root-cause', 'evidence-backed-hypothesis', 'insufficient-evidence'];
      if (!allowed.includes(classification)) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `--classification must be one of: ${allowed.join(', ')}.`);
      const evidence = (ctx.flags.evidence ?? []).map((/** @type {string} */ item) => redactString(item, { pii: true }).slice(0, 500));
      if (classification !== 'insufficient-evidence' && evidence.length === 0) {
        throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'A hypothesis or a verified root cause needs at least one --evidence reference. Without evidence, classify it as insufficient-evidence.');
      }
      if (classification === 'verified-root-cause' && evidence.length < 2) {
        throw new AutoDevError(
          ErrorCodes.INVALID_ARGUMENT,
          'A verified root cause needs at least two independent pieces of evidence (for example the failing code path and a reproduction). A shared trace id alone is a lead, not proof.',
        );
      }
      const statement = redactString(ctx.need('statement'), { pii: true }).slice(0, 1000);
      incident.hypotheses = [
        ...incident.hypotheses,
        { statement, verified: classification === 'verified-root-cause', evidence, recordedBy: ctx.env.AUTODEV_ACTOR ?? 'investigator', at: new Date().toISOString() },
      ];
      incident.classification = classification;
      incident.history.push({ at: new Date().toISOString(), event: 'classified', from: incident.status, to: incident.status, classification });
      saveIncident(ctx.workspace, incident);
      await appendAudit(ctx.workspace, projectId, { action: 'incident.classified', outcome: 'success', details: { incidentId: incident.incidentId, classification, evidenceCount: evidence.length } });
      return { incidentId: incident.incidentId, classification, hypotheses: incident.hypotheses };
    },
  },
  'incident link-pr': {
    summary: 'Link pull request(s) to an incident once development has produced them.',
    usage: 'incident link-pr --incident <INC-...> --pr <url> [--pr <url>]',
    run: (ctx) => {
      const { incident } = incidentOf(ctx);
      const prs = ctx.flags.pr ?? [];
      if (prs.length === 0) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'Give at least one --pr <url>.');
      incident.links.pullRequests = [...new Set([...incident.links.pullRequests, ...prs])];
      if (incident.status === Status.DEVELOPMENT_STARTED) applyEvent(incident, 'pr-created', { pullRequests: prs });
      saveIncident(ctx.workspace, incident);
      return { incidentId: incident.incidentId, status: incident.status, pullRequests: incident.links.pullRequests };
    },
  },
  'incident close': {
    summary: 'Close an incident with a reason (for example a false positive).',
    usage: 'incident close --incident <INC-...> --reason "..."',
    run: (ctx) => {
      const { incident } = incidentOf(ctx);
      applyEvent(incident, 'closed', { reason: redactString(ctx.need('reason'), { pii: true }) });
      saveIncident(ctx.workspace, incident);
      return { incidentId: incident.incidentId, status: incident.status };
    },
  },

  'handoff list': {
    summary: 'List defects queued for the auto-developer and whether each may start.',
    run: (ctx) => ({ tasks: listTasks(ctx.workspace, ctx.project().projectId) }),
  },
  'handoff authorize': {
    summary: 'Request or use approval to start development on a queued defect.',
    usage: 'handoff authorize --task-id <task-...> [--approval <id>]',
    run: (ctx) => {
      const { projectId, manifest } = ctx.project();
      return authorizeStart(ctx.workspace, { projectId, taskId: ctx.need('task-id'), manifest, approvalId: ctx.flags.approval, dryRun: ctx.dryRun });
    },
  },
  'handoff next': {
    summary: 'Claim the next defect that is cleared for development. Returns null when none is ready.',
    run: async (ctx) => {
      const { projectId } = ctx.project();
      if (ctx.dryRun) return { dryRun: true, ready: listTasks(ctx.workspace, projectId).filter((task) => task.status === 'ready') };
      const task = await claimNext(ctx.workspace, projectId);
      if (!task) {
        const waiting = listTasks(ctx.workspace, projectId).filter((candidate) => candidate.status === 'awaiting-start-approval');
        return { task: null, note: waiting.length > 0 ? `${waiting.length} task(s) are waiting for a person to approve the start of development.` : 'Nothing is queued.' };
      }
      const incident = getIncident(ctx.workspace, projectId, task.incidentId);
      if (incident.status === Status.HANDOFF_QUEUED) {
        applyEvent(incident, 'development-started', { taskId: task.taskId });
        saveIncident(ctx.workspace, incident);
      }
      return {
        task,
        instructions: `Re-read defect ${task.defectId} from Agility (autodev agility story ${task.defectId}) and the project context before changing anything. Do not rely on the incident summary alone.`,
      };
    },
  },
  'handoff complete': {
    summary: 'Mark a claimed defect as done (with PR links) or blocked (with a reason).',
    usage: 'handoff complete --task-id <task-...> --outcome done|blocked [--pr <url>]... [--reason "..."]',
    run: async (ctx) => {
      const { projectId } = ctx.project();
      const outcome = ctx.need('outcome');
      if (outcome !== 'done' && outcome !== 'blocked') throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, '--outcome must be done or blocked.');
      const task = await completeTask(ctx.workspace, { projectId, taskId: ctx.need('task-id'), outcome, pullRequests: ctx.flags.pr ?? [], reason: ctx.flags.reason });
      if (outcome === 'done' && task.pullRequests.length > 0) {
        const incident = getIncident(ctx.workspace, projectId, task.incidentId);
        incident.links.pullRequests = [...new Set([...incident.links.pullRequests, ...task.pullRequests])];
        if (incident.status === Status.DEVELOPMENT_STARTED) applyEvent(incident, 'pr-created', { pullRequests: task.pullRequests });
        saveIncident(ctx.workspace, incident);
      }
      return task;
    },
  },

  'learn propose': {
    summary: 'Propose a learning. Stages the exact text and an approval request; writes nothing to knowledge.',
    usage: `learn propose --skill <${KNOWLEDGE_AREAS.join('|')}> --rule "When X, always/never Y" --evidence "..." --source "S-01234"`,
    run: (ctx) => {
      const { projectId } = ctx.project();
      if (ctx.dryRun) return { dryRun: true, wouldPropose: { skill: ctx.need('skill'), rule: ctx.need('rule') } };
      return proposeLearning(ctx.workspace, {
        projectId, skill: ctx.need('skill'), rule: ctx.need('rule'), evidence: (ctx.flags.evidence ?? []).join('; '), source: ctx.need('source'),
      });
    },
  },
  'learn apply': {
    summary: 'Write a learning that a person has approved. Writes exactly the approved text.',
    usage: 'learn apply --approval <id>',
    run: (ctx) => applyLearning(ctx.workspace, { projectId: ctx.project().projectId, approvalId: ctx.need('approval'), dryRun: ctx.dryRun }),
  },
  'learn list': {
    summary: 'List staged learning proposals and their approval status.',
    run: (ctx) => ({ proposals: listProposals(ctx.workspace, ctx.project().projectId) }),
  },
  'learn verify': {
    summary: 'Check that every knowledge file is exactly what was approved.',
    run: (ctx) => verifyKnowledge(ctx.workspace, ctx.project().projectId),
  },

  'mock serve': {
    summary: 'Start the local mock of Agility, Bitbucket, Splunk and Dynatrace for trying commands without corporate access.',
    usage: 'mock serve [--port 8765]',
    run: async (ctx) => {
      const server = await startMockServer(demoScenario(), { port: ctx.flags.port ? Number(ctx.flags.port) : 8765 });
      process.stderr.write(
        [
          '',
          `Mock services listening on ${server.baseUrl} (loopback only). Press Ctrl+C to stop.`,
          'Point a project at it by setting the environment variables its project.yaml names, for example:',
          `  $env:AGILITY_BASE_URL   = "${server.baseUrl}"`,
          `  $env:BITBUCKET_BASE_URL = "${server.baseUrl}"`,
          `  $env:SPLUNK_BASE_URL    = "${server.baseUrl}"`,
          `  $env:DYNATRACE_BASE_URL = "${server.baseUrl}"`,
          '  and any non-empty value for the matching *_TOKEN variables.',
          '',
        ].join('\n'),
      );
      await new Promise((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
      await server.close();
      return { stopped: true, requestsServed: server.state.requests.length };
    },
  },

  'demo e2e': {
    summary: 'Run both workflows end to end against local mocks in a temporary workspace. Needs no corporate access.',
    run: async () => {
      const report = await runDemo();
      if (!report.passed) {
        throw new AutoDevError(ErrorCodes.GATE_FAILED, 'The end-to-end dry run did not pass every check.', { details: report });
      }
      return report;
    },
  },
};
