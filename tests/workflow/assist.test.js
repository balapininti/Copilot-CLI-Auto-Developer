import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { main } from '../../src/cli/main.js';
import { CODE_AREAS, normalizeChecklist, PLAN_AREAS } from '../../src/workflow/checklist.js';
import { buildContext, compactGuideline, CONTEXT_TASKS } from '../../src/workflow/context.js';
import { nextStep, progress } from '../../src/workflow/next.js';
import { checkPlanFacts, criteriaCoverage, extractReferences, findReferences, splitCriteria } from '../../src/workflow/plan-check.js';
import { reviewPlan, submitPlan } from '../../src/workflow/plan.js';
import { recordGate, repoState, updateRun } from '../../src/workflow/run-store.js';
import { expectCode, fullManifest, git, setGitEnv, tempWorkspace, writeProject } from '../helpers.js';

const S = 'S-01001';

/** @param {Record<string, any>} [over] @returns {import('../../src/workflow/next.js').RepoFacts} */
const repoFacts = (over = {}) => ({
  name: 'service-api', prepared: true, cloneExists: true, featureBranch: 'feature/S-01001-x', currentBranch: 'feature/S-01001-x',
  dirty: false, changedFiles: 0, worktreeBlockers: [], headBlockers: [], pr: null, ...over,
});
/** @param {Record<string, any>} [over] @returns {import('../../src/workflow/next.js').StoryFacts} */
const facts = (over = {}) => ({
  storyId: S, storyRead: true, storyGaps: [], projectRepositories: ['service-api', 'web-ui'], planRequired: true,
  plan: { exists: true, evaluated: true, stale: false, verdict: 'ready', rounds: 1, blocking: [], shouldFix: [] },
  repos: [repoFacts()], ...over,
});
const ALL_GATES = [{ gate: 'tests', reason: 'Not run yet.' }, { gate: 'automated-review', reason: 'Not run yet.' }, { gate: 'independent-review', reason: 'Not run yet.' }];

describe('next step', () => {
  test('walks the whole workflow in order, one step at a time', () => {
    const sequence = [
      [facts({ storyRead: false, repos: [] }), 'read-story', 'auto-developer'],
      [facts({ repos: [] }), 'prepare-repositories', 'auto-developer'],
      [facts({ plan: { exists: false, evaluated: false, stale: false, verdict: null, rounds: 0, blocking: [], shouldFix: [] } }), 'write-plan', 'auto-developer'],
      [facts({ plan: { exists: true, evaluated: false, stale: false, verdict: null, rounds: 0, blocking: [], shouldFix: [] } }), 'evaluate-plan', 'plan-reviewer'],
      [facts({ plan: { exists: true, evaluated: true, stale: false, verdict: 'not-ready', rounds: 1, blocking: ['P1: Null customer'], shouldFix: [] } }), 'revise-plan', 'auto-developer'],
      [facts({ plan: { exists: true, evaluated: true, stale: true, verdict: null, rounds: 1, blocking: [], shouldFix: [] } }), 'evaluate-plan', 'plan-reviewer'],
      [facts(), 'implement', 'auto-developer'],
      [facts({ repos: [repoFacts({ dirty: true, changedFiles: 2, worktreeBlockers: ALL_GATES })] }), 'test', 'auto-developer'],
      [facts({ repos: [repoFacts({ dirty: true, changedFiles: 2, worktreeBlockers: ALL_GATES.slice(1) })] }), 'automated-review', 'auto-developer'],
      [facts({ repos: [repoFacts({ dirty: true, changedFiles: 2, worktreeBlockers: ALL_GATES.slice(2) })] }), 'independent-review', 'code-reviewer'],
      [facts({ repos: [repoFacts({ dirty: true, changedFiles: 2 })] }), 'commit', 'auto-developer'],
      [facts({ repos: [repoFacts({ changedFiles: 2 })] }), 'open-pull-request', 'auto-developer'],
      [facts({ repos: [repoFacts({ changedFiles: 2, pr: { url: 'https://bitbucket.example.internal/pr/1' } })] }), 'capture-learnings', 'auto-developer'],
      [facts({ learningChecked: true, repos: [repoFacts({ changedFiles: 2, pr: { url: 'https://bitbucket.example.internal/pr/1' } })] }), 'report', 'auto-developer'],
    ];
    for (const [input, step, actor] of sequence) {
      const result = nextStep(/** @type {any} */ (input));
      assert.equal(result.step, step);
      assert.equal(result.actor, actor, step);
      assert.ok(result.why.length > 10 && (result.command === null || result.command.startsWith('autodev ')), step);
    }
  });

  test('gates are redone in order when the code changed after they ran', () => {
    const stale = [{ gate: 'independent-review', reason: 'stale' }, { gate: 'tests', reason: 'Passed for an earlier version of the code' }];
    const step = nextStep(facts({ repos: [repoFacts({ dirty: true, changedFiles: 1, worktreeBlockers: stale })] }));
    assert.equal(step.step, 'test');
    assert.match(step.why, /earlier version/);
    assert.match(String(step.details?.[0]), /scenario affected/);
    // Committed, but the commit is not what was tested.
    assert.equal(nextStep(facts({ repos: [repoFacts({ changedFiles: 1, headBlockers: [{ gate: 'automated-review', reason: 'stale' }] })] })).step, 'automated-review');
  });

  test('stops for a person when it should', () => {
    const disagreement = nextStep(facts({ plan: { exists: true, evaluated: true, stale: false, verdict: 'not-ready', rounds: 3, blocking: ['P0: Drops a column'], shouldFix: [] } }));
    assert.equal(disagreement.step, 'plan-disagreement');
    assert.equal(disagreement.actor, 'user');
    assert.deepEqual(disagreement.details, ['P0: Drops a column']);
    const wrongBranch = nextStep(facts({ repos: [repoFacts({ currentBranch: 'main' })] }));
    assert.equal(wrongBranch.step, 'wrong-branch');
    assert.equal(wrongBranch.actor, 'user');
    const gaps = nextStep(facts({ repos: [], storyGaps: ['the story names no release branch'] }));
    assert.match(String(gaps.details?.join(' ')), /Ask the user first: the story names no release branch/);
  });

  test('carries P2 findings into the implement step and finishes one repository before the next', () => {
    const implement = nextStep(facts({ plan: { exists: true, evaluated: true, stale: false, verdict: 'ready', rounds: 1, blocking: [], shouldFix: ['P2: No test for guest orders'] } }));
    assert.match(String(implement.details?.join(' ')), /Confirm the plan with the user/);
    assert.match(String(implement.details?.join(' ')), /P2: No test for guest orders/);
    const two = facts({ repos: [repoFacts({ changedFiles: 2, pr: { url: 'x' } }), repoFacts({ name: 'web-ui' })] });
    assert.equal(nextStep(two).repository, 'web-ui');
    assert.equal(nextStep(two).step, 'implement');
    assert.equal(nextStep(facts({ repos: [repoFacts({ cloneExists: false })] })).step, 'prepare-repositories');
  });

  test('an advisory plan gate is still a step, and says it does not block', () => {
    const step = nextStep(facts({ planRequired: false, plan: { exists: false, evaluated: false, stale: false, verdict: null, rounds: 0, blocking: [], shouldFix: [] } }));
    assert.equal(step.step, 'write-plan');
    assert.match(step.why, /advisory/);
  });

  test('every story ends with the learning check, and the report lists what is waiting for the user', () => {
    const done = { repos: [repoFacts({ changedFiles: 2, pr: { url: 'x' } })] };
    const learn = nextStep(facts(done));
    assert.equal(learn.step, 'capture-learnings');
    assert.equal(learn.command, 'autodev learn suggest --story S-01001');
    assert.equal(learn.skill, 'learning-management');
    const report = nextStep(facts({ ...done, learningChecked: true, pendingApprovals: [{ id: 'apr-1', action: 'learning.write', summary: 'Save a learning to knowledge/testing/approved.md' }] }));
    assert.equal(report.step, 'report');
    assert.match(String(report.details?.join(' ')), /Waiting for the user: Save a learning .* approvals review apr-1/);
  });

  test('progress is a short status', () => {
    const status = progress(facts({ repos: [repoFacts({ dirty: true, changedFiles: 3, worktreeBlockers: ALL_GATES.slice(1) })] }));
    assert.deepEqual(status, { story: 'read', plan: 'ready', repositories: [{ name: 'service-api', changedFiles: 3, uncommitted: true, gatesOutstanding: ['automated-review', 'independent-review'], pullRequest: null }] });
    assert.equal(progress(facts({ plan: { exists: true, evaluated: true, stale: true, verdict: null, rounds: 1, blocking: [], shouldFix: [] } })).plan, 'changed since evaluation');
  });
});

describe('checklist', () => {
  const full = (/** @type {Record<string, string>} */ areas) => Object.fromEntries(Object.keys(areas).map((name) => [name, { status: 'OK', looked: 'Read the diff and the surrounding code.' }]));

  test('plans and code each have nine areas', () => {
    assert.equal(Object.keys(PLAN_AREAS).length, 9);
    assert.equal(Object.keys(CODE_AREAS).length, 9);
    assert.ok('blast-radius' in PLAN_AREAS && 'plan' in CODE_AREAS && 'scenarios' in CODE_AREAS);
  });

  test('a code review pass needs every area; a fail does not need a checklist', async () => {
    assert.equal(normalizeChecklist(undefined, CODE_AREAS, { signOff: false }), null);
    await expectCode(() => normalizeChecklist(undefined, CODE_AREAS, { signOff: true }), 'INVALID_ARGUMENT', /needs a checklist/);
    const ok = normalizeChecklist(full(CODE_AREAS), CODE_AREAS, { signOff: true });
    assert.equal(ok?.regression.status, 'ok');
    const partial = { ...full(CODE_AREAS), performance: { status: 'not-checked' } };
    assert.deepEqual((await expectCode(() => normalizeChecklist(partial, CODE_AREAS, { signOff: true }), 'INVALID_ARGUMENT')).details.problems, ['performance: not checked']);
    assert.equal(normalizeChecklist(partial, CODE_AREAS, { signOff: false })?.performance.status, 'not-checked');
    await expectCode(() => normalizeChecklist([], CODE_AREAS, { signOff: true }), 'INVALID_ARGUMENT');
    await expectCode(() => normalizeChecklist({ ...full(CODE_AREAS), tests: { status: 'fine', looked: 'Read the tests in the diff.' } }, CODE_AREAS, { signOff: true }), 'INVALID_ARGUMENT');
  });

  test('personal data in "looked" is masked', () => {
    const list = normalizeChecklist({ ...full(CODE_AREAS), security: { status: 'findings', looked: 'The log line prints jane.doe@example.com in clear.' } }, CODE_AREAS, { signOff: true });
    assert.equal(list?.security.looked.includes('jane.doe'), false);
  });
});

describe('guideline trimming', () => {
  test('drops comments, the fill-in notice and headings with nothing under them', () => {
    const template = '# Architecture\n\n> Fill this in. The agents read it.\n\n## System overview\n<!-- What the system does. -->\n\n## Services\nControllers never call repositories directly.\n\n### Detail\n<!-- nothing -->\n\n## Data\n\n### Ownership\nAPP is owned by orders-service.\n\n## Constraints\n<!-- x -->\n';
    assert.equal(compactGuideline(template), '# Architecture\n\n## Services\nControllers never call repositories directly.\n\n## Data\n\n### Ownership\nAPP is owned by orders-service.');
  });

  test('an untouched template has nothing to say', () => {
    assert.equal(compactGuideline('# Coding standards\n\n> Fill this in. Reviews are checked against it.\n\n## Java\n<!-- a -->\n\n## UI\n<!-- b -->\n'), '');
    assert.equal(compactGuideline(''), '');
    assert.equal(compactGuideline('Plain rule with no heading.'), 'Plain rule with no heading.');
  });
});

describe('plan references', () => {
  const PLAN_TEXT = [
    '## Changes',
    'service-api: change `PricingService.price()` in src/main/java/orders/PricingService.java and read the rate from APP.DISCOUNT by `CUSTOMER_ID`.',
    'Add a new file src/main/java/orders/DiscountPolicy.java. Update web/src/orders/OrderForm.tsx and `MAX_DISCOUNT_RATE`.',
    'Do not touch OTHER.TABLE. See `README.md`, `String`, `the order total` and version 2.15.1.',
  ].join('\n');

  test('finds files, code identifiers and tables of the project, and ignores prose', () => {
    const refs = extractReferences(PLAN_TEXT, ['APP', 'COMMON']);
    assert.deepEqual(refs.paths, ['src/main/java/orders/PricingService.java', 'src/main/java/orders/DiscountPolicy.java', 'web/src/orders/OrderForm.tsx', 'README.md']);
    assert.deepEqual(refs.symbols, ['PricingService', 'CUSTOMER_ID', 'MAX_DISCOUNT_RATE']);
    assert.deepEqual(refs.tables, ['APP.DISCOUNT']);
  });

  test('splits acceptance criteria written as a list, numbered or as sentences', () => {
    assert.deepEqual(splitCriteria('1. Loyalty members get a ten percent discount.\n2) Guest orders are unchanged.\n- Totals are rounded to two decimals.'), [
      'Loyalty members get a ten percent discount.', 'Guest orders are unchanged.', 'Totals are rounded to two decimals.',
    ]);
    assert.equal(splitCriteria('<p>Members get a discount.</p> <p>Given a guest order. When priced. Then the total is unchanged.</p>').length >= 2, true);
    assert.deepEqual(splitCriteria(null), []);
    assert.deepEqual(splitCriteria('ok'), []);
  });

  test('flags a criterion the plan does not pick up', () => {
    const criteria = '1. Loyalty members receive the member discount on their order total.\n2. An audit record is written whenever a discount is applied.';
    const coverage = criteriaCoverage(criteria, 'Apply the member discount to the order total for loyalty members in PricingService.');
    assert.equal(coverage[0].inPlan, 'mentioned');
    assert.equal(coverage[1].inPlan, 'not-found');
    assert.ok(coverage[1].missingTerms.includes('audit'));
  });
});

describe('plan facts and commands against real clones', () => {
  const ws = tempWorkspace();
  const W = ['--workspace', ws.root, '--project', 'orders'];
  /** @type {() => void} */
  let restoreGit;
  /** @type {string} */
  let repoPath;
  const PLAN = `# Plan

## Goal
Loyalty members get the member discount on their order total.

## Acceptance criteria
1. Loyalty members receive the member discount on the order total: \`PricingService\`.

## Changes
service-api: src/PricingService.java (apply the discount), and a new file src/DiscountPolicy.java. Uses \`GhostHelper\`.

## Edge cases
Guest orders with no customer; an empty order.

## Tests
A unit test in test/PricingServiceTest.java that fails without the change.

## Risks and rollback
One class. Revert the commit.

## Assumptions and open questions
The rate is fixed. None open.
`;
  const run = async (/** @type {string[]} */ argv) => {
    /** @type {string[]} */
    const out = [];
    const exitCode = await main([...argv, ...W], { env: { AUTODEV_DISABLE_CREDENTIAL_STORE: '1' }, stdout: (text) => { out.push(text); } });
    return { exitCode, envelope: JSON.parse(out[0]) };
  };

  before(async () => {
    restoreGit = setGitEnv(ws.root);
    const dir = writeProject(ws.workspace, fullManifest({ policies: {} }), {
      'guidelines/architecture.md': '# Architecture\n\n## Layering\nControllers never call repositories directly.\n\n## Data\n<!-- empty -->\n',
    });
    repoPath = path.join(dir, 'repos', 'service-api');
    fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoPath, 'test'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'src', 'PricingService.java'), 'class PricingService {\n  int price() { return 1; }\n}\n');
    fs.writeFileSync(path.join(repoPath, 'src', 'CheckoutController.java'), 'class CheckoutController {\n  PricingService pricing;\n  // PricingServiceLegacy is unrelated\n}\n');
    fs.writeFileSync(path.join(repoPath, 'src', 'InvoiceJob.java'), 'class InvoiceJob { void run(PricingService p) {} }\n');
    fs.writeFileSync(path.join(repoPath, 'test', 'PricingServiceTest.java'), 'class PricingServiceTest { PricingService s; }\n');
    await git(['init', '--quiet', '-b', 'release/2.15'], repoPath);
    await git(['add', '-A'], repoPath);
    await git(['commit', '--quiet', '-m', 'base'], repoPath);
    await git(['switch', '--quiet', '-c', 'feature/S-01001-loyalty'], repoPath);
  });
  after(() => {
    restoreGit();
    ws.cleanup();
  });

  test('references are whole-word and include untracked files', async () => {
    fs.writeFileSync(path.join(repoPath, 'src', 'Untracked.java'), 'class Untracked { PricingService x; }\n');
    const hits = await findReferences(repoPath, 'PricingService');
    assert.deepEqual(hits.map((hit) => hit.file).sort(), ['src/CheckoutController.java', 'src/InvoiceJob.java', 'src/PricingService.java', 'src/Untracked.java', 'test/PricingServiceTest.java']);
    assert.deepEqual(hits.find((hit) => hit.file === 'src/CheckoutController.java')?.lines, [2], 'PricingServiceLegacy on line 3 is a different word');
    fs.rmSync(path.join(repoPath, 'src', 'Untracked.java'));
    assert.deepEqual(await findReferences(repoPath, 'bad symbol; rm -rf'), []);
    assert.deepEqual(await findReferences(repoPath, 'NoSuchThing'), []);
  });

  test('plan facts name the callers the plan left out, the files that do not exist and the criteria it skipped', async () => {
    const result = await checkPlanFacts({
      planText: PLAN, schemas: ['APP'], repos: [{ name: 'service-api', path: repoPath }],
      criteriaText: '1. Loyalty members receive the member discount on the order total.\n2. An audit record is written whenever a discount is applied.',
    });
    const file = (/** @type {string} */ named) => result.files.find((entry) => entry.named === named);
    assert.equal(file('src/PricingService.java')?.exists, true);
    assert.deepEqual(file('test/PricingServiceTest.java')?.where, ['service-api:test/PricingServiceTest.java']);
    assert.equal(file('src/DiscountPolicy.java')?.exists, false);
    assert.equal(file('src/DiscountPolicy.java')?.planSaysNew, true);
    const pricing = result.symbols.find((entry) => entry.symbol === 'PricingService');
    assert.deepEqual(pricing?.definedIn, ['service-api:src/PricingService.java']);
    assert.deepEqual(pricing?.referencesNotMentionedInPlan, ['service-api:src/CheckoutController.java:2', 'service-api:src/InvoiceJob.java:1']);
    assert.equal(result.symbols.find((entry) => entry.symbol === 'GhostHelper')?.found, false);
    assert.equal(result.criteria?.[1].inPlan, 'not-found');
    assert.ok(result.attention.some((line) => /GhostHelper/.test(line)));
    assert.ok(result.attention.some((line) => /PricingService is used in 2 file\(s\) the plan does not mention/.test(line)));
    assert.ok(result.attention.some((line) => /Acceptance criterion 2/.test(line)));
    assert.equal(result.attention.some((line) => /DiscountPolicy/.test(line)), false, 'a file the plan calls new is not reported as missing');
    const noCriteria = await checkPlanFacts({ planText: PLAN, repos: [{ name: 'service-api', path: repoPath }] });
    assert.equal(noCriteria.criteria, null);
    assert.ok(noCriteria.attention.some((line) => /no recorded acceptance criteria/.test(line)));
  });

  test('next, context, plan check and code refs work together from the command line', async () => {
    const first = await run(['next', '--story', S]);
    assert.equal(first.envelope.data.next.step, 'read-story');

    await updateRun(ws.workspace, 'orders', S, (state) => {
      state.story = { id: S, title: 'Loyalty discount', releaseBranch: 'release/2.15', acceptanceCriteria: '1. Loyalty members receive the member discount on the order total.', description: 'Long description. '.repeat(50), fetchedAt: '2026-01-01T00:00:00Z' };
    });
    assert.equal((await run(['next', '--story', S])).envelope.data.next.step, 'prepare-repositories');
    await updateRun(ws.workspace, 'orders', S, (state) => {
      Object.assign(repoState(state, 'service-api'), { baseBranch: 'release/2.15', featureBranch: 'feature/S-01001-loyalty' });
    });
    assert.equal((await run(['next', '--story', S])).envelope.data.next.step, 'write-plan');
    assert.equal((await run(['plan', 'check', '--story', S])).envelope.error.code, 'NOT_FOUND');

    const plan = /** @type {any} */ (await submitPlan(ws.workspace, { projectId: 'orders', storyId: S, text: PLAN }));
    const evaluate = (await run(['next', '--story', S])).envelope.data;
    assert.equal(evaluate.next.step, 'evaluate-plan');
    assert.equal(evaluate.next.actor, 'plan-reviewer');
    assert.equal(evaluate.progress.plan, 'not evaluated');

    const check = (await run(['plan', 'check', '--story', S])).envelope.data;
    assert.equal(check.planHash, plan.planHash);
    assert.deepEqual(check.searchedRepositories, ['service-api']);
    assert.ok(check.attention.length >= 2);

    const reviewContext = (await run(['context', '--story', S, '--task', 'plan-review'])).envelope.data;
    assert.equal(reviewContext.plan.verdict, 'not evaluated');
    assert.match(reviewContext.plan.text, /## Edge cases/);
    assert.ok(reviewContext.planFacts.symbols.length > 0, 'the reviewer gets the looked-up facts with the plan');
    assert.deepEqual(Object.keys(reviewContext.checklistAreas), Object.keys(PLAN_AREAS));
    assert.match(reviewContext.story.description, /Long description/);
    assert.deepEqual(reviewContext.guidelines.map((/** @type {any} */ file) => file.content), ['# Architecture\n\n## Layering\nControllers never call repositories directly.']);

    const areas = Object.fromEntries(Object.keys(PLAN_AREAS).map((name) => [name, { status: name === 'tests' ? 'findings' : 'ok', looked: 'Read PricingService and the three files that use it.' }]));
    await reviewPlan(ws.workspace, {
      projectId: 'orders', storyId: S, planHash: plan.planHash, verdict: 'ready', reviewer: 'plan-reviewer', areas,
      findings: [{ priority: 'P2', area: 'tests', title: 'No test for a guest order', detail: 'The plan lists the guest case but plans no test for it.' }, { priority: 'P4', title: 'Name the constant', detail: 'A named constant reads better than a literal.' }],
    });
    const implement = (await run(['next', '--story', S])).envelope.data.next;
    assert.equal(implement.step, 'implement');
    assert.match(implement.details.join(' '), /P2: No test for a guest order/);

    const implementContext = (await run(['context', '--story', S, '--task', 'implement', '--repo', 'service-api'])).envelope.data;
    assert.equal(implementContext.plan.verdict, 'ready');
    assert.deepEqual(implementContext.plan.findingsToAddress.map((/** @type {any} */ finding) => finding.priority), ['P2']);
    assert.equal('description' in implementContext.story, false);
    assert.ok(implementContext.leftOut.some((/** @type {string} */ line) => /story description/.test(line)));
    assert.ok(implementContext.leftOut.some((/** @type {string} */ line) => /1 P3\/P4 finding/.test(line)));
    assert.equal(implementContext.repositories.length, 1);
    assert.equal(implementContext.repositories[0].storyBranch, 'feature/S-01001-loyalty');
    assert.equal(implementContext.next.step, 'implement');
    assert.equal(implementContext.size.overBudget, false);
    assert.ok(implementContext.size.approxTokens > 100);
    assert.equal('planFacts' in implementContext, false);
    const testContext = (await run(['context', '--story', S, '--task', 'test'])).envelope.data;
    assert.equal('text' in testContext.plan, false);

    // The agent edits a file: the next step becomes the tests, then the reviews, then the commit.
    fs.appendFileSync(path.join(repoPath, 'src', 'PricingService.java'), '// discount\n');
    assert.equal((await run(['next', '--story', S])).envelope.data.next.step, 'test');
    const { worktreeTreeId } = await import('../../src/adapters/bitbucket/git.js');
    const treeId = await worktreeTreeId(repoPath);
    await recordGate(ws.workspace, { projectId: 'orders', storyId: S, repo: 'service-api', gate: 'tests', treeId, passed: true, summary: {} });
    assert.equal((await run(['next', '--story', S])).envelope.data.next.step, 'automated-review');
    await recordGate(ws.workspace, { projectId: 'orders', storyId: S, repo: 'service-api', gate: 'automated-review', treeId, passed: true, summary: {} });
    const handOff = (await run(['next', '--story', S])).envelope.data.next;
    assert.equal(handOff.step, 'independent-review');
    assert.equal(handOff.actor, 'code-reviewer');
    assert.deepEqual(Object.keys((await run(['context', '--story', S, '--task', 'review'])).envelope.data.checklistAreas), Object.keys(CODE_AREAS));
    await recordGate(ws.workspace, { projectId: 'orders', storyId: S, repo: 'service-api', gate: 'independent-review', treeId, passed: true, summary: {} });
    assert.equal((await run(['next', '--story', S])).envelope.data.next.step, 'commit');
    await git(['commit', '--quiet', '-am', 'S-01001: discount'], repoPath);
    assert.equal((await run(['next', '--story', S])).envelope.data.next.step, 'open-pull-request');

    const refs = (await run(['code', 'refs', '--symbol', 'PricingService'])).envelope.data;
    assert.equal(refs.files, 4);
    assert.deepEqual(refs.definedIn, ['service-api:src/PricingService.java']);
    assert.equal((await run(['code', 'refs', '--symbol', 'not a symbol'])).envelope.error.code, 'INVALID_ARGUMENT');
    assert.equal((await run(['context', '--story', S, '--task', 'deploy'])).envelope.error.code, 'INVALID_ARGUMENT');
    assert.equal((await run(['context', '--story', S, '--task', 'test', '--repo', 'elsewhere'])).envelope.error.code, 'PROJECT_SCOPE_VIOLATION');
  });

  test('context stays inside its budget by clipping, and says what it left out', () => {
    const manifest = fullManifest({ policies: {} });
    const long = { storyId: S, repos: {}, story: { id: S, title: 't', acceptanceCriteria: 'c', description: 'd'.repeat(40_000) }, plan: { version: 1, hash: 'h', text: 'p'.repeat(40_000), review: null } };
    const bundle = buildContext(ws.workspace, { projectId: 'orders', manifest: /** @type {any} */ ({ ...manifest, tests: { required: ['unit'] }, database: { schemas: ['APP'] } }), run: long, task: 'plan-review', maxChars: 6000 });
    assert.ok(bundle.size.chars < 9000, `bundle was ${bundle.size.chars} characters`);
    assert.match(String(bundle.plan?.text), /more characters not shown/);
    assert.match(String(bundle.story?.description), /more characters not shown/);
    assert.deepEqual([...CONTEXT_TASKS], ['plan', 'plan-review', 'implement', 'test', 'review']);
  });
});
