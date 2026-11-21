/**
 * Approval gate for anything that writes outside the local worktree: pull
 * requests, Agility tickets, database writes, persisted learnings and the
 * start of defect-driven development.
 *
 * An approval is bound to the SHA-256 of the exact payload. Executing the
 * action re-hashes what is about to be sent and consumes the approval, so an
 * approval cannot be reused or applied to different content.
 *
 * The record of a decision is written only by `decideApproval`, which the CLI
 * exposes solely through an interactive command a human runs in their own
 * terminal (see src/cli/commands/approvals.js and docs/security.md).
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { appendAudit } from './audit.js';
import { AutoDevError, ErrorCodes } from './errors.js';
import { hashOf } from './hash.js';
import { redact } from './redact.js';
import { atomicWriteJson, ensureDir, readJson, safeId, withLock } from './state-store.js';
import { stateDirFor } from './workspace.js';

export const Policy = Object.freeze({
  APPROVAL_REQUIRED: 'approval-required',
  PROHIBITED: 'prohibited',
  ALLOWED: 'allowed',
});

/** Actions that can be gated. */
export const Actions = Object.freeze({
  CREATE_PR: 'bitbucket.createPullRequest',
  CREATE_DEFECT: 'agility.createDefect',
  UPDATE_TICKET: 'agility.updateTicket',
  DB_WRITE: 'db2.write',
  SCHEMA_CHANGE: 'db2.schemaChange',
  LEARNING_WRITE: 'learning.write',
  START_DEVELOPMENT: 'handoff.startDevelopment',
  PRODUCTION_CHANGE: 'production.change',
});

const DEFAULT_TTL_MINUTES = 24 * 60;

/**
 * @typedef {object} Approval
 * @property {string} id
 * @property {string} projectId
 * @property {string} action
 * @property {string} summary
 * @property {string} payloadHash
 * @property {string} challenge short code the approver types to confirm
 * @property {unknown} preview redacted copy of the payload, for display
 * @property {'pending' | 'approved' | 'denied' | 'consumed' | 'expired'} status
 * @property {string} requestedAt
 * @property {string} requestedBy
 * @property {string} expiresAt
 * @property {string} [decidedAt]
 * @property {string} [decidedBy]
 * @property {string} [reason]
 * @property {string} [consumedAt]
 */

/**
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string} projectId
 */
function approvalsDir(workspace, projectId) {
  return stateDirFor(workspace, 'approvals', projectId);
}

/**
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {string} id
 */
function approvalFile(workspace, projectId, id) {
  return path.join(approvalsDir(workspace, projectId), `${safeId(id, 'approval id')}.json`);
}

/**
 * @param {Approval} approval
 * @returns {Approval}
 */
function withExpiry(approval) {
  if ((approval.status === 'pending' || approval.status === 'approved') && Date.parse(approval.expiresAt) <= Date.now()) {
    return { ...approval, status: 'expired' };
  }
  return approval;
}

/**
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {{ status?: Approval['status'] }} [filter]
 * @returns {Approval[]}
 */
export function listApprovals(workspace, projectId, filter = {}) {
  const dir = approvalsDir(workspace, projectId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => withExpiry(readJson(path.join(dir, name))))
    .filter((approval) => !filter.status || approval.status === filter.status)
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

/**
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {string} id
 * @returns {Approval}
 */
export function getApproval(workspace, projectId, id) {
  const approval = readJson(approvalFile(workspace, projectId, id), /** @type {Approval | null} */ (null));
  if (!approval) {
    throw new AutoDevError(ErrorCodes.NOT_FOUND, `No approval request ${id} for project ${projectId}.`);
  }
  return withExpiry(approval);
}

/**
 * Stage an approval request. Asking twice for the same action and payload
 * returns the existing open request rather than creating a duplicate.
 * @param {import('./workspace.js').Workspace} workspace
 * @param {{ projectId: string, action: string, summary: string, payload: unknown, requestedBy?: string, ttlMinutes?: number }} request
 * @returns {Promise<Approval>}
 */
export async function requestApproval(workspace, request) {
  const dir = approvalsDir(workspace, request.projectId);
  ensureDir(dir);
  const payloadHash = hashOf(request.payload);
  return withLock(path.join(dir, '.lock'), async () => {
    const existing = listApprovals(workspace, request.projectId).find(
      (approval) =>
        approval.action === request.action &&
        approval.payloadHash === payloadHash &&
        (approval.status === 'pending' || approval.status === 'approved'),
    );
    if (existing) return existing;

    const now = Date.now();
    /** @type {Approval} */
    const approval = {
      id: `apr-${randomBytes(6).toString('hex')}`,
      projectId: request.projectId,
      action: request.action,
      summary: request.summary,
      payloadHash,
      challenge: payloadHash.slice(0, 6).toUpperCase(),
      preview: redact(request.payload, { pii: true }),
      status: 'pending',
      requestedAt: new Date(now).toISOString(),
      requestedBy: request.requestedBy ?? process.env.AUTODEV_ACTOR ?? 'autodev',
      expiresAt: new Date(now + (request.ttlMinutes ?? DEFAULT_TTL_MINUTES) * 60_000).toISOString(),
    };
    atomicWriteJson(approvalFile(workspace, request.projectId, approval.id), approval);
    await appendAudit(workspace, request.projectId, {
      action: 'approval.requested',
      details: { approvalId: approval.id, gatedAction: approval.action, payloadHash, summary: approval.summary },
    });
    return approval;
  });
}

/**
 * Record a human decision on a pending request.
 * @param {import('./workspace.js').Workspace} workspace
 * @param {{ projectId: string, id: string, decision: 'approved' | 'denied', decidedBy: string, reason?: string }} input
 * @returns {Promise<Approval>}
 */
export async function decideApproval(workspace, input) {
  const dir = approvalsDir(workspace, input.projectId);
  return withLock(path.join(dir, '.lock'), async () => {
    const approval = getApproval(workspace, input.projectId, input.id);
    if (approval.status !== 'pending') {
      throw new AutoDevError(ErrorCodes.CONFLICT, `Approval ${input.id} is ${approval.status}, not pending.`, {
        details: { status: approval.status },
      });
    }
    /** @type {Approval} */
    const decided = {
      ...approval,
      status: input.decision,
      decidedAt: new Date().toISOString(),
      decidedBy: input.decidedBy,
      ...(input.reason ? { reason: input.reason } : {}),
    };
    atomicWriteJson(approvalFile(workspace, input.projectId, input.id), decided);
    await appendAudit(workspace, input.projectId, {
      action: `approval.${input.decision}`,
      actor: input.decidedBy,
      outcome: input.decision === 'approved' ? 'success' : 'denied',
      details: { approvalId: input.id, gatedAction: approval.action, payloadHash: approval.payloadHash },
    });
    return decided;
  });
}

/**
 * Spend an approval for exactly the payload that is about to be sent.
 * @param {import('./workspace.js').Workspace} workspace
 * @param {{ projectId: string, id: string, action: string, payload: unknown }} input
 * @returns {Promise<Approval>}
 */
export async function consumeApproval(workspace, input) {
  const dir = approvalsDir(workspace, input.projectId);
  return withLock(path.join(dir, '.lock'), async () => {
    const approval = getApproval(workspace, input.projectId, input.id);
    const hint = { approvalId: approval.id, status: approval.status };
    if (approval.action !== input.action || approval.payloadHash !== hashOf(input.payload)) {
      await appendAudit(workspace, input.projectId, {
        action: 'approval.mismatch',
        outcome: 'denied',
        details: { approvalId: approval.id, gatedAction: input.action },
      });
      throw new AutoDevError(
        ErrorCodes.APPROVAL_MISMATCH,
        'The content to be sent differs from what was approved. Request a new approval for the current content.',
        { details: hint },
      );
    }
    if (approval.status === 'pending') {
      throw new AutoDevError(ErrorCodes.APPROVAL_REQUIRED, `Approval ${approval.id} has not been decided yet.`, {
        details: { ...hint, howToApprove: approveHint(approval) },
      });
    }
    if (approval.status === 'denied') {
      throw new AutoDevError(ErrorCodes.APPROVAL_DENIED, `Approval ${approval.id} was denied.`, {
        details: { ...hint, reason: approval.reason ?? null },
      });
    }
    if (approval.status !== 'approved') {
      throw new AutoDevError(
        ErrorCodes.APPROVAL_REQUIRED,
        `Approval ${approval.id} is ${approval.status} and cannot be used. Request a new one.`,
        { details: hint },
      );
    }
    /** @type {Approval} */
    const consumed = { ...approval, status: 'consumed', consumedAt: new Date().toISOString() };
    atomicWriteJson(approvalFile(workspace, input.projectId, input.id), consumed);
    await appendAudit(workspace, input.projectId, {
      action: 'approval.consumed',
      outcome: 'success',
      details: { approvalId: approval.id, gatedAction: approval.action, payloadHash: approval.payloadHash },
    });
    return consumed;
  });
}

/**
 * @param {Approval} approval
 */
function approveHint(approval) {
  return `A person must run, in their own terminal (not through the agent): autodev approvals review ${approval.id} --project ${approval.projectId}`;
}

/**
 * Apply a policy to an external write.
 *
 * Returns `{ proceed: false, dryRun: true }` in dry-run mode, `{ proceed: true }`
 * when the action may run now, and otherwise throws POLICY_PROHIBITED,
 * APPROVAL_REQUIRED (after staging a request), APPROVAL_DENIED or
 * APPROVAL_MISMATCH.
 *
 * @param {import('./workspace.js').Workspace} workspace
 * @param {{ projectId: string, action: string, policy: string | undefined, summary: string, payload: unknown, approvalId?: string | null, dryRun?: boolean }} input
 * @returns {Promise<{ proceed: boolean, dryRun: boolean, approvalId: string | null }>}
 */
export async function enforcePolicy(workspace, input) {
  const policy = input.policy ?? Policy.APPROVAL_REQUIRED;

  if (policy === Policy.PROHIBITED) {
    await appendAudit(workspace, input.projectId, {
      action: 'policy.prohibited',
      outcome: 'denied',
      details: { gatedAction: input.action, summary: input.summary },
    });
    throw new AutoDevError(ErrorCodes.POLICY_PROHIBITED, `${input.action} is prohibited by this project's policy.`, {
      details: { action: input.action },
    });
  }
  if (policy !== Policy.ALLOWED && policy !== Policy.APPROVAL_REQUIRED) {
    throw new AutoDevError(ErrorCodes.CONFIG_INVALID, `Unknown policy value "${policy}" for ${input.action}.`);
  }
  if (input.dryRun) {
    await appendAudit(workspace, input.projectId, {
      action: 'policy.dry-run',
      outcome: 'dry-run',
      details: { gatedAction: input.action, summary: input.summary, payloadHash: hashOf(input.payload) },
    });
    return { proceed: false, dryRun: true, approvalId: null };
  }
  if (policy === Policy.ALLOWED) return { proceed: true, dryRun: false, approvalId: null };

  if (!input.approvalId) {
    const approval = await requestApproval(workspace, input);
    if (approval.status !== 'approved') {
      throw new AutoDevError(
        ErrorCodes.APPROVAL_REQUIRED,
        `${input.action} needs a person's approval before it can run.`,
        {
          details: {
            approvalId: approval.id,
            action: input.action,
            summary: input.summary,
            howToApprove: approveHint(approval),
            thenRerunWith: `--approval ${approval.id}`,
          },
        },
      );
    }
    input = { ...input, approvalId: approval.id };
  }
  const consumed = await consumeApproval(workspace, {
    projectId: input.projectId,
    id: /** @type {string} */ (input.approvalId),
    action: input.action,
    payload: input.payload,
  });
  return { proceed: true, dryRun: false, approvalId: consumed.id };
}
