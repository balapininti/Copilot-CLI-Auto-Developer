/**
 * Running local programs (git, build tools, test runners) without a shell.
 *
 * Arguments are passed as an array, so nothing the agent or a ticket supplies
 * is ever interpreted by a command interpreter.
 */

import { spawn } from 'node:child_process';

import { AutoDevError, ErrorCodes } from './errors.js';
import { redactString } from './redact.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 512 * 1024;

/** Characters cmd.exe would interpret; refused in arguments to .cmd/.bat files. */
const CMD_META = /[&|<>^%"!\r\n]/;

/**
 * @typedef {object} ExecResult
 * @property {number | null} exitCode
 * @property {string} stdout redacted, truncated to the output limit
 * @property {string} stderr redacted, truncated to the output limit
 * @property {boolean} timedOut
 * @property {boolean} truncated
 * @property {number} durationMs
 */

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.Platform} platform
 * @returns {{ file: string, argv: string[], windowsVerbatimArguments: boolean }}
 */
export function buildSpawn(command, args, platform = process.platform) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    // Node refuses to spawn batch files directly; go through cmd.exe, and
    // refuse any argument cmd.exe could reinterpret.
    for (const value of [command, ...args]) {
      if (CMD_META.test(value)) {
        throw new AutoDevError(
          ErrorCodes.INVALID_ARGUMENT,
          'Refusing to pass an argument containing shell metacharacters to a batch file.',
          { details: { command } },
        );
      }
    }
    const line = [command, ...args].map((value) => (value === '' || /\s/.test(value) ? `"${value}"` : value)).join(' ');
    return { file: process.env.ComSpec || 'cmd.exe', argv: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
  }
  return { file: command, argv: args, windowsVerbatimArguments: false };
}

/**
 * @param {string} command
 * @param {string[]} [args]
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, maxOutputBytes?: number, input?: string, redactOutput?: boolean }} [options]
 * @returns {Promise<ExecResult>}
 */
export function runCommand(command, args = [], options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const started = Date.now();
  const { file, argv, windowsVerbatimArguments } = buildSpawn(command, args);

  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    /** @param {'out' | 'err'} which */
    const collect = (which) => (/** @type {Buffer} */ chunk) => {
      const current = which === 'out' ? stdout : stderr;
      if (current.length >= maxOutput) {
        truncated = true;
        return;
      }
      const next = current + chunk.toString('utf8');
      const clipped = next.length > maxOutput ? next.slice(0, maxOutput) : next;
      if (clipped.length < next.length) truncated = true;
      if (which === 'out') stdout = clipped;
      else stderr = clipped;
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));

    let settled = false;
    /** @type {NodeJS.Timeout | undefined} */
    let grace;
    const finish = (/** @type {number | null} */ exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      const clean = options.redactOutput === false ? (/** @type {string} */ text) => text : redactString;
      resolve({ exitCode, stdout: clean(stdout), stderr: clean(stderr), timedOut, truncated, durationMs: Date.now() - started });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        // Killing cmd.exe alone would leave the build tool it started running.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill('SIGKILL'));
      } else {
        child.kill('SIGKILL');
      }
      // A grandchild can keep the output pipes open; do not wait for it forever.
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null);
      }, 5_000);
    }, timeoutMs);

    child.on('error', (error) => {
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      reject(
        code === 'ENOENT'
          ? new AutoDevError(ErrorCodes.NOT_CONFIGURED, `Program not found on PATH: ${command}`, { details: { command } })
          : new AutoDevError(ErrorCodes.INTERNAL, `Could not start ${command}: ${error.message}`, { cause: error }),
      );
    });

    child.on('close', (exitCode) => finish(exitCode));

    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}

/**
 * Run a command and throw UPSTREAM_ERROR (or TIMEOUT) unless it exits 0.
 * @param {string} command
 * @param {string[]} args
 * @param {Parameters<typeof runCommand>[2] & { what?: string }} [options]
 * @returns {Promise<ExecResult>}
 */
export async function runChecked(command, args, options = {}) {
  const result = await runCommand(command, args, options);
  const what = options.what ?? `${command} ${args[0] ?? ''}`.trim();
  if (result.timedOut) {
    throw new AutoDevError(ErrorCodes.TIMEOUT, `${what} timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms.`);
  }
  if (result.exitCode !== 0) {
    throw new AutoDevError(ErrorCodes.UPSTREAM_ERROR, `${what} failed with exit code ${result.exitCode}.`, {
      details: { stderr: result.stderr.slice(-2000), stdout: result.stdout.slice(-1000) },
    });
  }
  return result;
}
