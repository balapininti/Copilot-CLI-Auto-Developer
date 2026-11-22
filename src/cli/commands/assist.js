/**
 * Commands that take work off the model: what to do next, one bundle of
 * context for a task, mechanical facts about a plan, and code references.
 */

import fs from 'node:fs';

import * as git from '../../adapters/bitbucket/git.js';
import { listApprovals } from '../../core/approvals.js';
import { AutoDevError, ErrorCodes } from '../../core/errors.js';
import { runCommand } from '../../core/exec.js';
import { resolveInside, safeId } from '../../core/state-store.js';
import { PLAN_AREAS, CODE_AREAS } from '../../workflow/checklist.js';
import { buildContext, CONTEXT_TASKS } from '../../workflow/context.js';
import { nextStep, progress } from '../../workflow/next.js';
import { checkPlan, planReviewRequired } from '../../workflow/plan.js';
import { checkPlanFacts, referencesAcrossRepos } from '../../workflow/plan-check.js';
import { checkGates, loadRun } from '../../workflow/run-store.js';
import { storyOf } from './integrations.js';

/**
 * Clones of the project's repositories that exist on disk.
 * @param {{ manifest: Record<string, any>, dir: string }} project
 * @param {string | null} [only]
 */
function clonesOf(project, only = null) {
  return project.manifest.repositories
    .filter((/** @type {any} */ repo) => !only || repo.name === only)
    .map((/** @type {any} */ repo) => ({ name: repo.name, path: resolveInside(project.dir, repo.localPath) }))
    .filter((/** @type {{ name: string, path: string }} */ repo) => fs.existsSync(repo.path));
}

/**
 * How many files differ from the release branch, counting uncommitted work.
 * Local only: asking what to do next must not need the network.
 * @param {string} repoPath
 * @param {string | null | undefined} baseBranch
 * @param {boolean} dirty
 */
async function changedAgainst(repoPath, baseBranch, dirty) {
  for (const ref of baseBranch ? [`origin/${baseBranch}`, baseBranch] : []) {
    const base = await runCommand('git', ['-C', repoPath, 'merge-base', ref, 'HEAD'], { timeoutMs: 15_000 }).catch(() => null);
    if (!base || base.exitCode !== 0) continue;
    const diff = await runCommand('git', ['-C', repoPath, 'diff', '--name-only', base.stdout.trim(), '--'], { timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 }).catch(() => null);
    if (!diff || diff.exitCode !== 0) continue;
    const tracked = diff.stdout.split('\n').filter(Boolean).length;
    return tracked > 0 ? tracked : dirty ? 1 : 0; // new, untracked files do not show in the diff but are still work
  }
  // The release branch is not known locally. Say there is work, so the gates decide rather than the step being skipped.
  return 1;
}

/**
 * Gather the recorded and on-disk facts nextStep() decides from.
 * @param {import('../main.js').CommandContext} ctx
 * @returns {Promise<{ facts: import('../../workflow/next.js').StoryFacts, run: Record<string, any>, project: ReturnType<import('../main.js').CommandContext['project']> }>}
 */
export async function gatherFacts(ctx) {
  const project = ctx.project();
  const { projectId, manifest, dir } = project;
  const storyId = storyOf(ctx);
  const run = loadRun(ctx.workspace, projectId, storyId);

  /** @type {import('../../workflow/next.js').RepoFacts[]} */
  const repos = [];
  for (const [name, state] of Object.entries(/** @type {Record<string, any>} */ (run.repos ?? {}))) {
    const repo = manifest.repositories.find((/** @type {any} */ candidate) => candidate.name === name);
    if (!repo) continue;
    const repoPath = resolveInside(dir, repo.localPath);
    const status = fs.existsSync(repoPath) ? await git.inspectRepo(repoPath) : { exists: false, isRepo: false };
    /** @type {import('../../workflow/next.js').RepoFacts} */
    const facts = {
      name, prepared: Boolean(state.featureBranch), cloneExists: Boolean(status.isRepo), featureBranch: state.featureBranch ?? null,
      currentBranch: null, dirty: false, changedFiles: 0, worktreeBlockers: [], headBlockers: [], pr: state.pr ?? null,
    };
    if (status.isRepo) {
      const live = /** @type {any} */ (status);
      facts.currentBranch = live.currentBranch ?? null;
      facts.dirty = Boolean(live.dirty);
      facts.changedFiles = await changedAgainst(repoPath, state.baseBranch, facts.dirty);
      facts.worktreeBlockers = checkGates(run, name, await git.worktreeTreeId(repoPath)).blockers;
      try {
        facts.headBlockers = checkGates(run, name, await git.headTreeId(repoPath)).blockers;
      } catch {
        facts.headBlockers = facts.worktreeBlockers; // no commit yet
      }
    }
    repos.push(facts);
  }

  const plan = run.plan ?? null;
  const current = plan?.review && plan.review.planHash === plan.hash ? plan.review : null;
  const titles = (/** @type {string[]} */ priorities) =>
    (current?.findings ?? []).filter((/** @type {any} */ finding) => priorities.includes(finding.priority)).map((/** @type {any} */ finding) => `${finding.priority}: ${finding.title}`);
  /** @type {string[]} */
  const storyGaps = [];
  if (run.story && !run.story.releaseBranch) storyGaps.push('the story names no release branch');
  if (run.story && !run.story.acceptanceCriteria) storyGaps.push('the story has no acceptance criteria');
  return {
    run,
    project,
    facts: {
      storyId,
      storyRead: Boolean(run.story),
      storyGaps,
      projectRepositories: manifest.repositories.map((/** @type {any} */ repo) => repo.name),
      planRequired: planReviewRequired(manifest),
      plan: {
        exists: Boolean(plan),
        evaluated: Boolean(plan?.review),
        stale: Boolean(plan?.review) && !current,
        verdict: current?.verdict ?? null,
        rounds: plan?.rounds ?? 0,
        blocking: titles(['P0', 'P1']),
        shouldFix: titles(['P2']),
      },
      repos,
      learningChecked: Boolean(run.learningCheck),
      pendingApprovals: listApprovals(ctx.workspace, projectId, { status: 'pending' }).map((approval) => ({ id: approval.id, action: approval.action, summary: approval.summary })),
    },
  };
}

/** @type {Record<string, import('../main.js').Command>} */
export const assistCommands = {
  next: {
    summary: 'The one next step for a story: who acts, the command, and why. Worked out from what is recorded, so no step is skipped or repeated.',
    usage: 'next --story <S-01234>',
    run: async (ctx) => {
      const { facts } = await gatherFacts(ctx);
      return { storyId: facts.storyId, next: nextStep(facts), progress: progress(facts), waitingForYou: facts.pendingApprovals ?? [] };
    },
  },

  context: {
    summary: 'One trimmed bundle of what a task needs: ticket, plan and findings, relevant guidelines, repository state and the next step.',
    usage: `context --story <S-01234> --task <${CONTEXT_TASKS.join('|')}> [--repo <name>] [--max-chars 30000]`,
    run: async (ctx) => {
      const { facts, run, project } = await gatherFacts(ctx);
      const task = ctx.need('task');
      const repo = ctx.flags.repo ? safeId(String(ctx.flags.repo), 'repository name') : null;
      if (repo && !project.manifest.repositories.some((/** @type {any} */ candidate) => candidate.name === repo)) {
        throw new AutoDevError(ErrorCodes.PROJECT_SCOPE_VIOLATION, `Repository "${repo}" is not mapped to project "${project.projectId}".`);
      }
      // A reviewer starts from looked-up facts about the plan, not from the plan's own account of the code.
      const planFacts = task === 'plan-review' && run.plan
        ? await checkPlanFacts({ planText: run.plan.text, criteriaText: run.story?.acceptanceCriteria, schemas: project.manifest.database?.schemas ?? [], repos: clonesOf(project) })
        : undefined;
      const bundle = buildContext(ctx.workspace, {
        projectId: project.projectId, manifest: project.manifest, run, task, repo,
        maxChars: ctx.flags['max-chars'] ? Number(ctx.flags['max-chars']) : null,
        next: nextStep(facts), planFacts,
      });
      const checklist = task === 'plan-review' ? PLAN_AREAS : task === 'review' ? CODE_AREAS : null;
      return checklist ? { ...bundle, checklistAreas: checklist } : bundle;
    },
  },

  'plan check': {
    summary: 'Mechanical facts about the plan: do the files and identifiers it names exist, who else uses them, is each acceptance criterion mentioned.',
    usage: 'plan check --story <S-01234>',
    run: async (ctx) => {
      const project = ctx.project();
      const storyId = storyOf(ctx);
      const run = loadRun(ctx.workspace, project.projectId, storyId);
      if (!run.plan) throw new AutoDevError(ErrorCodes.NOT_FOUND, `No plan has been submitted for ${storyId}. Run: autodev plan submit`);
      const repos = clonesOf(project);
      const facts = await checkPlanFacts({ planText: run.plan.text, criteriaText: run.story?.acceptanceCriteria, schemas: project.manifest.database?.schemas ?? [], repos });
      return { storyId, planHash: run.plan.hash, version: run.plan.version, readiness: checkPlan(run), searchedRepositories: repos.map((repo) => repo.name), ...facts };
    },
  },

  'code refs': {
    summary: 'Where an identifier is used across the project\'s repositories (whole-word search). Use it to find callers before changing something.',
    usage: 'code refs --symbol <Identifier> [--repo <name>]',
    run: async (ctx) => {
      const project = ctx.project();
      const symbol = ctx.need('symbol');
      if (!/^[A-Za-z_][A-Za-z0-9_]{1,80}$/.test(symbol)) {
        throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, '--symbol is one identifier: a class, method, function, constant or field name.');
      }
      const repos = clonesOf(project, ctx.flags.repo ? String(ctx.flags.repo) : null);
      if (repos.length === 0) throw new AutoDevError(ErrorCodes.NOT_FOUND, 'No clone to search. Prepare a repository first: autodev repo prepare');
      const references = await referencesAcrossRepos(repos, symbol);
      return {
        symbol,
        searchedRepositories: repos.map((repo) => repo.name),
        definedIn: references.filter((ref) => ref.definesIt).map((ref) => `${ref.repository}:${ref.file}`),
        files: references.length,
        references: references.slice(0, 200).map((ref) => ({ repository: ref.repository, file: ref.file, lines: ref.lines })),
        truncated: references.length > 200,
        note: 'A whole-word text search of tracked and untracked files. It finds uses by name; it does not resolve types, so check a hit before treating it as a caller, and remember uses through reflection or configuration may not show.',
      };
    },
  },
};
