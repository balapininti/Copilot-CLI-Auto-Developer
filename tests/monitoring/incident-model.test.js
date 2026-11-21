import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyEvent, fingerprintOf, maxSeverity, normalizeMessage, signalFromProblem, signalFromSplunk, Status, thresholdSignals, transition,
} from '../../src/monitoring/incident-model.js';
import { expectCode } from '../helpers.js';

const CORRELATION = {
  traceIdFields: ['trace_id', 'traceId'],
  spanIdFields: ['span_id', 'spanId'],
  requestIdFields: ['request_id', 'requestId'],
  serviceNameFields: ['service', 'application'],
  windowSeconds: 300,
};

describe('incident lifecycle transitions', () => {
  const valid = [
    ['detected', 'mapping-missing', 'needs-onboarding'],
    ['detected', 'defect-proposed', 'defect-proposed'],
    ['detected', 'defect-created', 'defect-created'],
    ['detected', 'existing-defect-linked', 'defect-created'],
    ['needs-onboarding', 'mapping-resolved', 'detected'],
    ['defect-proposed', 'defect-created', 'defect-created'],
    ['defect-proposed', 'defect-denied', 'defect-denied'],
    ['defect-proposed', 'approval-lapsed', 'detected'],
    ['defect-denied', 'reopened', 'detected'],
    ['defect-created', 'handoff-queued', 'handoff-queued'],
    ['handoff-queued', 'development-started', 'development-started'],
    ['development-started', 'pr-created', 'pr-created'],
    ['pr-created', 'deployment-recorded', 'validation-pending'],
    ['validation-pending', 'resolution-verified', 'resolved-verified'],
    ['validation-pending', 'still-occurring', 'validation-pending'],
    ['resolved-verified', 'closed', 'closed'],
  ];
  for (const [from, event, to] of valid) {
    test(`${from} --${event}--> ${to}`, () => {
      assert.equal(transition(from, event), to);
    });
  }

  test('every non-closed state can be closed', () => {
    for (const status of Object.values(Status)) {
      if (status === Status.CLOSED) continue;
      assert.equal(transition(status, 'closed'), Status.CLOSED);
    }
  });

  const invalid = [
    ['closed', 'closed'],
    ['closed', 'reopened'],
    ['detected', 'handoff-queued'],
    ['detected', 'development-started'],
    ['needs-onboarding', 'defect-proposed'],
    ['defect-proposed', 'handoff-queued'],
    ['defect-denied', 'defect-created'],
    ['defect-created', 'pr-created'],
    ['handoff-queued', 'pr-created'],
    ['pr-created', 'resolution-verified'],
    ['resolved-verified', 'still-occurring'],
    ['no-such-state', 'closed'],
    ['detected', ''],
  ];
  for (const [from, event] of invalid) {
    test(`${from} cannot take "${event}"`, async () => {
      const error = await expectCode(() => transition(from, event), 'CONFLICT');
      assert.equal(error.details.status, from);
      assert.ok(Array.isArray(error.details.allowed));
    });
  }

  test('a ticket cannot be skipped: detected cannot jump straight to a PR or to verified', async () => {
    await expectCode(() => transition('detected', 'pr-created'), 'CONFLICT');
    await expectCode(() => transition('detected', 'resolution-verified'), 'CONFLICT');
  });

  test('event names inherited from Object.prototype are rejected', async () => {
    for (const event of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      await expectCode(() => transition('detected', event), 'CONFLICT');
    }
  });

  test('applyEvent updates the status and appends history with from/to', () => {
    const incident = { status: 'detected', history: [] };
    applyEvent(incident, 'defect-proposed', { approvalId: 'apr-1' });
    assert.equal(incident.status, 'defect-proposed');
    assert.equal(incident.history.length, 1);
    assert.deepEqual(
      { event: incident.history[0].event, from: incident.history[0].from, to: incident.history[0].to, approvalId: incident.history[0].approvalId },
      { event: 'defect-proposed', from: 'detected', to: 'defect-proposed', approvalId: 'apr-1' },
    );
  });

  test('applyEvent leaves the incident untouched when the transition is invalid', async () => {
    const incident = { status: 'closed', history: [] };
    await expectCode(() => applyEvent(incident, 'reopened'), 'CONFLICT');
    assert.equal(incident.status, 'closed');
    assert.equal(incident.history.length, 0);
  });
});

describe('normalizeMessage and fingerprints', () => {
  test('ids, numbers, quoted values, uuids, hex and timestamps are masked', () => {
    const a = normalizeMessage('2026-01-05T10:11:12.123Z ERROR order 88213 failed for "jane" id=550e8400-e29b-41d4-a716-446655440000 ptr=0xdeadbeef trace 4bf92f3577b34da6a3ce929d0e0e4736');
    const b = normalizeMessage('2025-12-31 23:59:59,001+0100 ERROR order 7 failed for "bob smith" id=123e4567-e89b-12d3-a456-426614174000 ptr=0x1 trace 00000000000000000000000000000001');
    assert.equal(a, b);
    assert.ok(!/\d/.test(a), a);
  });

  test('different message shapes stay different', () => {
    assert.notEqual(normalizeMessage('ERROR order 1 failed'), normalizeMessage('ERROR payment 1 failed'));
  });

  test('whitespace is collapsed, output is bounded, and non-strings do not throw', () => {
    assert.equal(normalizeMessage('  a \t\n  b  '), 'a b');
    assert.ok(normalizeMessage('x '.repeat(5000)).length <= 300);
    assert.equal(normalizeMessage(/** @type {any} */ (null)), '');
    assert.equal(normalizeMessage(/** @type {any} */ (undefined)), '');
    assert.equal(typeof normalizeMessage(/** @type {any} */ ({ a: 1 })), 'string');
  });

  test('fingerprintOf is deterministic, 16 hex chars, and separates its parts', () => {
    assert.equal(fingerprintOf('a', 'b'), fingerprintOf('a', 'b'));
    assert.match(fingerprintOf('a', 'b'), /^[0-9a-f]{16}$/);
    assert.notEqual(fingerprintOf('ab', 'c'), fingerprintOf('a', 'bc'));
    assert.equal(fingerprintOf('a', null), fingerprintOf('a', undefined));
  });

  test('the same exception at different times, for different orders and traces, has one fingerprint', () => {
    const make = (/** @type {string} */ time, /** @type {number} */ order, /** @type {string} */ trace) =>
      signalFromSplunk(
        {
          _time: time,
          service: 'orders-service',
          trace_id: trace,
          _raw: `${time} ERROR Failed to price order ${order}\njava.lang.NullPointerException: "discount" is null\n\tat com.example.orders.PricingService.applyDiscount(PricingService.java:87)`,
        },
        CORRELATION,
      );
    const a = make('2026-01-05T10:00:00.000Z', 88213, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const b = make('2026-02-07T22:13:45.999Z', 5, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    assert.equal(a?.fingerprint, b?.fingerprint);
  });

  test('messages without an exception class are fingerprinted by their normalised first line', () => {
    const make = (/** @type {string} */ raw) => signalFromSplunk({ _time: '2026-01-05T10:00:00Z', service: 'orders-service', _raw: raw }, CORRELATION);
    assert.equal(make('2026-01-05T10:00:00Z ERROR upstream returned 503 for request 17')?.fingerprint, make('2026-01-06T11:00:00Z ERROR upstream returned 502 for request 99')?.fingerprint);
    assert.notEqual(make('ERROR upstream returned 503')?.fingerprint, make('ERROR cache eviction failed')?.fingerprint);
  });

  test('a different service or a different top frame gives a different fingerprint', () => {
    const make = (/** @type {string} */ service, /** @type {string} */ frame) =>
      signalFromSplunk({ _time: '2026-01-05T10:00:00Z', service, _raw: `ERROR x\njava.lang.IllegalStateException: no\n\tat ${frame}(File.java:1)` }, CORRELATION);
    assert.notEqual(make('a-service', 'com.A.run')?.fingerprint, make('b-service', 'com.A.run')?.fingerprint);
    assert.notEqual(make('a-service', 'com.A.run')?.fingerprint, make('a-service', 'com.B.run')?.fingerprint);
  });
});

describe('signalFromSplunk', () => {
  test('extracts service, ids, version and exception class from event fields', () => {
    const signal = signalFromSplunk(
      {
        _time: '2026-01-05T12:00:00.000+02:00',
        service: 'orders-service',
        trace_id: 'trace-abc-123',
        span_id: 'span-0001',
        request_id: 'req-42-xyz',
        version: '2.14.0',
        _raw: 'ERROR boom\njava.lang.NullPointerException: x\n\tat com.example.Foo.bar(Foo.java:1)',
      },
      CORRELATION,
      { evidenceLink: 'https://splunk.example/s' },
    );
    assert.ok(signal);
    assert.equal(signal.source, 'splunk');
    assert.equal(signal.service, 'orders-service');
    assert.equal(signal.traceId, 'trace-abc-123');
    assert.equal(signal.spanId, 'span-0001');
    assert.equal(signal.requestId, 'req-42-xyz');
    assert.equal(signal.deploymentVersion, '2.14.0');
    assert.equal(signal.exceptionClass, 'java.lang.NullPointerException');
    assert.equal(signal.timestamp, '2026-01-05T10:00:00.000Z');
    assert.equal(signal.sourceTimeZone, '+02:00');
    assert.equal(signal.evidenceLink, 'https://splunk.example/s');
    assert.equal(signal.metric, null);
  });

  test('falls back to the second configured field name (application, traceId, spanId)', () => {
    const signal = signalFromSplunk({ _time: '2026-01-05T10:00:00Z', application: 'pay', traceId: 'abcd1234', spanId: 'ef567890', _raw: 'ERROR x' }, CORRELATION);
    assert.equal(signal?.service, 'pay');
    assert.equal(signal?.traceId, 'abcd1234');
    assert.equal(signal?.spanId, 'ef567890');
  });

  test('extracts ids and service from _raw in key=value and JSON forms', () => {
    const kv = signalFromSplunk({ _time: '2026-01-05T10:00:00Z', _raw: 'ERROR failed service=orders-service trace_id=4bf92f3577b34da6 span_id=00f067aa0ba902b7 request_id=req-9911' }, CORRELATION);
    assert.equal(kv?.service, 'orders-service');
    assert.equal(kv?.traceId, '4bf92f3577b34da6');
    assert.equal(kv?.spanId, '00f067aa0ba902b7');
    assert.equal(kv?.requestId, 'req-9911');

    const json = signalFromSplunk({ _time: '2026-01-05T10:00:00Z', _raw: '{"level":"ERROR","service":"orders-service","traceId":"aaaa1111bbbb2222","spanId": "cccc3333"}' }, CORRELATION);
    assert.equal(json?.service, 'orders-service');
    assert.equal(json?.traceId, 'aaaa1111bbbb2222');
    assert.equal(json?.spanId, 'cccc3333');
  });

  test('a longer key that merely ends in the field name is not mistaken for it', () => {
    const signal = signalFromSplunk({ _time: '2026-01-05T10:00:00Z', _raw: 'ERROR parent_span_id=11112222 my_trace_id=33334444' }, CORRELATION);
    assert.equal(signal?.spanId, null);
    assert.equal(signal?.traceId, null);
  });

  test('ids that are absent stay null; nothing is invented', () => {
    const signal = signalFromSplunk({ _time: '2026-01-05T10:00:00Z', service: 'orders-service', _raw: 'ERROR something broke' }, CORRELATION);
    assert.ok(signal);
    assert.equal(signal.traceId, null);
    assert.equal(signal.spanId, null);
    assert.equal(signal.requestId, null);
    assert.equal(signal.deploymentVersion, null);
    assert.equal(signal.exceptionClass, null);
    assert.equal(signal.evidenceLink, null);
  });

  test('implausible id values (too short, non-string, with spaces) are ignored', () => {
    const signal = signalFromSplunk({ _time: '2026-01-05T10:00:00Z', trace_id: 'abc', span_id: 12345678, request_id: 'has space in it', _raw: 'ERROR x' }, CORRELATION);
    assert.equal(signal?.traceId, null);
    assert.equal(signal?.spanId, null);
    assert.equal(signal?.requestId, null);
  });

  test('returns null when the event has no usable timestamp', () => {
    assert.equal(signalFromSplunk({ service: 'x', _raw: 'ERROR no time' }, CORRELATION), null);
    assert.equal(signalFromSplunk({ _time: 'not a date', _raw: 'ERROR' }, CORRELATION), null);
    assert.equal(signalFromSplunk({ _time: null, timestamp: undefined, _raw: 'ERROR' }, CORRELATION), null);
  });

  test('uses `timestamp` when `_time` is absent, and `message` when `_raw` is absent', () => {
    const signal = signalFromSplunk({ timestamp: '2026-01-05T10:00:00Z', message: 'ERROR java.io.IOException: disk' }, CORRELATION);
    assert.equal(signal?.timestamp, '2026-01-05T10:00:00.000Z');
    assert.equal(signal?.exceptionClass, 'java.io.IOException');
  });

  test('the summary is one sanitized line: no email, no bearer token, no stack frames', () => {
    const signal = signalFromSplunk(
      { _time: '2026-01-05T10:00:00Z', service: 's', _raw: 'ERROR login failed for jane.doe@example.com Authorization: Bearer abcdef1234567890abcdef password=hunter2hunter2\n\tat com.A.b(A.java:1)' },
      CORRELATION,
    );
    assert.ok(signal);
    assert.ok(!signal.summary.includes('jane.doe@example.com'));
    assert.ok(!signal.summary.includes('abcdef1234567890abcdef'));
    assert.ok(!signal.summary.includes('hunter2hunter2'));
    assert.ok(!signal.summary.includes('\n'));
    assert.ok(signal.summary.length <= 400);
  });

  test('FATAL raises the severity hint', () => {
    assert.equal(signalFromSplunk({ _time: '2026-01-05T10:00:00Z', _raw: 'FATAL out of memory' }, CORRELATION)?.severityHint, 'high');
    assert.equal(signalFromSplunk({ _time: '2026-01-05T10:00:00Z', _raw: 'ERROR plain' }, CORRELATION)?.severityHint, null);
  });

  test('a missing requestIdFields list is tolerated', () => {
    const { requestIdFields: _omitted, ...partial } = CORRELATION;
    assert.equal(signalFromSplunk({ _time: '2026-01-05T10:00:00Z', request_id: 'req-1234', _raw: 'ERROR' }, partial)?.requestId, null);
  });

  test('regex metacharacters in configured field names are treated literally', () => {
    const correlation = { ...CORRELATION, traceIdFields: ['trace.id', 'x(y'] };
    const signal = signalFromSplunk({ _time: '2026-01-05T10:00:00Z', _raw: 'ERROR traceXid=zzzz9999 trace.id=aaaa0000' }, correlation);
    assert.equal(signal?.traceId, 'aaaa0000');
  });
});

describe('signalFromProblem', () => {
  const resolve = (/** @type {any} */ entity) => (entity.id === 'SERVICE-1' ? 'orders-service' : null);

  test('maps the root-cause entity to a configured service and carries trace id and link', () => {
    const signal = signalFromProblem(
      { title: 'Failure rate increase', severityLevel: 'ERROR', startTime: '2026-01-05T10:00:00.000Z', endTime: null, rootCauseEntity: { id: 'SERVICE-1', name: 'x' }, affectedEntities: [], traceIds: ['t-1234'], url: 'https://dt/p' },
      resolve,
    );
    assert.equal(signal.source, 'dynatrace-problem');
    assert.equal(signal.service, 'orders-service');
    assert.equal(signal.traceId, 't-1234');
    assert.equal(signal.spanId, null);
    assert.equal(signal.evidenceLink, 'https://dt/p');
    assert.equal(signal.severityHint, 'high');
    assert.equal(signal.timestamp, '2026-01-05T10:00:00.000Z');
  });

  test('an unmapped entity keeps its reported name; no entity at all leaves service null', () => {
    assert.equal(signalFromProblem({ title: 't', startTime: '2026-01-05T10:00:00.000Z', affectedEntities: [{ id: 'SERVICE-9', name: 'mystery' }] }, resolve).service, 'mystery');
    const none = signalFromProblem({ title: 't', startTime: '2026-01-05T10:00:00.000Z' }, resolve);
    assert.equal(none.service, null);
    assert.equal(none.traceId, null);
    assert.equal(none.evidenceLink, null);
  });

  test('the same problem title with different numbers shares a fingerprint; personal data in the title is masked', () => {
    const a = signalFromProblem({ title: 'Response time degradation 1500 ms for bob@example.com', startTime: '2026-01-05T10:00:00.000Z', rootCauseEntity: { id: 'SERVICE-1', name: null } }, resolve);
    const b = signalFromProblem({ title: 'Response time degradation 9000 ms for bob@example.com', startTime: '2026-01-06T10:00:00.000Z', rootCauseEntity: { id: 'SERVICE-1', name: null } }, resolve);
    assert.equal(a.fingerprint, b.fingerprint);
    assert.ok(!a.summary.includes('bob@example.com'));
  });

  test('an unknown severity level gives no severity hint', () => {
    assert.equal(signalFromProblem({ title: 't', startTime: '2026-01-05T10:00:00.000Z', severityLevel: 'CUSTOM_ALERT' }, resolve).severityHint, null);
    assert.equal(signalFromProblem({ title: 't', startTime: '2026-01-05T10:00:00.000Z', severityLevel: 'AVAILABILITY' }, resolve).severityHint, 'critical');
  });
});

describe('thresholdSignals', () => {
  const resolve = (/** @type {any} */ entity) => (entity.id === 'SERVICE-PAY' ? 'payments-service' : null);
  const AT = '2026-01-05T10:00:00.000Z';
  const latency = (/** @type {Record<string, unknown>} */ extra = {}) => ({
    metricId: 'builtin:service.response.time:percentile(95)', entity: 'SERVICE-PAY', dimensions: {}, max: 2_410_000, avg: 1_000_000, unit: 'MicroSecond', ...extra,
  });
  const errorRate = (/** @type {Record<string, unknown>} */ extra = {}) => ({
    metricId: 'builtin:service.errors.total.rate', entity: 'SERVICE-PAY', dimensions: {}, max: 12.5, avg: 3, unit: 'Percent', ...extra,
  });

  test('null thresholds are ignored entirely: no value, no alert', () => {
    const signals = thresholdSignals([latency(), errorRate()], { errorCount: null, errorRatePercent: null, p95LatencyMs: null }, resolve, AT);
    assert.deepEqual(signals, []);
    assert.deepEqual(thresholdSignals([latency(), errorRate()], {}, resolve, AT), []);
  });

  test('only the threshold that is set fires', () => {
    const onlyLatency = thresholdSignals([latency(), errorRate()], { errorRatePercent: null, p95LatencyMs: 1500 }, resolve, AT);
    assert.deepEqual(onlyLatency.map((signal) => signal.metric?.unit), ['ms']);
    const onlyErrors = thresholdSignals([latency(), errorRate()], { errorRatePercent: 5, p95LatencyMs: null }, resolve, AT);
    assert.deepEqual(onlyErrors.map((signal) => signal.metric?.unit), ['%']);
  });

  test('microseconds are converted to milliseconds for observed value and baseline', () => {
    const [signal] = thresholdSignals([latency()], { p95LatencyMs: 1500 }, resolve, AT);
    assert.equal(signal.source, 'threshold');
    assert.equal(signal.service, 'payments-service');
    assert.equal(signal.timestamp, AT);
    assert.deepEqual(signal.metric, { metric: 'builtin:service.response.time:percentile(95)', observed: 2410, threshold: 1500, baseline: 1000, unit: 'ms' });
    assert.match(signal.summary, /observed 2410ms, threshold 1500ms/);
    assert.equal(signal.traceId, null);
    assert.equal(signal.spanId, null);
    assert.equal(signal.exceptionClass, null);
  });

  test('a microsecond value that is under the limit once converted does not fire', () => {
    assert.deepEqual(thresholdSignals([latency({ max: 1_400_000 })], { p95LatencyMs: 1500 }, resolve, AT), []);
  });

  test('values already in milliseconds are not converted', () => {
    const [signal] = thresholdSignals([latency({ max: 1800, avg: 900, unit: 'MilliSecond' })], { p95LatencyMs: 1500 }, resolve, AT);
    assert.equal(signal.metric?.observed, 1800);
    assert.equal(signal.metric?.baseline, 900);
  });

  test('a value exactly at the threshold is not a breach', () => {
    assert.deepEqual(thresholdSignals([latency({ max: 1_500_000 })], { p95LatencyMs: 1500 }, resolve, AT), []);
    assert.deepEqual(thresholdSignals([errorRate({ max: 5 })], { errorRatePercent: 5 }, resolve, AT), []);
  });

  test('series with no data points are skipped', () => {
    assert.deepEqual(thresholdSignals([latency({ max: null, avg: null }), { metricId: 'x' }], { p95LatencyMs: 1 }, resolve, AT), []);
  });

  test('a threshold of zero is a real threshold', () => {
    assert.equal(thresholdSignals([errorRate({ max: 0.5 })], { errorRatePercent: 0 }, resolve, AT).length, 1);
  });

  test('severity is high at twice the threshold, otherwise medium', () => {
    assert.equal(thresholdSignals([latency({ max: 3_000_000 })], { p95LatencyMs: 1500 }, resolve, AT)[0].severityHint, 'high');
    assert.equal(thresholdSignals([latency({ max: 2_999_000 })], { p95LatencyMs: 1500 }, resolve, AT)[0].severityHint, 'medium');
  });

  test('an unmapped entity keeps its entity id as the service; a missing average leaves the baseline null', () => {
    const [signal] = thresholdSignals([latency({ entity: 'SERVICE-OTHER', avg: null })], { p95LatencyMs: 1500 }, resolve, AT);
    assert.equal(signal.service, 'SERVICE-OTHER');
    assert.equal(signal.metric?.baseline, null);
  });

  test('the fingerprint is stable per service and threshold, whatever the observed value', () => {
    const a = thresholdSignals([latency({ max: 2_000_000 })], { p95LatencyMs: 1500 }, resolve, AT)[0];
    const b = thresholdSignals([latency({ max: 9_000_000 })], { p95LatencyMs: 1500 }, resolve, '2026-02-01T00:00:00.000Z')[0];
    assert.equal(a.fingerprint, b.fingerprint);
  });

  test('unrelated metrics never fire', () => {
    assert.deepEqual(thresholdSignals([{ metricId: 'builtin:host.cpu.usage', max: 99, unit: 'Percent' }], { errorRatePercent: 1, p95LatencyMs: 1 }, resolve, AT), []);
  });
});

describe('maxSeverity', () => {
  test('picks the higher severity and tolerates null and unknown values', () => {
    assert.equal(maxSeverity('low', 'high'), 'high');
    assert.equal(maxSeverity('critical', 'medium'), 'critical');
    assert.equal(maxSeverity(null, undefined), 'low');
    assert.equal(maxSeverity('bogus', 'medium'), 'medium');
    assert.equal(maxSeverity('bogus', 'nonsense'), 'low');
  });
});
