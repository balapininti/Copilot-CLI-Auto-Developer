/**
 * Read-only discovery for assisted onboarding.
 *
 * A person points the onboarding agent at material that already exists on the
 * machine: clones of the project's repositories, an older skill or prompt
 * file, a team wiki export. This module turns that into facts an agent can
 * build onboarding answers from, without guessing:
 *
 *   - for every git clone found: its name, where it was cloned from, its
 *     build tool, versions and the test commands that tool implies;
 *   - for every text file found: the hosts of the URLs it mentions, with a
 *     hint about which system each one looks like.
 *
 * It never changes anything, never contacts a remote, and never returns a
 * credential: user names and passwords embedded in URLs are removed, and
 * query strings are dropped.
 */

import fs from 'node:fs';
import path from 'node:path';

import { detectBuild } from '../adapters/java/detect.js';
import { AutoDevError, ErrorCodes } from '../core/errors.js';
import { runCommand } from '../core/exec.js';
import { redactString } from '../core/redact.js';

const MAX_PATHS = 20;
const MAX_DEPTH = 4;
const MAX_REPOS = 50;
const MAX_FILES = 300;
const MAX_FILE_BYTES = 512 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'dist', 'out', '.gradle', '.idea', '.vscode', 'bin', 'obj', '.venv', 'venv', '__pycache__']);
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.yaml', '.yml', '.json', '.properties', '.toml', '.ini', '.cfg', '.conf', '.env.example', '.xml', '.ps1', '.sh', '.cmd', '.bat']);

/**
 * Which system a host or URL looks like. A hint for the agent, not a fact.
 * @param {string} host
 * @param {string} pathname
 */
export function classifyUrl(host, pathname) {
  const text = `${host}${pathname}`.toLowerCase();
  if (/bitbucket|\/scm\/|stash\./.test(text)) return 'bitbucket';
  if (/agility|versionone|\/rest-1\.v1|\/teamroom/.test(text)) return 'agility';
  if (/splunk|\/services\/search/.test(text)) return 'splunk';
  if (/dynatrace|\/api\/v2\/(problems|metrics|entities)/.test(text)) return 'dynatrace';
  if (/github\.com|gitlab|dev\.azure\.com/.test(text)) return 'other-git-host';
  if (/login\.|sso\.|adfs|okta|auth\.|\/oauth2?\/|\/saml/.test(text)) return 'identity-provider';
  return 'unknown';
}

/**
 * A clone URL with any embedded credentials removed.
 * @param {string} raw
 * @returns {{ url: string | null, host: string | null, credentialsRemoved: boolean }}
 */
export function sanitizeRemote(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { url: null, host: null, credentialsRemoved: false };
  const scp = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+):(?!\/\/)([^\s]+)$/.exec(value);
  if (scp && !/^[A-Za-z]:[\\/]/.test(value)) return { url: value, host: scp[2].toLowerCase(), credentialsRemoved: false };
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'file:') return { url: null, host: null, credentialsRemoved: false };
    const hadCredentials = Boolean(parsed.password) || (Boolean(parsed.username) && parsed.protocol !== 'ssh:');
    if (hadCredentials) {
      parsed.username = '';
      parsed.password = '';
    }
    parsed.search = '';
    parsed.hash = '';
    return { url: parsed.href, host: parsed.hostname.toLowerCase(), credentialsRemoved: hadCredentials };
  } catch {
    return { url: null, host: null, credentialsRemoved: false };
  }
}

/** @param {string} name */
function envNameFor(name) {
  return `${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}_REPO_URL`;
}

/**
 * @param {string} repoPath
 * @param {string[]} args
 */
async function git(repoPath, args) {
  try {
    const result = await runCommand('git', ['-C', repoPath, ...args], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
    return result.exitCode === 0 ? result.stdout.trim() : '';
  } catch {
    return '';
  }
}

/**
 * @param {string} repoPath
 */
async function describeRepository(repoPath) {
  const remote = sanitizeRemote(await git(repoPath, ['remote', 'get-url', 'origin']));
  const fromRemote = remote.url ? remote.url.replace(/\/+$/, '').replace(/\.git$/i, '').split(/[/:]/).pop() : null;
  const name = String(fromRemote || path.basename(repoPath)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  /** @type {Record<string, any>} */
  let build = { tool: 'unknown', defaults: {} };
  try {
    build = detectBuild(repoPath, 'win32'); // the framework runs on Windows: suggest the Windows form of each command
  } catch {
    // an unreadable build file is reported as an unknown build tool
  }
  const springBoot = build.springBootVersion ?? null;
  const type = build.tool === 'maven' || build.tool === 'gradle' ? (springBoot ? 'java-spring' : 'other') : build.tool === 'npm' ? 'ui' : null;
  return {
    path: repoPath,
    name,
    remote: remote.url,
    host: remote.host,
    credentialsRemovedFromRemote: remote.credentialsRemoved,
    currentBranch: (await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])) || null,
    buildTool: build.tool ?? 'unknown',
    javaVersion: build.javaVersion ?? null,
    springBootVersion: springBoot,
    suggestedType: type,
    suggestedTests: build.defaults ?? {},
    suggestedUrlEnv: envNameFor(name),
  };
}

/**
 * Discover repositories and referenced hosts under the given paths.
 * @param {string[]} inputPaths files or folders the person named
 */
export async function scanSources(inputPaths) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0 || inputPaths.length > MAX_PATHS) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Give 1 to ${MAX_PATHS} --path values: files or folders to read.`);
  }
  /** @type {string[]} */
  const repoDirs = [];
  /** @type {string[]} */
  const textFiles = [];
  /** @type {string[]} */
  const notFound = [];
  let truncated = false;

  /** @param {string} file */
  const considerFile = (file) => {
    const lower = path.basename(file).toLowerCase();
    const known = TEXT_EXTENSIONS.has(path.extname(lower)) || lower === 'readme' || lower.endsWith('.env.example');
    if (!known || /^\.env(\.|$)/.test(lower) && !lower.endsWith('.example')) return; // real .env files hold secrets; never read
    if (textFiles.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    textFiles.push(file);
  };
  /** @param {string} dir @param {number} depth */
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const isRepo = entries.some((entry) => entry.name === '.git');
    if (isRepo) {
      if (repoDirs.length >= MAX_REPOS) truncated = true;
      else repoDirs.push(dir);
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        // Inside a clone, only top-level documents describe the project; the rest is its source.
        if (!isRepo || depth >= 0) considerFile(full);
      } else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && depth < MAX_DEPTH && !isRepo) {
        walk(full, depth + 1);
      } else if (entry.isDirectory() && isRepo && ['docs', 'doc', '.github'].includes(entry.name) && depth < MAX_DEPTH) {
        walk(full, depth + 1);
      }
    }
  };

  for (const input of inputPaths) {
    const resolved = path.resolve(String(input));
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      notFound.push(resolved);
      continue;
    }
    if (stat.isDirectory()) walk(resolved, 0);
    else if (stat.isFile()) considerFile(resolved);
  }
  if (notFound.length === inputPaths.length) {
    throw new AutoDevError(ErrorCodes.NOT_FOUND, 'None of the given paths exist.', { details: { notFound } });
  }

  const repositories = [];
  for (const dir of repoDirs) repositories.push(await describeRepository(dir));

  /** @type {Map<string, { host: string, looksLike: string, example: string, seenIn: Set<string>, mentions: number }>} */
  const hosts = new Map();
  /** @type {Array<{ file: string, bytes: number, urls: number }>} */
  const documents = [];
  for (const file of textFiles) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      documents.push({ file, bytes: stat.size, urls: -1 });
      continue;
    }
    const content = fs.readFileSync(file, 'utf8');
    let count = 0;
    for (const match of content.matchAll(/https?:\/\/[^\s"'<>`)\]}]+/g)) {
      let url;
      try {
        url = new URL(match[0]);
      } catch {
        continue;
      }
      const host = url.hostname.toLowerCase();
      if (!host.includes('.') || /^(localhost|127\.|example\.|www\.w3\.org|schemas\.|maven\.apache\.org|json-schema\.org)/.test(host)) continue;
      count += 1;
      const firstSegments = url.pathname.split('/').filter(Boolean).slice(0, 3).join('/');
      const entry = hosts.get(host) ?? {
        host,
        looksLike: classifyUrl(host, url.pathname),
        // Origin and the start of the path only: no credentials, no query, no deep identifiers.
        example: redactString(`${url.protocol}//${url.host}${firstSegments ? `/${firstSegments}` : ''}`),
        seenIn: new Set(),
        mentions: 0,
      };
      if (entry.looksLike === 'unknown') entry.looksLike = classifyUrl(host, url.pathname);
      entry.mentions += 1;
      if (entry.seenIn.size < 3) entry.seenIn.add(file);
      hosts.set(host, entry);
    }
    documents.push({ file, bytes: stat.size, urls: count });
  }

  const withRemote = repositories.filter((repo) => repo.remote);
  return {
    repositories,
    hosts: [...hosts.values()].sort((a, b) => b.mentions - a.mentions).slice(0, 60).map((entry) => ({ ...entry, seenIn: [...entry.seenIn] })),
    documents: documents.sort((a, b) => b.urls - a.urls).slice(0, 100),
    notFound,
    truncated,
    // A starting point for the answers file. Every value here was read from the machine; nothing is inferred beyond the naming.
    suggestedAnswers: {
      repositories: withRemote.map((repo) => `${repo.name}=${repo.suggestedUrlEnv}`).join(', '),
      repositoryDetails: Object.fromEntries(
        withRemote.map((repo) => [repo.name, { ...(repo.suggestedType ? { type: repo.suggestedType } : {}), ...(Object.keys(repo.suggestedTests).length > 0 ? { tests: repo.suggestedTests } : {}) }]),
      ),
      bitbucketAllowedHosts: [...new Set(withRemote.map((repo) => repo.host).filter(Boolean))].join(', '),
      environmentValues: Object.fromEntries(withRemote.map((repo) => [repo.suggestedUrlEnv, repo.remote])),
    },
    notes: [
      '"looksLike" is a guess from the host name and path. Confirm each system with the user before using it.',
      'Documents listed here were only scanned for URLs. Read the relevant ones yourself for boards, schemas, services and process.',
      'Files named .env are never read. Tokens and passwords are never part of onboarding; record only the NAME each secret will be stored under.',
    ],
  };
}
