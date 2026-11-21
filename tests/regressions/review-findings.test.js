// Regression tests for defects found by the independent review. Each test
// states the failure it guards against.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import * as gitAdapter from '../../src/adapters/bitbucket/git.js';
import { parseDiff, reviewDiff } from '../../src/adapters/review/checks.js';
import { getApproval } from '../../src/core/approvals.js';
import { AutoDevError, ErrorCodes } from '../../src/core/errors.js';
import { withLock } from '../../src/core/state-store.js';
import { idempotencyMarker } from '../../src/monitoring/defect-draft.js';
import { applyEvent } from '../../src/monitoring/incident-model.js';
import { getIncident, listIncidents, saveIncident } from '../../src/monitoring/incident-store.js';
import { runOnce, verifyResolution } from '../../src/monitoring/worker.js';
import { expectCode, git, makeRemote, removeDir, setEnv, setGitEnv, tempDir } from '../helpers.js';
import { decide, fakeSources, minutes, monitoredProject, npeEvent, problem, TRACE } from '../monitoring/fixtures.js';

/** @type {string[]} */
const roots = [];
after(() => roots.forEach(removeDir));

function project() {
  const p = monitoredProject();
  roots.push(p.root);
  return p;
}

/** @param {Date} now */
function npeScenario(now) {
  return fakeSources({
    events: [npeEvent(minutes(now, -9), { trace_id: TRACE }), npeEvent(minutes(now, -7), { trace_id: TRACE })],
    problems: [problem(minutes(now, -10))],
  });
}

describe('monitoring worker: an approved ticket survives a transient failure', () => {
  test('a create call that fails once is retried under the same approval, and exactly one ticket results', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const { sources, state } = npeScenario(now);
    await runOnce(workspace, projectId, { sources, now });
    const proposed = listIncidents(workspace, projectId)[0];
    await decide(workspace, projectId, proposed.defect.approvalId);

    state.fail.createDefect = new AutoDevError(ErrorCodes.NETWORK, 'connection reset');
    const failed = await runOnce(workspace, projectId, { sources, now: minutes(now, 1) });
    assert.equal(failed.pending[0].outcome, 'retry-next-pass');
    assert.equal(state.defects.length, 0);
    assert.equal(getApproval(workspace, projectId, proposed.defect.approvalId).status, 'consumed');
    assert.equal(getIncident(workspace, projectId, proposed.incidentId).defect.state, 'creating');

    delete state.fail.createDefect;
    const retried = await runOnce(workspace, projectId, { sources, now: minutes(now, 2) });
    assert.equal(retried.pending[0].outcome, 'retried-interrupted-create');
    assert.equal(state.defects.length, 1, 'the approved ticket must not be lost');
    assert.equal(getIncident(workspace, projectId, proposed.incidentId).status, 'handoff-queued');

    await runOnce(workspace, projectId, { sources, now: minutes(now, 3) });
    assert.equal(state.defects.length, 1, 'and it must not be created twice');
  });
});

describe('monitoring worker: a regression after closure gets its own ticket', () => {
  test('the idempotency marker is scoped to the incident, so a closed incident does not absorb a later recurrence', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const first = npeScenario(now);
    await runOnce(workspace, projectId, { sources: first.sources, now });
    const incident = listIncidents(workspace, projectId)[0];
    await decide(workspace, projectId, incident.defect.approvalId);
    await runOnce(workspace, projectId, { sources: first.sources, now: minutes(now, 1) });
    assert.equal(first.state.defects.length, 1);

    const closed = getIncident(workspace, projectId, incident.incidentId);
    applyEvent(closed, 'closed', { reason: 'fixed' });
    saveIncident(workspace, closed);

    // The same error a few hours later, with the old defect still findable in Agility.
    const later = minutes(now, 3 * 60);
    first.state.events = [npeEvent(minutes(later, -5), { trace_id: TRACE })];
    first.state.problems = [];
    await runOnce(workspace, projectId, { sources: first.sources, now: later, ignoreBackoff: true });
    const incidents = listIncidents(workspace, projectId);
    const regression = incidents.find((candidate) => candidate.incidentId !== incident.incidentId);
    assert.ok(regression, 'a new incident is opened');
    assert.notEqual(idempotencyMarker(regression), idempotencyMarker(closed));
    assert.equal(regression.status, 'defect-proposed', 'and it proposes a new ticket instead of linking the old one');
    assert.equal(regression.defect.linkedExisting, undefined);
  });
});

describe('verify-resolution: the deployment time is validated', () => {
  test('a deployment time before the incident, or in the future, is refused', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const { sources } = npeScenario(now);
    await runOnce(workspace, projectId, { sources, now });
    const incident = listIncidents(workspace, projectId)[0];
    incident.status = 'pr-created';
    incident.history.push({ at: now.toISOString(), event: 'pr-created', from: 'development-started', to: 'pr-created' });
    saveIncident(workspace, incident);
    for (const deployedAt of ['2020-01-01T00:00:00Z', minutes(now, 600).toISOString()]) {
      await expectCode(() => verifyResolution(workspace, projectId, incident.incidentId, { sources, deployedAt, now: minutes(now, 5) }), 'INVALID_ARGUMENT');
    }
    assert.equal(getIncident(workspace, projectId, incident.incidentId).status, 'pr-created');
  });
});

describe('automated review: a diff that could not be read in full never passes', () => {
  const patch = [
    'diff --git a/src/A.java b/src/A.java',
    '--- a/src/A.java',
    '+++ b/src/A.java',
    '@@ -1,0 +1,1 @@',
    '+int a = 1;',
    '',
  ].join('\n');

  test('an incomplete patch is a blocker', () => {
    const result = reviewDiff(parseDiff(patch), { incomplete: true });
    assert.equal(result.passed, false);
    assert.ok(result.findings.some((finding) => finding.rule === 'diff-not-fully-reviewed' && finding.severity === 'blocker'));
  });

  test('files listed as changed but absent from the patch are blockers, and path rules still apply to them', () => {
    const result = reviewDiff(parseDiff(patch), { allPaths: ['src/A.java', 'db/migration/V2__drop.sql', 'config/server.pem'] });
    assert.equal(result.passed, false);
    const rules = result.findings.map((finding) => finding.rule);
    assert.ok(rules.includes('diff-not-fully-reviewed'));
    assert.ok(rules.includes('schema-change'), 'the unread migration is still reported');
    assert.ok(rules.includes('credential-file'), 'the unread key file is still reported');
  });

  test('a fully read patch is unaffected', () => {
    assert.ok(!reviewDiff(parseDiff(patch), { allPaths: ['src/A.java'], incomplete: false }).findings.some((finding) => finding.rule === 'diff-not-fully-reviewed'));
  });
});

describe('git: the push destination must be the approved URL', () => {
  const root = tempDir('autodev-pushurl-');
  roots.push(root);
  /** @type {() => void} */
  let restoreGit = () => {};
  /** @type {() => void} */
  let restoreEnv = () => {};
  after(() => {
    restoreGit();
    restoreEnv();
  });

  test('a clone whose pushurl points elsewhere is refused for reuse and for push', async () => {
    restoreGit = setGitEnv(root);
    restoreEnv = setEnv({ AUTODEV_ALLOW_FILE_REMOTES: '1' });
    const remote = await makeRemote(root);
    const repoPath = path.join(root, 'clone');
    await gitAdapter.ensureClone({ repoPath, url: remote.url, name: 'service-api' });
    assert.equal(await gitAdapter.pushUrlMatches(repoPath, remote.url), true);

    const elsewhere = path.join(root, 'elsewhere.git');
    await git(['init', '--quiet', '--bare', elsewhere]);
    await git(['config', 'remote.origin.pushurl', elsewhere], repoPath);
    assert.equal(await gitAdapter.pushUrlMatches(repoPath, remote.url), false);
    await expectCode(() => gitAdapter.ensureClone({ repoPath, url: remote.url, name: 'service-api' }), 'REPO_URL_NOT_APPROVED');

    await git(['switch', '--quiet', '-c', 'feature/S-1-x'], repoPath);
    await expectCode(
      () => gitAdapter.pushBranch({ repoPath, name: 'service-api', branch: 'feature/S-1-x', protectedBranches: ['main'], approvedUrl: remote.url }),
      'REPO_URL_NOT_APPROVED',
    );
    assert.equal(fs.readdirSync(path.join(elsewhere, 'refs', 'heads')).length, 0, 'nothing reached the other remote');
  });
});

describe('locks: a lock left by a dead process is reclaimed', () => {
  test('a fresh lock whose owner process no longer exists does not block', async () => {
    const dir = tempDir('autodev-lock-');
    roots.push(dir);
    const lockFile = path.join(dir, 'worker.lock');
    // A process id that is certainly not running.
    fs.writeFileSync(lockFile, JSON.stringify({ owner: '2147483646:dead', acquiredAt: new Date().toISOString() }));
    assert.equal(await withLock(lockFile, () => 'ran', { waitMs: 0, staleMs: 60 * 60_000 }), 'ran');
  });

  test('a lock held by a live process still blocks', async () => {
    const dir = tempDir('autodev-lock-');
    roots.push(dir);
    const lockFile = path.join(dir, 'worker.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ owner: `${process.ppid}:alive`, acquiredAt: new Date().toISOString() }));
    await expectCode(() => withLock(lockFile, () => 'ran', { waitMs: 0, staleMs: 60 * 60_000 }), 'LOCKED');
  });
});
