/**
 * Review checklists.
 *
 * A reviewer signs off by saying, area by area, what it looked at. A verdict
 * that leaves an area out, or marks one as not checked, cannot be a sign-off.
 * This does not make a review good, but it stops a review from being silent
 * about a whole class of problem.
 */

import { AutoDevError, ErrorCodes } from '../core/errors.js';
import { redactString } from '../core/redact.js';

/** What a plan is evaluated for (see the plan-review skill). */
export const PLAN_AREAS = Object.freeze({
  requirements: 'Every acceptance criterion maps to a change and a test; nothing beyond the ticket',
  feasibility: 'Each step can be done as described in this code base; what the plan names exists and behaves as it says',
  'edge-cases': 'Cases the plan does not list: nulls, boundaries, retries, concurrency, partial failure, time, existing data',
  'blast-radius': 'Callers and consumers of what changes, in every repository of the project',
  data: 'Schema, migrations, transactions, destructive statements, safety on existing data',
  security: 'Input validation, authorization, injection, secrets, what is logged',
  tests: 'Each planned test would fail without the change; failure paths and edge cases are covered',
  operations: 'Performance at realistic volume, observability, configuration, deployment order, rollback',
  assumptions: 'Stated assumptions are true; unstated ones are found',
});

/** What a finished change is reviewed for (see the code-review skill). */
export const CODE_AREAS = Object.freeze({
  correctness: 'Does what each acceptance criterion says; null, empty, error and boundary paths',
  security: 'Input validation, authorization, injection, secrets, what is logged',
  standards: 'Layering, naming, exception handling and logging rules from the project guidelines',
  regression: 'Callers and consumers of what changed; behaviour changes tests do not cover',
  performance: 'Queries in loops, missing limits, unbounded collections, blocking calls',
  data: 'Schema or migration changes, destructive statements, unvalidated writes',
  tests: 'Tests exercise the change and its failure cases, and would fail without it',
  plan: 'The change does what the evaluated plan says, including its edge cases and tests',
  scenarios: 'Affected end-to-end scenarios were run; any scenario update is justified by the story',
});

export const AREA_STATUSES = Object.freeze(['ok', 'findings', 'not-applicable', 'not-checked']);

/**
 * Validate a checklist and return it in canonical form.
 * @param {unknown} input { "<area>": { status, looked } }
 * @param {Readonly<Record<string, string>>} areas the areas this kind of review covers
 * @param {{ signOff: boolean }} options when signing off, every area must have been looked at
 */
export function normalizeChecklist(input, areas, options) {
  const names = Object.keys(areas);
  if (input === undefined || input === null) {
    if (!options.signOff) return null;
    throw new AutoDevError(
      ErrorCodes.INVALID_ARGUMENT,
      `A sign-off needs a checklist: for each of ${names.join(', ')}, a status (${AREA_STATUSES.join(', ')}) and what you looked at.`,
      { details: { areas } },
    );
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'The checklist is an object keyed by area name.', { details: { areas } });
  }
  const given = /** @type {Record<string, any>} */ (input);
  const unknown = Object.keys(given).filter((name) => !names.includes(name));
  if (unknown.length > 0) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Unknown checklist area(s): ${unknown.join(', ')}. The areas are: ${names.join(', ')}.`);
  }
  /** @type {Record<string, { status: string, looked: string }>} */
  const checklist = {};
  /** @type {string[]} */
  const problems = [];
  for (const name of names) {
    const entry = given[name];
    if (!entry || typeof entry !== 'object') {
      if (options.signOff) problems.push(`${name}: missing`);
      continue;
    }
    const status = String(entry.status ?? '').toLowerCase();
    const looked = redactString(String(entry.looked ?? '').replace(/\s+/g, ' ').trim(), { pii: true }).slice(0, 600);
    if (!AREA_STATUSES.includes(status)) {
      problems.push(`${name}: status must be one of ${AREA_STATUSES.join(', ')}`);
      continue;
    }
    if (options.signOff && status === 'not-checked') problems.push(`${name}: not checked`);
    else if (status !== 'not-checked' && looked.length < 15) problems.push(`${name}: say what you looked at${status === 'not-applicable' ? ' to decide it does not apply' : ''} (a short sentence)`);
    checklist[name] = { status, looked };
  }
  if (problems.length > 0) {
    throw new AutoDevError(
      ErrorCodes.INVALID_ARGUMENT,
      options.signOff ? 'This cannot be a sign-off: the checklist is incomplete.' : 'The checklist has entries that cannot be read.',
      { details: { problems, areas } },
    );
  }
  return checklist;
}

/**
 * A checklist must agree with the findings: an area marked "ok" cannot be
 * the subject of a blocking finding filed under it.
 * @param {Record<string, { status: string, looked: string }> | null} checklist
 * @param {Array<{ priority: string, area?: string | null }>} findings
 * @param {Readonly<Record<string, string>>} areas
 */
export function assertFindingsHaveAreas(checklist, findings, areas) {
  const names = Object.keys(areas);
  for (const finding of findings) {
    if (finding.area === undefined || finding.area === null) continue;
    if (!names.includes(finding.area)) {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `A finding names the area "${finding.area}", which is not one of: ${names.join(', ')}.`);
    }
    if (checklist?.[finding.area] && checklist[finding.area].status !== 'findings') {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `A finding is filed under "${finding.area}", but the checklist marks that area "${checklist[finding.area].status}". Mark it "findings".`);
    }
  }
}
