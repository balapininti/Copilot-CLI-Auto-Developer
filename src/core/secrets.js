/**
 * Secret lookup. Secrets come from injected environment variables or the
 * operating system's credential store and exist only in process memory. They
 * are never written to manifests, logs, state files, commits or prompts.
 *
 * Lookup order for a secret named NAME:
 *   1. environment variable NAME
 *   2. OS credential store entry "autodev/NAME"
 *        Windows: Credential Manager (generic credential)
 *        macOS:   login keychain (developer machines only)
 *        Linux:   libsecret via secret-tool, when installed
 */

import path from 'node:path';

import { AutoDevError, ErrorCodes } from './errors.js';
import { runCommand } from './exec.js';
import { registerSecret } from './redact.js';
import { AUTOMATION_ROOT } from './workspace.js';

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/;
const CREDENTIAL_PREFIX = 'autodev/';

/**
 * @typedef {(command: string, args: string[], options?: object) => Promise<{ exitCode: number | null, stdout: string }>} Runner
 */

/**
 * @param {string} name
 * @param {NodeJS.Platform} platform
 * @param {Runner} runner
 * @returns {Promise<string | null>}
 */
async function fromCredentialStore(name, platform, runner) {
  const target = `${CREDENTIAL_PREFIX}${name}`;
  /** @type {[string, string[]] | null} */
  let call = null;
  if (platform === 'win32') {
    const script = path.join(AUTOMATION_ROOT, 'scripts', 'ps', 'Get-AutoDevCredential.ps1');
    call = ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Target', target]];
  } else if (platform === 'darwin') {
    call = ['security', ['find-generic-password', '-s', target, '-w']];
  } else if (platform === 'linux') {
    call = ['secret-tool', ['lookup', 'service', 'autodev', 'name', name]];
  }
  if (!call) return null;
  try {
    const result = await runner(call[0], call[1], { timeoutMs: 15_000, redactOutput: false });
    if (result.exitCode !== 0) return null;
    const value = result.stdout.replace(/\r?\n$/, '');
    return value.length > 0 ? value : null;
  } catch {
    return null; // store tool not installed: treated as "no secret here"
  }
}

/**
 * @param {string | null | undefined} name
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, runner?: Runner, useCredentialStore?: boolean }} [options]
 * @returns {Promise<string | null>} the secret, or null when it is not stored anywhere
 */
export async function getSecret(name, options = {}) {
  if (!name) return null;
  if (!NAME_PATTERN.test(name)) {
    throw new AutoDevError(ErrorCodes.CONFIG_INVALID, 'Secret names may contain only letters, digits, dot, dash and underscore.');
  }
  const env = options.env ?? process.env;
  let value = env[name]?.trim() || null;
  const storeEnabled = options.useCredentialStore ?? env.AUTODEV_DISABLE_CREDENTIAL_STORE !== '1';
  if (!value && storeEnabled) {
    value = await fromCredentialStore(name, options.platform ?? process.platform, options.runner ?? runCommand);
  }
  if (value) registerSecret(value, name);
  return value;
}
