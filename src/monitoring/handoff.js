/**
 * Durable handoff queue from the monitoring worker to the auto-developer.
 *
 * Queuing a defect is not permission to change code. A task becomes "ready"
 * only when the project's policy allows development to start: either
 * autoStartDevelopment is true, or a person approved that specific task.
 * Tasks are claimed atomically, so two sessions cannot work the same defect.
 */

import path from 'node:path';

import { Actions, enforcePolicy, Policy } from '../core/approvals.js';
import { appendAudit } from '../core/audit.js';
import { AutoDevError, ErrorCodes } from '../core/errors.js';
import { hashOf } from '../core/hash.js';
import { atomicWriteJson, ensureDir, readJson, withLock } from '../core/state-store.js';
import { stateDirFor } from '../core/workspace.js';

export const TaskStatus = Object.freeze({
  AWAITING_START_APPROVAL: 'awaiting-start-approval',
  READY: 'ready',
  CLAIMED: 'claimed',
  DONE: 'done',
  BLOCKED: 'blocked',
});

/** A claim not completed within this time is released for another attempt. */
const CLAIM_TIMEOUT_MS = 8 * 60 * 60_000;

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 */
function queueFile(workspace, projectId) {
  return path.join(stateDirFor(workspace, 'handoff', projectId), 'queue.json');
}

/**
 * @template T
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {(tasks: Array<Record<string, any>>) => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
async function mutate(workspace, projectId, fn) {
  const file = queueFile(workspace, projectId);
  ensureDir(path.dirname(file));
  return withLock(`${file}.lock`, async () => {
    const tasks = readJson(file, /** @type {Array<Record<string, any>>} */ ([]));
    const result = await fn(tasks);
    atomicWriteJson(file, tasks);
    return result;
  });
}

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 */
export function listTasks(workspace, projectId) {
  return readJson(queueFile(workspace, projectId), /** @type {Array<Record<string, any>>} */ ([]));
}

/**
 * @param {Record<string, any>} task
 */
function startPayload(task) {
  return { taskId: task.taskId, projectId: task.projectId, defectId: task.defectId, incidentId: task.incidentId };
}

/**
 * Queue a defect for development. Idempotent: the task id is derived from the
 * project and defect, so re-running after a restart changes nothing.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {{ projectId: string, defectId: string, defectUrl?: string | null, incidentId: string, candidateRepos: string[], manifest: Record<string, any> }} input
 */
export async function enqueueHandoff(workspace, input) {
  const taskId = `task-${hashOf({ projectId: input.projectId, defectId: input.defectId }).slice(0, 12)}`;
  const autoStart = input.manifest.monitoring.incidentPolicy.autoStartDevelopment === true;
  const { task, created } = await mutate(workspace, input.projectId, (tasks) => {
    const existing = tasks.find((candidate) => candidate.taskId === taskId);
    if (existing) return { task: existing, created: false };
    const blocked = input.candidateRepos.length === 0;
    /** @type {Record<string, any>} */
    const fresh = {
      taskId,
      projectId: input.projectId,
      defectId: input.defectId,
      defectUrl: input.defectUrl ?? null,
      incidentId: input.incidentId,
      candidateRepos: input.candidateRepos,
      status: blocked ? TaskStatus.BLOCKED : autoStart ? TaskStatus.READY : TaskStatus.AWAITING_START_APPROVAL,
      blockedReason: blocked ? 'No repository is mapped to the affected service. Complete the service mapping in project.yaml.' : null,
      approvalId: null,
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    tasks.push(fresh);
    return { task: fresh, created: true };
  });
  if (created) {
    await appendAudit(workspace, input.projectId, {
      action: 'handoff.queued',
      outcome: 'success',
      details: { taskId, defectId: input.defectId, incidentId: input.incidentId, status: task.status },
    });
  }
  return { task, created };
}

/**
 * Ask for, or use, permission to start development on a queued task.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {{ projectId: string, taskId: string, manifest: Record<string, any>, approvalId?: string | null, dryRun?: boolean }} input
 */
export async function authorizeStart(workspace, input) {
  const task = listTasks(workspace, input.projectId).find((candidate) => candidate.taskId === input.taskId);
  if (!task) throw new AutoDevError(ErrorCodes.NOT_FOUND, `No handoff task ${input.taskId}.`);
  if (task.status === TaskStatus.READY) return task;
  if (task.status !== TaskStatus.AWAITING_START_APPROVAL) {
    throw new AutoDevError(ErrorCodes.CONFLICT, `Task ${task.taskId} is ${task.status}; it cannot be authorized.`, {
      details: { status: task.status, blockedReason: task.blockedReason },
    });
  }
  const gate = await enforcePolicy(workspace, {
    projectId: input.projectId,
    action: Actions.START_DEVELOPMENT,
    policy: input.manifest.monitoring.incidentPolicy.autoStartDevelopment === true ? Policy.ALLOWED : Policy.APPROVAL_REQUIRED,
    summary: `Start development on defect ${task.defectId} (incident ${task.incidentId})`,
    payload: startPayload(task),
    approvalId: input.approvalId ?? task.approvalId,
    dryRun: input.dryRun,
  });
  if (!gate.proceed) return { ...task, dryRun: true };
  return mutate(workspace, input.projectId, (tasks) => {
    const current = tasks.find((candidate) => candidate.taskId === input.taskId);
    if (!current) throw new AutoDevError(ErrorCodes.NOT_FOUND, `No handoff task ${input.taskId}.`);
    current.status = TaskStatus.READY;
    current.approvalId = gate.approvalId;
    current.updatedAt = new Date().toISOString();
    return current;
  });
}

/**
 * Claim the next ready task, oldest first. Returns null when none is ready.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {{ claimedBy?: string }} [options]
 */
export async function claimNext(workspace, projectId, options = {}) {
  const claimed = await mutate(workspace, projectId, (tasks) => {
    const now = Date.now();
    for (const task of tasks) {
      if (task.status === TaskStatus.CLAIMED && now - Date.parse(task.claimedAt) > CLAIM_TIMEOUT_MS) {
        task.status = TaskStatus.READY; // abandoned claim
        task.claimedBy = null;
      }
    }
    const next = tasks.find((task) => task.status === TaskStatus.READY);
    if (!next) return null;
    next.status = TaskStatus.CLAIMED;
    next.claimedAt = new Date().toISOString();
    next.claimedBy = options.claimedBy ?? process.env.AUTODEV_SESSION_ID ?? 'unknown-session';
    next.attempts += 1;
    next.updatedAt = next.claimedAt;
    return next;
  });
  if (claimed) {
    await appendAudit(workspace, projectId, {
      action: 'handoff.claimed',
      outcome: 'success',
      details: { taskId: claimed.taskId, defectId: claimed.defectId, claimedBy: claimed.claimedBy },
    });
  }
  return claimed;
}

/**
 * Finish a claimed task.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {{ projectId: string, taskId: string, outcome: 'done' | 'blocked', pullRequests?: string[], reason?: string }} input
 */
export async function completeTask(workspace, input) {
  const task = await mutate(workspace, input.projectId, (tasks) => {
    const current = tasks.find((candidate) => candidate.taskId === input.taskId);
    if (!current) throw new AutoDevError(ErrorCodes.NOT_FOUND, `No handoff task ${input.taskId}.`);
    if (current.status !== TaskStatus.CLAIMED) {
      throw new AutoDevError(ErrorCodes.CONFLICT, `Task ${current.taskId} is ${current.status}, not claimed.`);
    }
    current.status = input.outcome === 'done' ? TaskStatus.DONE : TaskStatus.BLOCKED;
    current.pullRequests = input.pullRequests ?? [];
    current.blockedReason = input.outcome === 'blocked' ? (input.reason ?? 'No reason given.') : null;
    current.updatedAt = new Date().toISOString();
    return current;
  });
  await appendAudit(workspace, input.projectId, {
    action: `handoff.${input.outcome}`,
    outcome: input.outcome === 'done' ? 'success' : 'failure',
    details: { taskId: task.taskId, defectId: task.defectId, pullRequests: task.pullRequests, reason: task.blockedReason },
  });
  return task;
}
