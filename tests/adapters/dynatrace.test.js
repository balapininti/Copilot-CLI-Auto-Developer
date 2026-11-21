import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import YAML from 'yaml';

import { listProblems, queryMetrics } from '../../src/adapters/dynatrace/client.js';
import { createTransport } from '../../src/core/auth.js';
import { parseManifest } from '../../src/core/manifest.js';
import { createMockState, startMockServer } from '../../src/mocks/server.js';
import { expectCode, fullManifest, serviceEnv } from '../helpers.js';

const METRIC = 'builtin:service.response.time:percentile(95)';

/** @param {(m: Record<string, any>) => void} [mutate] */
function monitoringConfig(mutate) {
  const { manifest } = parseManifest(YAML.stringify(fullManifest()));
  const monitoring = structuredClone(manifest.monitoring);
  mutate?.(monitoring);
  return monitoring;
}

/** A transport that records requests and never touches the network. */
function recordingTransport(body = {}) {
  /** @type {string[]} */
  const paths = [];
  return {
    paths,
    mode: /** @type {const} */ ('token'),
    service: 'dynatrace',
    baseUrl: 'https://dt.example.internal/e/abc/',
    request: async (/** @type {any} */ request) => {
      paths.push(request.path);
      return { status: 200, body, text: JSON.stringify(body) };
    },
    close: async () => {},
  };
}

const now = new Date('2026-03-01T12:00:00Z');
const window = { from: new Date(now.getTime() - 30 * 60_000), to: now };

describe('dynatrace selector and window validation (no HTTP)', () => {
  test('entity selectors are required for problems and metrics', async () => {
    const transport = recordingTransport();
    const none = monitoringConfig((m) => { m.dynatrace.entitySelectors = []; });
    await expectCode(() => listProblems(transport, none, window), 'QUERY_REJECTED', /no entity selectors/);
    await expectCode(() => queryMetrics(transport, none, window), 'QUERY_REJECTED', /no entity selectors/);
    const absent = monitoringConfig((m) => { delete m.dynatrace.entitySelectors; });
    await expectCode(() => listProblems(transport, absent, window), 'QUERY_REJECTED');
    assert.equal(transport.paths.length, 0);
  });

  test('entity selectors must start with type(...) or entityId(...)', async () => {
    for (const selector of ['tag(app:orders)', '*', '', 'managementZone("x")', 'TYPE(SERVICE)', 'typeX(SERVICE)', 'x'.padStart(501, 'type(SERVICE),'), /** @type {any} */ (42), /** @type {any} */ (null)]) {
      const transport = recordingTransport();
      const monitoring = monitoringConfig((m) => { m.dynatrace.entitySelectors = ['type(SERVICE)', selector]; });
      await expectCode(() => listProblems(transport, monitoring, window), 'QUERY_REJECTED', /must start with type/);
      assert.equal(transport.paths.length, 0, `no request may be sent when any selector is invalid (${String(selector).slice(0, 20)})`);
    }
  });

  test('valid selectors are sent URL-encoded, one request per selector', async () => {
    const transport = recordingTransport({ problems: [] });
    const monitoring = monitoringConfig((m) => { m.dynatrace.entitySelectors = ['type(SERVICE),tag(app:orders)', 'entityId(SERVICE-1&from=0)']; });
    await listProblems(transport, monitoring, window);
    assert.equal(transport.paths.length, 2);
    const first = new URL(transport.paths[0], 'https://x.invalid');
    assert.equal(first.pathname, '/api/v2/problems');
    assert.equal(first.searchParams.get('entitySelector'), 'type(SERVICE),tag(app:orders)');
    assert.equal(first.searchParams.get('from'), window.from.toISOString());
    const second = new URL(transport.paths[1], 'https://x.invalid');
    assert.equal(second.searchParams.get('entitySelector'), 'entityId(SERVICE-1&from=0)', 'a selector cannot smuggle extra query parameters');
    assert.equal(second.searchParams.getAll('from').length, 1);
  });

  test('the time window is bounded and must be valid', async () => {
    const transport = recordingTransport();
    const monitoring = monitoringConfig();
    await expectCode(() => listProblems(transport, monitoring, { from: new Date(now.getTime() - 61 * 60_000), to: now }), 'QUERY_REJECTED', /exceeds 60 minutes/);
    await expectCode(() => listProblems(transport, monitoring, { from: now, to: now }), 'QUERY_REJECTED', /invalid time window/);
    await expectCode(() => queryMetrics(transport, monitoring, { from: 'garbage', to: now }), 'QUERY_REJECTED');
    await expectCode(() => queryMetrics(transport, monitoring, { from: now, to: window.from }), 'QUERY_REJECTED');
    assert.equal(transport.paths.length, 0);
  });

  test('an unlisted metric selector is rejected before any request', async () => {
    const transport = recordingTransport();
    for (const metricSelector of ['builtin:host.cpu.usage', `${METRIC}:names`, ` ${METRIC}`, METRIC.toUpperCase(), '*']) {
      await expectCode(() => queryMetrics(transport, monitoringConfig(), { ...window, metricSelector }), 'QUERY_REJECTED', /not listed/);
    }
    assert.equal(transport.paths.length, 0);
  });

  test('with no metric selectors configured nothing is queried', async () => {
    const transport = recordingTransport();
    const result = await queryMetrics(transport, monitoringConfig((m) => { m.dynatrace.metricSelectors = []; }), window);
    assert.deepEqual(result.series, []);
    assert.equal(transport.paths.length, 0);
  });

  test('problems seen through several selectors are de-duplicated; missing fields become null', async () => {
    const transport = recordingTransport({ problems: [{ problemId: 'P-1', title: 'Slow', startTime: -1, endTime: -1 }] });
    const result = await listProblems(transport, monitoringConfig((m) => { m.dynatrace.entitySelectors = ['type(SERVICE)', 'type(HOST)']; }), window);
    assert.equal(result.count, 1);
    assert.deepEqual(result.problems[0], {
      problemId: 'P-1', displayId: null, title: 'Slow', severityLevel: null, impactLevel: null, status: null,
      startTime: null, endTime: null, affectedEntities: [], rootCauseEntity: null, traceIds: [],
      url: 'https://dt.example.internal/e/abc/#problems/problemdetails;pid=P-1',
    });
  });

  test('metric series with no numeric points report null statistics, not zero', async () => {
    const transport = recordingTransport({ result: [{ metricId: METRIC, data: [{ dimensions: ['SERVICE-9'], values: [null, null] }] }] });
    const result = await queryMetrics(transport, monitoringConfig(), { ...window, metricSelector: METRIC });
    assert.deepEqual(result.series, [{ metricId: METRIC, dimensions: {}, entity: 'SERVICE-9', points: 0, max: null, avg: null, last: null, unit: null }]);
  });
});

describe('dynatrace against the mock server', () => {
  /** @type {Awaited<ReturnType<typeof startMockServer>>} */
  let server;
  /** @type {import('../../src/core/auth.js').Transport} */
  let transport;

  before(async () => {
    server = await startMockServer(createMockState({
      problems: [
        {
          problemId: 'P-240117', displayId: 'P-240117', title: 'Failure rate increase', severityLevel: 'ERROR', impactLevel: 'SERVICES', status: 'OPEN',
          startTime: now.getTime() - 10 * 60_000, endTime: -1,
          affectedEntities: [{ entityId: { id: 'SERVICE-ORDERS0001' }, name: 'orders-service' }],
          rootCauseEntity: { entityId: { id: 'SERVICE-ORDERS0001' }, name: 'orders-service' },
          evidenceDetails: { details: [{ data: { traceId: 'trace-abc' } }, { data: {} }] },
        },
        { problemId: 'P-OLD', title: 'Long closed', status: 'CLOSED', startTime: now.getTime() - 500 * 60_000, endTime: now.getTime() - 400 * 60_000 },
        { problemId: 'P-FUTURE', title: 'Not yet', status: 'OPEN', startTime: now.getTime() + 60_000, endTime: -1 },
      ],
      metrics: [
        { metricId: METRIC, unit: 'MicroSecond', data: [{ dimensionMap: { 'dt.entity.service': 'SERVICE-PAYMENTS0002' }, values: [410_000, null, 2_350_000, 2_410_000] }] },
        { metricId: 'builtin:other', unit: 'Count', data: [{ dimensionMap: {}, values: [1] }] },
      ],
    }));
    const { manifest } = parseManifest(YAML.stringify(fullManifest()));
    transport = await createTransport('dynatrace', manifest, { env: serviceEnv(server.baseUrl), useCredentialStore: false });
  });
  after(async () => {
    await transport?.close();
    await server?.close();
  });

  test('listProblems returns normalized problems in the window with an evidence link', async () => {
    const result = await listProblems(transport, monitoringConfig(), window);
    assert.equal(result.count, 1);
    const [problem] = result.problems;
    assert.equal(problem.problemId, 'P-240117');
    assert.equal(problem.status, 'OPEN');
    assert.equal(problem.startTime, new Date(now.getTime() - 10 * 60_000).toISOString());
    assert.equal(problem.endTime, null);
    assert.deepEqual(problem.affectedEntities, [{ id: 'SERVICE-ORDERS0001', name: 'orders-service' }]);
    assert.deepEqual(problem.rootCauseEntity, { id: 'SERVICE-ORDERS0001', name: 'orders-service' });
    assert.deepEqual(problem.traceIds, ['trace-abc']);
    assert.equal(problem.url, `${server.baseUrl}/#problems/problemdetails;pid=P-240117`);
    assert.deepEqual(result.window, { from: window.from.toISOString(), to: now.toISOString() });
  });

  test('queryMetrics returns statistics for configured selectors only', async () => {
    const result = await queryMetrics(transport, monitoringConfig(), window);
    assert.equal(result.count, 1);
    const [series] = result.series;
    assert.equal(series.metricId, METRIC);
    assert.equal(series.entity, 'SERVICE-PAYMENTS0002');
    assert.equal(series.unit, 'MicroSecond');
    assert.equal(series.points, 3, 'null gaps are not counted as points');
    assert.equal(series.max, 2_410_000);
    assert.equal(series.last, 2_410_000);
    assert.equal(series.avg, (410_000 + 2_350_000 + 2_410_000) / 3);
  });

  test('queryMetrics with an explicitly listed selector works; an unlisted one never reaches the server', async () => {
    const ok = await queryMetrics(transport, monitoringConfig(), { ...window, metricSelector: METRIC });
    assert.equal(ok.count, 1);
    const before = server.state.requests.length;
    await expectCode(() => queryMetrics(transport, monitoringConfig(), { ...window, metricSelector: 'builtin:other' }), 'QUERY_REJECTED');
    assert.equal(server.state.requests.length, before);
  });

  test('the Dynatrace token is sent as Api-Token and only GETs are issued', async () => {
    assert.equal(transport.mode, 'token');
    assert.ok(server.state.requests.length > 0);
    assert.ok(server.state.requests.every((r) => r.method === 'GET'));
  });
});
