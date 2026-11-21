/**
 * Append-only audit log, one JSONL file per project.
 *
 * Each entry carries the hash of the previous one, so an edited or deleted
 * line is detectable with `verifyAudit`. The log records what was decided and
 * done, never payload contents that could hold secrets.
 */

import fs from 'node:fs';
import path from 'node:path';

import { hashOf } from './hash.js';
import { redact } from './redact.js';
import { AutoDevError, ErrorCodes } from './errors.js';
import { atomicWriteJson, ensureDir, readJson, withLock } from './state-store.js';
import { stateDirFor } from './workspace.js';

const GENESIS = '0'.repeat(64);

/**
 * @typedef {object} AuditEvent
 * @property {string} action e.g. "approval.requested", "bitbucket.pr.created"
 * @property {string} [actor] who or what did it
 * @property {'success' | 'failure' | 'denied' | 'dry-run' | 'info'} [outcome]
 * @property {Record<string, unknown>} [details]
 */

/**
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string} projectId
 */
function auditFile(workspace, projectId) {
  return path.join(stateDirFor(workspace, 'audit', projectId), 'audit.jsonl');
}

/**
 * Read the log. A line that is not valid JSON (an edit, or a write cut short)
 * is reported through `corruptLine` rather than thrown.
 * @param {string} file
 * @returns {{ entries: Array<Record<string, any>>, corruptLine: number | null }}
 */
function readEntries(file) {
  if (!fs.existsSync(file)) return { entries: [], corruptLine: null };
  /** @type {Array<Record<string, any>>} */
  const entries = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
      entries.push(parsed);
    } catch {
      return { entries, corruptLine: index + 1 };
    }
  }
  return { entries, corruptLine: null };
}

/**
 * The newest entry's sequence number and hash are also kept beside the log, so
 * removing entries from the end is detectable.
 * @param {string} file
 */
function headFile(file) {
  return `${file}.head.json`;
}

/**
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {AuditEvent} event
 * @returns {Promise<Record<string, unknown>>} the stored entry
 */
export async function appendAudit(workspace, projectId, event) {
  const file = auditFile(workspace, projectId);
  ensureDir(path.dirname(file));
  return withLock(`${file}.lock`, () => {
    const { entries, corruptLine } = readEntries(file);
    if (corruptLine !== null) {
      throw new AutoDevError(
        ErrorCodes.INTEGRITY_VIOLATION,
        `The audit log for project "${projectId}" has an unreadable entry at line ${corruptLine}. Nothing further is recorded until a person has looked at it.`,
        { details: { file, line: corruptLine, howToFix: 'Inspect the file, keep a copy, and remove or repair the damaged line. See docs/rollback.md.' } },
      );
    }
    const previous = entries.at(-1);
    const body = redact({
      seq: (previous?.seq ?? 0) + 1,
      ts: new Date().toISOString(),
      projectId,
      action: event.action,
      actor: event.actor ?? process.env.AUTODEV_ACTOR ?? 'autodev',
      outcome: event.outcome ?? 'info',
      details: event.details ?? {},
      prevHash: previous?.hash ?? GENESIS,
    });
    const entry = { ...body, hash: hashOf(body) };
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    atomicWriteJson(headFile(file), { seq: entry.seq, hash: entry.hash });
    return entry;
  });
}

/**
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {{ limit?: number, action?: string }} [filter]
 */
export function readAudit(workspace, projectId, filter = {}) {
  let { entries } = readEntries(auditFile(workspace, projectId));
  if (filter.action) entries = entries.filter((entry) => String(entry.action).startsWith(/** @type {string} */ (filter.action)));
  return filter.limit ? entries.slice(-filter.limit) : entries;
}

/**
 * Recompute the hash chain.
 * @param {import('./workspace.js').Workspace} workspace
 * @param {string} projectId
 * @returns {{ valid: boolean, entries: number, brokenAtSeq: number | null }}
 */
export function verifyAudit(workspace, projectId) {
  const file = auditFile(workspace, projectId);
  const { entries, corruptLine } = readEntries(file);
  let prevHash = GENESIS;
  let expectedSeq = 1;
  for (const entry of entries) {
    const { hash, ...body } = entry;
    if (body.prevHash !== prevHash || body.seq !== expectedSeq || hashOf(body) !== hash) {
      return { valid: false, entries: entries.length, brokenAtSeq: typeof entry.seq === 'number' ? entry.seq : expectedSeq };
    }
    prevHash = hash;
    expectedSeq += 1;
  }
  if (corruptLine !== null) return { valid: false, entries: entries.length, brokenAtSeq: expectedSeq };
  const head = readJson(headFile(file), /** @type {{ seq?: number, hash?: string } | null} */ (null));
  if (head && (head.seq !== entries.length || head.hash !== prevHash)) {
    // Entries were removed from the end (or the head record was altered).
    return { valid: false, entries: entries.length, brokenAtSeq: expectedSeq };
  }
  return { valid: true, entries: entries.length, brokenAtSeq: null };
}
