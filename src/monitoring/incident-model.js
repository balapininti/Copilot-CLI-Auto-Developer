/**
 * The common incident model, signal normalisation and the incident lifecycle.
 *
 * Signals are what the sources report (a Splunk error event, a Dynatrace
 * problem, a breached threshold). Incidents are what the framework tracks.
 * Identifiers that a source did not supply stay null; nothing is invented.
 */

import { AutoDevError, ErrorCodes } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { redactString } from '../core/redact.js';

/**
 * @typedef {object} Signal
 * @property {'splunk' | 'dynatrace-problem' | 'threshold'} source
 * @property {string | null} service
 * @property {string} timestamp ISO-8601 UTC
 * @property {string} fingerprint
 * @property {string} summary sanitized, one line
 * @property {string | null} [exceptionClass]
 * @property {string | null} [traceId]
 * @property {string | null} [spanId]
 * @property {string | null} [requestId]
 * @property {string | null} [deploymentVersion]
 * @property {string | null} [evidenceLink]
 * @property {string | null} [sourceTimeZone]
 * @property {string | null} [endTimestamp]
 * @property {{ metric: string, observed: number, threshold: number, baseline: number | null, unit: string | null } | null} [metric]
 * @property {string | null} [severityHint]
 */

/** Lifecycle states. */
export const Status = Object.freeze({
  DETECTED: 'detected',
  NEEDS_ONBOARDING: 'needs-onboarding',
  DEFECT_PROPOSED: 'defect-proposed',
  DEFECT_DENIED: 'defect-denied',
  DEFECT_CREATED: 'defect-created',
  HANDOFF_QUEUED: 'handoff-queued',
  DEVELOPMENT_STARTED: 'development-started',
  PR_CREATED: 'pr-created',
  VALIDATION_PENDING: 'validation-pending',
  RESOLVED_VERIFIED: 'resolved-verified',
  CLOSED: 'closed',
});

/**
 * Allowed transitions: state -> event -> next state. Keeping this a plain
 * table makes the lifecycle testable without any I/O.
 * @type {Record<string, Record<string, string>>}
 */
const TRANSITIONS = {
  [Status.DETECTED]: {
    'mapping-missing': Status.NEEDS_ONBOARDING,
    'defect-proposed': Status.DEFECT_PROPOSED,
    'defect-created': Status.DEFECT_CREATED,
    'existing-defect-linked': Status.DEFECT_CREATED,
    closed: Status.CLOSED,
  },
  [Status.NEEDS_ONBOARDING]: { 'mapping-resolved': Status.DETECTED, closed: Status.CLOSED },
  [Status.DEFECT_PROPOSED]: {
    'defect-created': Status.DEFECT_CREATED,
    'existing-defect-linked': Status.DEFECT_CREATED,
    'defect-denied': Status.DEFECT_DENIED,
    'approval-lapsed': Status.DETECTED,
    closed: Status.CLOSED,
  },
  [Status.DEFECT_DENIED]: { closed: Status.CLOSED, reopened: Status.DETECTED },
  [Status.DEFECT_CREATED]: { 'handoff-queued': Status.HANDOFF_QUEUED, closed: Status.CLOSED },
  [Status.HANDOFF_QUEUED]: { 'development-started': Status.DEVELOPMENT_STARTED, closed: Status.CLOSED },
  [Status.DEVELOPMENT_STARTED]: { 'pr-created': Status.PR_CREATED, closed: Status.CLOSED },
  [Status.PR_CREATED]: { 'deployment-recorded': Status.VALIDATION_PENDING, closed: Status.CLOSED },
  [Status.VALIDATION_PENDING]: {
    'resolution-verified': Status.RESOLVED_VERIFIED,
    'still-occurring': Status.VALIDATION_PENDING,
    closed: Status.CLOSED,
  },
  [Status.RESOLVED_VERIFIED]: { closed: Status.CLOSED },
  [Status.CLOSED]: {},
};

/**
 * Pure lifecycle step.
 * @param {string} status
 * @param {string} event
 * @returns {string} next status
 */
export function transition(status, event) {
  const table = Object.hasOwn(TRANSITIONS, status) ? TRANSITIONS[status] : {};
  const next = Object.hasOwn(table, event) ? table[event] : null;
  if (!next) {
    throw new AutoDevError(ErrorCodes.CONFLICT, `Incident in state "${status}" cannot take event "${event}".`, {
      details: { status, event, allowed: Object.keys(table) },
    });
  }
  return next;
}

/**
 * Apply a lifecycle event to an incident and record it in its history.
 * @param {Record<string, any>} incident
 * @param {string} event
 * @param {Record<string, unknown>} [note]
 */
export function applyEvent(incident, event, note = {}) {
  const from = incident.status;
  incident.status = transition(from, event);
  incident.history.push({ at: new Date().toISOString(), event, from, to: incident.status, ...note });
  return incident;
}

/**
 * Reduce a log message to its stable shape so recurring errors share a
 * fingerprint: ids, numbers, quoted values and timestamps are masked.
 * @param {string} message
 */
export function normalizeMessage(message) {
  return String(message ?? '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/(["'])(?:(?!\1).){0,200}\1/g, '<str>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * @param {Array<string | null | undefined>} parts
 */
export function fingerprintOf(...parts) {
  return sha256(parts.map((part) => part ?? '').join('\u001f')).slice(0, 16);
}

/**
 * @param {Record<string, any>} event
 * @param {string[]} fields
 * @param {RegExp} valuePattern
 */
function pickField(event, fields, valuePattern) {
  for (const field of fields) {
    const direct = event[field];
    if (typeof direct === 'string' && valuePattern.test(direct)) return direct;
  }
  const raw = typeof event._raw === 'string' ? event._raw : '';
  for (const field of fields) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`["']?\\b${escaped}["']?\\s*[:=]\\s*["']?([A-Za-z0-9._:-]{1,128})`).exec(raw);
    if (match && valuePattern.test(match[1])) return match[1];
  }
  return null;
}

const ID_VALUE = /^[A-Za-z0-9._:-]{4,128}$/;
const SERVICE_VALUE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Turn one Splunk result row into a signal.
 * @param {Record<string, any>} event
 * @param {Record<string, any>} correlation manifest.monitoring.correlation
 * @param {{ evidenceLink?: string | null }} [context]
 * @returns {Signal | null} null when the event has no usable timestamp
 */
export function signalFromSplunk(event, correlation, context = {}) {
  const time = new Date(event._time ?? event.timestamp ?? NaN);
  if (Number.isNaN(time.getTime())) return null;
  const raw = String(event._raw ?? event.message ?? '');
  const firstLine = raw.split('\n')[0];
  const exceptionClass = /\b((?:[a-z_][\w$]*\.)*[A-Z][\w$]*(?:Exception|Error))\b/.exec(raw)?.[1] ?? null;
  const topFrame = /^\s*at\s+([\w$.<>]+)\(/m.exec(raw)?.[1] ?? null;
  const service = pickField(event, correlation.serviceNameFields, SERVICE_VALUE);
  const zone = /([+-]\d{2}:?\d{2}|Z)$/.exec(String(event._time ?? ''))?.[1] ?? null;
  return {
    source: 'splunk',
    service,
    timestamp: time.toISOString(),
    sourceTimeZone: zone,
    fingerprint: fingerprintOf('error', service, exceptionClass, topFrame, exceptionClass ? null : normalizeMessage(firstLine)),
    summary: redactString(firstLine.slice(0, 300), { pii: true }),
    exceptionClass,
    traceId: pickField(event, correlation.traceIdFields, ID_VALUE),
    spanId: pickField(event, correlation.spanIdFields, ID_VALUE),
    requestId: pickField(event, correlation.requestIdFields ?? [], ID_VALUE),
    deploymentVersion: typeof event.version === 'string' ? event.version : null,
    evidenceLink: context.evidenceLink ?? null,
    metric: null,
    severityHint: /\bFATAL\b/.test(raw) ? 'high' : null,
  };
}

/**
 * @param {Record<string, any>} problem normalised by the Dynatrace adapter
 * @param {(entity: { id: string | null, name: string | null }) => string | null} resolveService
 * @returns {Signal}
 */
export function signalFromProblem(problem, resolveService) {
  const entities = [problem.rootCauseEntity, ...(problem.affectedEntities ?? [])].filter(Boolean);
  let service = null;
  for (const entity of entities) {
    service = resolveService(entity);
    if (service) break;
  }
  return {
    source: 'dynatrace-problem',
    service: service ?? entities[0]?.name ?? null,
    timestamp: problem.startTime ?? new Date().toISOString(),
    endTimestamp: problem.endTime ?? null,
    sourceTimeZone: 'Z',
    fingerprint: fingerprintOf('problem', service ?? entities[0]?.name, normalizeMessage(problem.title)),
    summary: redactString(String(problem.title ?? 'Dynatrace problem').slice(0, 300), { pii: true }),
    exceptionClass: null,
    traceId: problem.traceIds?.[0] ?? null,
    spanId: null,
    requestId: null,
    evidenceLink: problem.url ?? null,
    metric: null,
    severityHint: { AVAILABILITY: 'critical', ERROR: 'high', PERFORMANCE: 'medium', RESOURCE_CONTENTION: 'medium' }[
      /** @type {string} */ (problem.severityLevel)
    ] ?? null,
  };
}

/**
 * Evaluate configured thresholds against Dynatrace metric series. A threshold
 * that is null is skipped entirely: no value, no alert.
 * @param {Array<Record<string, any>>} series from the Dynatrace adapter
 * @param {Record<string, any>} thresholds manifest.monitoring.thresholds
 * @param {(entity: { id: string | null, name: string | null }) => string | null} resolveService
 * @param {string} at ISO timestamp for the signal
 * @returns {Signal[]}
 */
export function thresholdSignals(series, thresholds, resolveService, at) {
  /** @type {Signal[]} */
  const signals = [];
  for (const item of series) {
    if (typeof item.max !== 'number') continue;
    const id = String(item.metricId ?? '').toLowerCase();
    /** @type {{ key: string, limit: number, observed: number, unit: string } | null} */
    let check = null;
    if (/error|failure/.test(id) && /rate/.test(id) && typeof thresholds.errorRatePercent === 'number') {
      check = { key: 'errorRatePercent', limit: thresholds.errorRatePercent, observed: item.max, unit: '%' };
    } else if (/response\.time|latency|duration/.test(id) && typeof thresholds.p95LatencyMs === 'number') {
      // Dynatrace reports service response time in microseconds.
      const toMs = /micro/i.test(String(item.unit ?? '')) ? 1 / 1000 : 1;
      check = { key: 'p95LatencyMs', limit: thresholds.p95LatencyMs, observed: item.max * toMs, unit: 'ms' };
    }
    if (!check || check.observed <= check.limit) continue;
    const service = resolveService({ id: item.entity ?? null, name: item.dimensions?.['dt.entity.service.name'] ?? null }) ?? item.entity ?? null;
    const toMs = check.key === 'p95LatencyMs' && /micro/i.test(String(item.unit ?? '')) ? 1 / 1000 : 1;
    signals.push({
      source: 'threshold',
      service,
      timestamp: at,
      sourceTimeZone: 'Z',
      fingerprint: fingerprintOf('threshold', service, check.key),
      summary: `${check.key} breached: observed ${round(check.observed)}${check.unit}, threshold ${check.limit}${check.unit}`,
      exceptionClass: null,
      traceId: null,
      spanId: null,
      requestId: null,
      evidenceLink: null,
      metric: {
        metric: String(item.metricId),
        observed: round(check.observed),
        threshold: check.limit,
        baseline: typeof item.avg === 'number' ? round(item.avg * toMs) : null,
        unit: check.unit,
      },
      severityHint: check.observed >= check.limit * 2 ? 'high' : 'medium',
    });
  }
  return signals;
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100;
}

export const SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);

/**
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 */
export function maxSeverity(a, b) {
  const index = Math.max(SEVERITIES.indexOf(/** @type {any} */ (a ?? 'low')), SEVERITIES.indexOf(/** @type {any} */ (b ?? 'low')), 0);
  return SEVERITIES[index];
}
