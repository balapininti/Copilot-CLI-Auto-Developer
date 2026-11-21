/**
 * Local git operations for project repositories.
 *
 * Guarantees:
 *   - clones come only from URLs on the project's approved hosts
 *   - an existing clone is reused only if its origin is the approved URL
 *   - uncommitted work is never overwritten: no reset, no clean, no checkout
 *     over a dirty tree, no force push
 *   - the story's release branch must exist on the remote; there is no silent
 *     fallback to a default branch
 *   - commits and pushes never target a protected branch
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AutoDevError, ErrorCodes } from '../../core/errors.js';
import { runChecked, runCommand } from '../../core/exec.js';
import { isMissing } from '../../core/manifest.js';

const GIT_TIMEOUT_MS = 5 * 60_000;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/**
 * @param {string[]} args
 * @param {string | undefined} cwd
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv, what?: string }} [options]
 */
function git(args, cwd, options = {}) {
  return runChecked('git', args, {
    cwd,
    timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
    // Never block on a terminal credential prompt; a missing credential fails fast.
    env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: '0' },
    what: options.what ?? `git ${args[0]}`,
  });
}

/**
 * @param {string} name
 * @param {string} [label]
 * @returns {string}
 */
export function assertBranchName(name, label = 'branch name') {
  if (
    typeof name !== 'string' ||
    !BRANCH_NAME.test(name) ||
    name.includes('..') ||
    name.includes('//') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.endsWith('.lock')
  ) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Invalid ${label}: "${name}".`);
  }
  return name;
}

/**
 * Parse a remote URL into host and path. Supports https, ssh:// and the
 * scp-like git@host:path form; file URLs only when explicitly enabled for
 * local tests and demos.
 * @param {string} url
 * @returns {{ protocol: string, host: string, path: string }}
 */
export function parseRemoteUrl(url) {
  const value = String(url ?? '').trim();
  const scp = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/\/)([^\s]+)$/.exec(value);
  if (scp && !/^[A-Za-z]:[\\/]/.test(value)) return { protocol: 'ssh:', host: scp[1].toLowerCase(), path: clean(scp[2]) };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new AutoDevError(ErrorCodes.REPO_URL_NOT_APPROVED, 'Repository URL is not a valid https, ssh or git@host:path URL.');
  }
  if (parsed.password || (parsed.username && parsed.protocol !== 'ssh:')) {
    throw new AutoDevError(ErrorCodes.REPO_URL_NOT_APPROVED, 'Repository URLs must not embed credentials.');
  }
  return { protocol: parsed.protocol, host: parsed.hostname.toLowerCase(), path: clean(parsed.pathname) };

  /** @param {string} p */
  function clean(p) {
    return p.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
  }
}

/**
 * @param {string} url
 * @param {string[]} allowedHosts
 * @param {NodeJS.ProcessEnv} [env]
 */
export function validateRepoUrl(url, allowedHosts, env = process.env) {
  const remote = parseRemoteUrl(url);
  if (remote.protocol === 'file:') {
    if (env.AUTODEV_ALLOW_FILE_REMOTES !== '1') {
      throw new AutoDevError(ErrorCodes.REPO_URL_NOT_APPROVED, 'Local file remotes are only allowed in tests and demos.');
    }
    return remote;
  }
  if (remote.protocol !== 'https:' && remote.protocol !== 'ssh:') {
    throw new AutoDevError(ErrorCodes.REPO_URL_NOT_APPROVED, `Repository protocol ${remote.protocol} is not permitted. Use https or ssh.`);
  }
  if (!allowedHosts.map((host) => host.toLowerCase()).includes(remote.host)) {
    throw new AutoDevError(
      ErrorCodes.REPO_URL_NOT_APPROVED,
      `Repository host "${remote.host}" is not listed in bitbucket.allowedHosts.`,
      { details: { host: remote.host, allowedHosts } },
    );
  }
  return remote;
}

/**
 * @param {string} a
 * @param {string} b
 */
export function sameRemote(a, b) {
  const left = parseRemoteUrl(a);
  const right = parseRemoteUrl(b);
  return left.host === right.host && left.path === right.path;
}

/**
 * The approved URL for a repository, from the environment variable the
 * manifest names.
 * @param {Record<string, any>} manifest
 * @param {Record<string, any>} repo manifest repository entry
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function approvedRepoUrl(manifest, repo, env = process.env) {
  if (isMissing(repo.urlEnv)) {
    throw new AutoDevError(ErrorCodes.NOT_CONFIGURED, `Repository "${repo.name}" has no urlEnv in project.yaml.`, {
      details: { repository: repo.name },
    });
  }
  const url = env[repo.urlEnv]?.trim();
  if (!url) {
    throw new AutoDevError(ErrorCodes.NOT_CONFIGURED, `Environment variable ${repo.urlEnv} (URL of "${repo.name}") is not set.`, {
      details: { repository: repo.name, envName: repo.urlEnv },
    });
  }
  validateRepoUrl(url, manifest.bitbucket.allowedHosts, env);
  return url;
}

/**
 * @param {string} repoPath
 */
export async function inspectRepo(repoPath) {
  if (!fs.existsSync(repoPath)) return { exists: false, isRepo: false };
  const probe = await runCommand('git', ['rev-parse', '--show-toplevel'], { cwd: repoPath });
  const top = probe.stdout.trim();
  const isRepo = probe.exitCode === 0 && top !== '' && fs.realpathSync(top) === fs.realpathSync(repoPath);
  if (!isRepo) return { exists: true, isRepo: false, empty: fs.readdirSync(repoPath).length === 0 };

  const status = (await git(['status', '--porcelain=v1', '--untracked-files=all'], repoPath)).stdout;
  const changes = status.split('\n').filter((line) => line.length > 0);
  const branch = (await runCommand('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repoPath })).stdout.trim();
  const head = (await runCommand('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: repoPath })).stdout.trim();
  const origin = (await runCommand('git', ['remote', 'get-url', 'origin'], { cwd: repoPath })).stdout.trim();
  return {
    exists: true,
    isRepo: true,
    dirty: changes.length > 0,
    changes: changes.slice(0, 200),
    currentBranch: branch || null,
    headSha: head || null,
    originUrl: origin || null,
  };
}

/**
 * Make sure a usable clone exists: reuse a valid one, otherwise clone from the
 * approved URL. Existing local changes are reported, never touched.
 * @param {{ repoPath: string, url: string, name: string, dryRun?: boolean }} input
 */
export async function ensureClone(input) {
  const state = await inspectRepo(input.repoPath);

  if (state.isRepo) {
    if (!state.originUrl || !sameRemote(state.originUrl, input.url)) {
      throw new AutoDevError(
        ErrorCodes.REPO_URL_NOT_APPROVED,
        `The existing clone of "${input.name}" points at a different remote than the approved URL. It was left untouched.`,
        { details: { repository: input.name } },
      );
    }
    if (input.dryRun) return { repository: input.name, action: 'would-reuse', dirty: state.dirty, changes: state.changes };
    // Fetch updates remote-tracking refs only; the working tree is not modified.
    await git(['fetch', '--prune', 'origin'], input.repoPath, { what: `git fetch (${input.name})` });
    return { repository: input.name, action: 'reused', dirty: state.dirty, changes: state.changes, currentBranch: state.currentBranch };
  }

  if (state.exists && !state.empty) {
    throw new AutoDevError(
      ErrorCodes.CONFLICT,
      `The folder for "${input.name}" exists, is not a git clone and is not empty. It was left untouched.`,
      { details: { repository: input.name } },
    );
  }
  if (input.dryRun) return { repository: input.name, action: 'would-clone', dirty: false, changes: [] };
  fs.mkdirSync(path.dirname(input.repoPath), { recursive: true });
  await git(['clone', '--origin', 'origin', '--', input.url, input.repoPath], undefined, {
    timeoutMs: 20 * 60_000,
    what: `git clone (${input.name})`,
  });
  return { repository: input.name, action: 'cloned', dirty: false, changes: [] };
}

/**
 * Decide the base branch for a story. The story's own release branch wins. A
 * repository default is used only when the repository's policy allows it.
 * @param {Record<string, any>} repo manifest repository entry
 * @param {{ releaseBranch?: string | null, id?: string }} story
 * @returns {{ branch: string, source: string }}
 */
export function resolveBaseBranch(repo, story) {
  if (story.releaseBranch) return { branch: assertBranchName(story.releaseBranch, 'release branch'), source: 'story' };
  if (repo.branchPolicy === 'default-release-branch-allowed' && !isMissing(repo.defaultReleaseBranch)) {
    return { branch: assertBranchName(repo.defaultReleaseBranch, 'release branch'), source: 'repository default (allowed by branchPolicy)' };
  }
  throw new AutoDevError(
    ErrorCodes.BRANCH_MISSING,
    `Story ${story.id ?? ''} does not name a release branch, and "${repo.name}" requires one. Ask which release branch to use; do not assume the default branch.`.replace('  ', ' '),
    { details: { repository: repo.name, branchPolicy: repo.branchPolicy } },
  );
}

/**
 * Confirm the release branch exists on the remote (after a fetch).
 * @param {string} repoPath
 * @param {string} branch
 * @returns {Promise<string>} commit SHA of origin/<branch>
 */
export async function verifyReleaseBranch(repoPath, branch) {
  assertBranchName(branch, 'release branch');
  const result = await runCommand('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`], { cwd: repoPath });
  const sha = result.stdout.trim();
  if (result.exitCode !== 0 || !sha) {
    throw new AutoDevError(
      ErrorCodes.BRANCH_MISSING,
      `Release branch "${branch}" does not exist on the remote. This is a blocker; the default branch will not be used instead.`,
      { details: { branch } },
    );
  }
  return sha;
}

/**
 * @param {string} text
 */
export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/**
 * @param {string} pattern e.g. "feature/{storyId}-{slug}"
 * @param {string} storyId
 * @param {string} title
 */
export function featureBranchName(pattern, storyId, title) {
  const slug = slugify(title);
  const name = pattern.replaceAll('{storyId}', storyId).replaceAll('{slug}', slug).replace(/-+$/g, '');
  return assertBranchName(name, 'feature branch name');
}

/**
 * @param {string} branch
 * @param {string[]} patterns names or globs such as "release/*"
 */
export function isProtectedBranch(branch, patterns) {
  return patterns.some((pattern) => {
    const regex = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return regex.test(branch);
  });
}

/**
 * @param {string} repoPath
 * @param {string} branch
 */
async function branchExists(repoPath, branch) {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const result = await runCommand('git', ['show-ref', '--verify', '--quiet', ref], { cwd: repoPath });
    if (result.exitCode === 0) return true;
  }
  return false;
}

/**
 * Create a new, uniquely named feature branch from the release branch.
 * @param {{ repoPath: string, name: string, baseBranch: string, storyId: string, title: string, pattern: string, protectedBranches: string[], dryRun?: boolean }} input
 */
export async function createFeatureBranch(input) {
  const state = await inspectRepo(input.repoPath);
  if (!state.isRepo) throw new AutoDevError(ErrorCodes.NOT_FOUND, `No clone of "${input.name}" exists yet.`);
  if (state.dirty) {
    throw new AutoDevError(
      ErrorCodes.DIRTY_WORKTREE,
      `"${input.name}" has uncommitted changes. They were left untouched; commit, stash or move them yourself before a branch is created.`,
      { details: { repository: input.name, changes: state.changes } },
    );
  }
  const baseSha = await verifyReleaseBranch(input.repoPath, input.baseBranch);
  const baseName = featureBranchName(input.pattern, input.storyId, input.title);
  let branch = baseName;
  for (let suffix = 2; await branchExists(input.repoPath, branch); suffix += 1) {
    if (suffix > 50) throw new AutoDevError(ErrorCodes.CONFLICT, `Could not find a free branch name based on "${baseName}".`);
    branch = `${baseName}-${suffix}`;
  }
  if (isProtectedBranch(branch, input.protectedBranches)) {
    throw new AutoDevError(ErrorCodes.POLICY_PROHIBITED, `Feature branch name "${branch}" matches a protected branch pattern.`);
  }
  if (input.dryRun) return { repository: input.name, branch, baseBranch: input.baseBranch, baseSha, created: false, dryRun: true };
  await git(['switch', '--no-track', '-c', branch, `origin/${input.baseBranch}`], input.repoPath, { what: 'git switch -c' });
  return { repository: input.name, branch, baseBranch: input.baseBranch, baseSha, created: true };
}

/**
 * Run `fn` with a throwaway index that mirrors the whole working tree
 * (tracked, modified and untracked files, honouring .gitignore). The real
 * index and working tree are not modified.
 * @template T
 * @param {string} repoPath
 * @param {(env: NodeJS.ProcessEnv) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withWorktreeIndex(repoPath, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-index-'));
  const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    const head = await runCommand('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: repoPath });
    if (head.exitCode === 0) await git(['read-tree', 'HEAD'], repoPath, { env });
    await git(['add', '--all', '--', '.'], repoPath, { env });
    return await fn(env);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A fingerprint of everything in the working tree, as a git tree id. It is
 * the same before and after committing identical content, which lets test
 * and review results be tied to exactly the code that ends up in the PR.
 * @param {string} repoPath
 * @returns {Promise<string>}
 */
export function worktreeTreeId(repoPath) {
  return withWorktreeIndex(repoPath, async (env) => (await git(['write-tree'], repoPath, { env })).stdout.trim());
}

/**
 * @param {string} repoPath
 * @returns {Promise<string>}
 */
export async function headTreeId(repoPath) {
  return (await git(['rev-parse', 'HEAD^{tree}'], repoPath)).stdout.trim();
}

/**
 * Everything that differs from the release branch: committed, staged,
 * unstaged and untracked.
 * @param {string} repoPath
 * @param {string} baseBranch
 */
export async function diffAgainstBase(repoPath, baseBranch) {
  await verifyReleaseBranch(repoPath, baseBranch);
  const mergeBase = (await git(['merge-base', `origin/${baseBranch}`, 'HEAD'], repoPath)).stdout.trim();
  return withWorktreeIndex(repoPath, async (env) => {
    const base = ['diff', '--cached', '--no-ext-diff', '--no-color', '--find-renames'];
    const patch = (await runChecked('git', [...base, '--unified=3', mergeBase, '--'], {
      cwd: repoPath,
      env: { ...process.env, ...env },
      maxOutputBytes: 8 * 1024 * 1024,
      redactOutput: false,
    })).stdout;
    const numstat = (await git([...base, '--numstat', mergeBase, '--'], repoPath, { env })).stdout;
    const files = numstat
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [added, deleted, ...rest] = line.split('\t');
        return { path: rest.join('\t'), added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted) };
      });
    return {
      baseBranch,
      mergeBase,
      files,
      totals: {
        files: files.length,
        added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
        deleted: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
      },
      patch,
    };
  });
}

/**
 * Commit all current changes on the feature branch.
 * @param {{ repoPath: string, name: string, message: string, storyId: string, protectedBranches: string[], dryRun?: boolean }} input
 */
export async function commitAll(input) {
  const state = await inspectRepo(input.repoPath);
  if (!state.isRepo) throw new AutoDevError(ErrorCodes.NOT_FOUND, `No clone of "${input.name}" exists.`);
  if (!state.currentBranch) throw new AutoDevError(ErrorCodes.CONFLICT, `"${input.name}" is in a detached HEAD state.`);
  if (isProtectedBranch(state.currentBranch, input.protectedBranches)) {
    throw new AutoDevError(ErrorCodes.POLICY_PROHIBITED, `Refusing to commit on protected branch "${state.currentBranch}".`);
  }
  if (!input.message.includes(input.storyId)) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `The commit message must reference the story (${input.storyId}).`);
  }
  if (!state.dirty) return { repository: input.name, committed: false, reason: 'Nothing to commit.', headSha: state.headSha };
  if (input.dryRun) return { repository: input.name, committed: false, dryRun: true, files: state.changes };
  await git(['add', '--all', '--', '.'], input.repoPath);
  // Hooks and commit signing run as the user has configured them; nothing is bypassed.
  await git(['commit', '-m', input.message], input.repoPath, { what: 'git commit' });
  const headSha = (await git(['rev-parse', 'HEAD'], input.repoPath)).stdout.trim();
  return { repository: input.name, committed: true, headSha, branch: state.currentBranch };
}

/**
 * Push the feature branch. Never forced, never a protected branch.
 * @param {{ repoPath: string, name: string, branch: string, protectedBranches: string[] }} input
 */
export async function pushBranch(input) {
  assertBranchName(input.branch);
  if (isProtectedBranch(input.branch, input.protectedBranches)) {
    throw new AutoDevError(ErrorCodes.POLICY_PROHIBITED, `Refusing to push protected branch "${input.branch}".`);
  }
  await git(['push', '--set-upstream', 'origin', `refs/heads/${input.branch}:refs/heads/${input.branch}`], input.repoPath, {
    what: `git push (${input.name})`,
  });
  return { repository: input.name, pushed: true, branch: input.branch };
}

/**
 * Recent commits, used as leads during incident investigation.
 * @param {string} repoPath
 * @param {{ since?: string, limit?: number, ref?: string }} [options]
 */
export async function recentCommits(repoPath, options = {}) {
  const args = ['log', `--max-count=${Math.min(options.limit ?? 20, 200)}`, '--date=iso-strict', '--pretty=format:%H%x1f%ad%x1f%an%x1f%s'];
  if (options.since) args.push(`--since=${options.since}`);
  if (options.ref) args.push(assertBranchName(options.ref, 'ref'));
  const output = (await git(args, repoPath)).stdout;
  return output
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, date, author, subject] = line.split('\x1f');
      return { sha, date, author, subject };
    });
}
