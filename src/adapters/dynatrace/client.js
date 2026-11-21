/**
 * Dynatrace adapter (Environment API v2): problems and metrics, read-only and
 * scoped to the entity selectors configured for the project.
 *
 * Authentication is by API token only (scopes problems.read, metrics.read,
 * entities.read); browser-session access is not implemented
 * (docs/unsupported.md).
 *
 * Status: exercised against the local mock; not yet verified against a live
 * Dynatrace environment.
 */

import { AutoDevError, ErrorCodes } from '../../core/errors.js';

/**
 * @param {string} reason
 * @returns {never}
 */
function reject(reason) {
  throw new AutoDevError(ErrorCodes.QUERY_REJECTED, `Dynatrace query rejected: ${reason}`, { details: { reason } });
}

/**
 * @param {Record<string, any>} monitoring
 * @returns {string[]}
 */
function selectors(monitoring) {
  const list = monitoring.dynatrace.entitySelectors ?? [];
  if (list.length === 0) reject('no entity selectors are configured for this project (monitoring.dynatrace.entitySelectors)');
  for (const selector of list) {
    if (typeof selector !== 'string' || selector.length > 500 || !/^(type|entityId)\(/.test(selector.trim())) {
      reject('entity selectors must start with type(...) or entityId(...)');
    }
  }
  return list;
}

/**
 * @param {{ from: string | Date, to: string | Date }} window
 * @param {number} maxWindowMinutes
 */
function bounded(window, maxWindowMinutes) {
  const from = new Date(window.from);
  const to = new Date(window.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) reject('invalid time window');
  if (to.getTime() - from.getTime() > maxWindowMinutes * 60_000) reject(`time window exceeds ${maxWindowMinutes} minutes`);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * @param {string} baseUrl
 * @param {string} problemId
 */
function problemLink(baseUrl, problemId) {
  return `${baseUrl.replace(/\/+$/, '')}/#problems/problemdetails;pid=${encodeURIComponent(problemId)}`;
}

/**
 * Problems affecting the project's entities in the window.
 * @param {import('../../core/auth.js').Transport} transport
 * @param {Record<string, any>} monitoring
 * @param {{ from: string | Date, to: string | Date }} window
 */
export async function listProblems(transport, monitoring, window) {
  const range = bounded(window, monitoring.limits.maxWindowMinutes);
  /** @type {Map<string, Record<string, any>>} */
  const problems = new Map();
  for (const entitySelector of selectors(monitoring)) {
    const query = new URLSearchParams({ entitySelector, from: range.from, to: range.to, pageSize: '100' });
    const response = await transport.request({ path: `/api/v2/problems?${query}` });
    for (const problem of response.body?.problems ?? []) {
      problems.set(problem.problemId, {
        problemId: problem.problemId,
        displayId: problem.displayId ?? null,
        title: problem.title,
        severityLevel: problem.severityLevel ?? null,
        impactLevel: problem.impactLevel ?? null,
        status: problem.status ?? null,
        startTime: problem.startTime > 0 ? new Date(problem.startTime).toISOString() : null,
        endTime: problem.endTime > 0 ? new Date(problem.endTime).toISOString() : null,
        affectedEntities: (problem.affectedEntities ?? []).map((/** @type {any} */ entity) => ({
          id: entity.entityId?.id ?? null,
          name: entity.name ?? null,
        })),
        rootCauseEntity: problem.rootCauseEntity ? { id: problem.rootCauseEntity.entityId?.id ?? null, name: problem.rootCauseEntity.name ?? null } : null,
        traceIds: (problem.evidenceDetails?.details ?? [])
          .map((/** @type {any} */ detail) => detail.data?.traceId ?? detail.traceId)
          .filter(Boolean),
        url: problemLink(transport.baseUrl, problem.problemId),
      });
    }
  }
  return { window: range, count: problems.size, problems: [...problems.values()] };
}

/**
 * Query the project's configured metric selectors. Only selectors listed in
 * the manifest can be queried.
 * @param {import('../../core/auth.js').Transport} transport
 * @param {Record<string, any>} monitoring
 * @param {{ from: string | Date, to: string | Date, metricSelector?: string }} query
 */
export async function queryMetrics(transport, monitoring, query) {
  const range = bounded(query, monitoring.limits.maxWindowMinutes);
  const configured = monitoring.dynatrace.metricSelectors ?? [];
  if (query.metricSelector && !configured.includes(query.metricSelector)) {
    reject('that metric selector is not listed in monitoring.dynatrace.metricSelectors');
  }
  const wanted = query.metricSelector ? [query.metricSelector] : configured;
  /** @type {Array<Record<string, any>>} */
  const series = [];
  for (const metricSelector of wanted) {
    for (const entitySelector of selectors(monitoring)) {
      const params = new URLSearchParams({ metricSelector, entitySelector, from: range.from, to: range.to, resolution: '1m' });
      const response = await transport.request({ path: `/api/v2/metrics/query?${params}` });
      for (const result of response.body?.result ?? []) {
        for (const data of result.data ?? []) {
          const values = (data.values ?? []).filter((/** @type {unknown} */ value) => typeof value === 'number');
          series.push({
            metricId: result.metricId,
            dimensions: data.dimensionMap ?? {},
            entity: data.dimensionMap?.['dt.entity.service'] ?? data.dimensions?.[0] ?? null,
            points: values.length,
            max: values.length ? Math.max(...values) : null,
            avg: values.length ? values.reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0) / values.length : null,
            last: values.length ? values.at(-1) : null,
            unit: result.unit ?? null,
          });
        }
      }
    }
  }
  return { window: range, count: series.length, series };
}
