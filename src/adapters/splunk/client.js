/**
 * Splunk adapter: scoped, bounded, read-only searches.
 *
 * Every search is built here from the project's monitoring configuration:
 * explicit indexes (never index=*), a bounded time window and a result cap.
 * Free-text filters are checked so they cannot widen the scope or run a
 * command that writes.
 *
 * Authentication is by token only; session-based access through the browser
 * is not implemented for Splunk (docs/unsupported.md).
 *
 * Status: exercised against the local mock; not yet verified against a live
 * Splunk deployment.
 */

import { AutoDevError, ErrorCodes } from '../../core/errors.js';

const NAME = /^[A-Za-z0-9_.:-]{1,100}$/;

/**
 * @param {string} reason
 * @returns {never}
 */
function reject(reason) {
  throw new AutoDevError(ErrorCodes.QUERY_REJECTED, `Splunk search rejected: ${reason}`, { details: { reason } });
}

/**
 * @param {string[]} values
 * @param {string} label
 */
function names(values, label) {
  for (const value of values) {
    if (!NAME.test(value) || value.includes('*')) reject(`${label} "${value}" is not a plain name (wildcards are not allowed)`);
  }
  return values;
}

/**
 * Check a free-text filter fragment.
 * @param {string} filter
 */
export function validateFilter(filter) {
  if (filter.length > 500) reject('filter too long');
  if (/[|`[\]]/.test(filter)) reject('filters may not contain pipes, subsearches or macros');
  if (/\b(index|sourcetype|source|host|earliest|latest|_index_earliest|_index_latest)\s*(=|!=|::|<|>|\bIN\b)/i.test(filter)) {
    reject('filters may not change index, sourcetype, source, host or time range');
  }
  return filter.trim();
}

/**
 * Build the search for a project's error events.
 * @param {Record<string, any>} monitoring manifest.monitoring (defaults applied)
 * @param {{ extraFilter?: string | null, services?: string[] }} [options]
 * @returns {string}
 */
export function buildSearch(monitoring, options = {}) {
  const { splunk, limits, correlation } = monitoring;
  if (!splunk.indexes?.length) reject('no indexes are configured for this project (monitoring.splunk.indexes)');
  const indexes = names(splunk.indexes, 'index');
  const sourcetypes = names(splunk.sourcetypes ?? [], 'sourcetype');
  const group = (/** @type {string} */ field, /** @type {string[]} */ values) =>
    values.length === 1 ? `${field}="${values[0]}"` : `(${values.map((value) => `${field}="${value}"`).join(' OR ')})`;

  const parts = ['search', group('index', indexes)];
  if (sourcetypes.length > 0) parts.push(group('sourcetype', sourcetypes));
  const services = names(options.services ?? monitoring.services ?? [], 'service');
  if (services.length > 0) {
    const fields = names(correlation.serviceNameFields, 'service field');
    parts.push(`(${fields.flatMap((field) => services.map((service) => `${field}="${service}"`)).join(' OR ')})`);
  }
  parts.push(validateFilter(splunk.errorFilter || '(ERROR OR FATAL OR Exception)'));
  if (options.extraFilter) parts.push(validateFilter(options.extraFilter));
  return `${parts.join(' ')} | head ${limits.maxEventsPerQuery}`;
}

/**
 * @param {{ from: string | Date, to: string | Date }} window
 * @param {number} maxWindowMinutes
 */
export function boundedWindow(window, maxWindowMinutes) {
  const from = new Date(window.from);
  const to = new Date(window.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) reject('invalid time window');
  if (to.getTime() - from.getTime() > maxWindowMinutes * 60_000) {
    reject(`time window exceeds the configured maximum of ${maxWindowMinutes} minutes`);
  }
  return { from, to };
}

/**
 * The export endpoint streams one JSON object per line.
 * @param {string} text
 * @returns {Array<Record<string, any>>}
 */
function parseExport(text) {
  /** @type {Array<Record<string, any>>} */
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.result) events.push(parsed.result);
    } catch {
      // partial line from a truncated stream: ignore
    }
  }
  return events;
}

/**
 * Run the project's error search over a bounded window.
 * @param {import('../../core/auth.js').Transport} transport
 * @param {Record<string, any>} monitoring
 * @param {{ from: string | Date, to: string | Date, extraFilter?: string | null, services?: string[] }} query
 */
export async function searchErrors(transport, monitoring, query) {
  const { from, to } = boundedWindow(query, monitoring.limits.maxWindowMinutes);
  const search = buildSearch(monitoring, query);
  const body = new URLSearchParams({
    search,
    output_mode: 'json',
    earliest_time: from.toISOString(),
    latest_time: to.toISOString(),
    max_count: String(monitoring.limits.maxEventsPerQuery),
    adhoc_search_level: 'fast',
  });
  const response = await transport.request({
    method: 'POST',
    path: '/services/search/jobs/export',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    timeoutMs: 120_000,
    // A search is a read; repeating it is safe.
    retryNonIdempotent: true,
    retries: 2,
  });
  const events = parseExport(response.text);
  return {
    search,
    window: { from: from.toISOString(), to: to.toISOString() },
    count: events.length,
    capped: events.length >= monitoring.limits.maxEventsPerQuery,
    events,
  };
}

/**
 * Run one of the project's approved saved searches.
 * @param {import('../../core/auth.js').Transport} transport
 * @param {Record<string, any>} monitoring
 * @param {string} name
 * @param {{ from: string | Date, to: string | Date }} window
 */
export async function runSavedSearch(transport, monitoring, name, window) {
  if (!(monitoring.splunk.savedSearches ?? []).includes(name)) {
    reject(`saved search "${name}" is not listed in monitoring.splunk.savedSearches`);
  }
  const { from, to } = boundedWindow(window, monitoring.limits.maxWindowMinutes);
  const body = new URLSearchParams({
    search: `| savedsearch "${name.replace(/["\\]/g, '')}" | head ${monitoring.limits.maxEventsPerQuery}`,
    output_mode: 'json',
    earliest_time: from.toISOString(),
    latest_time: to.toISOString(),
  });
  const response = await transport.request({
    method: 'POST',
    path: '/services/search/jobs/export',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    timeoutMs: 120_000,
    retryNonIdempotent: true,
  });
  const events = parseExport(response.text);
  return { savedSearch: name, window: { from: from.toISOString(), to: to.toISOString() }, count: events.length, events };
}

/**
 * A link a person can open to see the same search in Splunk Web.
 * @param {string} baseUrl
 * @param {string} search
 * @param {{ from: string, to: string }} window
 */
export function searchLink(baseUrl, search, window) {
  const url = new URL(baseUrl);
  // The REST API usually listens on :8089; Splunk Web does not.
  if (url.port === '8089') url.port = '';
  url.pathname = '/app/search/search';
  url.search = new URLSearchParams({
    q: search,
    earliest: String(Math.floor(Date.parse(window.from) / 1000)),
    latest: String(Math.ceil(Date.parse(window.to) / 1000)),
  }).toString();
  return url.toString();
}
