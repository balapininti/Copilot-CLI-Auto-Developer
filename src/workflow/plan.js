/**
 * The implementation plan of a story, and its independent evaluation.
 *
 * Before code is written the author records a plan; a reviewer who did not
 * write it evaluates it against the ticket and the real code and records a
 * verdict with prioritised findings:
 *
 *   P0  blocking: would break production, lose or corrupt data, open a
 *       security hole, or cannot work as described
 *   P1  must fix before implementation: an acceptance criterion or a
 *       realistic case is not handled, or the plan rests on something untrue
 *   P2  should fix: a real weakness with a workable plan around it
 *   P3  worth considering: an improvement, not a defect
 *   P4  optional: style and preference
 *
 * The verdict is bound to the hash of the plan it evaluated. Changing the
 * plan, at any point, makes the evaluation stale. A plan cannot be recorded
 * as ready while a P0 or P1 finding stands, and (unless the project sets
 * policies.planReview to "advisory") nothing is committed and no pull
 * request is opened for a story whose current plan is not ready.
 */

import { appendAudit } from '../core/audit.js';
import { AutoDevError, ErrorCodes } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { containsSecret, redactString } from '../core/redact.js';
import { addHistory, loadRun, updateRun } from './run-store.js';

export const PRIORITIES = Object.freeze(['P0', 'P1', 'P2', 'P3', 'P4']);
export const BLOCKING_PRIORITIES = Object.freeze(['P0', 'P1']);
export const VERDICTS = Object.freeze(['ready', 'not-ready']);

/** Sections a plan must have, so that a reviewer can check each of them. */
export const PLAN_SECTIONS = Object.freeze([
  'Goal',
  'Acceptance criteria',
  'Changes',
  'Edge cases',
  'Tests',
  'Risks and rollback',
  'Assumptions and open questions',
]);

const MAX_PLAN_CHARS = 40_000;
const MIN_PLAN_CHARS = 200;
const MAX_FINDINGS = 60;

/**
 * @param {string} text
 * @returns {string[]} required sections that have no heading in the plan
 */
export function missingSections(text) {
  const headings = [...text.matchAll(/^#{1,4}\s+(.+?)\s*$/gm)].map((match) => match[1].toLowerCase());
  return PLAN_SECTIONS.filter((section) => !headings.some((heading) => heading.startsWith(section.toLowerCase())));
}

/**
 * Record the plan for a story. Replaces any earlier plan and its evaluation.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {{ projectId: string, storyId: string, text: string, dryRun?: boolean }} input
 */
export async function submitPlan(workspace, input) {
  const text = String(input.text ?? '').replace(/\r\n/g, '\n').trim();
  if (text.length < MIN_PLAN_CHARS || text.length > MAX_PLAN_CHARS) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `A plan is ${MIN_PLAN_CHARS} to ${MAX_PLAN_CHARS} characters of Markdown.`);
  }
  const missing = missingSections(text);
  if (missing.length > 0) {
    throw new AutoDevError(
      ErrorCodes.INVALID_ARGUMENT,
      `The plan has no heading for: ${missing.join(', ')}. Every section is required; write "None" with the reason where a section does not apply.`,
      { details: { required: PLAN_SECTIONS, missing } },
    );
  }
  if (containsSecret(text) || redactString(text, { pii: true }) !== text) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'The plan appears to contain a secret or personal data. Describe the data; do not include it.');
  }
  const hash = sha256(text);
  if (input.dryRun) return { dryRun: true, storyId: input.storyId, planHash: hash, sections: PLAN_SECTIONS };

  const result = await updateRun(workspace, input.projectId, input.storyId, (run) => {
    if (run.plan?.hash === hash) return { ...planView(run), unchanged: true };
    const version = (run.plan?.version ?? 0) + 1;
    // The earlier evaluation is kept for the record; it is stale because its planHash no longer matches.
    run.plan = { version, hash, text, submittedAt: new Date().toISOString(), review: run.plan?.review ?? null, rounds: run.plan?.rounds ?? 0 };
    addHistory(run, 'plan-submitted', { version, planHash: hash });
    return { ...planView(run), unchanged: false };
  });
  if (!result.unchanged) {
    await appendAudit(workspace, input.projectId, { action: 'plan.submitted', outcome: 'success', details: { storyId: input.storyId, version: result.version, planHash: hash } });
  }
  return {
    ...result,
    next: result.readiness.ok
      ? 'This plan is already evaluated as ready.'
      : 'Hand the plan to the plan-reviewer agent for an independent evaluation. Do not start implementing until it is recorded as ready and the user has confirmed it.',
  };
}

/**
 * Validate reviewer findings and return them in canonical, masked form.
 * @param {unknown} input
 */
export function normalizeFindings(input) {
  if (!Array.isArray(input) || input.length > MAX_FINDINGS) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Findings are a JSON array of at most ${MAX_FINDINGS} items (an empty array when there are none).`);
  }
  const clean = (/** @type {unknown} */ value, /** @type {number} */ max) => redactString(String(value ?? '').replace(/\s+/g, ' ').trim(), { pii: true }).slice(0, max);
  return input.map((item, index) => {
    const finding = /** @type {Record<string, unknown>} */ (item ?? {});
    const priority = String(finding.priority ?? '').toUpperCase();
    if (!PRIORITIES.includes(priority)) {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `findings[${index}].priority must be one of ${PRIORITIES.join(', ')}.`);
    }
    const title = clean(finding.title, 200);
    const detail = clean(finding.detail, 2000);
    const recommendation = clean(finding.recommendation, 1500);
    const evidence = clean(finding.evidence, 600);
    if (title.length < 5 || detail.length < 10) {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `findings[${index}] needs a title and a detail that says what goes wrong and when.`);
    }
    if (BLOCKING_PRIORITIES.includes(priority) && (recommendation.length < 10 || evidence.length < 5)) {
      // A blocking finding stops the work, so it must be checkable and actionable.
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `findings[${index}] is ${priority}: it needs "evidence" (the file and line, acceptance criterion or fact it rests on) and a "recommendation" (the change to the plan that resolves it).`);
    }
    return { priority, title, detail, evidence: evidence || null, recommendation: recommendation || null };
  }).sort((a, b) => a.priority.localeCompare(b.priority));
}

/**
 * Record the evaluation of the current plan.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {{ projectId: string, storyId: string, planHash: string, verdict: string, reviewer: string, findings: unknown, checked?: string | null, notVerified?: string | null }} input
 */
export async function reviewPlan(workspace, input) {
  if (!VERDICTS.includes(input.verdict)) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `--verdict must be one of: ${VERDICTS.join(', ')}.`);
  const reviewer = String(input.reviewer ?? '').trim();
  if (!reviewer || reviewer.length > 80) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, '--reviewer names who evaluated the plan.');
  if (/^auto-developer$/i.test(reviewer)) {
    throw new AutoDevError(ErrorCodes.POLICY_PROHIBITED, 'The evaluation must be independent: the auto-developer agent cannot sign off its own plan. Use the plan-reviewer agent or a person.');
  }
  const findings = normalizeFindings(input.findings);
  const blocking = findings.filter((finding) => BLOCKING_PRIORITIES.includes(finding.priority));
  if (input.verdict === 'ready' && blocking.length > 0) {
    throw new AutoDevError(
      ErrorCodes.GATE_FAILED,
      `A plan cannot be recorded as ready with ${blocking.length} P0/P1 finding(s). Record "not-ready"; the author revises the plan and it is evaluated again.`,
      { details: { blocking: blocking.map((finding) => `${finding.priority}: ${finding.title}`) } },
    );
  }
  const checked = redactString(String(input.checked ?? '').replace(/\s+/g, ' ').trim(), { pii: true }).slice(0, 2000);
  if (input.verdict === 'ready' && checked.length < 40) {
    // "Looks good" is not an evaluation. A sign-off says what was actually examined.
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'A "ready" verdict needs --checked: what you verified against the ticket and the code (at least a sentence).');
  }
  const notVerified = redactString(String(input.notVerified ?? '').replace(/\s+/g, ' ').trim(), { pii: true }).slice(0, 1000) || null;

  const result = await updateRun(workspace, input.projectId, input.storyId, (run) => {
    if (!run.plan) throw new AutoDevError(ErrorCodes.GATE_FAILED, 'No plan has been submitted for this story. Run: autodev plan submit');
    const given = String(input.planHash ?? '').toLowerCase();
    if (given.length < 12 || !run.plan.hash.startsWith(given)) {
      throw new AutoDevError(ErrorCodes.CONFLICT, 'The plan changed since you read it (or --plan-hash is missing). Read the current plan with "autodev plan show" and evaluate that one.', {
        details: { currentPlanHash: run.plan.hash, version: run.plan.version },
      });
    }
    run.plan.review = {
      verdict: input.verdict,
      planHash: run.plan.hash,
      reviewer,
      findings,
      counts: Object.fromEntries(PRIORITIES.map((priority) => [priority, findings.filter((finding) => finding.priority === priority).length])),
      checked: checked || null,
      notVerified,
      at: new Date().toISOString(),
      round: (run.plan.rounds ?? 0) + 1,
    };
    run.plan.rounds = run.plan.review.round;
    addHistory(run, 'plan-reviewed', { version: run.plan.version, verdict: input.verdict, reviewer, counts: run.plan.review.counts });
    return planView(run);
  });
  await appendAudit(workspace, input.projectId, {
    action: 'plan.reviewed',
    outcome: input.verdict === 'ready' ? 'success' : 'failure',
    details: { storyId: input.storyId, version: result.version, planHash: result.planHash, reviewer, counts: result.review?.counts },
  });
  return result;
}

/**
 * Is the story's current plan evaluated and ready?
 * @param {Record<string, any>} run
 * @returns {{ ok: boolean, blockers: Array<{ gate: string, reason: string }> }}
 */
export function checkPlan(run) {
  const blockers = [];
  const plan = run.plan;
  if (!plan) blockers.push({ gate: 'plan-review', reason: 'No implementation plan has been submitted for this story (autodev plan submit).' });
  else if (!plan.review) blockers.push({ gate: 'plan-review', reason: 'The plan has not been evaluated yet. Hand it to the plan-reviewer agent.' });
  else if (plan.review.planHash !== plan.hash) blockers.push({ gate: 'plan-review', reason: 'The plan was changed after it was evaluated. The current plan needs an evaluation.' });
  else if (plan.review.verdict !== 'ready') blockers.push({ gate: 'plan-review', reason: `The plan was evaluated as not ready (${plan.review.counts.P0} P0, ${plan.review.counts.P1} P1). Revise it and have it evaluated again.` });
  return { ok: blockers.length === 0, blockers };
}

/**
 * Does this project require an evaluated plan before a commit or pull request?
 * @param {Record<string, any>} manifest
 */
export function planReviewRequired(manifest) {
  return manifest.policies?.planReview !== 'advisory';
}

/**
 * @param {Record<string, any>} run
 */
function planView(run) {
  const plan = run.plan;
  return {
    storyId: run.storyId,
    version: plan.version,
    planHash: plan.hash,
    submittedAt: plan.submittedAt,
    review: plan.review && plan.review.planHash === plan.hash ? plan.review : null,
    staleReview: plan.review && plan.review.planHash !== plan.hash ? { verdict: plan.review.verdict, at: plan.review.at } : null,
    readiness: checkPlan(run),
  };
}

/**
 * The current plan, its evaluation and whether work may proceed.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {string} storyId
 */
export function showPlan(workspace, projectId, storyId) {
  const run = loadRun(workspace, projectId, storyId);
  if (!run.plan) throw new AutoDevError(ErrorCodes.NOT_FOUND, `No plan has been submitted for ${storyId}.`);
  return { ...planView(run), text: run.plan.text };
}
