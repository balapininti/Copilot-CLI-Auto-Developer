/**
 * Deterministic hashing. Approvals, idempotency keys and the audit chain all
 * depend on the same value hashing the same way every time.
 */

import { createHash } from 'node:crypto';

/**
 * JSON with object keys sorted at every level.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (value instanceof Date) return JSON.stringify(Number.isNaN(value.getTime()) ? null : value.toISOString());
  if (value instanceof Map) return stableStringify({ $map: [...value.entries()].map(([key, child]) => [stableStringify(key), child]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) });
  if (value instanceof Set) return stableStringify({ $set: [...value].map((child) => stableStringify(child)).sort() });
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`);
  return `{${entries.join(',')}}`;
}

/**
 * @param {string | Buffer} input
 * @returns {string} hex digest
 */
export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * @param {unknown} value
 * @returns {string} hex digest of the value's stable JSON form
 */
export function hashOf(value) {
  return sha256(stableStringify(value));
}
