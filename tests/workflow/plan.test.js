import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { readAudit } from '../../src/core/audit.js';
import { parseManifest } from '../../src/core/manifest.js';
import { main } from '../../src/cli/main.js';
import { BLOCKING_PRIORITIES, checkPlan, missingSections, normalizeFindings, planReviewRequired, PLAN_SECTIONS, reviewPlan, showPlan, submitPlan } from '../../src/workflow/plan.js';
import { loadRun } from '../../src/workflow/run-store.js';
import { expectCode, fullManifest, tempWorkspace, writeProject } from '../helpers.js';

const P = 'orders';
const S = 'S-01001';
const PLAN = `# Plan for S-01001

## Goal
Apply the loyalty discount to member orders, as the story asks.

## Acceptance criteria
1. Member orders are discounted: PricingService.price().
2. Other orders are unchanged: existing tests.

## Changes
service-api: PricingService.java, PricingServiceTest.java.

## Edge cases
Null customer, empty order, discount of zero, concurrent price requests.

## Tests
A unit test that fails without the change. Existing unit and integration stages.

## Risks and rollback
Confined to one service class. Roll back by reverting the commit.

## Assumptions and open questions
The rate comes from APP.DISCOUNT. No open questions.
`;
const CHECKED = 'Mapped both acceptance criteria to changes and tests; read PricingService and its two callers.';
const p1 = () => ({ priority: 'P1', title: 'Null customer is not handled', detail: 'price() dereferences order.getCustomer() and throws for guest orders.', evidence: 'PricingService.java:42', recommendation: 'Treat a missing customer as a non-member and add a test.' });
const p3 = () => ({ priority: 'p3', title: 'Rate is a literal', detail: 'A named constant would be easier to change later.' });

describe('plan', () => {
  /** @type {ReturnType<typeof tempWorkspace>} */
  let ws;
  beforeEach(() => {
    ws = tempWorkspace();
    writeProject(ws.workspace, fullManifest({ policies: {} }));
  });
  afterEach(() => ws.cleanup());

  const submit = (text = PLAN) => /** @type {Promise<any>} */ (submitPlan(ws.workspace, { projectId: P, storyId: S, text }));
  const review = (/** @type {Record<string, any>} */ over) =>
    reviewPlan(ws.workspace, { projectId: P, storyId: S, planHash: '', verdict: 'ready', reviewer: 'plan-reviewer', findings: [], checked: CHECKED, ...over });

  test('the plan gate is required by default and can only be relaxed explicitly', () => {
    assert.equal(parseManifest('id: p\n').manifest.policies.planReview, 'required');
    assert.equal(planReviewRequired(parseManifest('id: p\n').manifest), true);
    assert.equal(planReviewRequired(parseManifest('id: p\npolicies:\n  planReview: advisory\n').manifest), false);
    assert.equal(planReviewRequired({}), true);
    assert.throws(() => parseManifest('id: p\npolicies:\n  planReview: off\n'));
  });

  test('a plan needs every section, a sensible size and no secrets', async () => {
    assert.deepEqual(missingSections(PLAN), []);
    assert.deepEqual(missingSections('## Goal\nx\n## Tests\ny\n'), ['Acceptance criteria', 'Changes', 'Edge cases', 'Risks and rollback', 'Assumptions and open questions']);
    const error = await expectCode(() => submit(PLAN.replace('## Edge cases', '## Other')), 'INVALID_ARGUMENT', /no heading for: Edge cases/);
    assert.deepEqual(error.details.required, [...PLAN_SECTIONS]);
    await expectCode(() => submit('## Goal\ntoo short'), 'INVALID_ARGUMENT');
    await expectCode(() => submit(`${PLAN}\nUse token ghp_abcdefghijklmnopqrstuvwxyz0123456789 to test.`), 'INVALID_ARGUMENT', /secret or personal data/);
    await expectCode(() => submit(`${PLAN}\nTest with jane.doe@example.com.`), 'INVALID_ARGUMENT');
    await expectCode(() => showPlan(ws.workspace, P, S), 'NOT_FOUND');
  });

  test('a submitted plan is not ready until it is evaluated', async () => {
    const plan = await submit();
    assert.equal(plan.version, 1);
    assert.match(plan.planHash, /^[0-9a-f]{64}$/);
    assert.equal(plan.readiness.ok, false);
    assert.match(plan.readiness.blockers[0].reason, /not been evaluated/);
    assert.match(checkPlan(loadRun(ws.workspace, P, 'S-09999')).blockers[0].reason, /No implementation plan/);
    assert.equal((await submit()).unchanged, true, 'resubmitting the same text changes nothing');
    assert.equal(showPlan(ws.workspace, P, S).text, PLAN.trim());
    const dry = /** @type {any} */ (await submitPlan(ws.workspace, { projectId: P, storyId: 'S-02000', text: PLAN, dryRun: true }));
    assert.equal(dry.dryRun, true);
    await expectCode(() => showPlan(ws.workspace, P, 'S-02000'), 'NOT_FOUND');
  });

  test('the author cannot sign off its own plan', async () => {
    const plan = await submit();
    await expectCode(() => review({ planHash: plan.planHash, reviewer: 'auto-developer' }), 'POLICY_PROHIBITED', /independent/);
    await expectCode(() => review({ planHash: plan.planHash, reviewer: 'Auto-Developer' }), 'POLICY_PROHIBITED');
    await expectCode(() => review({ planHash: plan.planHash, reviewer: '' }), 'INVALID_ARGUMENT');
    assert.equal(showPlan(ws.workspace, P, S).review, null);
  });

  test('ready is refused while a P0 or P1 finding stands', async () => {
    const plan = await submit();
    assert.deepEqual([...BLOCKING_PRIORITIES], ['P0', 'P1']);
    for (const priority of BLOCKING_PRIORITIES) {
      const error = await expectCode(() => review({ planHash: plan.planHash, findings: [{ ...p1(), priority }, p3()] }), 'GATE_FAILED', /cannot be recorded as ready/);
      assert.deepEqual(error.details.blocking, [`${priority}: Null customer is not handled`]);
    }
    const recorded = await review({ planHash: plan.planHash, verdict: 'not-ready', findings: [p3(), p1()], checked: '' });
    assert.equal(recorded.readiness.ok, false);
    assert.match(recorded.readiness.blockers[0].reason, /not ready \(0 P0, 1 P1\)/);
    assert.deepEqual(recorded.review?.findings.map((/** @type {any} */ finding) => finding.priority), ['P1', 'P3'], 'findings are ordered most severe first');
    assert.deepEqual(recorded.review?.counts, { P0: 0, P1: 1, P2: 0, P3: 1, P4: 0 });
  });

  test('a sign-off must say what was checked, and may carry P2 to P4 findings', async () => {
    const plan = await submit();
    await expectCode(() => review({ planHash: plan.planHash, checked: 'LGTM' }), 'INVALID_ARGUMENT', /what you verified/);
    await expectCode(() => review({ planHash: plan.planHash, checked: null }), 'INVALID_ARGUMENT');
    const ready = await review({ planHash: plan.planHash, findings: [{ ...p3(), priority: 'P2' }, p3(), { ...p3(), priority: 'P4' }], notVerified: 'Did not run the integration stage.' });
    assert.equal(ready.readiness.ok, true);
    assert.equal(ready.review?.verdict, 'ready');
    assert.equal(ready.review?.notVerified, 'Did not run the integration stage.');
    assert.equal(ready.review?.round, 1);
    assert.deepEqual(readAudit(ws.workspace, P).filter((item) => item.action.startsWith('plan.')).map((item) => `${item.action}:${item.outcome}`), ['plan.submitted:success', 'plan.reviewed:success']);
  });

  test('the verdict belongs to the plan that was read; changing the plan makes it stale', async () => {
    const plan = await submit();
    await expectCode(() => review({ planHash: '' }), 'CONFLICT', /plan-hash is missing/);
    await expectCode(() => review({ planHash: 'abc' }), 'CONFLICT');
    await expectCode(() => review({ planHash: 'f'.repeat(64) }), 'CONFLICT');
    await review({ planHash: plan.planHash.slice(0, 12) });
    assert.equal(showPlan(ws.workspace, P, S).readiness.ok, true);

    const revised = await submit(PLAN.replace('Null customer, empty order', 'Null customer, guest checkout, empty order'));
    assert.equal(revised.version, 2);
    assert.equal(revised.readiness.ok, false);
    assert.equal(revised.review, null);
    assert.deepEqual(revised.staleReview?.verdict, 'ready');
    // A reviewer who read version 1 cannot have the verdict land on version 2.
    await expectCode(() => review({ planHash: plan.planHash }), 'CONFLICT', /changed since you read it/);
    const second = await review({ planHash: revised.planHash });
    assert.equal(second.readiness.ok, true);
    assert.equal(second.review?.round, 2, 'rounds are counted across revisions of the plan');
    await expectCode(() => reviewPlan(ws.workspace, { projectId: P, storyId: 'S-07777', planHash: plan.planHash, verdict: 'ready', reviewer: 'plan-reviewer', findings: [], checked: CHECKED }), 'GATE_FAILED', /No plan has been submitted/);
  });

  test('findings are validated: priority, substance, and evidence for anything blocking', async () => {
    assert.deepEqual(normalizeFindings([]), []);
    assert.equal(normalizeFindings([p3()])[0].priority, 'P3');
    await expectCode(() => normalizeFindings({}), 'INVALID_ARGUMENT');
    await expectCode(() => normalizeFindings([{ ...p3(), priority: 'P5' }]), 'INVALID_ARGUMENT', /P0, P1, P2, P3, P4/);
    await expectCode(() => normalizeFindings([{ ...p3(), priority: 'high' }]), 'INVALID_ARGUMENT');
    await expectCode(() => normalizeFindings([{ priority: 'P2', title: 'x', detail: 'y' }]), 'INVALID_ARGUMENT');
    await expectCode(() => normalizeFindings([{ ...p1(), evidence: '' }]), 'INVALID_ARGUMENT', /needs "evidence"/);
    await expectCode(() => normalizeFindings([{ ...p1(), recommendation: undefined }]), 'INVALID_ARGUMENT');
    await expectCode(() => normalizeFindings(Array.from({ length: 61 }, p3)), 'INVALID_ARGUMENT');
    const masked = normalizeFindings([{ ...p3(), detail: 'The log line contains jane.doe@example.com and should not.' }]);
    assert.equal(masked[0].detail.includes('jane.doe'), false);
  });

  test('the command line carries the whole flow', async () => {
    const run = async (/** @type {string[]} */ argv) => {
      /** @type {string[]} */
      const out = [];
      const exitCode = await main([...argv, '--workspace', ws.root, '--project', P], { env: { AUTODEV_DISABLE_CREDENTIAL_STORE: '1' }, stdout: (text) => { out.push(text); } });
      return { exitCode, envelope: JSON.parse(out[0]) };
    };
    const planFile = path.join(ws.root, 'plan.md');
    const findingsFile = path.join(ws.root, 'findings.json');
    fs.writeFileSync(planFile, PLAN);
    fs.writeFileSync(findingsFile, JSON.stringify([p1()]));

    const submitted = await run(['plan', 'submit', '--story', 's-01001', '--file', planFile]);
    assert.equal(submitted.envelope.ok, true, JSON.stringify(submitted.envelope));
    const hash = submitted.envelope.data.planHash;
    const refused = await run(['plan', 'review', '--story', S, '--plan-hash', hash, '--verdict', 'ready', '--reviewer', 'plan-reviewer', '--findings', findingsFile, '--checked', CHECKED]);
    assert.equal(refused.envelope.error.code, 'GATE_FAILED');
    assert.equal(refused.exitCode, 4);
    const notReady = await run(['plan', 'review', '--story', S, '--plan-hash', hash, '--verdict', 'not-ready', '--reviewer', 'plan-reviewer', '--findings', findingsFile]);
    assert.equal(notReady.envelope.data.readiness.ok, false);
    fs.writeFileSync(findingsFile, '[]');
    const ready = await run(['plan', 'review', '--story', S, '--plan-hash', hash, '--verdict', 'ready', '--reviewer', 'plan-reviewer', '--findings', findingsFile, '--checked', CHECKED]);
    assert.equal(ready.envelope.data.readiness.ok, true);
    assert.equal(ready.envelope.data.review.round, 2);
    const shown = await run(['plan', 'show', '--story', S]);
    assert.match(shown.envelope.data.text, /## Edge cases/);
    const state = await run(['run', 'show', '--story', S]);
    assert.equal(state.envelope.data.planReviewRequired, true);
    assert.equal(state.envelope.data.plan.readiness.ok, true);
    assert.equal('text' in state.envelope.data.plan, false);
    const bad = await run(['plan', 'review', '--story', S, '--plan-hash', hash, '--verdict', 'maybe', '--reviewer', 'x', '--findings', findingsFile]);
    assert.equal(bad.envelope.error.code, 'INVALID_ARGUMENT');
  });
});
