import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { decideApproval } from '../../src/core/approvals.js';
import { main } from '../../src/cli/main.js';
import { fullManifest, tempWorkspace, writeProject } from '../helpers.js';

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 */
async function run(argv, env = {}) {
  /** @type {string[]} */
  const writes = [];
  const exitCode = await main(argv, { env: { AUTODEV_DISABLE_CREDENTIAL_STORE: '1', ...env }, stdout: (text) => { writes.push(text); } });
  return { exitCode, envelope: JSON.parse(writes[0]) };
}

describe('cli: assisted onboarding inside a session', () => {
  const ws = tempWorkspace();
  const W = ['--workspace', ws.root];
  const session = { AUTODEV_SESSION_ID: 'sess-onboarding', AUTODEV_WORKSPACE: ws.root };
  const answersFile = path.join(ws.root, 'answers.json');
  fs.writeFileSync(answersFile, JSON.stringify({ id: 'payments', name: 'Payments', agilityBaseUrlEnv: 'AGILITY_BASE_URL', boardIds: '77', repositories: 'pay-api=PAY_API_REPO_URL' }));
  after(() => ws.cleanup());

  test('the direct command is refused in a session, but its dry run is not', async () => {
    const direct = await run(['onboard-project', '--answers', answersFile, ...W], session);
    assert.equal(direct.envelope.error.code, 'POLICY_PROHIBITED');
    assert.match(direct.envelope.error.message, /onboard propose/);
    assert.equal(direct.exitCode, 4);
    assert.equal(fs.existsSync(path.join(ws.workspace.projectsDir, 'payments')), false);
    const dry = await run(['onboard-project', '--answers', answersFile, '--dry-run', ...W], session);
    assert.equal(dry.envelope.ok, true);
  });

  test('scan, propose, show, approve and apply work in a session with no project selected', async () => {
    const scan = await run(['onboard', 'scan', '--path', answersFile, ...W], session);
    assert.equal(scan.envelope.ok, true, JSON.stringify(scan.envelope));
    assert.deepEqual(scan.envelope.data.repositories, []);

    const proposed = await run(['onboard', 'propose', '--answers', answersFile, '--source', 'old skill', '--source', 'clone of pay-api', ...W], session);
    assert.equal(proposed.envelope.ok, true, JSON.stringify(proposed.envelope));
    const { approvalId } = proposed.envelope.data;
    assert.equal(fs.existsSync(path.join(ws.workspace.projectsDir, 'payments')), false);

    // The project has no manifest yet; its onboarding approval can still be read.
    const shown = await run(['approvals', 'show', approvalId, '--project', 'payments', ...W]);
    assert.equal(shown.envelope.ok, true, JSON.stringify(shown.envelope));
    assert.equal(shown.envelope.data.action, 'project.onboard');
    assert.match(shown.envelope.data.preview['sources the agent read'], /old skill\nclone of pay-api/);

    const early = await run(['onboard', 'apply', '--approval', approvalId, '--project', 'payments', ...W], session);
    assert.equal(early.envelope.error.code, 'APPROVAL_REQUIRED');
    assert.equal(early.exitCode, 3);

    // An agent cannot decide it: the review command refuses inside a session.
    const selfApprove = await run(['approvals', 'review', approvalId, '--project', 'payments', ...W], session);
    assert.equal(selfApprove.envelope.error.code, 'POLICY_PROHIBITED');

    await decideApproval(ws.workspace, { projectId: 'payments', id: approvalId, decision: 'approved', decidedBy: 'tester' });
    const applied = await run(['onboard', 'apply', '--approval', approvalId, '--project', 'payments', ...W], session);
    assert.equal(applied.envelope.ok, true, JSON.stringify(applied.envelope));
    assert.ok(fs.existsSync(path.join(ws.workspace.projectsDir, 'payments', 'project.yaml')));
    const validated = await run(['project', 'validate', '--project', 'payments', ...W]);
    assert.equal(validated.envelope.ok, true);
  });

  test('approvals of a project that does not exist are not readable for other actions', async () => {
    const result = await run(['approvals', 'show', 'apr-000000000000', '--project', 'ghost', ...W]);
    assert.equal(result.envelope.error.code, 'PROJECT_NOT_FOUND');
  });

  test('a session bound to a project cannot onboard another', async () => {
    writeProject(ws.workspace, fullManifest({ id: 'orders' }));
    const result = await run(['onboard', 'propose', '--answers', answersFile, ...W], { ...session, AUTODEV_PROJECT: 'orders' });
    assert.equal(result.envelope.error.code, 'PROJECT_SCOPE_VIOLATION');
  });
});
