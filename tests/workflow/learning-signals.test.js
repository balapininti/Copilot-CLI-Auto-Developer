import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { main } from '../../src/cli/main.js';
import { loadGuidelines } from '../../src/core/project-context.js';
import { decideApproval } from '../../src/core/approvals.js';
import { applyLearning, KNOWLEDGE_AREAS, proposeLearning } from '../../src/workflow/learning.js';
import { findSignals, markSignal, readHandled } from '../../src/workflow/learning-signals.js';
import { PLAN_AREAS } from '../../src/workflow/checklist.js';
import { reviewPlan, submitPlan } from '../../src/workflow/plan.js';
import { loadRun, recordGate } from '../../src/workflow/run-store.js';
import { fullManifest, tempWorkspace, writeProject } from '../helpers.js';

const P = 'orders';
const planText = (/** @type {string} */ note) => `# Plan\n\n## Goal\nApply the loyalty discount to member orders. ${note}\n\n## Acceptance criteria\n1. Members are discounted: PricingService.\n\n## Changes\nservice-api: PricingService.java.\n\n## Edge cases\nEmpty order, zero discount.\n\n## Tests\nA unit test that fails without the change.\n\n## Risks and rollback\nOne class; revert the commit.\n\n## Assumptions and open questions\nThe rate is fixed. None open.\n`;
const areas = (/** @type {string[]} */ withFindings = []) => Object.fromEntries(Object.keys(PLAN_AREAS).map((name) => [name, { status: withFindings.includes(name) ? 'findings' : 'ok', looked: 'Read the plan against the code and the ticket.' }]));
const finding = (/** @type {string} */ title, area = 'blast-radius', priority = 'P1') => ({ priority, area, title, detail: 'The job reads the table this plan changes and is not mentioned.', evidence: 'batch/InvoiceJob.java:40', recommendation: 'Add the job to the plan and a test for it.' });

describe('learning signals', () => {
  /** @type {ReturnType<typeof tempWorkspace>} */
  let ws;
  beforeEach(() => {
    ws = tempWorkspace();
    writeProject(ws.workspace, fullManifest({ policies: {} }), { 'guidelines/architecture.md': '# Architecture\n\n## Rules\nKeep it layered.\n' });
  });
  afterEach(() => ws.cleanup());

  /** A story whose plan is sent back once with a finding, then passes. */
  const story = async (/** @type {string} */ storyId, /** @type {string} */ title, area = 'blast-radius') => {
    const first = /** @type {any} */ (await submitPlan(ws.workspace, { projectId: P, storyId, text: planText('First draft.') }));
    await reviewPlan(ws.workspace, { projectId: P, storyId, planHash: first.planHash, verdict: 'not-ready', reviewer: 'plan-reviewer', findings: [finding(title, area)], areas: areas([area]) });
    const second = /** @type {any} */ (await submitPlan(ws.workspace, { projectId: P, storyId, text: planText('Revised to cover the job.') }));
    await reviewPlan(ws.workspace, { projectId: P, storyId, planHash: second.planHash, verdict: 'ready', reviewer: 'plan-reviewer', findings: [], areas: areas() });
  };

  test('there are knowledge areas for plan review and scenarios, and each task receives the relevant ones', async () => {
    assert.ok(KNOWLEDGE_AREAS.includes('plan-review') && KNOWLEDGE_AREAS.includes('e2e-scenarios'));
    const proposal = await proposeLearning(ws.workspace, { projectId: P, skill: 'plan-review', rule: 'When a plan changes APP.DISCOUNT, always list the invoice batch job as a consumer.', evidence: 'Sent back on S-01001 and S-01002.', source: 'S-01001, S-01002' });
    await decideApproval(ws.workspace, { projectId: P, id: proposal.approvalId, decision: 'approved', decidedBy: 'tester' });
    await applyLearning(ws.workspace, { projectId: P, approvalId: proposal.approvalId });
    const forPlan = loadGuidelines(ws.workspace, P, 'plan').files.filter((file) => file.kind === 'approved-learning');
    assert.deepEqual(forPlan.map((file) => file.path), ['knowledge/plan-review/approved.md']);
    assert.match(forPlan[0].content, /invoice batch job/);
    assert.equal(loadGuidelines(ws.workspace, P, 'implement').files.some((file) => file.path === 'knowledge/plan-review/approved.md'), true);
    assert.equal(loadGuidelines(ws.workspace, P, 'investigate').files.some((file) => file.kind === 'approved-learning'), false);
  });

  test('findings that sent a plan back are kept after the plan is revised and passes', async () => {
    await story('S-01001', 'Invoice batch job reads the discount table and is not in the plan');
    const run = loadRun(ws.workspace, P, 'S-01001');
    assert.equal(run.plan.review.verdict, 'ready');
    assert.deepEqual(run.plan.reviews.map((/** @type {any} */ review) => `${review.verdict}:${review.findings.length}`), ['not-ready:1', 'ready:0']);
    assert.equal(run.plan.reviews[0].findings[0].area, 'blast-radius');
    assert.equal('detail' in run.plan.reviews[0].findings[0], false, 'only what is needed to recognise a pattern is kept');
  });

  test('this story: a blocking plan finding and a gate that failed repeatedly are raised', async () => {
    await story('S-01001', 'Invoice batch job reads the discount table and is not in the plan');
    for (const passed of [false, false, true]) {
      await recordGate(ws.workspace, { projectId: P, storyId: 'S-01001', repo: 'service-api', gate: 'tests', treeId: 't', passed, summary: {} });
    }
    await recordGate(ws.workspace, { projectId: P, storyId: 'S-01001', repo: 'service-api', gate: 'automated-review', treeId: 't', passed: false, summary: {} });
    const result = findSignals(ws.workspace, { projectId: P, storyId: 'S-01001' });
    const kinds = result.signals.map((signal) => signal.kind);
    assert.deepEqual(kinds, ['blocking-plan-finding', 'gate-failed-repeatedly']);
    assert.match(result.signals[0].what, /P1 Invoice batch job/);
    assert.equal(result.signals[0].knowledgeArea, 'plan-review');
    assert.match(result.signals[1].what, /tests gate failed 2 times/);
    assert.equal(result.signals[1].knowledgeArea, 'testing');
    assert.equal(result.storiesExamined, 1);
    assert.deepEqual(findSignals(ws.workspace, { projectId: P }).signals, [], 'one story is not a pattern');
    assert.deepEqual(findSignals(ws.workspace, { projectId: P, storyId: 'S-09999' }).signals, []);
  });

  test('across stories: the same finding in different words, and an area that keeps failing', async () => {
    await story('S-01001', 'Invoice batch job reads the discount table and is not in the plan');
    await story('S-01002', 'The invoice batch job that reads the discount table is not mentioned in the plan');
    await story('S-01003', 'Guest checkout has no customer', 'edge-cases');
    const result = findSignals(ws.workspace, { projectId: P });
    const similar = result.signals.find((signal) => signal.kind === 'same-finding-on-several-stories');
    assert.deepEqual(similar?.stories, ['S-01001', 'S-01002']);
    assert.equal(similar?.examples.length, 2);
    const area = result.signals.find((signal) => signal.kind === 'plan-area-keeps-failing');
    assert.match(String(area?.what), /"blast-radius" on 2 stories/);
    assert.equal(result.signals.some((signal) => /edge-cases/.test(signal.what)), false, 'one story under edge-cases is not a pattern');
    assert.equal(result.storiesExamined, 3);
    assert.ok(result.howToAct.some((line) => /Never propose a rule just to clear a signal/.test(line)));
  });

  test('a gate that usually fails first is raised only when it is most stories', async () => {
    for (const [index, fails] of [true, true, true, false].entries()) {
      const storyId = `S-0200${index}`;
      if (fails) await recordGate(ws.workspace, { projectId: P, storyId, repo: 'service-api', gate: 'tests', treeId: 't', passed: false, summary: {} });
      await recordGate(ws.workspace, { projectId: P, storyId, repo: 'service-api', gate: 'tests', treeId: 't', passed: true, summary: {} });
    }
    const signal = findSignals(ws.workspace, { projectId: P }).signals.find((item) => item.kind === 'gate-usually-fails-first');
    assert.match(String(signal?.what), /tests gate failed at least once on 3 of 4 stories/);
  });

  test('a signal that was proposed or dismissed is not raised again', async () => {
    await story('S-01001', 'Invoice batch job reads the discount table and is not in the plan');
    const [signal] = findSignals(ws.workspace, { projectId: P, storyId: 'S-01001' }).signals;
    markSignal(ws.workspace, P, signal.key, 'dismissed', 'Particular to this story.');
    const after = findSignals(ws.workspace, { projectId: P, storyId: 'S-01001' });
    assert.deepEqual(after.signals, []);
    assert.equal(after.alreadyHandled, 1);
    assert.equal(readHandled(ws.workspace, P)[signal.key].state, 'dismissed');
    assert.throws(() => markSignal(ws.workspace, P, '../escape', 'dismissed'));
  });

  test('the command line: the check is recorded for the story, a proposal clears its signal, nothing is saved without approval', async () => {
    const run = async (/** @type {string[]} */ argv) => {
      /** @type {string[]} */
      const out = [];
      await main([...argv, '--workspace', ws.root, '--project', P], { env: { AUTODEV_DISABLE_CREDENTIAL_STORE: '1' }, stdout: (text) => { out.push(text); } });
      return JSON.parse(out[0]);
    };
    await story('S-01001', 'Invoice batch job reads the discount table and is not in the plan');
    assert.equal(loadRun(ws.workspace, P, 'S-01001').learningCheck, undefined);
    const dry = await run(['learn', 'suggest', '--story', 'S-01001', '--dry-run']);
    assert.equal(dry.data.signals.length, 1);
    assert.equal(loadRun(ws.workspace, P, 'S-01001').learningCheck, undefined, 'a dry run does not count as the check');

    const suggested = await run(['learn', 'suggest', '--story', 's-01001']);
    assert.equal(suggested.ok, true, JSON.stringify(suggested));
    assert.equal(loadRun(ws.workspace, P, 'S-01001').learningCheck.signals, 1);
    const key = suggested.data.signals[0].key;

    const proposed = await run(['learn', 'propose', '--skill', 'plan-review', '--rule', 'When a plan changes APP.DISCOUNT, always list the invoice batch job as a consumer.', '--evidence', 'Plan for S-01001 was sent back for it.', '--source', 'S-01001', '--signal', key]);
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    assert.equal(proposed.data.status, 'pending');
    const again = await run(['learn', 'suggest', '--story', 'S-01001']);
    assert.deepEqual(again.data.signals, []);
    assert.equal(again.data.pendingProposals.length, 1);
    assert.equal(loadGuidelines(ws.workspace, P, 'plan').files.some((file) => file.kind === 'approved-learning'), false, 'proposed is not saved');

    const next = await run(['next', '--story', 'S-01001']);
    assert.deepEqual(next.data.waitingForYou.map((/** @type {any} */ item) => item.action), ['learning.write']);

    const dismissed = await run(['learn', 'suggest', '--dismiss', 'story-gate-0123456789', '--reason', 'A flaky runner, not a pattern.']);
    assert.equal(dismissed.data.state, 'dismissed');
    assert.equal((await run(['learn', 'suggest', '--dismiss', 'x'])).error.code, 'INVALID_ARGUMENT');
  });
});
