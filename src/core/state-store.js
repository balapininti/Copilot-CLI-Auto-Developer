/**
 * Small durable file store: atomic JSON writes and cross-process locks.
 *
 * State is plain JSON on disk on purpose. A developer can read it, the
 * monitoring worker survives restarts with it, and nothing needs a database
 * service on a locked-down workstation.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { AutoDevError, ErrorCodes } from './errors.js';

/**
 * @param {string} dir
 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Read JSON, returning `fallback` when the file does not exist.
 * @template T
 * @param {string} file
 * @param {T} [fallback]
 * @returns {T}
 */
export function readJson(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return /** @type {T} */ (fallback);
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new AutoDevError(ErrorCodes.INTEGRITY_VIOLATION, `State file is not valid JSON: ${file}`, {
      cause: error,
      details: { file },
    });
  }
}

/**
 * Write a file atomically: write a sibling temp file, flush it, then rename
 * over the target. A crash leaves either the old or the new content.
 * @param {string} file
 * @param {string} content
 */
export function atomicWriteFile(file, content) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const handle = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeSync(handle, content);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    renameWithRetry(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Windows can refuse a rename for a moment while antivirus or an indexer has
 * the target open. Retry briefly before giving up.
 * @param {string} from
 * @param {string} to
 */
function renameWithRetry(from, to) {
  const attempts = 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (attempt >= attempts || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt);
    }
  }
}

/**
 * @param {string} file
 * @param {unknown} value
 */
export function atomicWriteJson(file, value) {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Run `fn` while holding an exclusive lock file. A lock older than `staleMs`
 * is treated as abandoned by a crashed process and taken over.
 * @template T
 * @param {string} lockFile
 * @param {() => Promise<T> | T} fn
 * @param {{ staleMs?: number, waitMs?: number, pollMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withLock(lockFile, fn, options = {}) {
  const staleMs = options.staleMs ?? 10 * 60_000;
  const waitMs = options.waitMs ?? 5_000;
  const pollMs = options.pollMs ?? 50;
  const owner = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + waitMs;
  ensureDir(path.dirname(lockFile));

  for (;;) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ owner, acquiredAt: new Date().toISOString() }), { flag: 'wx' });
      break;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
      if (isStale(lockFile, staleMs)) {
        fs.rmSync(lockFile, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new AutoDevError(ErrorCodes.LOCKED, `Another process holds the lock: ${path.basename(lockFile)}`, {
          details: { lockFile },
        });
      }
      await sleep(pollMs);
    }
  }

  try {
    return await fn();
  } finally {
    // Release only a lock this call still owns; a stale takeover may have replaced it.
    const current = readJson(lockFile, /** @type {{ owner?: string } | null} */ (null));
    if (current?.owner === owner) fs.rmSync(lockFile, { force: true });
  }
}

/**
 * @param {string} lockFile
 * @param {number} staleMs
 */
function isStale(lockFile, staleMs) {
  try {
    return Date.now() - fs.statSync(lockFile).mtimeMs > staleMs;
  } catch {
    return true;
  }
}

/**
 * Resolve `relative` under `root` and refuse anything that escapes it.
 * @param {string} root
 * @param {string} relative
 * @returns {string}
 */
export function resolveInside(root, relative) {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  const rel = path.relative(base, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Path escapes its allowed root: ${relative}`, {
      details: { root: base },
    });
  }
  return target;
}

/**
 * Reject identifiers that could traverse paths or break file names.
 * @param {string} value
 * @param {string} label
 * @returns {string}
 */
export function safeId(value, label = 'identifier') {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) ||
    value.includes('..') ||
    value.endsWith('.') ||
    // Device names Windows reserves, with or without an extension.
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value)
  ) {
    throw new AutoDevError(
      ErrorCodes.INVALID_ARGUMENT,
      `Invalid ${label}: use letters, digits, dot, dash or underscore (max 100 characters).`,
      { details: { label } },
    );
  }
  return value;
}
