/**
 * Agent and skill discovery for GitHub Copilot CLI.
 *
 * Copilot CLI finds custom agents in `.github/agents` of the folder it is
 * started in and in `<COPILOT_HOME>/agents` (default ~/.copilot/agents), and
 * skills in `.github/skills` and `<COPILOT_HOME>/skills`. Being somewhere
 * under a workspace folder is not enough. So there are two supported setups:
 *
 *   1. Start Copilot CLI from this automation folder (scripts/Start-AutoDev.ps1).
 *   2. Install the agents and skills into the user-level folders with
 *      `autodev discovery install`, so they are available from any folder.
 *
 * `verify` checks the files against the documented format and, when the
 * `copilot` command is installed, asks it which skills it can actually see.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import YAML from 'yaml';

import { AutoDevError, ErrorCodes } from '../core/errors.js';
import { runCommand } from '../core/exec.js';
import { atomicWriteJson, ensureDir, readJson, resolveInside } from '../core/state-store.js';
import { AUTOMATION_ROOT } from '../core/workspace.js';

const AGENTS_DIR = path.join(AUTOMATION_ROOT, '.github', 'agents');
const SKILLS_DIR = path.join(AUTOMATION_ROOT, '.github', 'skills');
const HOOKS_DIR = path.join(AUTOMATION_ROOT, '.github', 'hooks');
const MAX_AGENT_BODY = 30_000;
const INSTALL_MANIFEST = 'autodev-install.json';
const USER_HOOK = path.join('hooks', 'autodev.json');

/**
 * @param {string} content
 * @returns {{ frontmatter: Record<string, any> | null, body: string, error: string | null }}
 */
export function parseFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return { frontmatter: null, body: content, error: 'No YAML frontmatter block at the top of the file.' };
  try {
    const parsed = YAML.parse(match[1]);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { frontmatter: null, body: match[2], error: 'Frontmatter is not a YAML mapping.' };
    }
    return { frontmatter: parsed, body: match[2], error: null };
  } catch (error) {
    return { frontmatter: null, body: match[2], error: `Frontmatter is not valid YAML: ${/** @type {Error} */ (error).message}` };
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function copilotHome(env = process.env) {
  return env.COPILOT_HOME ? path.resolve(env.COPILOT_HOME) : path.join(os.homedir(), '.copilot');
}

export function listAgents() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs
    .readdirSync(AGENTS_DIR)
    .filter((name) => name.endsWith('.agent.md'))
    .sort()
    .map((name) => {
      const file = path.join(AGENTS_DIR, name);
      const { frontmatter, body, error } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      const problems = [];
      if (error) problems.push(error);
      if (frontmatter && (typeof frontmatter.description !== 'string' || frontmatter.description.trim() === '')) problems.push('Missing required "description".');
      if (body.length > MAX_AGENT_BODY) problems.push(`Prompt body is ${body.length} characters; the limit is ${MAX_AGENT_BODY}.`);
      if (frontmatter && 'mcp-servers' in frontmatter) problems.push('Declares mcp-servers; this framework must not require MCP.');
      return { id: name.replace(/\.agent\.md$/, ''), file, description: frontmatter?.description ?? null, tools: frontmatter?.tools ?? null, problems };
    });
}

export function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const file = path.join(SKILLS_DIR, name, 'SKILL.md');
      const problems = [];
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) problems.push('Folder name must be lowercase words separated by hyphens.');
      if (!fs.existsSync(file)) return { name, file, description: null, problems: [...problems, 'SKILL.md is missing.'] };
      const { frontmatter, error } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      if (error) problems.push(error);
      if (frontmatter) {
        if (frontmatter.name !== name) problems.push(`Frontmatter name "${frontmatter.name}" does not match folder "${name}".`);
        if (typeof frontmatter.description !== 'string' || frontmatter.description.trim() === '') problems.push('Missing required "description".');
      }
      return { name, file, description: frontmatter?.description ?? null, problems };
    });
}

function listHooks() {
  if (!fs.existsSync(HOOKS_DIR)) return [];
  return fs
    .readdirSync(HOOKS_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const file = path.join(HOOKS_DIR, name);
      const problems = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed.version !== 1) problems.push('Expected "version": 1.');
        if (!parsed.hooks || typeof parsed.hooks !== 'object') problems.push('Missing "hooks" object.');
      } catch (error) {
        problems.push(`Not valid JSON: ${/** @type {Error} */ (error).message}`);
      }
      return { file, problems };
    });
}

/**
 * Check agents, skills and hooks, and ask the installed CLI what it sees.
 * @param {{ required?: { agents: string[], skills: string[] }, runner?: typeof runCommand, env?: NodeJS.ProcessEnv }} [options]
 */
export async function verifyDiscovery(options = {}) {
  const run = options.runner ?? runCommand;
  const agents = listAgents();
  const skills = listSkills();
  const hooks = listHooks();
  const problems = [
    ...agents.flatMap((agent) => agent.problems.map((problem) => `agent ${agent.id}: ${problem}`)),
    ...skills.flatMap((skill) => skill.problems.map((problem) => `skill ${skill.name}: ${problem}`)),
    ...hooks.flatMap((hook) => hook.problems.map((problem) => `hook ${path.basename(hook.file)}: ${problem}`)),
  ];
  for (const id of options.required?.agents ?? []) {
    if (!agents.some((agent) => agent.id === id)) problems.push(`Required agent "${id}" is missing.`);
  }
  for (const name of options.required?.skills ?? []) {
    if (!skills.some((skill) => skill.name === name)) problems.push(`Required skill "${name}" is missing.`);
  }

  /** @type {Record<string, any>} */
  const cli = { installed: false, version: null, skillsSeen: null, note: null };
  try {
    const version = await run(process.platform === 'win32' ? 'copilot.cmd' : 'copilot', ['--version'], { timeoutMs: 20_000, cwd: AUTOMATION_ROOT });
    if (version.exitCode === 0) {
      cli.installed = true;
      cli.version = version.stdout.trim().split('\n')[0];
      const listed = await run(process.platform === 'win32' ? 'copilot.cmd' : 'copilot', ['skill', 'list'], { timeoutMs: 30_000, cwd: AUTOMATION_ROOT });
      if (listed.exitCode === 0) {
        cli.skillsSeen = skills.map((skill) => skill.name).filter((name) => new RegExp(`(^|[^a-z0-9-])${name}([^a-z0-9-]|$)`, 'm').test(listed.stdout));
        const unseen = skills.map((skill) => skill.name).filter((name) => !cli.skillsSeen.includes(name));
        if (unseen.length > 0) problems.push(`Copilot CLI ${cli.version} does not list these skills from this folder: ${unseen.join(', ')}.`);
      } else {
        cli.note = 'The installed CLI did not accept "copilot skill list"; check discovery inside a session with /skills list and /agent.';
      }
    }
  } catch {
    // not installed
  }
  if (!cli.installed) {
    cli.note = 'GitHub Copilot CLI is not installed on this machine, so discovery could only be checked against the documented file format, not confirmed with the CLI itself.';
  }

  const home = copilotHome(options.env);
  const installed = readJson(path.join(home, INSTALL_MANIFEST), /** @type {Record<string, any> | null} */ (null));
  return {
    ok: problems.length === 0,
    confirmedWithCli: cli.installed && Array.isArray(cli.skillsSeen) && cli.skillsSeen.length === skills.length,
    problems,
    agents: agents.map(({ id, description, problems: p }) => ({ id, description, problems: p })),
    skills: skills.map(({ name, description, problems: p }) => ({ name, description, problems: p })),
    hooks: hooks.map((hook) => ({ file: path.relative(AUTOMATION_ROOT, hook.file), problems: hook.problems })),
    copilotCli: cli,
    locations: {
      repositoryLevel: { agents: AGENTS_DIR, skills: SKILLS_DIR, activeWhen: 'Copilot CLI is started in the automation folder (scripts/Start-AutoDev.ps1 does this).' },
      userLevel: { home, installed: Boolean(installed), installedAt: installed?.installedAt ?? null },
    },
  };
}

/**
 * Delete a file this installer recorded, but only if the recorded path really
 * is inside the agents or skills folder of the Copilot home. The record is a
 * file on disk and is not trusted.
 * @param {string} home
 * @param {unknown} recorded
 */
function removeInstalled(home, recorded) {
  if (typeof recorded !== 'string' || path.isAbsolute(recorded)) return;
  let target;
  try {
    target = resolveInside(home, recorded);
  } catch {
    return;
  }
  const top = path.relative(home, target).split(path.sep)[0];
  if (top !== 'agents' && top !== 'skills' && recorded !== USER_HOOK) return;
  fs.rmSync(target, { force: true });
}

/**
 * Copy agents and skills into the user-level Copilot folders. Files that are
 * already there and were not put there by this installer are left alone.
 * @param {{ env?: NodeJS.ProcessEnv, dryRun?: boolean, force?: boolean }} [options]
 */
export function installUserLevel(options = {}) {
  const home = copilotHome(options.env);
  const manifestFile = path.join(home, INSTALL_MANIFEST);
  const previous = new Set(readJson(manifestFile, /** @type {{ files?: string[] }} */ ({})).files ?? []);
  /** @type {Array<{ from: string, to: string }>} */
  const copies = [];
  for (const agent of listAgents()) copies.push({ from: agent.file, to: path.join('agents', path.basename(agent.file)) });
  for (const skill of listSkills()) {
    const dir = path.dirname(skill.file);
    for (const name of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!name.isFile()) continue;
      const absolute = path.join(name.parentPath, name.name);
      copies.push({ from: absolute, to: path.join('skills', skill.name, path.relative(dir, absolute)) });
    }
  }
  const conflicts = [...copies, { from: '', to: USER_HOOK }].filter((copy) => fs.existsSync(path.join(home, copy.to)) && !previous.has(copy.to)).map((copy) => copy.to);
  if (conflicts.length > 0 && !options.force) {
    throw new AutoDevError(
      ErrorCodes.CONFLICT,
      'Some files already exist in the user-level Copilot folders and were not installed by this framework. Nothing was changed.',
      { details: { conflicts, home, howToFix: 'Move them aside, or rerun with --force to replace them.' } },
    );
  }
  if (options.dryRun) return { dryRun: true, home, wouldCopy: [...copies.map((copy) => copy.to), USER_HOOK] };

  for (const copy of copies) {
    ensureDir(path.dirname(path.join(home, copy.to)));
    fs.copyFileSync(copy.from, path.join(home, copy.to));
  }
  // The hook must travel with the agents: without it a session started in
  // another folder would have the agents but not the guard on their tools.
  const hookScript = path.join(AUTOMATION_ROOT, 'scripts', 'hooks', 'pre-tool-use.mjs');
  const hookCommand = `node "${hookScript}"`;
  ensureDir(path.join(home, 'hooks'));
  atomicWriteJson(path.join(home, USER_HOOK), {
    version: 1,
    hooks: { preToolUse: [{ type: 'command', bash: hookCommand, powershell: hookCommand, timeoutSec: 15 }] },
  });
  for (const stale of previous) {
    if (!copies.some((copy) => copy.to === stale)) removeInstalled(home, stale);
  }
  atomicWriteJson(manifestFile, { installedAt: new Date().toISOString(), source: AUTOMATION_ROOT, files: [...copies.map((copy) => copy.to), USER_HOOK] });
  return {
    dryRun: false,
    home,
    copied: copies.length + 1,
    note: 'Agents, skills and the preToolUse hook were installed for this user. Sessions must still be started through Start-AutoDev.ps1: it sets AUTODEV_HOME, the workspace and the session id that bind a session to one project. A session started any other way is not bound.',
  };
}

/**
 * Remove what installUserLevel copied, and nothing else.
 * @param {{ env?: NodeJS.ProcessEnv, dryRun?: boolean }} [options]
 */
export function uninstallUserLevel(options = {}) {
  const home = copilotHome(options.env);
  const manifestFile = path.join(home, INSTALL_MANIFEST);
  const files = readJson(manifestFile, /** @type {{ files?: string[] }} */ ({})).files ?? [];
  if (options.dryRun) return { dryRun: true, home, wouldRemove: files };
  for (const file of files) removeInstalled(home, file);
  fs.rmSync(manifestFile, { force: true });
  return { dryRun: false, home, removed: files.length };
}
