/**
 * Correlation and grouping: signals in, incident candidates out.
 *
 * Signals are grouped by service and fingerprint, then log groups are joined
 * to Dynatrace problems and threshold breaches for the same service: by a
 * shared trace id when one exists (strong), otherwise by overlapping time
 * (weaker, and labelled as such). A trace id is a lead to follow, not proof
 * of root cause, so correlation alone never classifies anything as verified.
 */

import { hashOf } from '../core/hash.js';
import { findService } from '../core/project-context.js';
import { maxSeverity } from './incident-model.js';

/**
 * Build a function that maps a telemetry entity to a configured service name.
 * @param {Record<string, any>} manifest
 * @returns {(entity: { id: string | null, name: string | null }) => string | null}
 */
export function serviceResolver(manifest) {
  return (entity) => {
    if (!entity) return null;
    const byId = entity.id ? manifest.services.find((/** @type {any} */ s) => s.dynatraceEntityId && s.dynatraceEntityId === entity.id) : null;
    return byId?.name ?? findService(manifest, entity.name)?.name ?? null;
  };
}

/**
 * @param {string} projectId
 * @param {string | null} environment
 * @param {string | null} service
 * @param {string} fingerprint
 */
export function dedupeKeyOf(projectId, environment, service, fingerprint) {
  return hashOf({ projectId, environment: environment ?? null, service: service ?? null, fingerprint }).slice(0, 24);
}

/**
 * @typedef {object} Candidate
 * @property {string | null} service
 * @property {string} fingerprint
 * @property {string} firstSeen
 * @property {string} lastSeen
 * @property {number} occurrences
 * @property {string[]} sources
 * @property {string} summary
 * @property {string | null} exceptionClass
 * @property {string[]} traceIds
 * @property {string | null} spanId
 * @property {string | null} requestId
 * @property {string[]} evidenceLinks
 * @property {string[]} sourceTimeZones
 * @property {string[]} deploymentVersions
 * @property {Record<string, any> | null} metric
 * @property {string} severity
 * @property {string[]} triggers
 * @property {{ method: 'trace-id' | 'time-and-service' | 'none', missing: string[] }} correlation
 * @property {string[]} samples
 * @property {string[]} absorbedFingerprints fingerprints of telemetry signals merged into this candidate
 */

/**
 * @param {import('./incident-model.js').Signal[]} signals
 * @returns {Candidate}
 */
function groupToCandidate(signals) {
  const sorted = [...signals].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const first = sorted[0];
  const uniq = (/** @type {Array<string | null | undefined>} */ values) =>
    /** @type {string[]} */ ([...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))]);
  const lastSeen = sorted.reduce((latest, signal) => {
    const end = signal.endTimestamp ?? signal.timestamp;
    return end > latest ? end : latest;
  }, first.timestamp);
  return {
    service: first.service,
    fingerprint: first.fingerprint,
    firstSeen: first.timestamp,
    lastSeen,
    occurrences: sorted.length,
    sources: uniq(sorted.map((signal) => signal.source)),
    summary: first.summary,
    exceptionClass: sorted.find((signal) => signal.exceptionClass)?.exceptionClass ?? null,
    traceIds: /** @type {string[]} */ (uniq(sorted.map((signal) => signal.traceId))).slice(0, 20),
    spanId: sorted.find((signal) => signal.spanId)?.spanId ?? null,
    requestId: sorted.find((signal) => signal.requestId)?.requestId ?? null,
    evidenceLinks: /** @type {string[]} */ (uniq(sorted.map((signal) => signal.evidenceLink))),
    sourceTimeZones: /** @type {string[]} */ (uniq(sorted.map((signal) => signal.sourceTimeZone))),
    deploymentVersions: /** @type {string[]} */ (uniq(sorted.map((signal) => signal.deploymentVersion))),
    metric: sorted.find((signal) => signal.metric)?.metric ?? null,
    severity: sorted.reduce((severity, signal) => maxSeverity(severity, signal.severityHint), 'low'),
    triggers: [],
    correlation: { method: 'none', missing: [] },
    samples: /** @type {string[]} */ (uniq(sorted.map((signal) => signal.summary))).slice(0, 3),
    absorbedFingerprints: [],
  };
}

/**
 * @param {Candidate} a
 * @param {Candidate} b
 * @param {number} windowMs
 */
function overlaps(a, b, windowMs) {
  return Date.parse(a.firstSeen) <= Date.parse(b.lastSeen) + windowMs && Date.parse(b.firstSeen) <= Date.parse(a.lastSeen) + windowMs;
}

/**
 * Merge `other` into `target`.
 * @param {Candidate} target
 * @param {Candidate} other
 * @param {'trace-id' | 'time-and-service'} method
 */
function absorb(target, other, method) {
  target.firstSeen = other.firstSeen < target.firstSeen ? other.firstSeen : target.firstSeen;
  target.lastSeen = other.lastSeen > target.lastSeen ? other.lastSeen : target.lastSeen;
  target.sources = [...new Set([...target.sources, ...other.sources])];
  target.traceIds = [...new Set([...target.traceIds, ...other.traceIds])].slice(0, 20);
  target.evidenceLinks = [...new Set([...target.evidenceLinks, ...other.evidenceLinks])];
  target.sourceTimeZones = [...new Set([...target.sourceTimeZones, ...other.sourceTimeZones])];
  target.deploymentVersions = [...new Set([...target.deploymentVersions, ...other.deploymentVersions])];
  target.samples = [...new Set([...target.samples, ...other.samples])].slice(0, 5);
  target.metric = target.metric ?? other.metric;
  target.severity = maxSeverity(target.severity, other.severity);
  target.spanId = target.spanId ?? other.spanId;
  target.requestId = target.requestId ?? other.requestId;
  target.absorbedFingerprints.push(other.fingerprint);
  if (target.correlation.method !== 'trace-id') target.correlation.method = method;
}

/**
 * @param {import('./incident-model.js').Signal[]} signals
 * @param {Record<string, any>} monitoring manifest.monitoring
 * @returns {Candidate[]}
 */
export function buildCandidates(signals, monitoring) {
  /** @type {Map<string, import('./incident-model.js').Signal[]>} */
  const groups = new Map();
  for (const signal of signals) {
    const key = `${signal.source === 'splunk' ? 'log' : signal.source}|${signal.service ?? ''}|${signal.fingerprint}`;
    const group = groups.get(key) ?? [];
    group.push(signal);
    groups.set(key, group);
  }
  const all = [...groups.values()].map(groupToCandidate);
  const logs = all.filter((candidate) => candidate.sources.includes('splunk'));
  const others = all.filter((candidate) => !candidate.sources.includes('splunk'));
  const windowMs = monitoring.correlation.windowSeconds * 1000;
  const errorThreshold = monitoring.thresholds.errorCount;

  /** @type {Candidate[]} */
  const result = [];
  /** @type {Set<Candidate>} */
  const consumed = new Set();

  for (const log of logs) {
    if (typeof errorThreshold === 'number') {
      if (log.occurrences < errorThreshold) continue; // below the team's configured threshold
      log.triggers.push(`errorCount >= ${errorThreshold}`);
      log.severity = maxSeverity(log.severity, log.occurrences >= errorThreshold * 5 ? 'high' : 'medium');
    } else {
      log.triggers.push('exception-observed');
    }
    for (const other of others) {
      if (consumed.has(other) || other.service !== log.service || !log.service) continue;
      const sharedTrace = other.traceIds.some((id) => log.traceIds.includes(id));
      if (sharedTrace) {
        absorb(log, other, 'trace-id');
      } else if (overlaps(log, other, windowMs)) {
        absorb(log, other, 'time-and-service');
      } else {
        continue;
      }
      consumed.add(other);
      log.triggers.push(other.metric ? 'threshold-breached' : 'dynatrace-problem');
    }
    if (log.traceIds.length === 0) log.correlation.missing.push('traceId');
    if (!log.spanId) log.correlation.missing.push('spanId');
    if (!log.service) log.correlation.missing.push('service');
    result.push(log);
  }

  for (const other of others) {
    if (consumed.has(other)) continue;
    other.triggers.push(other.metric ? 'threshold-breached' : 'dynatrace-problem');
    if (other.traceIds.length === 0) other.correlation.missing.push('traceId');
    other.correlation.missing.push('spanId');
    if (!other.service) other.correlation.missing.push('service');
    result.push(other);
  }
  return result;
}

/**
 * Confidence that the grouped signals describe one real incident. This is
 * about the incident being real and correctly grouped, not about its cause.
 * @param {Candidate} candidate
 * @returns {{ score: number, label: 'low' | 'medium' | 'high', reasons: string[] }}
 */
export function confidenceOf(candidate) {
  let score = 0.3;
  const reasons = [];
  if (candidate.sources.length > 1) {
    if (candidate.correlation.method === 'trace-id') {
      score += 0.4;
      reasons.push('logs and telemetry share a trace id');
    } else {
      score += 0.2;
      reasons.push('logs and telemetry overlap in time for the same service (no shared trace id)');
    }
  } else {
    reasons.push('single source only');
  }
  if (candidate.occurrences >= 5) {
    score += 0.1;
    reasons.push(`${candidate.occurrences} occurrences`);
  }
  if (candidate.metric) {
    score += 0.1;
    reasons.push('a configured threshold was breached');
  }
  if (!candidate.service) {
    score -= 0.2;
    reasons.push('service could not be identified');
  }
  for (const missing of candidate.correlation.missing) {
    // Each identifier the sources did not supply makes the grouping less certain.
    if (missing === 'traceId' || missing === 'spanId') score -= 0.02;
    reasons.push(`${missing} not present in the source data`);
  }
  const bounded = Math.max(0.05, Math.min(0.95, Math.round(score * 100) / 100));
  return { score: bounded, label: bounded >= 0.7 ? 'high' : bounded >= 0.45 ? 'medium' : 'low', reasons };
}
