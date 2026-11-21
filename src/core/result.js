/**
 * The one JSON envelope every command prints on stdout.
 *
 *   { "ok": true,  "data": ..., "meta": { ... } }
 *   { "ok": false, "error": { "code", "message", "retryable", "details" }, "meta": { ... } }
 */

import { toAutoDevError } from './errors.js';
import { redact } from './redact.js';

/**
 * @typedef {{ command?: string, projectId?: string | null, dryRun?: boolean, durationMs?: number, timestamp?: string, warnings?: string[] }} ResultMeta
 * @typedef {{ ok: true, data: unknown, meta: ResultMeta }} OkResult
 * @typedef {{ ok: false, error: { code: string, message: string, retryable: boolean, details: Record<string, unknown> }, meta: ResultMeta }} ErrResult
 * @typedef {OkResult | ErrResult} Result
 */

/**
 * @param {unknown} data
 * @param {ResultMeta} [meta]
 * @returns {OkResult}
 */
export function ok(data, meta = {}) {
  return { ok: true, data: redact(data), meta: redact({ timestamp: new Date().toISOString(), ...meta }) };
}

/**
 * @param {unknown} error
 * @param {ResultMeta} [meta]
 * @returns {ErrResult}
 */
export function fail(error, meta = {}) {
  const normalized = toAutoDevError(error);
  return {
    ok: false,
    error: redact({
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      details: normalized.details,
    }),
    meta: redact({ timestamp: new Date().toISOString(), ...meta }),
  };
}
