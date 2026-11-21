import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import { listApprovals } from '../../src/core/approvals.js';
import { readAudit, verifyAudit } from '../../src/core/audit.js';
import { authorizeStart, claimNext, completeTask, enqueueHandoff, listTasks, TaskStatus } from '../../src/monitoring/handoff.js';
import { expectCode, removeDir, setEnv, tempWorkspace } from '../helpers.js';
import { decide, manifestWithDefaults } from './fixtures.js';

const PROJECT = 'orders';

describe('handoff queue', () => {
  /** @type {ReturnType<typeof tempWorkspace>} */
  let ws;
  /** @type {string[]} */
  const roots = [];
  const restoreEnv = setEnv({ AUTODEV_SESSION_ID: undefined, AUTODEV_ACTOR: undefined });
  beforeEach(() => {
    ws = tempWorkspace();
    roots.push(ws.root);
  });
  after(() => {
    roots.forEach(removeDir);
    restoreEnv();
  });

  const manifest = manifestWithDefaults();
  const autoStartManifest = manifestWithDefaults();
  autoStartManifest.monitoring.incidentPolicy.autoStartDevelopment = true;

  /** @param {string} defectId @param {Record<string, any>} [extra] */
  const enqueue = (defectId, extra = {}) =>
    enqueueHandoff(ws.workspace, { projectId: PROJECT, defectId, defectUrl: `https://agility/${defectId}`, incidentId: `INC-${defectId}`, candidateRepos: ['service-api'], manifest, ...extra });

  /** Enqueue and get the task approved and ready. @param {string} defectId */
  async function readyTask(defectId) {
    const { task } = await enqueue(defectId);
    const blocked = await expectCode(() => authorizeStart(ws.workspace, { projectId: PROJECT, taskId: task.taskId, manifest }), 'APPROVAL_REQUIRED');
    await decide(ws.workspace, PROJECT, blocked.details.approvalId);
    return authorizeStart(ws.workspace, { projectId: PROJECT, taskId: task.taskId, manifest });
  }

  test('enqueue creates a task that waits for start approval', async () => {
    const { task, created } = await enqueue('D-00001');
    assert.equal(created, true);
    assert.match(task.taskId, /^task-[0-9a-f]{12}$/);
    assert.equal(task.status, TaskStatus.AWAITING_START_APPROVAL);
    assert.equal(task.defectId, 'D-00001');
    assert.equal(task.incidentId, 'INC-D-00001');
    assert.deepEqual(task.candidateRepos, ['service-api']);
    assert.equal(task.attempts, 0);
    assert.equal(task.blockedReason, null);
    assert.deepEqual(listTasks(ws.workspace, PROJECT), [task]);
  });

  test('enqueue is idempotent per defect: a second call changes nothing', async () => {
    const first = await enqueue('D-00001');
    const second = await enqueue('D-00001', { candidateRepos: ['other-repo'], incidentId: 'INC-other' });
    assert.equal(second.created, false);
    assert.deepEqual(second.task, first.task);
    assert.equal(listTasks(ws.workspace, PROJECT).length, 1);
    assert.equal(readAudit(ws.workspace, PROJECT, { action: 'handoff.queued' }).length, 1);
  });

  test('concurrent enqueues of the same defect create exactly one task', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => enqueue('D-00001')));
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(new Set(results.map((result) => result.task.taskId)).size, 1);
    assert.equal(listTasks(ws.workspace, PROJECT).length, 1);
  });

  test('different defects, and the same defect id in another project, are different tasks', async () => {
    const a = await enqueue('D-00001');
    const b = await enqueue('D-00002');
    const other = await enqueueHandoff(ws.workspace, { projectId: 'billing', defectId: 'D-00001', incidentId: 'INC-x', candidateRepos: ['r'], manifest });
    assert.notEqual(a.task.taskId, b.task.taskId);
    assert.notEqual(a.task.taskId, other.task.taskId);
    assert.equal(listTasks(ws.workspace, PROJECT).length, 2);
    assert.equal(listTasks(ws.workspace, 'billing').length, 1);
  });

  test('a defect with no mapped repository is queued as blocked and can be neither authorized nor claimed', async () => {
    const { task } = await enqueue('D-00001', { candidateRepos: [] });
    assert.equal(task.status, TaskStatus.BLOCKED);
    assert.match(task.blockedReason, /No repository is mapped/);
    const error = await expectCode(() => authorizeStart(ws.workspace, { projectId: PROJECT, taskId: task.taskId, manifest }), 'CONFLICT');
    assert.equal(error.details.status, 'blocked');
    assert.equal(await claimNext(ws.workspace, PROJECT), null);
    assert.equal(listApprovals(ws.workspace, PROJECT).length, 0);
  });

  test('blocked wins even when autoStartDevelopment is true', async () => {
    const { task } = await enqueue('D-00001', { candidateRepos: [], manifest: autoStartManifest });
    assert.equal(task.status, TaskStatus.BLOCKED);
    assert.equal(await claimNext(ws.workspace, PROJECT), null);
  });

  test('a queued task cannot be claimed before development is authorized', async () => {
    await enqueue('D-00001');
    assert.equal(await claimNext(ws.workspace, PROJECT), null);
    assert.equal(listTasks(ws.workspace, PROJECT)[0].status, TaskStatus.AWAITING_START_APPROVAL);
    assert.equal(readAudit(ws.workspace, PROJECT, { action: 'handoff.claimed' }).length, 0);
  });

  test('authorizing asks for approval first and leaves the task unclaimable while it is pending', async () => {
    const { task } = await enqueue('D-00001');
    const error = await expectCode(() => authorizeStart(ws.workspace, { projectId: PROJECT, taskId: task.taskId, manifest }), 'APPROVAL_REQUIRED');
    assert.match(error.details.approvalId, /^apr-/);
    const again = await expectCode(() => authorizeStart(ws.workspace, { projectId: PROJECT, taskId: task.taskId, manifest }), 'APPROVAL_REQUIRED');
    assert.equal(again.details.approvalId, error.details.approvalId, 'asking twice does not create a second request');
    assert.equal(listApprovals(ws.workspace, PROJECT).length, 1);
    assert.equal(listApprovals(ws.workspace, PROJECT)[0].action, 'handoff.startDevelopment');
    assert.equal(await claimNext(ws.workspace, PROJECT), null);
  });

  test('after approval, authorize makes the task ready and spends the approval', async () => {
    const ready = await readyTask('D-00001');
    assert.equal(ready.status, TaskStatus.READY);
    assert.match(ready.approvalId, /^apr-/);
    assert.equal(listApprovals(ws.workspace, PROJECT, { status: 'consumed' }).length, 1);
    const again = await authorizeStart(ws.workspace, { projectId: PROJECT, taskId: ready.taskId, manifest });
    assert.equal(again.status, TaskStatus.READY, 'authorizing a ready task is a no-op');
    assert.equal(listApprovals(ws.workspace, PROJECT).length, 1);
  });

  test('a denied start approval does not authorize the task', async () => {
    const { task } = await enqueue('D-00001');
    const blocked = await expectCode(() => authorizeStart(ws.workspace, { projectId: PROJECT, taskId: task.taskId, manifest }), 'APPROVAL_REQUIRED');
    await decide(ws.workspace, PROJECT, blocked.details.approvalId, 'denied');
    await expectCode(() => authorizeStart(ws.workspace, { projectId: PROJECT, taskId: task.taskId, manifest, approvalId: blocked.details.approvalId }), 'APPROVAL_DENIED');
    assert.equal(listTasks(ws.workspace, PROJECT)[0].status, TaskStatus.AWAITING_START_APPROVAL);
    assert.equal(await claimNext(ws.workspace, PROJECT), null);
  });

  test('an approval for one task cannot authorize another', async () => {
    const a = (await enqueue('D-00001')).task;
    const b = (await enqueue('D-00002')).task;
    const blocked = await expectCode(() => authorizeStart(ws.workspace, { projectId: PROJECT, taskId: a.taskId, manifest }), 'APPROVAL_REQUIRED');
    await decide(ws.workspace, PROJECT, blocked.details.approvalId);
    await expectCode(() => authorizeStart(ws.workspace, { projectId: PROJECT, taskId: b.taskId, manifest, approvalId: blocked.details.approvalId }), 'APPROVAL_MISMATCH');
    assert.equal(listTasks(ws.workspace, PROJECT).find((task) => task.taskId === b.taskId)?.status, TaskStatus.AWAITING_START_APPROVAL);
  });

  test('dry-run authorize creates no approval and changes nothing', async () => {
    const { task } = await enqueue('D-00001');
    const result = await authorizeStart(ws.workspace, { projectId: PROJECT, taskId: task.taskId, manifest, dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(listApprovals(ws.workspace, PROJECT).length, 0);
    assert.equal(listTasks(ws.workspace, PROJECT)[0].status, TaskStatus.AWAITING_START_APPROVAL);
  });

  test('authorizing an unknown task is NOT_FOUND', async () => {
    await expectCode(() => authorizeStart(ws.workspace, { projectId: PROJECT, taskId: 'task-000000000000', manifest }), 'NOT_FOUND');
  });

  test('with autoStartDevelopment the task is ready as soon as it is queued', async () => {
    const { task } = await enqueue('D-00001', { manifest: autoStartManifest });
    assert.equal(task.status, TaskStatus.READY);
    assert.equal((await claimNext(ws.workspace, PROJECT, { claimedBy: 's1' }))?.taskId, task.taskId);
  });

  test('claimNext hands out a ready task once, records who took it, and audits it', async () => {
    const ready = await readyTask('D-00001');
    const claimed = await claimNext(ws.workspace, PROJECT, { claimedBy: 'session-a' });
    assert.equal(claimed?.taskId, ready.taskId);
    assert.equal(claimed?.status, TaskStatus.CLAIMED);
    assert.equal(claimed?.claimedBy, 'session-a');
    assert.equal(claimed?.attempts, 1);
    assert.equal(await claimNext(ws.workspace, PROJECT, { claimedBy: 'session-b' }), null);
    assert.equal(readAudit(ws.workspace, PROJECT, { action: 'handoff.claimed' }).length, 1);
  });

  test('under concurrent claimNext calls a single ready task is claimed exactly once', async () => {
    const ready = await readyTask('D-00001');
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => claimNext(ws.workspace, PROJECT, { claimedBy: `session-${index}` })));
    const winners = results.filter(Boolean);
    assert.equal(winners.length, 1);
    assert.equal(winners[0]?.taskId, ready.taskId);
    const [stored] = listTasks(ws.workspace, PROJECT);
    assert.equal(stored.status, TaskStatus.CLAIMED);
    assert.equal(stored.attempts, 1);
    assert.equal(stored.claimedBy, winners[0]?.claimedBy);
    assert.equal(readAudit(ws.workspace, PROJECT, { action: 'handoff.claimed' }).length, 1);
    assert.equal(verifyAudit(ws.workspace, PROJECT).valid, true);
  });

  test('concurrent claims over several ready tasks never hand the same task to two sessions', async () => {
    for (const id of ['D-00001', 'D-00002', 'D-00003']) await enqueue(id, { manifest: autoStartManifest });
    const results = await Promise.all(Array.from({ length: 7 }, (_, index) => claimNext(ws.workspace, PROJECT, { claimedBy: `s${index}` })));
    const ids = results.filter(Boolean).map((task) => task?.taskId);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3);
  });

  test('tasks are claimed oldest first', async () => {
    const first = (await enqueue('D-00001', { manifest: autoStartManifest })).task;
    const second = (await enqueue('D-00002', { manifest: autoStartManifest })).task;
    assert.equal((await claimNext(ws.workspace, PROJECT))?.taskId, first.taskId);
    assert.equal((await claimNext(ws.workspace, PROJECT))?.taskId, second.taskId);
    assert.equal(await claimNext(ws.workspace, PROJECT), null);
  });

  test('claims in one project never return another project\'s tasks', async () => {
    await enqueue('D-00001', { manifest: autoStartManifest });
    assert.equal(await claimNext(ws.workspace, 'billing'), null);
    assert.equal(listTasks(ws.workspace, 'billing').length, 0);
  });

  test('the claimant defaults to the session id, else "unknown-session"', async () => {
    await enqueue('D-00001', { manifest: autoStartManifest });
    await enqueue('D-00002', { manifest: autoStartManifest });
    assert.equal((await claimNext(ws.workspace, PROJECT))?.claimedBy, 'unknown-session');
    const restore = setEnv({ AUTODEV_SESSION_ID: 'sess-42' });
    try {
      assert.equal((await claimNext(ws.workspace, PROJECT))?.claimedBy, 'sess-42');
    } finally {
      restore();
    }
  });

  test('an abandoned claim (older than the timeout) is released and can be claimed again', async () => {
    const { task } = await enqueue('D-00001', { manifest: autoStartManifest });
    await claimNext(ws.workspace, PROJECT, { claimedBy: 'crashed-session' });
    assert.equal(await claimNext(ws.workspace, PROJECT), null);
    const file = path.join(ws.workspace.stateDir, 'handoff', PROJECT, 'queue.json');
    const tasks = JSON.parse(fs.readFileSync(file, 'utf8'));
    tasks[0].claimedAt = new Date(Date.now() - 9 * 60 * 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(tasks));
    const reclaimed = await claimNext(ws.workspace, PROJECT, { claimedBy: 'new-session' });
    assert.equal(reclaimed?.taskId, task.taskId);
    assert.equal(reclaimed?.claimedBy, 'new-session');
    assert.equal(reclaimed?.attempts, 2);
  });

  test('complete marks a claimed task done with its pull requests', async () => {
    const ready = await readyTask('D-00001');
    await claimNext(ws.workspace, PROJECT, { claimedBy: 's' });
    const done = await completeTask(ws.workspace, { projectId: PROJECT, taskId: ready.taskId, outcome: 'done', pullRequests: ['https://bitbucket/pr/1'] });
    assert.equal(done.status, TaskStatus.DONE);
    assert.deepEqual(done.pullRequests, ['https://bitbucket/pr/1']);
    assert.equal(done.blockedReason, null);
    assert.equal(await claimNext(ws.workspace, PROJECT), null, 'a done task is not handed out again');
    assert.equal(readAudit(ws.workspace, PROJECT, { action: 'handoff.done' }).length, 1);
  });

  test('complete with outcome blocked records the reason', async () => {
    const ready = await readyTask('D-00001');
    await claimNext(ws.workspace, PROJECT);
    const blocked = await completeTask(ws.workspace, { projectId: PROJECT, taskId: ready.taskId, outcome: 'blocked', reason: 'Release branch missing.' });
    assert.equal(blocked.status, TaskStatus.BLOCKED);
    assert.equal(blocked.blockedReason, 'Release branch missing.');
    assert.equal(await claimNext(ws.workspace, PROJECT), null);
  });

  test('a task that is not claimed cannot be completed; completing twice is refused', async () => {
    const { task } = await enqueue('D-00001');
    await expectCode(() => completeTask(ws.workspace, { projectId: PROJECT, taskId: task.taskId, outcome: 'done' }), 'CONFLICT');
    const ready = await readyTask('D-00002');
    await expectCode(() => completeTask(ws.workspace, { projectId: PROJECT, taskId: ready.taskId, outcome: 'done' }), 'CONFLICT');
    await claimNext(ws.workspace, PROJECT);
    await completeTask(ws.workspace, { projectId: PROJECT, taskId: ready.taskId, outcome: 'done' });
    await expectCode(() => completeTask(ws.workspace, { projectId: PROJECT, taskId: ready.taskId, outcome: 'done' }), 'CONFLICT');
    await expectCode(() => completeTask(ws.workspace, { projectId: PROJECT, taskId: 'task-nope', outcome: 'done' }), 'NOT_FOUND');
  });

  test('a failed mutation leaves the queue file intact and releases its lock', async () => {
    const { task } = await enqueue('D-00001');
    await expectCode(() => completeTask(ws.workspace, { projectId: PROJECT, taskId: task.taskId, outcome: 'done' }), 'CONFLICT');
    const dir = path.join(ws.workspace.stateDir, 'handoff', PROJECT);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.lock') || name.endsWith('.tmp')), []);
    assert.equal(listTasks(ws.workspace, PROJECT)[0].status, TaskStatus.AWAITING_START_APPROVAL);
  });

  test('project ids that could traverse paths are rejected', async () => {
    await expectCode(() => listTasks(ws.workspace, '../orders'), 'INVALID_ARGUMENT');
    await expectCode(() => claimNext(ws.workspace, '..'), 'INVALID_ARGUMENT');
  });
});
