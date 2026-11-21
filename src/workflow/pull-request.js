/**
 * Pull request creation, the last step of the ticket-to-PR workflow.
 *
 * Order of checks, none of which can be skipped by a caller:
 *   1. the work is committed on the story's feature branch
 *   2. tests, automated review and independent review all passed for exactly
 *      the committed code
 *   3. the project's createPR policy (approval of this exact PR content)
 *   4. only then: push the branch and open the PR
 *
 * Nothing here merges or deploys.
 */

import * as bitbucket from '../adapters/bitbucket/api.js';
import * as git from '../adapters/bitbucket/git.js';
import { Actions, enforcePolicy } from '../core/approvals.js';
import { appendAudit } from '../core/audit.js';
import { createTransport } from '../core/auth.js';
import { AutoDevError, ErrorCodes } from '../core/errors.js';
import { envValue } from '../core/manifest.js';
import { redactString } from '../core/redact.js';
import { resolveInside } from '../core/state-store.js';
import { addHistory, checkGates, loadRun, repoState, updateRun } from './run-store.js';

/**
 * @param {Record<string, any>} run
 * @param {string} repoName
 * @param {Awaited<ReturnType<typeof git.diffAgainstBase>>} diff
 * @param {{ risks?: string | null, dependencies?: string | null }} notes
 */
export function buildDescription(run, repoName, diff, notes) {
  const story = run.story ?? {};
  const state = run.repos[repoName];
  const tests = state.gates.tests?.summary ?? {};
  const review = state.gates['independent-review']?.summary ?? {};
  const automated = state.gates['automated-review']?.summary ?? {};
  const otherRepos = Object.keys(run.repos).filter((name) => name !== repoName);
  const lines = [
    `## ${run.storyId}: ${story.title ?? ''}`.trim(),
    story.url ? `Story: ${story.url}` : `Story: ${run.storyId}`,
    '',
    '### Changes in this repository',
    `${diff.totals.files} file(s), +${diff.totals.added} / -${diff.totals.deleted} against \`${state.baseBranch}\`.`,
    ...diff.files.slice(0, 40).map((file) => `- \`${file.path}\` (+${file.added ?? 'bin'} / -${file.deleted ?? 'bin'})`),
    diff.files.length > 40 ? `- … and ${diff.files.length - 40} more` : '',
    '',
    '### Test evidence',
    ...(Array.isArray(tests.stages) && tests.stages.length > 0
      ? tests.stages.map((/** @type {any} */ stage) => `- ${stage.stage}: ${stage.status}${stage.junit ? ` (${stage.junit.tests} tests, ${stage.junit.failures + stage.junit.errors} failed, ${stage.junit.skipped} skipped)` : ''}`)
      : ['- No stage results recorded.']),
    '',
    '### Review',
    `- Automated checks: ${automated.counts ? `${automated.counts.blocker} blocker, ${automated.counts.major} major, ${automated.counts.minor} minor` : 'not recorded'}`,
    `- Independent review: ${review.verdict ?? 'not recorded'}${review.reviewer ? ` by ${review.reviewer}` : ''}${review.notes ? ` – ${review.notes}` : ''}`,
    '',
    '### Dependencies',
    notes.dependencies ? notes.dependencies : otherRepos.length > 0 ? `Related changes for this story in: ${otherRepos.join(', ')}.` : 'None identified.',
    ...(story.dependencies?.upstream?.length ? [`Upstream stories: ${story.dependencies.upstream.join(', ')}`] : []),
    '',
    '### Risks',
    notes.risks ? notes.risks : 'None recorded.',
    '',
    '_Prepared by the auto-developer agent. Not merged or deployed automatically._',
  ];
  return redactString(lines.filter((line) => line !== undefined).join('\n'), { pii: true });
}

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {{ projectId: string, manifest: Record<string, any>, projectDir: string, storyId: string, repoName: string, approvalId?: string | null, dryRun?: boolean, risks?: string | null, dependencies?: string | null, title?: string | null, logger?: import('../core/logger.js').Logger, env?: NodeJS.ProcessEnv }} input
 */
export async function createPullRequest(workspace, input) {
  const { manifest, projectId, storyId, repoName } = input;
  const repo = manifest.repositories.find((/** @type {any} */ candidate) => candidate.name === repoName);
  if (!repo) {
    throw new AutoDevError(ErrorCodes.PROJECT_SCOPE_VIOLATION, `Repository "${repoName}" is not part of project "${projectId}".`);
  }
  const repoPath = resolveInside(input.projectDir, repo.localPath);
  const run = loadRun(workspace, projectId, storyId);
  const state = run.repos[repoName];
  if (!state?.featureBranch || !state.baseBranch) {
    throw new AutoDevError(ErrorCodes.GATE_FAILED, `No feature branch has been prepared for ${repoName} on story ${storyId}. Run: autodev repo prepare`);
  }

  const status = await git.inspectRepo(repoPath);
  if (!status.isRepo) throw new AutoDevError(ErrorCodes.NOT_FOUND, `No clone of "${repoName}" exists.`);
  if (status.currentBranch !== state.featureBranch) {
    throw new AutoDevError(ErrorCodes.GATE_FAILED, `"${repoName}" is on branch "${status.currentBranch}", not the story branch "${state.featureBranch}".`);
  }
  if (status.dirty) {
    throw new AutoDevError(ErrorCodes.GATE_FAILED, `"${repoName}" has uncommitted changes. Commit them (autodev repo commit) so the PR contains exactly what was tested.`, {
      details: { changes: status.changes },
    });
  }
  if (git.isProtectedBranch(state.featureBranch, manifest.branching.protected)) {
    throw new AutoDevError(ErrorCodes.POLICY_PROHIBITED, `"${state.featureBranch}" is a protected branch.`);
  }

  const treeId = await git.headTreeId(repoPath);
  const gates = checkGates(run, repoName, treeId);
  if (!gates.ok) {
    await appendAudit(workspace, projectId, {
      action: 'bitbucket.pr.blocked',
      outcome: 'denied',
      details: { storyId, repository: repoName, blockers: gates.blockers },
    });
    throw new AutoDevError(ErrorCodes.GATE_FAILED, 'The pull request is blocked: required checks have not passed for the committed code.', {
      details: { repository: repoName, blockers: gates.blockers },
    });
  }

  const diff = await git.diffAgainstBase(repoPath, state.baseBranch);
  if (diff.totals.files === 0) {
    throw new AutoDevError(ErrorCodes.GATE_FAILED, `"${repoName}" has no changes against ${state.baseBranch}; there is nothing to open a PR for.`);
  }
  const title = redactString(input.title ?? `${storyId}: ${run.story?.title ?? 'changes'}`, { pii: true }).slice(0, 200);
  const payload = {
    repository: repoName,
    sourceBranch: state.featureBranch,
    targetBranch: state.baseBranch,
    // Shown to the approver: whether the base came from the story or was named by hand.
    targetBranchSource: state.baseBranchSource ?? 'story',
    headSha: status.headSha,
    title,
    description: buildDescription(run, repoName, diff, input),
  };

  const gate = await enforcePolicy(workspace, {
    projectId,
    action: Actions.CREATE_PR,
    policy: manifest.policies.createPR,
    summary: `Push ${state.featureBranch} and open a pull request into ${state.baseBranch} for ${repoName} (${storyId})`,
    payload,
    approvalId: input.approvalId,
    dryRun: input.dryRun,
  });
  if (!gate.proceed) return { dryRun: true, wouldCreate: payload };

  await git.pushBranch({
    repoPath, name: repoName, branch: state.featureBranch, protectedBranches: manifest.branching.protected,
    approvedUrl: git.approvedRepoUrl(manifest, repo, input.env),
  });

  /** @type {Record<string, any>} */
  let pr;
  try {
    const transport = await createTransport('bitbucket', manifest, { projectId, logger: input.logger, env: input.env });
    try {
      pr = await bitbucket.createPullRequest(transport, manifest, repo, payload);
    } finally {
      await transport.close();
    }
  } catch (error) {
    if (!(error instanceof AutoDevError) || (error.code !== ErrorCodes.AUTH_REQUIRED && error.code !== ErrorCodes.NOT_CONFIGURED)) throw error;
    // Without an API token the branch is pushed and the user opens the PR themselves.
    const baseUrl = envValue(manifest.bitbucket.baseUrlEnv, input.env);
    pr = {
      created: false,
      id: null,
      url: null,
      manualUrl: baseUrl && manifest.bitbucket.flavor && manifest.bitbucket.projectKey ? bitbucket.manualPullRequestUrl(manifest, repo, baseUrl, payload) : null,
      reason: `The branch was pushed, but the PR could not be created through the API (${error.code}). Open it with the link, using the prepared title and description.`,
      title: payload.title,
      description: payload.description,
    };
  }

  await updateRun(workspace, projectId, storyId, (current) => {
    repoState(current, repoName).pr = { id: pr.id, url: pr.url ?? pr.manualUrl ?? null, created: pr.created, at: new Date().toISOString(), headSha: status.headSha };
    addHistory(current, 'pr', { repo: repoName, id: pr.id, created: pr.created });
  });
  await appendAudit(workspace, projectId, {
    action: 'bitbucket.pr.created',
    outcome: pr.id ? 'success' : 'info',
    details: { storyId, repository: repoName, prId: pr.id, url: pr.url ?? pr.manualUrl ?? null, approvalId: gate.approvalId, headSha: status.headSha },
  });
  return { ...pr, repository: repoName, sourceBranch: payload.sourceBranch, targetBranch: payload.targetBranch, approvalId: gate.approvalId };
}
