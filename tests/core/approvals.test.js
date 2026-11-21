import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  Actions,
  Policy,
  consumeApproval,
  decideApproval,
  enforcePolicy,
  getApproval,
  listApprovals,
  requestApproval,
} from '../../src/core/approvals.js';
import { readAudit, verifyAudit } from '../../src/core/audit.js';
import { expectCode, setEnv, tempWorkspace } from '../helpers.js';

const P = 'orders';
/** @type {ReturnType<typeof tempWorkspace>} */
let ws;
/** @type {() => void} */
let restoreEnv;
beforeEach(() => {
  ws = tempWorkspace();
  restoreEnv = setEnv({ AUTODEV_ACTOR: undefined });
});
afterEach(() => {
  restoreEnv();
  ws.cleanup();
});

const payload = () => ({ title: 'S-01001: discount', toRef: 'release/2.15', files: ['src/a.js'] });
const request = (/** @type {Record<string, any>} */ extra = {}) =>
  requestApproval(ws.workspace, { projectId: P, action: Actions.CREATE_PR, summary: 'Open PR', payload: payload(), ...extra });
const approve = (/** @type {string} */ id) => decideApproval(ws.workspace, { projectId: P, id, decision: 'approved', decidedBy: 'jane' });
const deny = (/** @type {string} */ id, reason = 'not now') => decideApproval(ws.workspace, { projectId: P, id, decision: 'denied', decidedBy: 'jane', reason });
const consume = (/** @type {string} */ id, /** @type {Record<string, any>} */ extra = {}) =>
  consumeApproval(ws.workspace, { projectId: P, id, action: Actions.CREATE_PR, payload: payload(), ...extra });
const approvalFile = (/** @type {string} */ id) => path.join(ws.workspace.stateDir, 'approvals', P, `${id}.json`);

describe('requestApproval', () => {
  test('stages a pending request bound to the payload hash', async () => {
    const approval = await request();
    assert.match(approval.id, /^apr-[0-9a-f]{12}$/);
    assert.equal(approval.status, 'pending');
    assert.equal(approval.projectId, P);
    assert.equal(approval.action, Actions.CREATE_PR);
    assert.match(approval.payloadHash, /^[0-9a-f]{64}$/);
    assert.equal(approval.challenge, approval.payloadHash.slice(0, 6).toUpperCase());
    assert.equal(approval.requestedBy, 'autodev');
    assert.ok(Date.parse(approval.expiresAt) > Date.now());
    assert.deepEqual(getApproval(ws.workspace, P, approval.id), approval);
    assert.ok(fs.existsSync(approvalFile(approval.id)));
  });

  test('is idempotent for the same action and payload (key order irrelevant)', async () => {
    const first = await request();
    const second = await request({ payload: { files: ['src/a.js'], toRef: 'release/2.15', title: 'S-01001: discount' } });
    assert.equal(second.id, first.id);
    assert.equal(listApprovals(ws.workspace, P).length, 1);
    assert.equal(readAudit(ws.workspace, P, { action: 'approval.requested' }).length, 1);
  });

  test('concurrent identical requests produce one approval', async () => {
    const all = await Promise.all(Array.from({ length: 6 }, () => request()));
    assert.equal(new Set(all.map((approval) => approval.id)).size, 1);
    assert.equal(listApprovals(ws.workspace, P).length, 1);
  });

  test('an approved-but-unspent request is returned rather than duplicated', async () => {
    const first = await request();
    await approve(first.id);
    const again = await request();
    assert.equal(again.id, first.id);
    assert.equal(again.status, 'approved');
  });

  test('a different payload or action gets its own request', async () => {
    const first = await request();
    const changed = await request({ payload: { ...payload(), title: 'changed' } });
    const otherAction = await request({ action: Actions.CREATE_DEFECT });
    assert.equal(new Set([first.id, changed.id, otherAction.id]).size, 3);
  });

  test('after a request is consumed, denied or expired, asking again stages a new one', async () => {
    const first = await request();
    await approve(first.id);
    await consume(first.id);
    const second = await request();
    assert.notEqual(second.id, first.id);
    await deny(second.id);
    const third = await request({ ttlMinutes: 0 });
    assert.notEqual(third.id, second.id);
    const fourth = await request();
    assert.notEqual(fourth.id, third.id);
    assert.equal(fourth.status, 'pending');
  });

  test('the stored preview is redacted (secrets and personal data), the hash is of the real payload', async () => {
    const secretPayload = { body: 'contact jane.doe@example.com Authorization: Bearer abcdefgh12345678', password: 'pw' };
    const approval = await request({ payload: secretPayload });
    const stored = fs.readFileSync(approvalFile(approval.id), 'utf8');
    assert.ok(!stored.includes('jane.doe@example.com'));
    assert.ok(!stored.includes('abcdefgh12345678'));
    assert.equal(/** @type {any} */ (approval.preview).password, '[REDACTED:field]');
    await approve(approval.id);
    await consumeApproval(ws.workspace, { projectId: P, id: approval.id, action: Actions.CREATE_PR, payload: secretPayload });
  });
});

describe('decideApproval', () => {
  test('records who decided and audits it', async () => {
    const approval = await request();
    const decided = await approve(approval.id);
    assert.equal(decided.status, 'approved');
    assert.equal(decided.decidedBy, 'jane');
    assert.ok(decided.decidedAt);
    const audit = readAudit(ws.workspace, P, { action: 'approval.approved' });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor, 'jane');
    assert.equal(audit[0].details.approvalId, approval.id);
  });

  test('a decision cannot be changed once made', async () => {
    const approval = await request();
    await deny(approval.id);
    await expectCode(() => approve(approval.id), 'CONFLICT');
    assert.equal(getApproval(ws.workspace, P, approval.id).status, 'denied');
    const other = await request({ payload: { n: 2 } });
    await approve(other.id);
    await expectCode(() => deny(other.id), 'CONFLICT');
    await expectCode(() => approve(other.id), 'CONFLICT');
  });

  test('an expired request cannot be approved', async () => {
    const approval = await request({ ttlMinutes: 0 });
    assert.equal(getApproval(ws.workspace, P, approval.id).status, 'expired');
    await expectCode(() => approve(approval.id), 'CONFLICT');
  });

  test('an unknown id is NOT_FOUND and a hostile id is rejected', async () => {
    await expectCode(() => approve('apr-000000000000'), 'NOT_FOUND');
    await expectCode(() => approve('../../audit/orders/audit'), 'INVALID_ARGUMENT');
    await expectCode(() => getApproval(ws.workspace, P, '..'), 'INVALID_ARGUMENT');
  });
});

describe('consumeApproval', () => {
  test('fails with APPROVAL_REQUIRED while the request is pending', async () => {
    const approval = await request();
    const error = await expectCode(() => consume(approval.id), 'APPROVAL_REQUIRED');
    assert.equal(error.details.approvalId, approval.id);
    assert.match(error.details.howToApprove, new RegExp(`approvals review ${approval.id} --project ${P}`));
    assert.equal(getApproval(ws.workspace, P, approval.id).status, 'pending');
  });

  test('fails with APPROVAL_DENIED when it was denied, carrying the reason', async () => {
    const approval = await request();
    await deny(approval.id, 'wrong branch');
    const error = await expectCode(() => consume(approval.id), 'APPROVAL_DENIED');
    assert.equal(error.details.reason, 'wrong branch');
  });

  test('fails with APPROVAL_MISMATCH when the payload changed after approval', async () => {
    const approval = await request();
    await approve(approval.id);
    await expectCode(() => consume(approval.id, { payload: { ...payload(), title: 'S-01001: discount ' } }), 'APPROVAL_MISMATCH');
    await expectCode(() => consume(approval.id, { payload: { ...payload(), extra: null } }), 'APPROVAL_MISMATCH');
    await expectCode(() => consume(approval.id, { payload: { ...payload(), files: [] } }), 'APPROVAL_MISMATCH');
    assert.equal(getApproval(ws.workspace, P, approval.id).status, 'approved', 'a mismatch does not spend the approval');
    assert.equal(readAudit(ws.workspace, P, { action: 'approval.mismatch' }).length, 3);
    await consume(approval.id);
  });

  test('fails with APPROVAL_MISMATCH when used for a different action', async () => {
    const approval = await request();
    await approve(approval.id);
    await expectCode(() => consume(approval.id, { action: Actions.CREATE_DEFECT }), 'APPROVAL_MISMATCH');
  });

  test('succeeds once, then fails as already consumed', async () => {
    const approval = await request();
    await approve(approval.id);
    const consumed = await consume(approval.id);
    assert.equal(consumed.status, 'consumed');
    assert.ok(consumed.consumedAt);
    const error = await expectCode(() => consume(approval.id), 'APPROVAL_REQUIRED', /consumed/);
    assert.equal(error.details.status, 'consumed');
    assert.equal(readAudit(ws.workspace, P, { action: 'approval.consumed' }).length, 1);
  });

  test('of several concurrent consumers exactly one succeeds', async () => {
    const approval = await request();
    await approve(approval.id);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => consume(approval.id)));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    for (const result of results) {
      if (result.status === 'rejected') assert.equal(result.reason.code, 'APPROVAL_REQUIRED');
    }
  });

  test('fails when the approval expired, even if it had been approved', async () => {
    const approval = await request();
    await approve(approval.id);
    const stored = JSON.parse(fs.readFileSync(approvalFile(approval.id), 'utf8'));
    stored.expiresAt = new Date(Date.now() - 1_000).toISOString();
    fs.writeFileSync(approvalFile(approval.id), JSON.stringify(stored));
    const error = await expectCode(() => consume(approval.id), 'APPROVAL_REQUIRED', /expired/);
    assert.equal(error.details.status, 'expired');
    assert.equal(listApprovals(ws.workspace, P, { status: 'expired' }).length, 1);
  });

  test('an approval from one project cannot be used in another', async () => {
    const approval = await request();
    await approve(approval.id);
    await expectCode(
      () => consumeApproval(ws.workspace, { projectId: 'billing', id: approval.id, action: Actions.CREATE_PR, payload: payload() }),
      'NOT_FOUND',
    );
    assert.equal(getApproval(ws.workspace, P, approval.id).status, 'approved');
  });
});

describe('listApprovals', () => {
  test('lists by status in request order and is empty for an unknown project', async () => {
    const a = await request({ payload: { n: 1 } });
    const b = await request({ payload: { n: 2 } });
    const c = await request({ payload: { n: 3 } });
    await approve(b.id);
    await deny(c.id);
    assert.deepEqual(listApprovals(ws.workspace, P).map((approval) => approval.id).sort(), [a.id, b.id, c.id].sort());
    assert.deepEqual(listApprovals(ws.workspace, P, { status: 'pending' }).map((approval) => approval.id), [a.id]);
    assert.deepEqual(listApprovals(ws.workspace, P, { status: 'approved' }).map((approval) => approval.id), [b.id]);
    assert.deepEqual(listApprovals(ws.workspace, 'billing'), []);
  });
});

describe('enforcePolicy', () => {
  const input = (/** @type {Record<string, any>} */ extra = {}) => ({
    projectId: P, action: Actions.CREATE_PR, policy: Policy.APPROVAL_REQUIRED, summary: 'Open PR', payload: payload(), ...extra,
  });

  test('prohibited: throws POLICY_PROHIBITED, audits it, stages nothing', async () => {
    const error = await expectCode(() => enforcePolicy(ws.workspace, input({ policy: Policy.PROHIBITED })), 'POLICY_PROHIBITED');
    assert.equal(error.details.action, Actions.CREATE_PR);
    assert.equal(listApprovals(ws.workspace, P).length, 0);
    assert.equal(readAudit(ws.workspace, P, { action: 'policy.prohibited' }).length, 1);
  });

  test('prohibited wins over dry-run and over a supplied approval id', async () => {
    const approval = await request();
    await approve(approval.id);
    await expectCode(() => enforcePolicy(ws.workspace, input({ policy: Policy.PROHIBITED, dryRun: true })), 'POLICY_PROHIBITED');
    await expectCode(() => enforcePolicy(ws.workspace, input({ policy: Policy.PROHIBITED, approvalId: approval.id })), 'POLICY_PROHIBITED');
    assert.equal(getApproval(ws.workspace, P, approval.id).status, 'approved');
  });

  test('allowed: proceeds without an approval', async () => {
    assert.deepEqual(await enforcePolicy(ws.workspace, input({ policy: Policy.ALLOWED })), { proceed: true, dryRun: false, approvalId: null });
    assert.equal(listApprovals(ws.workspace, P).length, 0);
  });

  test('approval-required: stages a request and throws APPROVAL_REQUIRED with instructions', async () => {
    const error = await expectCode(() => enforcePolicy(ws.workspace, input()), 'APPROVAL_REQUIRED');
    const pending = listApprovals(ws.workspace, P, { status: 'pending' });
    assert.equal(pending.length, 1);
    assert.equal(error.details.approvalId, pending[0].id);
    assert.equal(error.details.thenRerunWith, `--approval ${pending[0].id}`);
    assert.match(error.details.howToApprove, /own terminal/);
    // Asking again does not pile up requests.
    await expectCode(() => enforcePolicy(ws.workspace, input()), 'APPROVAL_REQUIRED');
    assert.equal(listApprovals(ws.workspace, P).length, 1);
  });

  test('approval-required: an undefined policy defaults to approval-required', async () => {
    await expectCode(() => enforcePolicy(ws.workspace, input({ policy: undefined })), 'APPROVAL_REQUIRED');
  });

  test('approval-required: proceeds once approved, with or without the id, and spends the approval', async () => {
    const first = await expectCode(() => enforcePolicy(ws.workspace, input()), 'APPROVAL_REQUIRED');
    await approve(first.details.approvalId);
    const result = await enforcePolicy(ws.workspace, input({ approvalId: first.details.approvalId }));
    assert.deepEqual(result, { proceed: true, dryRun: false, approvalId: first.details.approvalId });
    assert.equal(getApproval(ws.workspace, P, first.details.approvalId).status, 'consumed');
    await expectCode(() => enforcePolicy(ws.workspace, input({ approvalId: first.details.approvalId })), 'APPROVAL_REQUIRED');

    const second = await expectCode(() => enforcePolicy(ws.workspace, input()), 'APPROVAL_REQUIRED');
    assert.notEqual(second.details.approvalId, first.details.approvalId);
    await approve(second.details.approvalId);
    assert.equal((await enforcePolicy(ws.workspace, input())).approvalId, second.details.approvalId);
  });

  test('approval-required: a denied or mismatched approval id is refused', async () => {
    const a = await request();
    await deny(a.id);
    await expectCode(() => enforcePolicy(ws.workspace, input({ approvalId: a.id })), 'APPROVAL_DENIED');
    const b = await request();
    await approve(b.id);
    await expectCode(() => enforcePolicy(ws.workspace, input({ approvalId: b.id, payload: { different: true } })), 'APPROVAL_MISMATCH');
    await expectCode(() => enforcePolicy(ws.workspace, input({ approvalId: 'apr-ffffffffffff' })), 'NOT_FOUND');
  });

  test('dry-run: does not proceed and creates no approval', async () => {
    for (const policy of [Policy.APPROVAL_REQUIRED, Policy.ALLOWED, undefined]) {
      assert.deepEqual(await enforcePolicy(ws.workspace, input({ policy, dryRun: true })), { proceed: false, dryRun: true, approvalId: null });
    }
    assert.equal(listApprovals(ws.workspace, P).length, 0);
    const audit = readAudit(ws.workspace, P, { action: 'policy.dry-run' });
    assert.equal(audit.length, 3);
    assert.equal(audit[0].outcome, 'dry-run');
  });

  test('dry-run: does not spend an approval that was supplied', async () => {
    const approval = await request();
    await approve(approval.id);
    await enforcePolicy(ws.workspace, input({ approvalId: approval.id, dryRun: true }));
    assert.equal(getApproval(ws.workspace, P, approval.id).status, 'approved');
  });

  test('an unknown policy value is CONFIG_INVALID, never treated as allowed', async () => {
    for (const policy of ['Allowed', 'yes', '', 'ALLOWED ', 'none']) {
      await expectCode(() => enforcePolicy(ws.workspace, input({ policy })), 'CONFIG_INVALID');
    }
    assert.equal(listApprovals(ws.workspace, P).length, 0);
  });

  test('the audit chain stays valid across the whole approval life cycle', async () => {
    const first = await expectCode(() => enforcePolicy(ws.workspace, input()), 'APPROVAL_REQUIRED');
    await approve(first.details.approvalId);
    await enforcePolicy(ws.workspace, input({ approvalId: first.details.approvalId }));
    const audit = verifyAudit(ws.workspace, P);
    assert.equal(audit.valid, true);
    assert.deepEqual(readAudit(ws.workspace, P).map((entry) => entry.action), ['approval.requested', 'approval.approved', 'approval.consumed']);
  });
});
