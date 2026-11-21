import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import * as gitAdapter from '../../src/adapters/bitbucket/git.js';
import { decideApproval, listApprovals } from '../../src/core/approvals.js';
import { readAudit } from '../../src/core/audit.js';
import { loadManifest } from '../../src/core/manifest.js';
import { resolveInside } from '../../src/core/state-store.js';
import { resolveWorkspace } from '../../src/core/workspace.js';
import { createMockState, startMockServer } from '../../src/mocks/server.js';
import { buildDescription, createPullRequest } from '../../src/workflow/pull-request.js';
import { checkGates, loadRun, recordGate, repoState, REQUIRED_GATES, updateRun } from '../../src/workflow/run-store.js';
import { expectCode, fullManifest, git, makeRemote, removeDir, serviceEnv, setEnv, setGitEnv, tempDir, writeProject } from '../helpers.js';

const P = 'orders';
const STORY = 'S-01001';
const REPO = 'service-api';

/**
 * A workspace with one project, a file remote, a clone on a fresh feature
 * branch and a run record pointing at it. Nothing is committed on the branch.
 * @param {Record<string, any>} [manifestOverrides]
 */
async function setup(manifestOverrides = {}) {
  const root = tempDir('autodev-pr-');
  const restoreGit = setGitEnv(root);
  const server = await startMockServer(createMockState());
  const remote = await makeRemote(root);
  const restoreEnv = setEnv({ ...serviceEnv(server.baseUrl), TEST_SERVICE_API_URL: remote.url });
  const workspace = resolveWorkspace({ workspace: path.join(root, 'ws') });
  writeProject(workspace, fullManifest(manifestOverrides));
  const { manifest, dir } = loadManifest(workspace, P);
  const repo = manifest.repositories[0];
  const repoPath = resolveInside(dir, repo.localPath);
  await gitAdapter.ensureClone({ repoPath, url: gitAdapter.approvedRepoUrl(manifest, repo), name: REPO });
  const branch = await gitAdapter.createFeatureBranch({
    repoPath, name: REPO, baseBranch: 'release/2.15', storyId: STORY, title: 'Apply loyalty discount',
    pattern: manifest.branching.featurePattern, protectedBranches: manifest.branching.protected,
  });
  await updateRun(workspace, P, STORY, (run) => {
    run.story = { id: STORY, title: 'Apply loyalty discount', url: 'https://agility.example.internal/story/1001', dependencies: { upstream: ['S-00999'] } };
    const state = repoState(run, REPO);
    state.baseBranch = 'release/2.15';
    state.featureBranch = branch.branch;
  });
  const input = { projectId: P, manifest, projectDir: dir, storyId: STORY, repoName: REPO };
  return {
    root, server, remote, workspace, manifest, dir, repo, repoPath, branch: branch.branch, input,
    passGates: async () => {
      const treeId = await gitAdapter.worktreeTreeId(repoPath);
      for (const gate of REQUIRED_GATES) {
        await recordGate(workspace, {
          projectId: P, storyId: STORY, repo: REPO, gate, treeId, passed: true,
          summary: gate === 'tests' ? { stages: [{ stage: 'unit', status: 'passed', junit: { tests: 3, failures: 0, errors: 0, skipped: 1 } }] } : gate === 'automated-review' ? { counts: { blocker: 0, major: 0, minor: 1 } } : { verdict: 'pass', reviewer: 'code-reviewer', notes: 'ok' },
        });
      }
      return treeId;
    },
    commit: (/** @type {string} */ message = `${STORY}: change`) =>
      gitAdapter.commitAll({ repoPath, name: REPO, message, storyId: STORY, protectedBranches: manifest.branching.protected }),
    remoteHeads: async () => (await git(['ls-remote', '--heads', remote.url])).stdout,
    cleanup: async () => {
      await server.close();
      restoreEnv();
      restoreGit();
      removeDir(root);
    },
  };
}

describe('pull-request: gating order against the mock and a file remote', () => {
  /** @type {Awaited<ReturnType<typeof setup>>} */
  let ctx;
  /** @type {string} */
  let approvalId;
  before(async () => { ctx = await setup(); });
  after(async () => { await ctx?.cleanup(); });

  const nothingWritten = async () => {
    assert.equal(ctx.server.state.pullRequests.length, 0, 'no PR may exist yet');
    assert.ok(!(await ctx.remoteHeads()).includes('feature/'), 'the feature branch must not be pushed yet');
  };

  test('a repository that is not part of the project is refused', async () => {
    await expectCode(() => createPullRequest(ctx.workspace, { ...ctx.input, repoName: 'someone-elses-repo' }), 'PROJECT_SCOPE_VIOLATION');
  });

  test('a story with no prepared feature branch is refused', async () => {
    await expectCode(() => createPullRequest(ctx.workspace, { ...ctx.input, storyId: 'S-00002' }), 'GATE_FAILED', /No feature branch/);
  });

  test('1. uncommitted changes block the PR (even if gates passed for that tree)', async () => {
    fs.writeFileSync(path.join(ctx.repoPath, 'src', 'app.js'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(ctx.repoPath, 'src', 'new-file.js'), 'export const b = 1;\n');
    await ctx.passGates();
    const error = await expectCode(() => createPullRequest(ctx.workspace, ctx.input), 'GATE_FAILED', /uncommitted/);
    assert.ok(error.details.changes.length >= 2);
    await nothingWritten();
    assert.equal(listApprovals(ctx.workspace, P).length, 0);
  });

  test('2. committed code with a missing gate is blocked and the blocker is named', async () => {
    // Wipe the recorded gates, then commit.
    await updateRun(ctx.workspace, P, STORY, (run) => { repoState(run, REPO).gates = {}; });
    const commit = await ctx.commit();
    assert.equal(commit.committed, true);
    const error = await expectCode(() => createPullRequest(ctx.workspace, ctx.input), 'GATE_FAILED', /required checks/);
    assert.deepEqual(error.details.blockers.map((/** @type {any} */ b) => b.gate), [...REQUIRED_GATES]);
    await nothingWritten();
    assert.equal(readAudit(ctx.workspace, P, { action: 'bitbucket.pr.blocked' }).length, 1);
  });

  test('2b. a failed independent review blocks the PR', async () => {
    const treeId = await ctx.passGates();
    await recordGate(ctx.workspace, { projectId: P, storyId: STORY, repo: REPO, gate: 'independent-review', treeId, passed: false, summary: { verdict: 'fail' } });
    const error = await expectCode(() => createPullRequest(ctx.workspace, ctx.input), 'GATE_FAILED');
    assert.deepEqual(error.details.blockers, [{ gate: 'independent-review', reason: 'Did not pass.' }]);
  });

  test('3. gates that passed for an earlier tree are stale after a new commit', async () => {
    await ctx.passGates();
    fs.appendFileSync(path.join(ctx.repoPath, 'src', 'app.js'), '// changed after review\n');
    await ctx.commit(`${STORY}: sneak in a change after review`);
    const error = await expectCode(() => createPullRequest(ctx.workspace, ctx.input), 'GATE_FAILED');
    assert.equal(error.details.blockers.length, 3);
    assert.ok(error.details.blockers.every((/** @type {any} */ b) => /earlier version/.test(b.reason)));
    await nothingWritten();
    assert.equal(listApprovals(ctx.workspace, P).length, 0, 'no approval may be requested for ungated code');
  });

  test('being on a different branch than the story branch is refused', async () => {
    await ctx.passGates();
    await git(['switch', '--quiet', '-c', 'feature/other-work'], ctx.repoPath);
    try {
      await expectCode(() => createPullRequest(ctx.workspace, ctx.input), 'GATE_FAILED', /not the story branch/);
    } finally {
      await git(['switch', '--quiet', ctx.branch], ctx.repoPath);
    }
  });

  test('dry run reports the PR it would create, writes nothing and creates no approval', async () => {
    const dry = await createPullRequest(ctx.workspace, { ...ctx.input, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.wouldCreate.sourceBranch, ctx.branch);
    assert.equal(dry.wouldCreate.targetBranch, 'release/2.15');
    await nothingWritten();
    assert.equal(listApprovals(ctx.workspace, P).length, 0);
  });

  test('4. with gates green the PR still needs approval; nothing is pushed while pending', async () => {
    const error = await expectCode(() => createPullRequest(ctx.workspace, ctx.input), 'APPROVAL_REQUIRED');
    approvalId = error.details.approvalId;
    assert.match(approvalId, /^apr-/);
    await nothingWritten();
    const pending = listApprovals(ctx.workspace, P, { status: 'pending' });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].action, 'bitbucket.createPullRequest');
  });

  test('asking again while pending does not create a second approval', async () => {
    const again = await expectCode(() => createPullRequest(ctx.workspace, ctx.input), 'APPROVAL_REQUIRED');
    assert.equal(again.details.approvalId, approvalId);
    assert.equal(listApprovals(ctx.workspace, P).length, 1);
  });

  test('passing the pending approval id explicitly is still APPROVAL_REQUIRED', async () => {
    await expectCode(() => createPullRequest(ctx.workspace, { ...ctx.input, approvalId }), 'APPROVAL_REQUIRED');
    await nothingWritten();
  });

  test('an approval cannot be applied to different PR content (changed title)', async () => {
    await decideApproval(ctx.workspace, { projectId: P, id: approvalId, decision: 'approved', decidedBy: 'tester' });
    await expectCode(() => createPullRequest(ctx.workspace, { ...ctx.input, approvalId, title: `${STORY}: something else entirely` }), 'APPROVAL_MISMATCH');
    await nothingWritten();
  });

  test('5. after approval the branch is pushed and the PR opened into the release branch', async () => {
    const pr = await createPullRequest(ctx.workspace, { ...ctx.input, approvalId });
    assert.equal(pr.created, true);
    assert.equal(pr.approvalId, approvalId);
    assert.equal(pr.sourceBranch, ctx.branch);
    assert.equal(pr.targetBranch, 'release/2.15');
    assert.equal(ctx.server.state.pullRequests.length, 1);
    const created = ctx.server.state.pullRequests[0];
    assert.equal(created.key, 'ORD');
    assert.equal(created.slug, REPO);
    assert.equal(created.fromRef.id, `refs/heads/${ctx.branch}`);
    assert.equal(created.toRef.id, 'refs/heads/release/2.15');
    assert.match(created.description, /S-01001/);
    assert.match(created.description, /Test evidence/);
    assert.match(created.description, /unit: passed \(3 tests, 0 failed, 1 skipped\)/);
    assert.match(created.description, /src\/app\.js/);
    assert.match(created.description, /Upstream stories: S-00999/);
    assert.ok((await ctx.remoteHeads()).includes(`refs/heads/${ctx.branch}`));
    const run = loadRun(ctx.workspace, P, STORY);
    assert.equal(run.repos[REPO].pr.created, true);
    assert.equal(run.repos[REPO].pr.id, '1');
    assert.equal(readAudit(ctx.workspace, P, { action: 'bitbucket.pr.created' }).length, 1);
  });

  test('the remote release and main branches were not moved by the push', async () => {
    const heads = await ctx.remoteHeads();
    const sha = (/** @type {string} */ name) => heads.split('\n').find((line) => line.endsWith(`refs/heads/${name}`))?.split('\t')[0];
    assert.equal(sha('main'), sha('release/2.15'));
    assert.notEqual(sha(ctx.branch), sha('main'));
  });

  test('a spent approval cannot be reused and no second PR appears', async () => {
    await expectCode(() => createPullRequest(ctx.workspace, { ...ctx.input, approvalId }), 'APPROVAL_REQUIRED', /consumed/);
    assert.equal(ctx.server.state.pullRequests.length, 1);
  });

  test('the token never appears in the audit log or run state', () => {
    const state = fs.readdirSync(ctx.workspace.stateDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))
      .join('\n');
    assert.ok(!state.includes('test-bitbucket-token-1'));
  });
});

describe('pull-request: no API token', () => {
  /** @type {Awaited<ReturnType<typeof setup>>} */
  let ctx;
  before(async () => {
    ctx = await setup({ policies: { createPR: 'allowed' } });
    fs.writeFileSync(path.join(ctx.repoPath, 'src', 'app.js'), 'export const a = 3;\n');
    await ctx.passGates();
    await ctx.commit();
  });
  after(async () => { await ctx?.cleanup(); });

  test('a protected feature branch name in run state is refused before any push', async () => {
    await git(['switch', '--quiet', '-c', 'release/9.9'], ctx.repoPath);
    await updateRun(ctx.workspace, P, STORY, (run) => { repoState(run, REPO).featureBranch = 'release/9.9'; });
    try {
      await expectCode(() => createPullRequest(ctx.workspace, ctx.input), 'POLICY_PROHIBITED');
      assert.ok(!(await ctx.remoteHeads()).includes('release/9.9'));
    } finally {
      await git(['switch', '--quiet', ctx.branch], ctx.repoPath);
      await updateRun(ctx.workspace, P, STORY, (run) => { repoState(run, REPO).featureBranch = ctx.branch; });
    }
  });

  test('without a token the branch is pushed and a manual PR URL is returned instead of a PR', async () => {
    const env = { ...process.env };
    delete env.TEST_BITBUCKET_TOKEN;
    const pr = await createPullRequest(ctx.workspace, { ...ctx.input, env });
    assert.equal(pr.created, false);
    assert.equal(pr.id, null);
    assert.equal(pr.url, null);
    assert.match(pr.reason, /AUTH_REQUIRED/);
    assert.ok(pr.manualUrl.startsWith(`${ctx.server.baseUrl}/projects/ORD/repos/${REPO}/pull-requests?create`));
    assert.ok(pr.manualUrl.includes(`sourceBranch=refs/heads/${encodeURIComponent(ctx.branch)}`));
    assert.ok(pr.manualUrl.includes(`targetBranch=refs/heads/${encodeURIComponent('release/2.15')}`));
    assert.ok(pr.title && pr.description, 'the prepared title and description are returned for the user to paste');
    assert.equal(ctx.server.state.pullRequests.length, 0);
    assert.ok((await ctx.remoteHeads()).includes(`refs/heads/${ctx.branch}`));
    assert.equal(loadRun(ctx.workspace, P, STORY).repos[REPO].pr.created, false);
  });

  test('a branch with no changes against its base has nothing to open a PR for', async () => {
    const empty = await gitAdapter.createFeatureBranch({
      repoPath: ctx.repoPath, name: REPO, baseBranch: 'release/2.15', storyId: 'S-00003', title: 'empty',
      pattern: ctx.manifest.branching.featurePattern, protectedBranches: ctx.manifest.branching.protected,
    });
    await updateRun(ctx.workspace, P, 'S-00003', (run) => {
      const state = repoState(run, REPO);
      state.baseBranch = 'release/2.15';
      state.featureBranch = empty.branch;
    });
    const treeId = await gitAdapter.headTreeId(ctx.repoPath);
    for (const gate of REQUIRED_GATES) await recordGate(ctx.workspace, { projectId: P, storyId: 'S-00003', repo: REPO, gate, treeId, passed: true, summary: {} });
    assert.equal(checkGates(loadRun(ctx.workspace, P, 'S-00003'), REPO, treeId).ok, true);
    await expectCode(() => createPullRequest(ctx.workspace, { ...ctx.input, storyId: 'S-00003' }), 'GATE_FAILED', /no changes/);
  });
});

describe('pull-request: buildDescription', () => {
  const diff = { totals: { files: 1, added: 2, deleted: 1 }, files: [{ path: 'src/a.js', added: 2, deleted: 1 }] };
  const run = (/** @type {Record<string, any>} */ story, /** @type {Record<string, any>} */ gates = {}) => ({
    storyId: 'S-1', story, repos: { api: { baseBranch: 'release/1', featureBranch: 'feature/S-1-x', gates }, web: {} },
  });

  test('personal data and secrets are masked in the description', () => {
    const text = buildDescription(run({ title: 'Fix login for jane.doe@example.com' }), 'api', /** @type {any} */ (diff), { risks: 'password=hunter2hunter2 leaked in logs' });
    assert.ok(!text.includes('jane.doe@example.com'));
    assert.ok(!text.includes('hunter2hunter2'));
    assert.match(text, /\[REDACTED:email\]/);
  });

  test('missing evidence is stated as not recorded, never invented', () => {
    const text = buildDescription(run({}), 'api', /** @type {any} */ (diff), {});
    assert.match(text, /No stage results recorded/);
    assert.match(text, /Automated checks: not recorded/);
    assert.match(text, /Independent review: not recorded/);
    assert.match(text, /Related changes for this story in: web/);
    assert.match(text, /Not merged or deployed automatically/);
  });

  test('binary files and long file lists are summarised', () => {
    const files = Array.from({ length: 45 }, (_, i) => ({ path: `f${i}.bin`, added: null, deleted: null }));
    const text = buildDescription(run({}), 'api', /** @type {any} */ ({ totals: { files: 45, added: 0, deleted: 0 }, files }), {});
    assert.match(text, /`f0\.bin` \(\+bin \/ -bin\)/);
    assert.match(text, /and 5 more/);
    assert.ok(!text.includes('f44.bin'));
  });
});
