import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import * as gitAdapter from '../../src/adapters/bitbucket/git.js';
import { normalizeStory } from '../../src/adapters/agility/normalize.js';
import { asset } from '../../src/mocks/server.js';
import { expectCode, git, makeRemote, removeDir, setGitEnv, tempDir } from '../helpers.js';

const HOSTS = ['bitbucket.example.internal'];
const PROTECTED = ['main', 'master', 'develop', 'release/*'];
const PATTERN = 'feature/{storyId}-{slug}';

describe('bitbucket git: URL parsing and allowlist', () => {
  test('parseRemoteUrl parses https URLs (port, .git suffix and case are normalised)', () => {
    assert.deepEqual(gitAdapter.parseRemoteUrl('https://Bitbucket.Example.Internal:8443/scm/ORD/Service-API.git'), {
      protocol: 'https:',
      host: 'bitbucket.example.internal',
      path: 'scm/ord/service-api',
    });
    assert.equal(gitAdapter.parseRemoteUrl('  https://h.example/a/b/  ').path, 'a/b');
  });

  test('parseRemoteUrl parses ssh:// URLs with a user and port', () => {
    assert.deepEqual(gitAdapter.parseRemoteUrl('ssh://git@bitbucket.example.internal:7999/ord/service-api.git'), {
      protocol: 'ssh:',
      host: 'bitbucket.example.internal',
      path: 'ord/service-api',
    });
  });

  test('parseRemoteUrl parses the scp-like git@host:path form', () => {
    assert.deepEqual(gitAdapter.parseRemoteUrl('git@bitbucket.example.internal:ord/service-api.git'), {
      protocol: 'ssh:',
      host: 'bitbucket.example.internal',
      path: 'ord/service-api',
    });
    assert.equal(gitAdapter.parseRemoteUrl('bitbucket.example.internal:ord/x').host, 'bitbucket.example.internal');
  });

  test('parseRemoteUrl rejects embedded credentials', async () => {
    await expectCode(() => gitAdapter.parseRemoteUrl('https://user:secret@bitbucket.example.internal/ord/x.git'), 'REPO_URL_NOT_APPROVED', /credentials/);
    await expectCode(() => gitAdapter.parseRemoteUrl('https://token@bitbucket.example.internal/ord/x.git'), 'REPO_URL_NOT_APPROVED', /credentials/);
    await expectCode(() => gitAdapter.parseRemoteUrl('ssh://git:secret@bitbucket.example.internal/ord/x.git'), 'REPO_URL_NOT_APPROVED', /credentials/);
  });

  test('parseRemoteUrl rejects things that are not URLs', async () => {
    for (const bad of ['', '   ', 'not a url', '/just/a/path', null, undefined]) {
      await expectCode(() => gitAdapter.parseRemoteUrl(/** @type {any} */ (bad)), 'REPO_URL_NOT_APPROVED');
    }
  });

  test('a Windows drive path is not mistaken for host:path', () => {
    assert.notEqual(gitAdapter.parseRemoteUrl('C:\\repos\\service-api').protocol, 'ssh:');
    assert.notEqual(gitAdapter.parseRemoteUrl('C:/repos/service-api').protocol, 'ssh:');
  });

  test('validateRepoUrl accepts https, ssh and scp forms on an allowed host (case-insensitive)', () => {
    for (const url of [
      'https://bitbucket.example.internal/scm/ord/service-api.git',
      'https://BITBUCKET.example.internal:8443/scm/ord/service-api.git',
      'ssh://git@bitbucket.example.internal:7999/ord/service-api.git',
      'git@bitbucket.example.internal:ord/service-api.git',
    ]) {
      assert.equal(gitAdapter.validateRepoUrl(url, HOSTS, {}).host, 'bitbucket.example.internal');
    }
    assert.equal(gitAdapter.validateRepoUrl('https://bb.example/x.git', ['BB.Example'], {}).host, 'bb.example');
  });

  test('validateRepoUrl refuses hosts that are not on the allowlist', async () => {
    for (const url of [
      'https://github.com/someone/service-api.git',
      'git@github.com:someone/service-api.git',
      'ssh://git@evil.example/ord/service-api.git',
      'https://bitbucket.example.internal.evil.example/ord/x.git',
      'https://evil.example/bitbucket.example.internal/x.git',
      'https://evilbitbucket.example.internal/ord/x.git',
      'https://sub.bitbucket.example.internal/ord/x.git',
      'https://evil.example\\@bitbucket.example.internal/ord/x.git',
      'https://evil.example#@bitbucket.example.internal/ord/x.git',
      'https://evil.example?@bitbucket.example.internal/ord/x.git',
    ]) {
      await expectCode(() => gitAdapter.validateRepoUrl(url, HOSTS, {}), 'REPO_URL_NOT_APPROVED');
    }
    await expectCode(() => gitAdapter.validateRepoUrl('https://bitbucket.example.internal/x.git', [], {}), 'REPO_URL_NOT_APPROVED');
  });

  test('validateRepoUrl refuses credentials even on an allowed host', async () => {
    await expectCode(() => gitAdapter.validateRepoUrl('https://u:p@bitbucket.example.internal/ord/x.git', HOSTS, {}), 'REPO_URL_NOT_APPROVED');
    await expectCode(() => gitAdapter.validateRepoUrl('https://bitbucket.example.internal@evil.example/x.git', HOSTS, {}), 'REPO_URL_NOT_APPROVED');
    await expectCode(() => gitAdapter.validateRepoUrl('u:p@bitbucket.example.internal:ord/x.git', HOSTS, {}), 'REPO_URL_NOT_APPROVED');
  });

  test('validateRepoUrl refuses other protocols and git transport helpers', async () => {
    for (const url of [
      'http://bitbucket.example.internal/ord/x.git',
      'git://bitbucket.example.internal/ord/x.git',
      'ftp://bitbucket.example.internal/ord/x.git',
      'ext::sh -c "touch pwned"',
      'ext::bitbucket.example.internal',
      'fd::17/foo',
      '--upload-pack=touch pwned',
      '-oProxyCommand=touch${IFS}pwned',
    ]) {
      await expectCode(() => gitAdapter.validateRepoUrl(url, HOSTS, { AUTODEV_ALLOW_FILE_REMOTES: '1' }), 'REPO_URL_NOT_APPROVED');
    }
  });

  test('file remotes are refused unless AUTODEV_ALLOW_FILE_REMOTES=1', async () => {
    const url = pathToFileURL(path.join(tempDirName(), 'x.git')).href;
    await expectCode(() => gitAdapter.validateRepoUrl(url, HOSTS, {}), 'REPO_URL_NOT_APPROVED', /tests and demos/);
    await expectCode(() => gitAdapter.validateRepoUrl(url, HOSTS, { AUTODEV_ALLOW_FILE_REMOTES: 'true' }), 'REPO_URL_NOT_APPROVED');
    assert.equal(gitAdapter.validateRepoUrl(url, HOSTS, { AUTODEV_ALLOW_FILE_REMOTES: '1' }).protocol, 'file:');
  });

  test('sameRemote compares host and path across protocols, case and .git', () => {
    assert.equal(gitAdapter.sameRemote('https://bitbucket.example.internal/ord/service-api.git', 'git@bitbucket.example.internal:ord/service-api'), true);
    assert.equal(gitAdapter.sameRemote('ssh://git@BITBUCKET.example.internal:7999/ORD/Service-Api.git', 'https://bitbucket.example.internal/ord/service-api/'), true);
    assert.equal(gitAdapter.sameRemote('https://bitbucket.example.internal/ord/service-api.git', 'https://bitbucket.example.internal/ord/other.git'), false);
    assert.equal(gitAdapter.sameRemote('https://bitbucket.example.internal/ord/service-api.git', 'https://github.com/ord/service-api.git'), false);
    assert.equal(gitAdapter.sameRemote('https://bitbucket.example.internal/ord/service-api.git', 'https://bitbucket.example.internal/ord/service-api-fork.git'), false);
  });

  test('approvedRepoUrl reads the URL from the env var named in the manifest', async () => {
    const manifest = { bitbucket: { allowedHosts: HOSTS } };
    const repo = { name: 'service-api', urlEnv: 'TEST_REPO_URL' };
    assert.equal(
      gitAdapter.approvedRepoUrl(manifest, repo, { TEST_REPO_URL: ' https://bitbucket.example.internal/ord/service-api.git ' }),
      'https://bitbucket.example.internal/ord/service-api.git',
    );
    const unset = await expectCode(() => gitAdapter.approvedRepoUrl(manifest, repo, {}), 'NOT_CONFIGURED');
    assert.equal(unset.details.envName, 'TEST_REPO_URL');
    await expectCode(() => gitAdapter.approvedRepoUrl(manifest, { name: 'service-api', urlEnv: null }, {}), 'NOT_CONFIGURED');
    await expectCode(() => gitAdapter.approvedRepoUrl(manifest, repo, { TEST_REPO_URL: 'https://github.com/x/y.git' }), 'REPO_URL_NOT_APPROVED');
  });
});

/** A path under the temp folder that is never created. */
function tempDirName() {
  return path.join(path.resolve(process.env.TEMP ?? process.env.TMPDIR ?? path.sep), 'autodev-never-created');
}

describe('bitbucket git: branch names and policies', () => {
  test('assertBranchName accepts ordinary names', () => {
    for (const name of ['main', 'release/2.15', 'feature/S-01001-apply-loyalty-discount', 'hotfix/1.2.3_rc', 'a']) {
      assert.equal(gitAdapter.assertBranchName(name), name);
    }
  });

  test('assertBranchName rejects `-x`, `a..b`, spaces and other hostile names', async () => {
    for (const bad of [
      '-x', '--upload-pack=evil', 'a..b', 'has space', ' main', 'main ', 'a//b', 'trailing/', 'dot.', 'x.lock', '/leading', '.hidden',
      'a~1', 'a^', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a@{1}', 'a\nb', 'a\tb', 'a;rm -rf', '$(id)', '`id`', '', 'x'.repeat(201), null, undefined, 42,
    ]) {
      await expectCode(() => gitAdapter.assertBranchName(/** @type {any} */ (bad)), 'INVALID_ARGUMENT');
    }
  });

  test('isProtectedBranch matches exact names and globs only', () => {
    assert.equal(gitAdapter.isProtectedBranch('main', PROTECTED), true);
    assert.equal(gitAdapter.isProtectedBranch('release/2.15', PROTECTED), true);
    assert.equal(gitAdapter.isProtectedBranch('release/2.15/hotfix', PROTECTED), true);
    assert.equal(gitAdapter.isProtectedBranch('develop', PROTECTED), true);
    for (const branch of ['main2', 'xmain', 'feature/main', 'release', 'releases/1', 'feature/S-1-release/x', 'prerelease/1']) {
      assert.equal(gitAdapter.isProtectedBranch(branch, PROTECTED), false, branch);
    }
    assert.equal(gitAdapter.isProtectedBranch('anything', []), false);
  });

  test('isProtectedBranch treats regex metacharacters in patterns literally', () => {
    assert.equal(gitAdapter.isProtectedBranch('release-1x0', ['release-1.0']), false);
    assert.equal(gitAdapter.isProtectedBranch('release-1.0', ['release-1.0']), true);
    assert.equal(gitAdapter.isProtectedBranch('a+b', ['a+b']), true);
    assert.equal(gitAdapter.isProtectedBranch('aab', ['a+b']), false);
    assert.equal(gitAdapter.isProtectedBranch('hotfix/x/prod', ['hotfix/*/prod']), true);
    assert.equal(gitAdapter.isProtectedBranch('main', ['(main']), false);
  });

  test('resolveBaseBranch: the story release branch always wins', () => {
    const repo = { name: 'r', branchPolicy: 'default-release-branch-allowed', defaultReleaseBranch: 'release/1.0' };
    assert.deepEqual(gitAdapter.resolveBaseBranch(repo, { id: 'S-1', releaseBranch: 'release/2.15' }), { branch: 'release/2.15', source: 'story' });
  });

  test('resolveBaseBranch: the repository default is used only when the policy allows it', async () => {
    const allowed = { name: 'r', branchPolicy: 'default-release-branch-allowed', defaultReleaseBranch: 'release/1.0' };
    const result = gitAdapter.resolveBaseBranch(allowed, { id: 'S-1', releaseBranch: null });
    assert.equal(result.branch, 'release/1.0');
    assert.match(result.source, /repository default/);

    const required = { name: 'r', branchPolicy: 'story-release-branch-required', defaultReleaseBranch: 'release/1.0' };
    const error = await expectCode(() => gitAdapter.resolveBaseBranch(required, { id: 'S-1', releaseBranch: null }), 'BRANCH_MISSING', /S-1/);
    assert.equal(error.details.branchPolicy, 'story-release-branch-required');
    await expectCode(() => gitAdapter.resolveBaseBranch(required, { id: 'S-1', releaseBranch: '' }), 'BRANCH_MISSING');
    await expectCode(() => gitAdapter.resolveBaseBranch({ name: 'r' }, {}), 'BRANCH_MISSING');
  });

  test('resolveBaseBranch: policy allows a default but none is configured -> BRANCH_MISSING', async () => {
    for (const value of [null, undefined, '', 'TODO']) {
      const repo = { name: 'r', branchPolicy: 'default-release-branch-allowed', defaultReleaseBranch: value };
      await expectCode(() => gitAdapter.resolveBaseBranch(repo, { id: 'S-1' }), 'BRANCH_MISSING');
    }
  });

  test('a hostile release branch taken from story text is rejected, not passed to git', async () => {
    const manifest = { agility: { fields: {}, releaseBranchPattern: 'Release branch:\\s*(\\S+)' } };
    const story = normalizeStory(asset('Story:1', { Number: 'S-1', Description: 'Release branch: --upload-pack=touch${IFS}pwned' }), {
      manifest,
      baseUrl: 'https://a.example',
      fetchedVia: 'api',
    });
    assert.equal(story.releaseBranch, '--upload-pack=touch${IFS}pwned');
    await expectCode(() => gitAdapter.resolveBaseBranch({ name: 'r' }, story), 'INVALID_ARGUMENT');
    await expectCode(() => gitAdapter.resolveBaseBranch({ name: 'r', branchPolicy: 'default-release-branch-allowed', defaultReleaseBranch: '-x' }, {}), 'INVALID_ARGUMENT');
  });

  test('slugify and featureBranchName produce safe names from hostile titles', async () => {
    assert.equal(gitAdapter.slugify('Apply loyalty discount when pricing an order'), 'apply-loyalty-discount-when-pricing-an-o');
    assert.equal(gitAdapter.slugify('  "; rm -rf / #  '), 'rm-rf');
    assert.equal(gitAdapter.slugify(null), '');
    assert.equal(gitAdapter.featureBranchName(PATTERN, 'S-01001', 'Fix: the `$(id)` thing..lock'), 'feature/S-01001-fix-the-id-thing-lock');
    assert.equal(gitAdapter.featureBranchName(PATTERN, 'S-01001', ''), 'feature/S-01001');
    assert.equal(gitAdapter.featureBranchName(PATTERN, 'S-01001', '日本語'), 'feature/S-01001');
    await expectCode(() => gitAdapter.featureBranchName(PATTERN, 'S-1 --force', 'x'), 'INVALID_ARGUMENT');
    await expectCode(() => gitAdapter.featureBranchName(PATTERN, '../../x', 'x'), 'INVALID_ARGUMENT');
    await expectCode(() => gitAdapter.featureBranchName('{storyId}', '-D', 'x'), 'INVALID_ARGUMENT');
  });
});

describe('bitbucket git: working with a real clone of a local file remote', () => {
  /** @type {string} */
  let root;
  /** @type {() => void} */
  let restoreEnv;
  /** @type {{ bare: string, url: string, seed: string }} */
  let remote;
  let counter = 0;

  /** A fresh clone path (not yet created). */
  const newRepoPath = () => path.join(root, 'clones', `c${(counter += 1)}`, 'service-api');
  const clone = async () => {
    const repoPath = newRepoPath();
    await gitAdapter.ensureClone({ repoPath, url: remote.url, name: 'service-api' });
    return repoPath;
  };
  /** @param {string} repoPath @param {string} [title] */
  const feature = (repoPath, title = 'Apply loyalty discount') =>
    gitAdapter.createFeatureBranch({
      repoPath, name: 'service-api', baseBranch: 'release/2.15', storyId: 'S-01001', title, pattern: PATTERN, protectedBranches: PROTECTED,
    });
  const remoteHeads = async () => (await git(['ls-remote', '--heads', remote.url])).stdout;

  before(async () => {
    root = tempDir('autodev-git-');
    restoreEnv = setGitEnv(root);
    remote = await makeRemote(root, { 'README.md': '# service\n', 'src/app.js': 'export const a = 1;\n', '.gitignore': 'ignored/\n' });
  });
  after(() => {
    restoreEnv?.();
    removeDir(root);
  });

  test('inspectRepo reports a missing folder and a non-repo folder', async () => {
    assert.deepEqual(await gitAdapter.inspectRepo(path.join(root, 'nope')), { exists: false, isRepo: false });
    const empty = path.join(root, 'empty-dir');
    fs.mkdirSync(empty);
    assert.deepEqual(await gitAdapter.inspectRepo(empty), { exists: true, isRepo: false, empty: true });
  });

  test('ensureClone clones a missing repository from the approved URL', async () => {
    const repoPath = newRepoPath();
    const dry = await gitAdapter.ensureClone({ repoPath, url: remote.url, name: 'service-api', dryRun: true });
    assert.equal(dry.action, 'would-clone');
    assert.equal(fs.existsSync(repoPath), false);

    const result = await gitAdapter.ensureClone({ repoPath, url: remote.url, name: 'service-api' });
    assert.deepEqual(result, { repository: 'service-api', action: 'cloned', dirty: false, changes: [] });
    assert.equal(fs.readFileSync(path.join(repoPath, 'README.md'), 'utf8'), '# service\n');
    const state = await gitAdapter.inspectRepo(repoPath);
    assert.equal(state.isRepo, true);
    assert.equal(state.dirty, false);
    assert.equal(state.currentBranch, 'main');
    assert.match(String(state.headSha), /^[0-9a-f]{40}$/);
    assert.ok(gitAdapter.sameRemote(String(state.originUrl), remote.url));
  });

  test('ensureClone clones into an existing empty folder', async () => {
    const repoPath = newRepoPath();
    fs.mkdirSync(repoPath, { recursive: true });
    assert.equal((await gitAdapter.ensureClone({ repoPath, url: remote.url, name: 'service-api' })).action, 'cloned');
  });

  test('ensureClone reuses a clean clone', async () => {
    const repoPath = await clone();
    const result = await gitAdapter.ensureClone({ repoPath, url: remote.url, name: 'service-api' });
    assert.equal(result.action, 'reused');
    assert.equal(result.dirty, false);
    assert.equal(result.currentBranch, 'main');
    assert.equal((await gitAdapter.ensureClone({ repoPath, url: remote.url, name: 'service-api', dryRun: true })).action, 'would-reuse');
  });

  test('ensureClone reuses a dirty clone and preserves every uncommitted change', async () => {
    const repoPath = await clone();
    fs.writeFileSync(path.join(repoPath, 'src', 'app.js'), 'export const a = 2; // local edit\n');
    fs.writeFileSync(path.join(repoPath, 'untracked.txt'), 'keep me\n');
    fs.writeFileSync(path.join(repoPath, 'staged.txt'), 'staged\n');
    await git(['add', 'staged.txt'], repoPath);
    fs.rmSync(path.join(repoPath, 'README.md'));

    const result = await gitAdapter.ensureClone({ repoPath, url: remote.url, name: 'service-api' });
    assert.equal(result.action, 'reused');
    assert.equal(result.dirty, true);
    assert.equal(result.changes.length, 4);
    assert.equal(fs.readFileSync(path.join(repoPath, 'src', 'app.js'), 'utf8'), 'export const a = 2; // local edit\n');
    assert.equal(fs.readFileSync(path.join(repoPath, 'untracked.txt'), 'utf8'), 'keep me\n');
    assert.equal(fs.existsSync(path.join(repoPath, 'README.md')), false);
    assert.match((await git(['status', '--porcelain'], repoPath)).stdout, /^A {2}staged\.txt$/m);
  });

  test('ensureClone refuses a clone whose origin is a different remote, and leaves it untouched', async () => {
    const repoPath = await clone();
    fs.writeFileSync(path.join(repoPath, 'local.txt'), 'mine\n');
    const other = pathToFileURL(path.join(root, 'remote', 'someone-elses.git')).href;
    const error = await expectCode(() => gitAdapter.ensureClone({ repoPath, url: other, name: 'service-api' }), 'REPO_URL_NOT_APPROVED', /different remote/);
    assert.equal(error.details.repository, 'service-api');
    await expectCode(
      () => gitAdapter.ensureClone({ repoPath, url: 'https://bitbucket.example.internal/ord/service-api.git', name: 'service-api', dryRun: true }),
      'REPO_URL_NOT_APPROVED',
    );
    assert.equal(fs.readFileSync(path.join(repoPath, 'local.txt'), 'utf8'), 'mine\n');
    assert.ok(gitAdapter.sameRemote((await git(['remote', 'get-url', 'origin'], repoPath)).stdout.trim(), remote.url));
  });

  test('ensureClone refuses a clone that has no origin at all', async () => {
    const repoPath = newRepoPath();
    fs.mkdirSync(repoPath, { recursive: true });
    await git(['init', '--quiet', '--initial-branch=main'], repoPath);
    await expectCode(() => gitAdapter.ensureClone({ repoPath, url: remote.url, name: 'service-api' }), 'REPO_URL_NOT_APPROVED');
  });

  test('ensureClone refuses a non-git, non-empty folder and leaves its content alone', async () => {
    const repoPath = newRepoPath();
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'notes.txt'), 'important\n');
    await expectCode(() => gitAdapter.ensureClone({ repoPath, url: remote.url, name: 'service-api' }), 'CONFLICT', /not a git clone and is not empty/);
    await expectCode(() => gitAdapter.ensureClone({ repoPath, url: remote.url, name: 'service-api', dryRun: true }), 'CONFLICT');
    assert.deepEqual(fs.readdirSync(repoPath), ['notes.txt']);
  });

  test('a sub-folder of another clone is not treated as the repository', async () => {
    const outer = await clone();
    const inner = path.join(outer, 'src');
    assert.equal((await gitAdapter.inspectRepo(inner)).isRepo, false);
    await expectCode(() => gitAdapter.ensureClone({ repoPath: inner, url: remote.url, name: 'service-api' }), 'CONFLICT');
  });

  test('verifyReleaseBranch returns the remote commit; a missing branch -> BRANCH_MISSING', async () => {
    const repoPath = await clone();
    assert.match(await gitAdapter.verifyReleaseBranch(repoPath, 'release/2.15'), /^[0-9a-f]{40}$/);
    const error = await expectCode(() => gitAdapter.verifyReleaseBranch(repoPath, 'release/9.9'), 'BRANCH_MISSING', /default branch will not be used/);
    assert.equal(error.details.branch, 'release/9.9');
    await expectCode(() => gitAdapter.verifyReleaseBranch(repoPath, '--help'), 'INVALID_ARGUMENT');
  });

  test('a branch that exists only locally does not count as a release branch', async () => {
    const repoPath = await clone();
    await git(['branch', 'release/local-only'], repoPath);
    await expectCode(() => gitAdapter.verifyReleaseBranch(repoPath, 'release/local-only'), 'BRANCH_MISSING');
  });

  test('createFeatureBranch branches from the release branch without tracking it', async () => {
    const repoPath = await clone();
    const dry = await gitAdapter.createFeatureBranch({
      repoPath, name: 'service-api', baseBranch: 'release/2.15', storyId: 'S-01001', title: 'Apply loyalty discount', pattern: PATTERN, protectedBranches: PROTECTED, dryRun: true,
    });
    assert.equal(dry.created, false);
    assert.equal(dry.dryRun, true);
    assert.equal((await gitAdapter.inspectRepo(repoPath)).currentBranch, 'main');

    const result = await feature(repoPath);
    assert.equal(result.created, true);
    assert.equal(result.branch, 'feature/S-01001-apply-loyalty-discount');
    assert.equal(result.baseBranch, 'release/2.15');
    const state = await gitAdapter.inspectRepo(repoPath);
    assert.equal(state.currentBranch, result.branch);
    assert.equal(state.headSha, result.baseSha);
    const upstream = await git(['config', '--get', `branch.${result.branch}.merge`], repoPath).catch(() => null);
    assert.equal(upstream, null, 'the feature branch must not track the release branch');
  });

  test('createFeatureBranch picks a unique suffix when the name is taken locally or on the remote', async () => {
    const repoPath = await clone();
    const first = await feature(repoPath);
    const second = await feature(repoPath);
    const third = await feature(repoPath);
    assert.deepEqual([first.branch, second.branch, third.branch], [
      'feature/S-01001-apply-loyalty-discount',
      'feature/S-01001-apply-loyalty-discount-2',
      'feature/S-01001-apply-loyalty-discount-3',
    ]);

    // Taken on the remote only.
    await git(['push', '--quiet', 'origin', `${first.branch}:refs/heads/feature/S-01001-remote-only`], repoPath);
    const fresh = await clone();
    const result = await feature(fresh, 'Remote only');
    assert.equal(result.branch, 'feature/S-01001-remote-only-2');
    await git(['push', '--quiet', 'origin', '--delete', 'feature/S-01001-remote-only'], repoPath);
  });

  test('createFeatureBranch refuses a dirty worktree (DIRTY_WORKTREE) and preserves its content', async () => {
    const repoPath = await clone();
    fs.writeFileSync(path.join(repoPath, 'src', 'app.js'), 'export const a = 42;\n');
    fs.writeFileSync(path.join(repoPath, 'new-file.txt'), 'untracked work\n');
    const error = await expectCode(() => feature(repoPath), 'DIRTY_WORKTREE', /left untouched/);
    assert.equal(error.details.changes.length, 2);
    assert.equal(fs.readFileSync(path.join(repoPath, 'src', 'app.js'), 'utf8'), 'export const a = 42;\n');
    assert.equal(fs.readFileSync(path.join(repoPath, 'new-file.txt'), 'utf8'), 'untracked work\n');
    assert.equal((await gitAdapter.inspectRepo(repoPath)).currentBranch, 'main');
    assert.doesNotMatch((await git(['branch', '--list'], repoPath)).stdout, /feature\//);
  });

  test('createFeatureBranch: an untracked file alone also counts as dirty', async () => {
    const repoPath = await clone();
    fs.writeFileSync(path.join(repoPath, 'scratch.txt'), 'x\n');
    await expectCode(() => feature(repoPath), 'DIRTY_WORKTREE');
  });

  test('createFeatureBranch refuses a missing release branch, a missing clone and a protected result', async () => {
    const repoPath = await clone();
    const input = { repoPath, name: 'service-api', baseBranch: 'release/2.15', storyId: 'S-01001', title: 't', pattern: PATTERN, protectedBranches: PROTECTED };
    await expectCode(() => gitAdapter.createFeatureBranch({ ...input, baseBranch: 'release/9.9' }), 'BRANCH_MISSING');
    await expectCode(() => gitAdapter.createFeatureBranch({ ...input, repoPath: path.join(root, 'no-such-clone') }), 'NOT_FOUND');
    await expectCode(() => gitAdapter.createFeatureBranch({ ...input, pattern: 'release/{storyId}' }), 'POLICY_PROHIBITED');
    await expectCode(() => gitAdapter.createFeatureBranch({ ...input, storyId: '-D main' }), 'INVALID_ARGUMENT');
    assert.equal((await gitAdapter.inspectRepo(repoPath)).currentBranch, 'main');
  });

  test('commitAll refuses to commit on a protected branch', async () => {
    const repoPath = await clone();
    fs.writeFileSync(path.join(repoPath, 'src', 'app.js'), 'export const a = 3;\n');
    const head = (await gitAdapter.inspectRepo(repoPath)).headSha;
    await expectCode(
      () => gitAdapter.commitAll({ repoPath, name: 'service-api', message: 'S-01001: change', storyId: 'S-01001', protectedBranches: PROTECTED }),
      'POLICY_PROHIBITED',
      /protected branch "main"/,
    );
    await git(['switch', '--quiet', '-c', 'release/2.15', 'origin/release/2.15'], repoPath);
    await expectCode(
      () => gitAdapter.commitAll({ repoPath, name: 'service-api', message: 'S-01001: change', storyId: 'S-01001', protectedBranches: PROTECTED }),
      'POLICY_PROHIBITED',
    );
    const state = await gitAdapter.inspectRepo(repoPath);
    assert.equal(state.headSha, head);
    assert.equal(state.dirty, true);
  });

  test('commitAll refuses a message that does not reference the story id', async () => {
    const repoPath = await clone();
    const { branch } = await feature(repoPath);
    fs.writeFileSync(path.join(repoPath, 'src', 'app.js'), 'export const a = 3;\n');
    await expectCode(
      () => gitAdapter.commitAll({ repoPath, name: 'service-api', message: 'fix pricing', storyId: 'S-01001', protectedBranches: PROTECTED }),
      'INVALID_ARGUMENT',
      /S-01001/,
    );
    await expectCode(
      () => gitAdapter.commitAll({ repoPath, name: 'service-api', message: 'S-01002: wrong story', storyId: 'S-01001', protectedBranches: PROTECTED }),
      'INVALID_ARGUMENT',
    );
    assert.equal((await git(['rev-list', '--count', `origin/release/2.15..${branch}`], repoPath)).stdout.trim(), '0');
  });

  test('commitAll commits tracked, untracked and deleted files; dry-run and no-op are reported', async () => {
    const repoPath = await clone();
    const { branch } = await feature(repoPath);
    const input = { repoPath, name: 'service-api', message: 'S-01001: apply loyalty discount', storyId: 'S-01001', protectedBranches: PROTECTED };

    const nothing = await gitAdapter.commitAll(input);
    assert.equal(nothing.committed, false);
    assert.match(String(nothing.reason), /Nothing to commit/);

    fs.writeFileSync(path.join(repoPath, 'src', 'app.js'), 'export const a = 3;\n');
    fs.writeFileSync(path.join(repoPath, 'src', 'new.js'), 'export const b = 1;\n');
    fs.rmSync(path.join(repoPath, 'README.md'));

    const dry = await gitAdapter.commitAll({ ...input, dryRun: true });
    assert.equal(dry.committed, false);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.files?.length, 3);
    assert.equal((await gitAdapter.inspectRepo(repoPath)).dirty, true);

    const result = await gitAdapter.commitAll(input);
    assert.equal(result.committed, true);
    assert.equal(result.branch, branch);
    assert.match(String(result.headSha), /^[0-9a-f]{40}$/);
    assert.equal((await gitAdapter.inspectRepo(repoPath)).dirty, false);
    const names = (await git(['show', '--name-status', '--pretty=format:%s', 'HEAD'], repoPath)).stdout;
    assert.match(names, /^S-01001: apply loyalty discount/);
    assert.match(names, /D\tREADME\.md/);
    assert.match(names, /A\tsrc\/new\.js/);
    assert.match(names, /M\tsrc\/app\.js/);
  });

  test('commitAll refuses a detached HEAD', async () => {
    const repoPath = await clone();
    await git(['switch', '--quiet', '--detach', 'origin/release/2.15'], repoPath);
    fs.writeFileSync(path.join(repoPath, 'x.txt'), 'x\n');
    await expectCode(
      () => gitAdapter.commitAll({ repoPath, name: 'service-api', message: 'S-01001: x', storyId: 'S-01001', protectedBranches: PROTECTED }),
      'CONFLICT',
      /detached/,
    );
  });

  test('pushBranch refuses protected branches and invalid names; nothing reaches the remote', async () => {
    const repoPath = await clone();
    const before = await remoteHeads();
    for (const branch of ['main', 'release/2.15', 'develop']) {
      await expectCode(() => gitAdapter.pushBranch({ repoPath, name: 'service-api', branch, protectedBranches: PROTECTED }), 'POLICY_PROHIBITED', /protected/);
    }
    for (const branch of ['--force', '+main', 'main:refs/heads/main', 'feature/x y', '--delete']) {
      await expectCode(() => gitAdapter.pushBranch({ repoPath, name: 'service-api', branch, protectedBranches: PROTECTED }), 'INVALID_ARGUMENT');
    }
    assert.equal(await remoteHeads(), before);
  });

  test('pushBranch pushes a feature branch to the same name on the remote', async () => {
    const repoPath = await clone();
    const { branch } = await feature(repoPath, 'Push me');
    fs.writeFileSync(path.join(repoPath, 'pushed.txt'), 'x\n');
    const commit = await gitAdapter.commitAll({ repoPath, name: 'service-api', message: 'S-01001: push me', storyId: 'S-01001', protectedBranches: PROTECTED });
    const result = await gitAdapter.pushBranch({ repoPath, name: 'service-api', branch, protectedBranches: PROTECTED });
    assert.deepEqual(result, { repository: 'service-api', pushed: true, branch });
    assert.match(await remoteHeads(), new RegExp(`^${commit.headSha}\\trefs/heads/${branch}$`, 'm'));
  });

  test('pushBranch never forces: a diverged remote branch is not overwritten', async () => {
    const one = await clone();
    const { branch } = await feature(one, 'Diverge');
    fs.writeFileSync(path.join(one, 'one.txt'), '1\n');
    const first = await gitAdapter.commitAll({ repoPath: one, name: 'service-api', message: 'S-01001: one', storyId: 'S-01001', protectedBranches: PROTECTED });
    await gitAdapter.pushBranch({ repoPath: one, name: 'service-api', branch, protectedBranches: PROTECTED });

    const two = await clone();
    await git(['switch', '--quiet', '--no-track', '-c', branch, 'origin/release/2.15'], two);
    fs.writeFileSync(path.join(two, 'two.txt'), '2\n');
    await gitAdapter.commitAll({ repoPath: two, name: 'service-api', message: 'S-01001: two', storyId: 'S-01001', protectedBranches: PROTECTED });
    await expectCode(() => gitAdapter.pushBranch({ repoPath: two, name: 'service-api', branch, protectedBranches: PROTECTED }), 'UPSTREAM_ERROR');
    assert.match(await remoteHeads(), new RegExp(`^${first.headSha}\\trefs/heads/${branch}$`, 'm'));
  });

  test('worktreeTreeId equals headTreeId for a clean tree and after committing the same content', async () => {
    const repoPath = await clone();
    assert.equal(await gitAdapter.worktreeTreeId(repoPath), await gitAdapter.headTreeId(repoPath));

    await feature(repoPath, 'Tree ids');
    fs.writeFileSync(path.join(repoPath, 'src', 'app.js'), 'export const a = 7;\n');
    fs.writeFileSync(path.join(repoPath, 'src', 'added.js'), 'export const c = 1;\n');
    const before = await gitAdapter.worktreeTreeId(repoPath);
    assert.match(before, /^[0-9a-f]{40}$/);
    assert.notEqual(before, await gitAdapter.headTreeId(repoPath));
    await gitAdapter.commitAll({ repoPath, name: 'service-api', message: 'S-01001: tree ids', storyId: 'S-01001', protectedBranches: PROTECTED });
    assert.equal(await gitAdapter.headTreeId(repoPath), before);
    assert.equal(await gitAdapter.worktreeTreeId(repoPath), before);
  });

  test('worktreeTreeId changes when a tracked file changes, an untracked file appears or a file is deleted', async () => {
    const repoPath = await clone();
    const clean = await gitAdapter.worktreeTreeId(repoPath);

    fs.writeFileSync(path.join(repoPath, 'src', 'app.js'), 'export const a = 2;\n');
    const modified = await gitAdapter.worktreeTreeId(repoPath);
    assert.notEqual(modified, clean);

    fs.writeFileSync(path.join(repoPath, 'untracked.js'), 'export const u = 1;\n');
    const withUntracked = await gitAdapter.worktreeTreeId(repoPath);
    assert.notEqual(withUntracked, modified);

    fs.rmSync(path.join(repoPath, 'README.md'));
    const withDeletion = await gitAdapter.worktreeTreeId(repoPath);
    assert.notEqual(withDeletion, withUntracked);

    // Restoring the exact content restores the id.
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# service\n');
    fs.rmSync(path.join(repoPath, 'untracked.js'));
    fs.writeFileSync(path.join(repoPath, 'src', 'app.js'), 'export const a = 1;\n');
    assert.equal(await gitAdapter.worktreeTreeId(repoPath), clean);
  });

  test('worktreeTreeId ignores .gitignore-d files and what is or is not staged', async () => {
    const repoPath = await clone();
    const clean = await gitAdapter.worktreeTreeId(repoPath);
    fs.mkdirSync(path.join(repoPath, 'ignored'));
    fs.writeFileSync(path.join(repoPath, 'ignored', 'build.log'), 'noise\n');
    assert.equal(await gitAdapter.worktreeTreeId(repoPath), clean);

    fs.writeFileSync(path.join(repoPath, 'src', 'app.js'), 'export const a = 5;\n');
    const unstaged = await gitAdapter.worktreeTreeId(repoPath);
    await git(['add', 'src/app.js'], repoPath);
    assert.equal(await gitAdapter.worktreeTreeId(repoPath), unstaged);
  });

  test('worktreeTreeId does not modify the real index or the working tree', async () => {
    const repoPath = await clone();
    fs.writeFileSync(path.join(repoPath, 'src', 'app.js'), 'export const a = 9;\n');
    fs.writeFileSync(path.join(repoPath, 'untracked.txt'), 'u\n');
    const before = (await git(['status', '--porcelain=v1', '--untracked-files=all'], repoPath)).stdout;
    await gitAdapter.worktreeTreeId(repoPath);
    assert.equal((await git(['status', '--porcelain=v1', '--untracked-files=all'], repoPath)).stdout, before);
    assert.equal((await git(['diff', '--cached', '--name-only'], repoPath)).stdout, '');
  });

  test('diffAgainstBase covers committed, unstaged and untracked changes without staging anything', async () => {
    const repoPath = await clone();
    await feature(repoPath, 'Diff');
    fs.writeFileSync(path.join(repoPath, 'committed.txt'), 'c\n');
    await gitAdapter.commitAll({ repoPath, name: 'service-api', message: 'S-01001: committed', storyId: 'S-01001', protectedBranches: PROTECTED });
    fs.writeFileSync(path.join(repoPath, 'src', 'app.js'), 'export const a = 1;\nexport const z = 26;\n');
    fs.writeFileSync(path.join(repoPath, 'untracked.txt'), 'u\n');

    const diff = await gitAdapter.diffAgainstBase(repoPath, 'release/2.15');
    assert.equal(diff.baseBranch, 'release/2.15');
    assert.deepEqual(diff.files.map((file) => file.path).sort(), ['committed.txt', 'src/app.js', 'untracked.txt']);
    assert.deepEqual(diff.totals, { files: 3, added: 3, deleted: 0 });
    assert.match(diff.patch, /\+export const z = 26;/);
    assert.match(diff.patch, /\+\+\+ b\/untracked\.txt/);
    assert.equal((await git(['diff', '--cached', '--name-only'], repoPath)).stdout, '');
    await expectCode(() => gitAdapter.diffAgainstBase(repoPath, 'release/9.9'), 'BRANCH_MISSING');
  });

  test('recentCommits lists commits and validates the ref', async () => {
    const repoPath = await clone();
    const commits = await gitAdapter.recentCommits(repoPath, { limit: 5 });
    assert.equal(commits.length, 1);
    assert.equal(commits[0].subject, 'Initial commit');
    assert.equal(commits[0].author, 'Auto Developer Test');
    assert.match(commits[0].sha, /^[0-9a-f]{40}$/);
    await expectCode(() => gitAdapter.recentCommits(repoPath, { ref: '--output=pwned.txt' }), 'INVALID_ARGUMENT');
    assert.equal(fs.existsSync(path.join(repoPath, 'pwned.txt')), false);
  });
});
