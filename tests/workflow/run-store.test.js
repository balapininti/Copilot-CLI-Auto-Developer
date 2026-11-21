import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { addHistory, checkGates, loadRun, recordGate, repoState, REQUIRED_GATES, updateRun } from '../../src/workflow/run-store.js';
import { expectCode, tempWorkspace } from '../helpers.js';

const P = 'orders';
const S = 'S-01001';
const TREE_A = 'a'.repeat(40);
const TREE_B = 'b'.repeat(40);

describe('run-store', () => {
  const ws = tempWorkspace();
  after(() => ws.cleanup());

  /** @param {string} storyId @param {string} treeId @param {Partial<Record<string, boolean>>} [passed] */
  const recordAll = async (storyId, treeId, passed = {}) => {
    for (const gate of REQUIRED_GATES) {
      await recordGate(ws.workspace, { projectId: P, storyId, repo: 'api', gate, treeId, passed: passed[gate] ?? true, summary: {} });
    }
  };

  test('loadRun returns an empty run when nothing is stored and writes nothing', () => {
    const run = loadRun(ws.workspace, P, 'S-EMPTY');
    assert.equal(run.projectId, P);
    assert.equal(run.storyId, 'S-EMPTY');
    assert.deepEqual(run.repos, {});
    assert.deepEqual(run.history, []);
    assert.equal(fs.existsSync(path.join(ws.workspace.stateDir, 'runs', P, 'S-EMPTY.json')), false);
  });

  test('the three required gates are tests, automated-review and independent-review', () => {
    assert.deepEqual([...REQUIRED_GATES], ['tests', 'automated-review', 'independent-review']);
  });

  test('checkGates reports every gate as not run for a new story', () => {
    const result = checkGates(loadRun(ws.workspace, P, 'S-NEW'), 'api', TREE_A);
    assert.equal(result.ok, false);
    assert.deepEqual(result.blockers.map((b) => b.gate), [...REQUIRED_GATES]);
    assert.ok(result.blockers.every((b) => /Not run yet/.test(b.reason)));
  });

  test('gates recorded for a tree pass only for exactly that tree id', async () => {
    await recordAll(S, TREE_A);
    const run = loadRun(ws.workspace, P, S);
    assert.deepEqual(checkGates(run, 'api', TREE_A), { ok: true, blockers: [] });
    const stale = checkGates(run, 'api', TREE_B);
    assert.equal(stale.ok, false);
    assert.equal(stale.blockers.length, 3);
    assert.ok(stale.blockers.every((b) => /earlier version/.test(b.reason)));
  });

  test('gates recorded for one repository do not satisfy another repository', async () => {
    await recordAll('S-REPO', TREE_A);
    assert.equal(checkGates(loadRun(ws.workspace, P, 'S-REPO'), 'web-ui', TREE_A).ok, false);
  });

  test('a failed gate blocks even when the tree id matches', async () => {
    await recordAll('S-FAIL', TREE_A, { 'automated-review': false });
    const result = checkGates(loadRun(ws.workspace, P, 'S-FAIL'), 'api', TREE_A);
    assert.equal(result.ok, false);
    assert.deepEqual(result.blockers, [{ gate: 'automated-review', reason: 'Did not pass.' }]);
  });

  test('re-recording a single gate for a new tree leaves the others stale', async () => {
    await recordAll('S-PART', TREE_A);
    await recordGate(ws.workspace, { projectId: P, storyId: 'S-PART', repo: 'api', gate: 'tests', treeId: TREE_B, passed: true, summary: {} });
    const result = checkGates(loadRun(ws.workspace, P, 'S-PART'), 'api', TREE_B);
    assert.deepEqual(result.blockers.map((b) => b.gate), ['automated-review', 'independent-review']);
  });

  test('recordGate rejects an unknown gate name', async () => {
    await expectCode(
      () => recordGate(ws.workspace, { projectId: P, storyId: S, repo: 'api', gate: 'vibes', treeId: TREE_A, passed: true, summary: {} }),
      'INVALID_ARGUMENT',
    );
  });

  test('recordGate stores summary, tree id and a history entry', async () => {
    const stored = await recordGate(ws.workspace, { projectId: P, storyId: 'S-SUM', repo: 'api', gate: 'tests', treeId: TREE_A, passed: true, summary: { stages: [{ stage: 'unit', status: 'passed' }] } });
    assert.equal(stored.treeId, TREE_A);
    const run = loadRun(ws.workspace, P, 'S-SUM');
    assert.deepEqual(run.repos.api.gates.tests.summary, { stages: [{ stage: 'unit', status: 'passed' }] });
    assert.equal(run.history.at(-1).event, 'gate:tests');
    assert.ok(run.updatedAt);
  });

  test('concurrent recordGate calls do not lose each other\'s writes', async () => {
    await Promise.all(
      REQUIRED_GATES.map((gate) => recordGate(ws.workspace, { projectId: P, storyId: 'S-CONC', repo: 'api', gate, treeId: TREE_A, passed: true, summary: {} })),
    );
    assert.equal(checkGates(loadRun(ws.workspace, P, 'S-CONC'), 'api', TREE_A).ok, true);
  });

  test('story ids that could traverse paths are rejected', async () => {
    await expectCode(() => loadRun(ws.workspace, P, '../../etc/passwd'), 'INVALID_ARGUMENT');
    await expectCode(() => updateRun(ws.workspace, P, 'a/b', () => {}), 'INVALID_ARGUMENT');
    await expectCode(() => loadRun(ws.workspace, '..', S), 'INVALID_ARGUMENT');
  });

  test('runs are stored per project: project B cannot see project A gates', async () => {
    await recordAll('S-ISO', TREE_A);
    assert.equal(checkGates(loadRun(ws.workspace, 'billing', 'S-ISO'), 'api', TREE_A).ok, false);
  });

  test('updateRun does not persist when the callback throws and releases the lock', async () => {
    await assert.rejects(updateRun(ws.workspace, P, 'S-THROW', () => { throw new Error('boom'); }), /boom/);
    assert.deepEqual(loadRun(ws.workspace, P, 'S-THROW').repos, {});
    await updateRun(ws.workspace, P, 'S-THROW', (run) => { repoState(run, 'api').baseBranch = 'release/1'; });
    assert.equal(loadRun(ws.workspace, P, 'S-THROW').repos.api.baseBranch, 'release/1');
  });

  test('history is capped at 500 entries', () => {
    const run = loadRun(ws.workspace, P, 'S-HIST');
    for (let i = 0; i < 520; i += 1) addHistory(run, 'e', { i });
    assert.equal(run.history.length, 500);
    assert.equal(run.history[0].i, 20);
  });

  test('a corrupt run file is reported as an integrity violation, not silently reset', async () => {
    const file = path.join(ws.workspace.stateDir, 'runs', P, 'S-BAD.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    await expectCode(() => loadRun(ws.workspace, P, 'S-BAD'), 'INTEGRITY_VIOLATION');
  });

  test('a repository named __proto__ cannot pollute Object.prototype', async () => {
    await recordGate(ws.workspace, { projectId: P, storyId: 'S-PROTO', repo: '__proto__', gate: 'tests', treeId: TREE_A, passed: true, summary: {} }).catch(() => {});
    assert.equal(/** @type {any} */ ({}).gates, undefined);
    assert.equal(/** @type {any} */ ({}).baseBranch, undefined);
  });
});
