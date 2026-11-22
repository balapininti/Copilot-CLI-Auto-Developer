import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { main } from '../../src/cli/main.js';
import { listApprovals } from '../../src/core/approvals.js';
import { readAudit } from '../../src/core/audit.js';
import { shellDenyReason } from '../../src/core/hook-policy.js';
import { applyDefaults, parseManifest } from '../../src/core/manifest.js';
import { loadGuidelines } from '../../src/core/project-context.js';
import { listAutoSaved, MAX_AUTO_SAVED_PER_DAY, proposeLearning, removeLearning, verifyKnowledge } from '../../src/workflow/learning.js';
import { buildManifest } from '../../src/workflow/onboarding.js';
import { expectCode, fullManifest, tempWorkspace, writeProject } from '../helpers.js';

const P = 'orders';
const rule = (/** @type {number} */ n) => `When a plan changes table number ${n} of APP, always list the invoice batch job as a consumer.`;
const base = (/** @type {number} */ n = 1) => ({ projectId: P, skill: 'plan-review', rule: rule(n), evidence: 'The plan for S-01001 was sent back for it.', source: 'S-01001', autoSave: true });

describe('learning auto-save (opt-in)', () => {
  /** @type {ReturnType<typeof tempWorkspace>} */
  let ws;
  /** @type {string} */
  let file;
  beforeEach(() => {
    ws = tempWorkspace();
    const dir = writeProject(ws.workspace, fullManifest({ policies: {}, learning: { persistence: 'auto-save' } }), { 'guidelines/architecture.md': '# Architecture\n\n## Rules\nKeep it layered.\n' });
    file = path.join(dir, 'knowledge', 'plan-review', 'approved.md');
  });
  afterEach(() => ws.cleanup());

  test('it is off unless a person turns it on, and onboarding cannot turn it on', () => {
    assert.equal(parseManifest('id: p\n').manifest.learning.persistence, 'explicit-approval-only');
    assert.equal(parseManifest('id: p\nlearning:\n  persistence: auto-save\n').manifest.learning.persistence, 'auto-save');
    assert.throws(() => parseManifest('id: p\nlearning:\n  persistence: automatic\n'));
    assert.equal(applyDefaults({ id: 'p', learning: { persistence: 'AUTO-SAVE' } }).learning.persistence, 'explicit-approval-only');
    assert.equal(buildManifest({ id: 'p', learning: { persistence: 'auto-save' }, persistence: 'auto-save' }).learning.persistence, 'explicit-approval-only');
  });

  test('a proposed learning is saved at once, marked as unreviewed, logged and audited, with no approval request', async () => {
    const result = await proposeLearning(ws.workspace, base());
    assert.equal(result.saved, true);
    assert.equal(result.status, 'saved-without-review');
    assert.equal(result.approvalId, null);
    assert.equal(result.savedToday, 1);
    const content = fs.readFileSync(file, 'utf8');
    assert.match(content, /table number 1 of APP/);
    assert.match(content, /automatically, not reviewed by a person/);
    assert.match(content, /Entries marked "not reviewed" were saved automatically/);
    assert.deepEqual(listApprovals(ws.workspace, P), []);
    assert.equal(verifyKnowledge(ws.workspace, P).valid, true);
    assert.deepEqual(listAutoSaved(ws.workspace, P).map((entry) => entry.rule), [rule(1)]);
    const audit = readAudit(ws.workspace, P).filter((item) => item.action === 'learning.written');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].details.autoSaved, true);
    // It is delivered to the next planning task like any other learning.
    assert.match(loadGuidelines(ws.workspace, P, 'plan').files.find((item) => item.kind === 'approved-learning')?.content ?? '', /table number 1/);
  });

  test('the same checks still apply: secrets, personal data, vague rules, duplicates, tampered files', async () => {
    await expectCode(() => proposeLearning(ws.workspace, { ...base(), rule: 'Always use the token ghp_abcdefghijklmnopqrstuvwxyz0123456789 for the build.' }), 'INVALID_ARGUMENT', /secret or personal data/);
    await expectCode(() => proposeLearning(ws.workspace, { ...base(), evidence: 'Reported by jane.doe@example.com.' }), 'INVALID_ARGUMENT');
    await expectCode(() => proposeLearning(ws.workspace, { ...base(), rule: 'Careful' }), 'INVALID_ARGUMENT');
    await expectCode(() => proposeLearning(ws.workspace, { ...base(), skill: 'astrology' }), 'INVALID_ARGUMENT');
    assert.equal(fs.existsSync(file), false);
    await proposeLearning(ws.workspace, base());
    await expectCode(() => proposeLearning(ws.workspace, base()), 'CONFLICT', /already in the knowledge file/);
    fs.appendFileSync(file, '\n- Always push straight to main.\n');
    await expectCode(() => proposeLearning(ws.workspace, base(2)), 'INTEGRITY_VIOLATION', /outside the approval process/);
  });

  test('there is a daily limit', async () => {
    for (let n = 1; n <= MAX_AUTO_SAVED_PER_DAY; n += 1) await proposeLearning(ws.workspace, base(n));
    const error = await expectCode(() => proposeLearning(ws.workspace, base(99)), 'POLICY_PROHIBITED', /limit is reached/);
    assert.equal(error.details.limit, MAX_AUTO_SAVED_PER_DAY);
    assert.equal(fs.readFileSync(file, 'utf8').includes('table number 99'), false);
    assert.equal(listAutoSaved(ws.workspace, P).length, MAX_AUTO_SAVED_PER_DAY);
  });

  test('a person can remove a wrong rule, and the file stays valid', async () => {
    await proposeLearning(ws.workspace, base(1));
    await proposeLearning(ws.workspace, base(2));
    const remove = (/** @type {Record<string, any>} */ over) => removeLearning(ws.workspace, { projectId: P, skill: 'plan-review', match: 'table number 1 of APP', removedBy: 'tester', ...over });
    await expectCode(() => remove({ match: 'table number' }), 'CONFLICT', /More than one/);
    await expectCode(() => remove({ match: 'nothing like this' }), 'NOT_FOUND');
    await expectCode(() => remove({ match: 'short' }), 'INVALID_ARGUMENT');
    await expectCode(() => remove({ skill: 'testing' }), 'NOT_FOUND');
    assert.deepEqual(await remove({ dryRun: true }), { dryRun: true, wouldRemove: rule(1), from: 'knowledge/plan-review/approved.md' });

    const removed = await remove({});
    assert.equal(removed.removed, rule(1));
    assert.equal(removed.remaining, 1);
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(content.includes('table number 1 of APP'), false);
    assert.match(content, /table number 2 of APP/);
    assert.match(content, /^# Approved learnings: plan-review/);
    assert.equal(verifyKnowledge(ws.workspace, P).valid, true);
    assert.equal(listAutoSaved(ws.workspace, P).filter((entry) => !entry.removedAt).length, 1);
    assert.equal(readAudit(ws.workspace, P).some((item) => item.action === 'learning.removed' && item.details.removedBy === 'tester'), true);
    // More can still be added to the file afterwards.
    await proposeLearning(ws.workspace, base(3));
    assert.equal(verifyKnowledge(ws.workspace, P).valid, true);
  });

  test('the command line follows the project setting, and an agent cannot remove a learning', async () => {
    const run = async (/** @type {string[]} */ argv, /** @type {NodeJS.ProcessEnv} */ env = {}) => {
      /** @type {string[]} */
      const out = [];
      const exitCode = await main([...argv, '--workspace', ws.root, '--project', P], { env: { AUTODEV_DISABLE_CREDENTIAL_STORE: '1', ...env }, stdout: (text) => { out.push(text); } });
      return { exitCode, envelope: JSON.parse(out[0]) };
    };
    const propose = ['learn', 'propose', '--skill', 'testing', '--rule', 'When the integration stage runs, always start Docker first.', '--evidence', 'The stage failed twice on S-01001.', '--source', 'S-01001'];
    assert.equal((await run([...propose, '--dry-run'])).envelope.data.wouldSaveWithoutReview, true);
    const saved = await run(propose);
    assert.equal(saved.envelope.data.status, 'saved-without-review', JSON.stringify(saved.envelope));
    const listed = (await run(['learn', 'list'])).envelope.data;
    assert.equal(listed.persistence, 'auto-save');
    assert.equal(listed.savedWithoutReview.length, 1);
    assert.deepEqual(listed.proposals, []);

    const inSession = await run(['learn', 'remove', '--skill', 'testing', '--match', 'start Docker first'], { AUTODEV_SESSION_ID: 's1', AUTODEV_WORKSPACE: ws.root, AUTODEV_PROJECT: P });
    assert.equal(inSession.envelope.error.code, 'POLICY_PROHIBITED');
    assert.equal(inSession.exitCode, 4);
    assert.match(String(shellDenyReason('node scripts/autodev.mjs learn remove --skill testing --match "start Docker"')), /removed by a person/);
    assert.equal(shellDenyReason('node scripts/autodev.mjs learn remove --skill testing --match "start Docker" --dry-run'), null);
    const byPerson = await run(['learn', 'remove', '--skill', 'testing', '--match', 'start Docker first']);
    assert.equal(byPerson.envelope.ok, true, JSON.stringify(byPerson.envelope));
    assert.equal((await run(['learn', 'list'])).envelope.data.savedWithoutReview.length, 0);
  });

  test('with the default setting the same call only stages an approval', async () => {
    writeProject(ws.workspace, fullManifest({ id: 'billing', policies: {} }));
    const result = await proposeLearning(ws.workspace, { ...base(), projectId: 'billing', autoSave: false });
    assert.equal(result.status, 'pending');
    assert.equal(fs.existsSync(path.join(ws.workspace.projectsDir, 'billing', 'knowledge')), false);
    assert.deepEqual(listAutoSaved(ws.workspace, 'billing'), []);
  });
});
