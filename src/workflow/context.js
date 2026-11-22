/**
 * One compact bundle of what a task needs.
 *
 * Reading the ticket, the guidelines, the plan and the repository state takes
 * several commands, each returning more than the task needs. Everything a
 * model reads stays in its context for the rest of the session, and a
 * smaller model degrades sooner as that fills. This assembles the parts a
 * given task needs, trimmed, inside a size budget, and says what it left out.
 */

import { AutoDevError, ErrorCodes } from '../core/errors.js';
import { loadGuidelines } from '../core/project-context.js';

/** What each task receives. `guidelines` is the task type understood by loadGuidelines. */
const TASKS = Object.freeze({
  plan: { guidelines: 'plan', planText: false, description: true },
  'plan-review': { guidelines: 'plan', planText: true, description: true },
  implement: { guidelines: 'implement', planText: true, description: false },
  test: { guidelines: 'test', planText: false, description: false },
  review: { guidelines: 'review', planText: true, description: false },
});

export const CONTEXT_TASKS = Object.freeze(Object.keys(TASKS));
const DEFAULT_BUDGET = 30_000;
const MIN_BUDGET = 4_000;
const MAX_BUDGET = 120_000;

/**
 * A guideline with the parts nobody wrote removed: comments, the "fill this
 * in" notice, and headings that have nothing under them.
 * @param {string} content
 * @returns {string}
 */
export function compactGuideline(content) {
  const lines = content
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .filter((line) => !/^>\s*Fill this in\b/i.test(line.trim()));
  const level = (/** @type {string} */ line) => /^(#{1,6})\s+\S/.exec(line)?.[1].length ?? 0;
  /** @type {string[]} */
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const own = level(line);
    if (own > 0) {
      // Keep a heading only when something is written under it before the next heading at its level or above.
      let hasText = false;
      for (let ahead = index + 1; ahead < lines.length; ahead += 1) {
        const other = level(lines[ahead]);
        if (other > 0 && other <= own) break;
        if (other === 0 && lines[ahead].trim() !== '') {
          hasText = true;
          break;
        }
      }
      if (!hasText) continue;
    }
    if (line.trim() === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line.trimEnd());
  }
  return out.join('\n').trim();
}

/**
 * @param {string} text
 * @param {number} max
 */
function clip(text, max) {
  if (text.length <= max) return { text, clipped: false };
  return { text: `${text.slice(0, Math.max(0, max - 60)).trimEnd()}\n[… ${text.length - max + 60} more characters not shown]`, clipped: true };
}

/**
 * Assemble the context for one task of one story.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {{ projectId: string, manifest: Record<string, any>, run: Record<string, any>, task: string, repo?: string | null, maxChars?: number | null, next?: unknown, planFacts?: unknown }} input
 */
export function buildContext(workspace, input) {
  const spec = Object.hasOwn(TASKS, input.task) ? TASKS[/** @type {keyof typeof TASKS} */ (input.task)] : null;
  if (!spec) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Unknown task "${input.task}". Use one of: ${CONTEXT_TASKS.join(', ')}.`);
  const budget = Math.min(Math.max(Number(input.maxChars) || DEFAULT_BUDGET, MIN_BUDGET), MAX_BUDGET);
  const { manifest, run } = input;
  /** @type {string[]} */
  const left = [];

  const story = run.story
    ? {
        id: run.story.id,
        title: run.story.title,
        status: run.story.status ?? null,
        releaseBranch: run.story.releaseBranch ?? null,
        acceptanceCriteria: run.story.acceptanceCriteria ?? null,
        ...(spec.description && run.story.description ? { description: clip(String(run.story.description), Math.floor(budget * 0.2)).text } : {}),
        dependencies: run.story.dependencies ?? null,
        readAt: run.story.fetchedAt ?? null,
      }
    : null;
  if (story && !spec.description && run.story.description) left.push('story description (not needed for this task; autodev agility story shows it)');
  if (story && story.acceptanceCriteria === null) left.push('acceptance criteria: none recorded for this story');

  const repositories = manifest.repositories
    .filter((/** @type {any} */ repo) => !input.repo || repo.name === input.repo)
    .map((/** @type {any} */ repo) => {
      const state = run.repos?.[repo.name];
      return {
        name: repo.name,
        type: repo.type ?? null,
        schemas: repo.schemas ?? [],
        configuredTestStages: Object.keys(repo.tests ?? {}),
        ...(state ? { releaseBranch: state.baseBranch, storyBranch: state.featureBranch, pullRequest: state.pr?.url ?? null } : { prepared: false }),
      };
    });

  let plan = null;
  if (run.plan) {
    const current = run.plan.review && run.plan.review.planHash === run.plan.hash ? run.plan.review : null;
    const findings = (current?.findings ?? []).filter((/** @type {any} */ finding) => ['P0', 'P1', 'P2'].includes(finding.priority));
    plan = {
      version: run.plan.version,
      planHash: run.plan.hash,
      verdict: current?.verdict ?? (run.plan.review ? 'changed since evaluation' : 'not evaluated'),
      findingsToAddress: findings,
      notVerifiedByReviewer: current?.notVerified ?? null,
      ...(spec.planText ? { text: clip(run.plan.text, Math.floor(budget * 0.35)).text } : {}),
    };
    if (!spec.planText) left.push('plan text (autodev plan show prints it)');
    const lower = (current?.findings ?? []).length - findings.length;
    if (lower > 0) left.push(`${lower} P3/P4 finding(s) (autodev plan show lists them)`);
  }

  const loaded = loadGuidelines(workspace, input.projectId, spec.guidelines);
  /** @type {Array<{ path: string, kind: string, content: string }>} */
  const guidelines = [];
  /** @type {string[]} */
  const emptyGuidelines = [];
  const perFile = Math.floor((budget * 0.4) / Math.max(1, loaded.files.length));
  for (const file of loaded.files) {
    const compact = file.kind === 'guideline' ? compactGuideline(file.content) : file.content.trim();
    if (!compact) {
      emptyGuidelines.push(file.path);
      continue;
    }
    const clipped = clip(compact, Math.max(1500, perFile));
    if (clipped.clipped) left.push(`rest of ${file.path} (autodev project guidelines --task ${spec.guidelines} has all of it)`);
    guidelines.push({ path: file.path, kind: file.kind, content: clipped.text });
  }

  const bundle = {
    task: input.task,
    storyId: run.storyId,
    project: {
      id: input.projectId,
      schemas: manifest.database?.schemas ?? [],
      requiredTestStages: manifest.tests?.required ?? [],
      securityRestrictions: manifest.securityRestrictions ?? [],
      tech: manifest.tech ?? null,
    },
    story,
    repositories,
    plan,
    ...(input.planFacts ? { planFacts: input.planFacts } : {}),
    guidelines,
    gaps: {
      storyNotRead: story === null,
      emptyGuidelines,
      missingGuidelines: loaded.missing,
      rejectedLearnings: loaded.rejected,
    },
    next: input.next ?? null,
    leftOut: left,
  };
  const chars = JSON.stringify(bundle).length;
  return { ...bundle, size: { chars, approxTokens: Math.round(chars / 4), budgetChars: budget, overBudget: chars > budget } };
}
