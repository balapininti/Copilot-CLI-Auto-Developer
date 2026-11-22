/**
 * `autodev` command-line entry point.
 *
 * Every command prints exactly one JSON result envelope on stdout (see
 * core/result.js) and structured logs on stderr, and exits with a code that
 * tells a caller whether it succeeded, needs a person, was refused by policy
 * or hit an upstream problem (see core/errors.js).
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { AutoDevError, ErrorCodes, exitCodeFor, toAutoDevError } from '../core/errors.js';
import { assertTlsPolicy } from '../core/http.js';
import { createLogger } from '../core/logger.js';
import { loadManifest } from '../core/manifest.js';
import { resolveProjectScope } from '../core/project-context.js';
import { fail, ok } from '../core/result.js';
import { resolveWorkspace } from '../core/workspace.js';
import { integrationCommands } from './commands/integrations.js';
import { monitoringCommands } from './commands/monitoring.js';
import { projectCommands } from './commands/project.js';
import { scenarioCommands } from './commands/scenario.js';

/** @type {Record<string, { type: 'string' | 'boolean', multiple?: boolean }>} */
const OPTIONS = {
  project: { type: 'string' },
  workspace: { type: 'string' },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean' },
  all: { type: 'boolean' },
  force: { type: 'boolean' },
  strict: { type: 'boolean' },
  headless: { type: 'boolean' },
  'ignore-backoff': { type: 'boolean' },
  'authorize-schema-change': { type: 'boolean' },
  board: { type: 'string' },
  story: { type: 'string' },
  team: { type: 'string' },
  task: { type: 'string' },
  repo: { type: 'string' },
  service: { type: 'string' },
  stage: { type: 'string', multiple: true },
  sql: { type: 'string' },
  param: { type: 'string', multiple: true },
  schema: { type: 'string' },
  table: { type: 'string' },
  approval: { type: 'string' },
  steps: { type: 'string' },
  browser: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  minutes: { type: 'string' },
  filter: { type: 'string' },
  name: { type: 'string' },
  verdict: { type: 'string' },
  reviewer: { type: 'string' },
  notes: { type: 'string' },
  message: { type: 'string' },
  title: { type: 'string' },
  risks: { type: 'string' },
  dependencies: { type: 'string' },
  skill: { type: 'string' },
  rule: { type: 'string' },
  evidence: { type: 'string', multiple: true },
  source: { type: 'string', multiple: true },
  incident: { type: 'string' },
  classification: { type: 'string' },
  statement: { type: 'string' },
  pr: { type: 'string', multiple: true },
  'deployed-at': { type: 'string' },
  'deployment-ref': { type: 'string' },
  'task-id': { type: 'string' },
  outcome: { type: 'string' },
  reason: { type: 'string' },
  status: { type: 'string' },
  answers: { type: 'string' },
  port: { type: 'string' },
  limit: { type: 'string' },
  action: { type: 'string' },
  text: { type: 'string' },
  metric: { type: 'string' },
  'release-branch': { type: 'string' },
  'max-rows': { type: 'string' },
  scope: { type: 'string' },
  path: { type: 'string', multiple: true },
  guidelines: { type: 'string' },
  har: { type: 'string' },
  host: { type: 'string' },
  file: { type: 'string' },
  'base-url': { type: 'string' },
  'keep-request-values': { type: 'boolean' },
  draft: { type: 'boolean' },
};

/**
 * @typedef {object} CommandContext
 * @property {string[]} args positional arguments after the command name
 * @property {Record<string, any>} flags
 * @property {import('../core/workspace.js').Workspace} workspace
 * @property {NodeJS.ProcessEnv} env
 * @property {import('../core/logger.js').Logger} logger
 * @property {boolean} dryRun
 * @property {() => { projectId: string, manifest: Record<string, any>, dir: string, missing: Array<{ field: string, neededFor: string }> }} project resolve and load the scoped project
 * @property {(name: string) => string} need a required flag
 *
 * @typedef {{ summary: string, usage?: string, run: (ctx: CommandContext) => Promise<unknown> | unknown }} Command
 */

/** @type {Record<string, Command>} */
export const COMMANDS = { ...projectCommands, ...integrationCommands, ...monitoringCommands, ...scenarioCommands };

function helpText() {
  const names = Object.keys(COMMANDS).sort();
  const width = Math.max(...names.map((name) => name.length));
  return {
    usage: 'autodev <command> [options]   (add --dry-run to any command to see what it would do without writing anywhere)',
    commands: Object.fromEntries(names.map((name) => [name.padEnd(width), COMMANDS[name].summary])),
    globalOptions: {
      '--project <id>': 'Project to act on. Must match the session project when a session is active.',
      '--workspace <dir>': 'Workspace root (default: AUTODEV_WORKSPACE, else the parent of the automation folder).',
      '--dry-run': 'Make no external write and spend no approval; report what would happen.',
    },
  };
}

/**
 * Run the CLI. Returns the exit code; never throws.
 * @param {string[]} argv arguments after the script name
 * @param {{ env?: NodeJS.ProcessEnv, stdout?: (text: string) => void }} [io]
 * @returns {Promise<number>}
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const write = io.stdout ?? ((text) => process.stdout.write(text));
  const started = Date.now();
  let commandName = '';
  let projectId = null;
  let dryRun = false;

  try {
    /** @type {{ values: Record<string, any>, positionals: string[] }} */
    let parsed;
    try {
      parsed = /** @type {any} */ (parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }));
    } catch (error) {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, /** @type {Error} */ (error).message);
    }
    const { values: flags, positionals } = parsed;
    dryRun = flags['dry-run'] === true || env.AUTODEV_DRY_RUN === '1';

    // Longest match first: "monitor verify-resolution" before "monitor".
    const two = positionals.slice(0, 2).join(' ');
    commandName = Object.hasOwn(COMMANDS, two) ? two : (positionals[0] ?? '');
    if (!commandName || flags.help || commandName === 'help') {
      write(`${JSON.stringify(ok(helpText(), { command: 'help' }), null, 2)}\n`);
      return 0;
    }
    const command = Object.hasOwn(COMMANDS, commandName) ? COMMANDS[commandName] : null;
    if (!command) {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Unknown command "${two || commandName}". Run "autodev help".`);
    }

    assertTlsPolicy(env);
    const workspace = resolveWorkspace({ workspace: flags.workspace, env });
    if (flags.workspace && (env.AUTODEV_SESSION_ID || env.AUTODEV_PROJECT)) {
      // Inside a session the workspace is fixed by the launcher. Pointing a
      // command at another one would swap the project binding, the policies
      // and the approval store all at once.
      const bound = resolveWorkspace({ env }).root;
      const real = (/** @type {string} */ dir) => {
        let resolved;
        try {
          resolved = fs.realpathSync.native(dir);
        } catch {
          resolved = path.resolve(dir);
        }
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      };
      if (real(workspace.root) !== real(bound)) {
        throw new AutoDevError(ErrorCodes.PROJECT_SCOPE_VIOLATION, 'This session is bound to its workspace; --workspace cannot point at a different one.');
      }
    }
    const logger = createLogger({ bindings: { command: commandName } });
    /** @type {ReturnType<CommandContext['project']> | null} */
    let scoped = null;

    /** @type {CommandContext} */
    const ctx = {
      args: positionals.slice(commandName.split(' ').length),
      flags,
      workspace,
      env,
      logger,
      dryRun,
      project: () => {
        if (!scoped) {
          const id = resolveProjectScope(workspace, flags.project, env);
          scoped = { projectId: id, ...loadManifest(workspace, id) };
          projectId = id;
        }
        return scoped;
      },
      need: (name) => {
        const value = flags[name];
        if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
          throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Missing required option --${name}.${command.usage ? ` Usage: autodev ${command.usage}` : ''}`);
        }
        return Array.isArray(value) ? value[0] : value;
      },
    };

    const data = await command.run(ctx);
    write(`${JSON.stringify(ok(data, { command: commandName, projectId, dryRun, durationMs: Date.now() - started }), null, 2)}\n`);
    return 0;
  } catch (error) {
    const failure = toAutoDevError(error);
    write(`${JSON.stringify(fail(failure, { command: commandName, projectId, dryRun, durationMs: Date.now() - started }), null, 2)}\n`);
    return exitCodeFor(failure.code);
  }
}
