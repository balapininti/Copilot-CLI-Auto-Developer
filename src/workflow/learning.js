/**
 * Learning management: nothing is remembered without a person approving the
 * exact text.
 *
 *   propose  stages the change and an approval request. No knowledge file is touched.
 *   apply    after approval, writes exactly the approved text, nothing else.
 *   verify   detects knowledge files changed by any other route.
 *
 * A project may opt in to `learning.persistence: auto-save`. Then a proposed
 * learning is written straight away, without a person reviewing it. The
 * same checks and the same single write path apply, each such entry is
 * marked as unreviewed in the file and logged, there is a daily cap, and a
 * person can remove any entry (removeLearning). Only a person can turn the
 * setting on: agents cannot edit project.yaml and onboarding cannot set it.
 *
 * Enforcement sits at the file boundary, not in a prompt:
 *   - `apply` is the only code path that writes a knowledge file, and it
 *     consumes an approval bound to the hash of the target path, the file's
 *     prior content and the added text.
 *   - every approved file's hash is kept in an integrity record, and
 *     loadGuidelines refuses to load a knowledge file whose content does not
 *     match it. A learning written around the gate is therefore never used.
 *   - the Copilot CLI hook denies direct edits to knowledge files.
 */

import fs from 'node:fs';
import path from 'node:path';

import { Actions, consumeApproval, getApproval, requestApproval } from '../core/approvals.js';
import { appendAudit } from '../core/audit.js';
import { AutoDevError, ErrorCodes } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { integrityFile, isApprovedContent, readIntegrity } from '../core/knowledge-integrity.js';
import { containsSecret, redactString } from '../core/redact.js';
import { atomicWriteFile, atomicWriteJson, ensureDir, readJson, safeId, withLock } from '../core/state-store.js';
import { projectDir, stateDirFor } from '../core/workspace.js';

/** Knowledge is filed per skill; these are the areas a learning can belong to. */
export const KNOWLEDGE_AREAS = Object.freeze([
  'project-context', 'agility', 'bitbucket', 'db2', 'java-spring', 'browser-playwright', 'testing', 'code-review',
  'splunk', 'dynatrace', 'authentication', 'incident-correlation', 'root-cause-analysis', 'workflow-handoff', 'plan-review', 'e2e-scenarios',
]);

const MAX_RULE_LENGTH = 800;
/** Auto-saved learnings per project per day. A run-away agent cannot fill the knowledge folder. */
export const MAX_AUTO_SAVED_PER_DAY = 5;

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 */
function autoSavedFile(workspace, projectId) {
  return path.join(stateDirFor(workspace, 'learning', projectId), 'auto-saved.json');
}

/**
 * Learnings saved without review, newest last.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @returns {Array<{ at: string, skill: string, rule: string, source: string, removedAt?: string }>}
 */
export function listAutoSaved(workspace, projectId) {
  return readJson(autoSavedFile(workspace, projectId), /** @type {any[]} */ ([]));
}

/**
 * Write a knowledge file and its integrity record. The only place either is written.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {string} target relative path
 * @param {string} content the whole file
 */
function writeKnowledge(workspace, projectId, target, content) {
  atomicWriteFile(path.join(projectDir(workspace, projectId), target), content);
  const integrity = readIntegrity(workspace, projectId);
  integrity[target] = sha256(content);
  atomicWriteJson(integrityFile(workspace, projectId), integrity);
  return integrity[target];
}

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {string} approvalId
 */
function proposalFile(workspace, projectId, approvalId) {
  return path.join(stateDirFor(workspace, 'learning', projectId), 'proposals', `${safeId(approvalId, 'approval id')}.json`);
}

/**
 * @param {string} skill
 */
function relativeTarget(skill) {
  return `knowledge/${skill}/approved.md`;
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * A learning is appended to a file, and the reviewer sees only the addition.
 * So the file it is appended to must itself be exactly what was approved
 * earlier; otherwise unapproved text would become trusted along with it.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {string} target relative path
 * @param {string | null} current
 */
function assertApprovedBase(workspace, projectId, target, current) {
  if (current === null || isApprovedContent(workspace, projectId, target, current)) return;
  throw new AutoDevError(
    ErrorCodes.INTEGRITY_VIOLATION,
    `${target} was created or changed outside the approval process, so nothing can be added to it. A person must restore the approved content or remove the file first.`,
    { details: { targetPath: target, howToCheck: 'autodev learn verify' } },
  );
}

/**
 * Stage a proposed learning and request approval for its exact text.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {{ projectId: string, skill: string, rule: string, evidence: string, source: string, autoSave?: boolean }} input
 *   `autoSave`: the project has opted in to saving learnings without review.
 * @returns {Promise<Record<string, any>>}
 */
export async function proposeLearning(workspace, input) {
  if (!KNOWLEDGE_AREAS.includes(input.skill)) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Unknown knowledge area "${input.skill}". Use one of: ${KNOWLEDGE_AREAS.join(', ')}.`);
  }
  const rule = String(input.rule ?? '').replace(/\s+/g, ' ').trim();
  const evidence = String(input.evidence ?? '').replace(/\s+/g, ' ').trim();
  const source = String(input.source ?? '').replace(/\s+/g, ' ').trim();
  if (rule.length < 10 || rule.length > MAX_RULE_LENGTH) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `A learning is one specific rule of 10 to ${MAX_RULE_LENGTH} characters.`);
  }
  if (!evidence || !source) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'A learning needs both --evidence (what showed it to be true) and --source (story, incident or review it came from).');
  }
  for (const [label, text] of [['rule', rule], ['evidence', evidence], ['source', source]]) {
    if (containsSecret(text) || redactString(text, { pii: true }) !== text) {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `The ${label} appears to contain a secret or personal data. Rephrase it without them.`);
    }
  }

  const target = relativeTarget(input.skill);
  const absolute = path.join(projectDir(workspace, input.projectId), target);
  const current = readOrNull(absolute);
  assertApprovedBase(workspace, input.projectId, target, current);
  const header = current === null ? `# Approved learnings: ${input.skill}\n\nEvery entry below was approved by a person. Do not edit this file directly; use \`autodev learn propose\`.\n` : '';
  const today = new Date().toISOString().slice(0, 10);
  if (input.autoSave) {
    return withLock(`${integrityFile(workspace, input.projectId)}.lock`, async () => {
      const fresh = readOrNull(absolute);
      assertApprovedBase(workspace, input.projectId, target, fresh);
      const log = listAutoSaved(workspace, input.projectId);
      const savedToday = log.filter((entry) => entry.at.startsWith(today)).length;
      if (savedToday >= MAX_AUTO_SAVED_PER_DAY) {
        throw new AutoDevError(
          ErrorCodes.POLICY_PROHIBITED,
          `This project saves learnings without review, limited to ${MAX_AUTO_SAVED_PER_DAY} a day, and that limit is reached. Tell the user; do not look for another way to save it.`,
          { details: { savedToday, limit: MAX_AUTO_SAVED_PER_DAY } },
        );
      }
      if (fresh !== null && fresh.includes(`- ${rule}\n`)) {
        throw new AutoDevError(ErrorCodes.CONFLICT, 'That rule is already in the knowledge file.');
      }
      const head = fresh === null ? `# Approved learnings: ${input.skill}\n\nDo not edit this file directly; use \`autodev learn propose\`. Entries marked "not reviewed" were saved automatically because this project sets learning.persistence to auto-save.\n` : '';
      const entry = `${head}\n- ${rule}\n  - Evidence: ${evidence}\n  - Source: ${source}\n  - Saved: ${today}, automatically, not reviewed by a person\n`;
      const fileHash = writeKnowledge(workspace, input.projectId, target, `${fresh ?? ''}${entry}`);
      ensureDir(path.dirname(autoSavedFile(workspace, input.projectId)));
      atomicWriteJson(autoSavedFile(workspace, input.projectId), [...log, { at: new Date().toISOString(), skill: input.skill, rule, source }].slice(-500));
      await appendAudit(workspace, input.projectId, {
        action: 'learning.written',
        outcome: 'success',
        details: { autoSaved: true, approvalId: null, targetPath: target, additionHash: sha256(entry), fileHash },
      });
      return {
        saved: true,
        autoSaved: true,
        approvalId: null,
        status: 'saved-without-review',
        targetPath: `projects/${input.projectId}/${target}`,
        createsFile: fresh === null,
        diff: entry.split('\n').map((line) => `+ ${line}`).join('\n'),
        evidence,
        source,
        savedToday: savedToday + 1,
        dailyLimit: MAX_AUTO_SAVED_PER_DAY,
        next: 'Saved. Tell the user what was saved and that they can remove it: autodev learn remove --skill <area> --match "<part of the rule>"',
      };
    });
  }
  const addition = `${header}\n- ${rule}\n  - Evidence: ${evidence}\n  - Source: ${source}\n  - Proposed: ${today}\n`;
  const payload = { targetPath: target, baseHash: current === null ? null : sha256(current), addition };

  const approval = await requestApproval(workspace, {
    projectId: input.projectId,
    action: Actions.LEARNING_WRITE,
    summary: `Save a learning to ${target}`,
    payload,
  });
  const file = proposalFile(workspace, input.projectId, approval.id);
  ensureDir(path.dirname(file));
  atomicWriteJson(file, { approvalId: approval.id, projectId: input.projectId, skill: input.skill, payload, stagedAt: new Date().toISOString() });

  return {
    approvalId: approval.id,
    status: approval.status,
    targetPath: `projects/${input.projectId}/${target}`,
    createsFile: current === null,
    diff: addition.split('\n').map((line) => `+ ${line}`).join('\n'),
    evidence,
    source,
    next: `A person reviews it in their own terminal: autodev approvals review ${approval.id} --project ${input.projectId}. Then: autodev learn apply --approval ${approval.id}`,
  };
}

/**
 * Write an approved learning. Only the approved text is appended.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {{ projectId: string, approvalId: string, dryRun?: boolean }} input
 */
export async function applyLearning(workspace, input) {
  const proposal = readJson(proposalFile(workspace, input.projectId, input.approvalId), /** @type {Record<string, any> | null} */ (null));
  if (!proposal) throw new AutoDevError(ErrorCodes.NOT_FOUND, `No staged learning for approval ${input.approvalId}.`);
  const { payload } = proposal;
  const root = projectDir(workspace, input.projectId);
  const absolute = path.join(root, payload.targetPath);
  if (!KNOWLEDGE_AREAS.some((skill) => relativeTarget(skill) === payload.targetPath)) {
    throw new AutoDevError(ErrorCodes.INTEGRITY_VIOLATION, 'The staged learning targets a path outside the knowledge folders.');
  }

  return withLock(`${integrityFile(workspace, input.projectId)}.lock`, async () => {
    const current = readOrNull(absolute);
    assertApprovedBase(workspace, input.projectId, payload.targetPath, current);
    const currentHash = current === null ? null : sha256(current);
    if (currentHash !== payload.baseHash) {
      throw new AutoDevError(
        ErrorCodes.CONFLICT,
        'The knowledge file changed after this learning was proposed. Propose it again so the approval matches the current file.',
        { details: { targetPath: payload.targetPath } },
      );
    }
    if (input.dryRun) {
      const approval = getApproval(workspace, input.projectId, input.approvalId);
      return { dryRun: true, approvalStatus: approval.status, wouldAppendTo: payload.targetPath, text: payload.addition };
    }
    await consumeApproval(workspace, { projectId: input.projectId, id: input.approvalId, action: Actions.LEARNING_WRITE, payload });

    const next = `${current ?? ''}${payload.addition}`;
    const integrity = { [payload.targetPath]: writeKnowledge(workspace, input.projectId, payload.targetPath, next) };
    fs.rmSync(proposalFile(workspace, input.projectId, input.approvalId), { force: true });

    await appendAudit(workspace, input.projectId, {
      action: 'learning.written',
      outcome: 'success',
      details: { approvalId: input.approvalId, targetPath: payload.targetPath, additionHash: sha256(payload.addition), fileHash: integrity[payload.targetPath] },
    });
    return { written: true, targetPath: `projects/${input.projectId}/${payload.targetPath}`, approvalId: input.approvalId };
  });
}

/**
 * Remove one learning. For a person: this is how a wrong rule is taken out,
 * whether it was approved or saved automatically.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {{ projectId: string, skill: string, match: string, removedBy: string, dryRun?: boolean }} input
 */
export async function removeLearning(workspace, input) {
  if (!KNOWLEDGE_AREAS.includes(input.skill)) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Unknown knowledge area "${input.skill}". Use one of: ${KNOWLEDGE_AREAS.join(', ')}.`);
  }
  const match = String(input.match ?? '').trim();
  if (match.length < 8) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, '--match is a distinctive part of the rule to remove, at least 8 characters.');
  const target = relativeTarget(input.skill);
  const absolute = path.join(projectDir(workspace, input.projectId), target);
  return withLock(`${integrityFile(workspace, input.projectId)}.lock`, async () => {
    const current = readOrNull(absolute);
    if (current === null) throw new AutoDevError(ErrorCodes.NOT_FOUND, `There are no learnings under ${input.skill}.`);
    assertApprovedBase(workspace, input.projectId, target, current);
    // An entry is a "- rule" line and the indented lines under it.
    const blocks = current.split(/\n(?=- )/);
    const hits = blocks.map((block, index) => ({ block, index })).filter(({ block, index }) => index > 0 && block.split('\n')[0].includes(match));
    if (hits.length === 0) throw new AutoDevError(ErrorCodes.NOT_FOUND, 'No learning matches that text.', { details: { rules: blocks.slice(1).map((block) => block.split('\n')[0].slice(2)) } });
    if (hits.length > 1) {
      throw new AutoDevError(ErrorCodes.CONFLICT, 'More than one learning matches. Give a longer, more specific --match.', { details: { matches: hits.map(({ block }) => block.split('\n')[0].slice(2)) } });
    }
    const removed = hits[0].block.split('\n')[0].slice(2);
    if (input.dryRun) return { dryRun: true, wouldRemove: removed, from: target };
    const next = `${blocks.filter((_, index) => index !== hits[0].index).join('\n').replace(/\n+$/, '')}\n`;
    const fileHash = writeKnowledge(workspace, input.projectId, target, next);
    const log = listAutoSaved(workspace, input.projectId);
    const entry = log.find((item) => item.rule === removed && !item.removedAt);
    if (entry) {
      entry.removedAt = new Date().toISOString();
      atomicWriteJson(autoSavedFile(workspace, input.projectId), log);
    }
    await appendAudit(workspace, input.projectId, { action: 'learning.removed', outcome: 'success', details: { targetPath: target, removedBy: input.removedBy, ruleHash: sha256(removed), fileHash } });
    return { removed, from: `projects/${input.projectId}/${target}`, remaining: blocks.length - 2 };
  });
}

/**
 * Compare every knowledge file with the integrity record.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 */
export function verifyKnowledge(workspace, projectId) {
  const root = projectDir(workspace, projectId);
  const integrity = readIntegrity(workspace, projectId);
  /** @type {Array<{ path: string, state: 'approved' | 'modified-outside-approval' | 'never-approved' | 'missing' }>} */
  const files = [];
  const knowledgeDir = path.join(root, 'knowledge');
  const seen = new Set();
  if (fs.existsSync(knowledgeDir)) {
    for (const entry of fs.readdirSync(knowledgeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relative = `knowledge/${entry.name}/approved.md`;
      const content = readOrNull(path.join(root, relative));
      if (content === null) continue;
      seen.add(relative);
      files.push({ path: relative, state: !integrity[relative] ? 'never-approved' : integrity[relative] === sha256(content) ? 'approved' : 'modified-outside-approval' });
    }
  }
  for (const relative of Object.keys(integrity)) {
    if (!seen.has(relative)) files.push({ path: relative, state: 'missing' });
  }
  return { valid: files.every((file) => file.state === 'approved'), files };
}

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 */
export function listProposals(workspace, projectId) {
  const dir = path.join(stateDirFor(workspace, 'learning', projectId), 'proposals');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const proposal = readJson(path.join(dir, name));
      let status = 'unknown';
      try {
        status = getApproval(workspace, projectId, proposal.approvalId).status;
      } catch {
        // approval record gone
      }
      return { approvalId: proposal.approvalId, skill: proposal.skill, targetPath: proposal.payload.targetPath, status, stagedAt: proposal.stagedAt, text: proposal.payload.addition };
    });
}
