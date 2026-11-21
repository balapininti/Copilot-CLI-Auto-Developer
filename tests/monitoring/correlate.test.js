import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildCandidates, confidenceOf, dedupeKeyOf, serviceResolver } from '../../src/monitoring/correlate.js';
import { manifestWithDefaults } from './fixtures.js';

const T0 = Date.parse('2026-01-05T10:00:00.000Z');
const iso = (/** @type {number} */ seconds) => new Date(T0 + seconds * 1000).toISOString();

/** @param {Record<string, any>} [extra] */
function log(extra = {}) {
  return {
    source: 'splunk', service: 'orders-service', timestamp: iso(0), fingerprint: 'fp-log', summary: 'ERROR boom',
    exceptionClass: 'java.lang.NullPointerException', traceId: null, spanId: null, requestId: null, deploymentVersion: null,
    evidenceLink: 'https://splunk/s', sourceTimeZone: 'Z', metric: null, severityHint: null, ...extra,
  };
}
/** @param {Record<string, any>} [extra] */
function problem(extra = {}) {
  return {
    source: 'dynatrace-problem', service: 'orders-service', timestamp: iso(-60), endTimestamp: null, fingerprint: 'fp-problem',
    summary: 'Failure rate increase', exceptionClass: null, traceId: null, spanId: null, requestId: null,
    evidenceLink: 'https://dt/p', sourceTimeZone: 'Z', metric: null, severityHint: 'high', ...extra,
  };
}
/** @param {Record<string, any>} [extra] */
function breach(extra = {}) {
  return {
    source: 'threshold', service: 'orders-service', timestamp: iso(30), fingerprint: 'fp-threshold', summary: 'p95LatencyMs breached',
    exceptionClass: null, traceId: null, spanId: null, requestId: null, evidenceLink: null, sourceTimeZone: 'Z',
    metric: { metric: 'm', observed: 2000, threshold: 1500, baseline: 900, unit: 'ms' }, severityHint: 'medium', ...extra,
  };
}

/** @param {Record<string, any>} [thresholds] @param {number} [windowSeconds] */
function monitoring(thresholds = {}, windowSeconds = 300) {
  const m = manifestWithDefaults().monitoring;
  return { ...m, correlation: { ...m.correlation, windowSeconds }, thresholds: { errorCount: null, errorRatePercent: null, p95LatencyMs: null, ...thresholds } };
}

/** @param {any[]} signals @param {any} [config] */
const build = (signals, config = monitoring()) => buildCandidates(/** @type {any} */ (signals), config);

describe('buildCandidates: grouping', () => {
  test('log signals with the same service and fingerprint become one candidate with counted occurrences', () => {
    const [candidate, ...rest] = build([log({ timestamp: iso(20) }), log({ timestamp: iso(0) }), log({ timestamp: iso(40) })]);
    assert.equal(rest.length, 0);
    assert.equal(candidate.occurrences, 3);
    assert.equal(candidate.firstSeen, iso(0));
    assert.equal(candidate.lastSeen, iso(40));
    assert.deepEqual(candidate.sources, ['splunk']);
    assert.deepEqual(candidate.triggers, ['exception-observed']);
  });

  test('different fingerprints or services stay separate', () => {
    assert.equal(build([log(), log({ fingerprint: 'other' }), log({ service: 'payments-service' })]).length, 3);
  });

  test('no signals gives no candidates', () => {
    assert.deepEqual(build([]), []);
  });

  test('trace ids are de-duplicated and capped; samples are capped', () => {
    const signals = Array.from({ length: 30 }, (_, index) => log({ timestamp: iso(index), traceId: `trace-${String(index % 25).padStart(4, '0')}`, summary: `sample ${index}` }));
    const [candidate] = build(signals);
    assert.equal(candidate.traceIds.length, 20);
    assert.equal(new Set(candidate.traceIds).size, 20);
    assert.ok(candidate.samples.length <= 3);
  });
});

describe('buildCandidates: joining logs to telemetry', () => {
  test('a shared trace id joins a log group and a problem (method trace-id), even far apart in time', () => {
    const candidates = build([
      log({ traceId: 'trace-0001', spanId: 'span-0001' }),
      problem({ traceId: 'trace-0001', timestamp: iso(-36_000) }),
    ]);
    assert.equal(candidates.length, 1);
    const [candidate] = candidates;
    assert.equal(candidate.correlation.method, 'trace-id');
    assert.deepEqual(candidate.sources.sort(), ['dynatrace-problem', 'splunk']);
    assert.deepEqual(candidate.evidenceLinks.sort(), ['https://dt/p', 'https://splunk/s']);
    assert.deepEqual(candidate.absorbedFingerprints, ['fp-problem']);
    assert.ok(candidate.triggers.includes('dynatrace-problem'));
    assert.equal(candidate.firstSeen, iso(-36_000));
    assert.equal(candidate.severity, 'high');
    assert.equal(candidate.fingerprint, 'fp-log');
    assert.equal(candidate.occurrences, 1);
    assert.deepEqual(candidate.correlation.missing, []);
  });

  test('with no shared trace id, overlap in time for the same service joins them (method time-and-service)', () => {
    const candidates = build([log(), problem({ timestamp: iso(-60) })]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].correlation.method, 'time-and-service');
    assert.deepEqual(candidates[0].correlation.missing, ['traceId', 'spanId']);
  });

  test('a different trace id on each side is not a trace join', () => {
    const [candidate] = build([log({ traceId: 'trace-aaaa' }), problem({ traceId: 'trace-bbbb' })]);
    assert.equal(candidate.correlation.method, 'time-and-service');
  });

  test('a closed problem outside the correlation window is not joined', () => {
    const candidates = build([log(), problem({ timestamp: iso(-3600), endTimestamp: iso(-3000) })]);
    assert.equal(candidates.length, 2);
    assert.ok(candidates.every((candidate) => candidate.correlation.method === 'none'));
    assert.ok(candidates.every((candidate) => candidate.sources.length === 1));
  });

  test('the correlation window boundary is inclusive, one second past it is not', () => {
    const at = (/** @type {number} */ gapSeconds) => build([log({ timestamp: iso(0) }), problem({ timestamp: iso(gapSeconds), endTimestamp: iso(gapSeconds) })], monitoring({}, 300));
    assert.equal(at(300).length, 1);
    assert.equal(at(301).length, 2);
    assert.equal(at(-300).length, 1);
    assert.equal(at(-301).length, 2);
  });

  test('telemetry for a different service is never joined, even with overlapping time', () => {
    const candidates = build([log(), problem({ service: 'payments-service' })]);
    assert.equal(candidates.length, 2);
    assert.ok(candidates.every((candidate) => candidate.correlation.method === 'none'));
  });

  test('signals with no identified service are never joined to each other', () => {
    const candidates = build([log({ service: null }), problem({ service: null })]);
    assert.equal(candidates.length, 2);
    for (const candidate of candidates) assert.ok(candidate.correlation.missing.includes('service'));
  });

  test('a threshold breach joins the log group and is recorded as threshold-breached with its metric', () => {
    const [candidate, ...rest] = build([log(), breach()]);
    assert.equal(rest.length, 0);
    assert.ok(candidate.triggers.includes('threshold-breached'));
    assert.equal(candidate.metric?.observed, 2000);
  });

  test('one problem is consumed by only one log group', () => {
    const candidates = build([log(), log({ fingerprint: 'fp-second' }), problem()]);
    assert.equal(candidates.length, 2);
    assert.equal(candidates.filter((candidate) => candidate.sources.includes('dynatrace-problem')).length, 1);
  });

  test('a standalone problem or breach becomes its own candidate with missing ids recorded', () => {
    const candidates = build([problem({ service: 'payments-service' }), breach({ service: 'billing' })]);
    assert.equal(candidates.length, 2);
    const p = candidates.find((candidate) => candidate.fingerprint === 'fp-problem');
    const b = candidates.find((candidate) => candidate.fingerprint === 'fp-threshold');
    assert.deepEqual(p?.triggers, ['dynatrace-problem']);
    assert.deepEqual(b?.triggers, ['threshold-breached']);
    assert.deepEqual(p?.correlation.missing, ['traceId', 'spanId']);
    assert.equal(p?.correlation.method, 'none');
    assert.equal(b?.exceptionClass, null);
  });

  test('missing ids are recorded on the candidate and never filled in', () => {
    const [withTraceOnly] = build([log({ traceId: 'trace-0001' })]);
    assert.deepEqual(withTraceOnly.correlation.missing, ['spanId']);
    assert.equal(withTraceOnly.spanId, null);
    const [neither] = build([log()]);
    assert.deepEqual(neither.correlation.missing, ['traceId', 'spanId']);
    assert.deepEqual(neither.traceIds, []);
    assert.equal(neither.requestId, null);
  });
});

describe('buildCandidates: errorCount threshold', () => {
  test('log groups below the configured count are dropped', () => {
    const signals = [log(), log({ timestamp: iso(1) })];
    assert.equal(build(signals, monitoring({ errorCount: 3 })).length, 0);
  });

  test('log groups at the count are kept and say why', () => {
    const signals = [log(), log({ timestamp: iso(1) }), log({ timestamp: iso(2) })];
    const [candidate] = build(signals, monitoring({ errorCount: 3 }));
    assert.equal(candidate.occurrences, 3);
    assert.deepEqual(candidate.triggers, ['errorCount >= 3']);
    assert.equal(candidate.severity, 'medium');
  });

  test('five times the count is high severity', () => {
    const signals = Array.from({ length: 10 }, (_, index) => log({ timestamp: iso(index) }));
    assert.equal(build(signals, monitoring({ errorCount: 2 }))[0].severity, 'high');
  });

  test('a filtered-out log group does not swallow the telemetry for its service', () => {
    const candidates = build([log(), problem()], monitoring({ errorCount: 5 }));
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0].sources, ['dynatrace-problem']);
  });

  test('with no errorCount configured every exception is reported as exception-observed', () => {
    assert.deepEqual(build([log()], monitoring({ errorCount: null }))[0].triggers, ['exception-observed']);
  });
});

describe('confidenceOf', () => {
  test('logs and telemetry sharing a trace id: high', () => {
    const [candidate] = build([log({ traceId: 'trace-0001', spanId: 'span-0001' }), problem({ traceId: 'trace-0001' })]);
    const confidence = confidenceOf(candidate);
    assert.equal(confidence.label, 'high');
    assert.equal(confidence.score, 0.7);
    assert.ok(confidence.reasons.some((reason) => /share a trace id/.test(reason)));
  });

  test('logs and telemetry joined by time only: medium, and the reason says there is no shared trace id', () => {
    const [candidate] = build([log(), problem()]);
    const confidence = confidenceOf(candidate);
    assert.equal(confidence.label, 'medium');
    assert.ok(confidence.reasons.some((reason) => /no shared trace id/.test(reason)));
    assert.ok(confidence.reasons.includes('traceId not present in the source data'));
    assert.ok(confidence.reasons.includes('spanId not present in the source data'));
  });

  test('a single source: low', () => {
    const confidence = confidenceOf(build([log()])[0]);
    assert.equal(confidence.label, 'low');
    assert.ok(confidence.reasons.includes('single source only'));
  });

  test('an unidentified service lowers the score, which never leaves 0.05..0.95', () => {
    const confidence = confidenceOf(build([log({ service: null })])[0]);
    assert.equal(confidence.label, 'low');
    assert.ok(confidence.score >= 0.05 && confidence.score < 0.3);
    const best = build([
      ...Array.from({ length: 6 }, (_, index) => log({ traceId: 'trace-0001', spanId: 'span-0001', timestamp: iso(index) })),
      problem({ traceId: 'trace-0001' }),
      breach(),
    ])[0];
    const top = confidenceOf(best);
    assert.ok(top.score <= 0.95);
    assert.equal(top.label, 'high');
  });

  test('many occurrences and a breached threshold each raise the score', () => {
    const one = confidenceOf(build([log()])[0]).score;
    const many = confidenceOf(build(Array.from({ length: 5 }, (_, index) => log({ timestamp: iso(index) })))[0]).score;
    const breached = confidenceOf(build([breach()])[0]).score;
    assert.ok(many > one);
    assert.ok(breached > one);
  });

  test('a missing span id lowers the confidence score', () => {
    const withSpan = confidenceOf(build([log({ traceId: 'trace-0001', spanId: 'span-0001' }), problem({ traceId: 'trace-0001' })])[0]);
    const withoutSpan = confidenceOf(build([log({ traceId: 'trace-0001' }), problem({ traceId: 'trace-0001' })])[0]);
    assert.ok(withoutSpan.score < withSpan.score, `${withoutSpan.score} should be below ${withSpan.score}`);
  });
});

describe('serviceResolver and dedupeKeyOf', () => {
  const manifest = manifestWithDefaults({
    services: [
      { name: 'orders-service', repository: 'service-api', aliases: ['Orders-API'], dynatraceEntityId: 'SERVICE-ORDERS0001' },
      { name: 'payments-service', repository: 'service-api' },
    ],
  });
  const resolve = serviceResolver(manifest);

  test('resolves by Dynatrace entity id first, then by name or alias, case-insensitively', () => {
    assert.equal(resolve({ id: 'SERVICE-ORDERS0001', name: 'something else' }), 'orders-service');
    assert.equal(resolve({ id: 'SERVICE-UNKNOWN', name: 'PAYMENTS-SERVICE' }), 'payments-service');
    assert.equal(resolve({ id: null, name: 'orders-api' }), 'orders-service');
  });

  test('unknown or empty entities resolve to null', () => {
    assert.equal(resolve({ id: 'SERVICE-X', name: 'nope' }), null);
    assert.equal(resolve({ id: null, name: null }), null);
    assert.equal(resolve(/** @type {any} */ (null)), null);
  });

  test('a service without an entity id is never matched by a null id', () => {
    assert.equal(resolve({ id: /** @type {any} */ (undefined), name: null }), null);
  });

  test('dedupe keys are stable and scoped by project, environment, service and fingerprint', () => {
    const key = dedupeKeyOf('orders', 'nonprod', 'svc', 'fp');
    assert.equal(key, dedupeKeyOf('orders', 'nonprod', 'svc', 'fp'));
    assert.match(key, /^[0-9a-f]{24}$/);
    assert.notEqual(key, dedupeKeyOf('billing', 'nonprod', 'svc', 'fp'));
    assert.notEqual(key, dedupeKeyOf('orders', 'prod', 'svc', 'fp'));
    assert.notEqual(key, dedupeKeyOf('orders', 'nonprod', 'other', 'fp'));
    assert.notEqual(key, dedupeKeyOf('orders', 'nonprod', 'svc', 'fp2'));
    assert.equal(dedupeKeyOf('orders', null, null, 'fp'), dedupeKeyOf('orders', /** @type {any} */ (undefined), /** @type {any} */ (undefined), 'fp'));
  });
});
