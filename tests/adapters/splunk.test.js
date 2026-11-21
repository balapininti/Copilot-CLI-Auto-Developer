import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import YAML from 'yaml';

import { boundedWindow, buildSearch, runSavedSearch, searchErrors, searchLink, validateFilter } from '../../src/adapters/splunk/client.js';
import { createTransport } from '../../src/core/auth.js';
import { parseManifest } from '../../src/core/manifest.js';
import { createMockState, startMockServer } from '../../src/mocks/server.js';
import { expectCode, fullManifest, serviceEnv } from '../helpers.js';

/** @param {(m: Record<string, any>) => void} [mutate] */
function monitoringConfig(mutate) {
  const { manifest } = parseManifest(YAML.stringify(fullManifest()));
  const monitoring = structuredClone(manifest.monitoring);
  mutate?.(monitoring);
  return monitoring;
}

describe('splunk buildSearch', () => {
  test('scopes to the configured index and sourcetype and caps results', () => {
    const search = buildSearch(monitoringConfig());
    assert.equal(search, 'search index="app_nonprod" sourcetype="app:json" (ERROR OR FATAL OR Exception) | head 500');
  });

  test('never emits index=* and always names every index explicitly', () => {
    const search = buildSearch(monitoringConfig((m) => { m.splunk.indexes = ['app_a', 'app_b']; m.splunk.sourcetypes = []; }));
    assert.match(search, /^search \(index="app_a" OR index="app_b"\) /);
    assert.ok(!/index\s*=\s*"?\*/.test(search));
    assert.ok(!search.includes('sourcetype'));
  });

  test('requires indexes: none configured is rejected', async () => {
    await expectCode(() => buildSearch(monitoringConfig((m) => { m.splunk.indexes = []; })), 'QUERY_REJECTED', /no indexes/);
    await expectCode(() => buildSearch(monitoringConfig((m) => { delete m.splunk.indexes; })), 'QUERY_REJECTED', /no indexes/);
  });

  test('wildcard and hostile index names are rejected', async () => {
    for (const index of ['*', 'app_*', '_*', 'app" OR index="*', 'a b', 'a|delete', '', 'a)(', 'x'.repeat(101)]) {
      await expectCode(() => buildSearch(monitoringConfig((m) => { m.splunk.indexes = ['app_nonprod', index]; })), 'QUERY_REJECTED');
    }
  });

  test('wildcard and hostile sourcetypes are rejected', async () => {
    for (const sourcetype of ['*', 'app:*', 'x" | delete "']) {
      await expectCode(() => buildSearch(monitoringConfig((m) => { m.splunk.sourcetypes = [sourcetype]; })), 'QUERY_REJECTED');
    }
  });

  test('services are matched on every configured service-name field', () => {
    const search = buildSearch(monitoringConfig(), { services: ['orders-service', 'payments-service'] });
    assert.ok(search.includes('(service="orders-service" OR service="payments-service" OR application="orders-service" OR application="payments-service")'), search);
  });

  test('hostile service names and service fields are rejected', async () => {
    for (const service of ['orders" OR index="*', '*', 'a | delete', 'a b']) {
      await expectCode(() => buildSearch(monitoringConfig(), { services: [service] }), 'QUERY_REJECTED');
    }
    await expectCode(() => buildSearch(monitoringConfig((m) => { m.correlation.serviceNameFields = ['service) OR (index']; }), { services: ['orders-service'] }), 'QUERY_REJECTED');
  });

  test('a configured errorFilter replaces the default and an extra filter is appended', () => {
    const search = buildSearch(monitoringConfig((m) => { m.splunk.errorFilter = 'level=ERROR'; }), { extraFilter: '  "NullPointerException"  ' });
    assert.ok(search.includes(' level=ERROR "NullPointerException" | head 500'), search);
    assert.ok(!search.includes('FATAL'));
  });

  test('a hostile errorFilter in the manifest or extraFilter is rejected', async () => {
    await expectCode(() => buildSearch(monitoringConfig((m) => { m.splunk.errorFilter = 'ERROR | delete'; })), 'QUERY_REJECTED');
    await expectCode(() => buildSearch(monitoringConfig(), { extraFilter: 'x OR index=*' }), 'QUERY_REJECTED');
    await expectCode(() => buildSearch(monitoringConfig(), { extraFilter: 'x | outputlookup y' }), 'QUERY_REJECTED');
  });

  test('exactly one pipe appears in any built search: the final head', () => {
    const search = buildSearch(monitoringConfig(), { services: ['orders-service'], extraFilter: 'timeout' });
    assert.equal(search.split('|').length, 2);
    assert.match(search, /\| head 500$/);
  });
});

describe('splunk validateFilter', () => {
  test('accepts plain terms and trims', () => {
    assert.equal(validateFilter('  (ERROR OR FATAL) "timed out" status=500 '), '(ERROR OR FATAL) "timed out" status=500');
    assert.equal(validateFilter('reindex=true hostname=x'), 'reindex=true hostname=x', 'word boundaries: field names merely containing index/host are fine');
  });

  test('rejects pipes, subsearches and macros', async () => {
    for (const filter of ['ERROR | delete', 'ERROR|outputlookup x', '[search index=secret]', 'x [ y', 'x ] y', '`my_macro`', 'a\n| collect index=x']) {
      await expectCode(() => validateFilter(filter), 'QUERY_REJECTED', /pipes, subsearches or macros/);
    }
  });

  test('rejects index, sourcetype, source, host and time-range overrides', async () => {
    for (const filter of [
      'index=*', 'INDEX = secret', 'x OR index="other"', 'index!=app', 'index::secret', 'Index\t=\tsecret',
      'sourcetype=other', 'source="/var/log/x"', 'host=prod01', 'earliest=-30d', 'latest=now', '_index_earliest=-1y', '_index_latest=now',
      '(ERROR) OR (index=*)',
    ]) {
      await expectCode(() => validateFilter(filter), 'QUERY_REJECTED', /may not change/);
    }
  });

  test('rejects over-long filters', async () => {
    assert.equal(validateFilter('x'.repeat(500)).length, 500);
    await expectCode(() => validateFilter('x'.repeat(501)), 'QUERY_REJECTED', /too long/);
  });

  test('rejects an index override written with the IN operator', async () => {
    await expectCode(() => validateFilter('x OR index IN (secret_idx)'), 'QUERY_REJECTED');
    await expectCode(() => validateFilter('host IN (prod*)'), 'QUERY_REJECTED');
  });
});

describe('splunk boundedWindow', () => {
  const from = new Date('2026-01-01T00:00:00Z');

  test('accepts a window up to the limit, as Date or ISO string', () => {
    const window = boundedWindow({ from: from.toISOString(), to: new Date(from.getTime() + 60 * 60_000) }, 60);
    assert.equal(window.from.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(window.to.toISOString(), '2026-01-01T01:00:00.000Z');
  });

  test('rejects a window longer than the limit', async () => {
    await expectCode(() => boundedWindow({ from, to: new Date(from.getTime() + 60 * 60_000 + 1) }, 60), 'QUERY_REJECTED', /maximum of 60 minutes/);
  });

  test('rejects reversed, empty and unparseable windows', async () => {
    await expectCode(() => boundedWindow({ from, to: from }, 60), 'QUERY_REJECTED', /invalid time window/);
    await expectCode(() => boundedWindow({ from, to: new Date(from.getTime() - 1) }, 60), 'QUERY_REJECTED');
    await expectCode(() => boundedWindow({ from: 'yesterday-ish', to: from }, 60), 'QUERY_REJECTED');
    await expectCode(() => boundedWindow({ from, to: /** @type {any} */ (undefined) }, 60), 'QUERY_REJECTED');
  });
});

describe('splunk against the mock server', () => {
  /** @type {Awaited<ReturnType<typeof startMockServer>>} */
  let server;
  /** @type {import('../../src/core/auth.js').Transport} */
  let transport;
  const now = new Date('2026-03-01T12:00:00Z');
  const at = (/** @type {number} */ minutesAgo) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

  before(async () => {
    server = await startMockServer(createMockState({
      splunkEvents: [
        { _time: at(50), service: 'orders-service', _raw: 'ERROR one' },
        { _time: at(10), service: 'orders-service', _raw: 'ERROR two' },
        { _time: at(5), service: 'orders-service', _raw: 'ERROR three' },
        { _time: at(500), service: 'orders-service', _raw: 'ERROR ancient' },
      ],
    }));
    const { manifest } = parseManifest(YAML.stringify(fullManifest()));
    transport = await createTransport('splunk', manifest, { env: serviceEnv(server.baseUrl), useCredentialStore: false });
  });
  after(async () => {
    await transport?.close();
    await server?.close();
  });

  test('searchErrors returns only events inside the bounded window', async () => {
    const result = await searchErrors(transport, monitoringConfig(), { from: at(30), to: now });
    assert.equal(result.count, 2);
    assert.deepEqual(result.events.map((e) => e._raw), ['ERROR two', 'ERROR three']);
    assert.equal(result.capped, false);
    assert.deepEqual(result.window, { from: at(30), to: now.toISOString() });
    assert.match(result.search, /^search index="app_nonprod"/);
    assert.ok(server.state.requests.some((r) => r.method === 'POST' && r.path === '/services/search/jobs/export'));
  });

  test('searchErrors reports capped when the result count reaches the limit', async () => {
    const result = await searchErrors(transport, monitoringConfig((m) => { m.limits.maxEventsPerQuery = 2; }), { from: at(30), to: now });
    assert.equal(result.capped, true);
    assert.match(result.search, /\| head 2$/);
  });

  test('searchErrors refuses an over-long window and a hostile filter before any request', async () => {
    const before = server.state.requests.length;
    await expectCode(() => searchErrors(transport, monitoringConfig(), { from: at(61), to: now }), 'QUERY_REJECTED');
    await expectCode(() => searchErrors(transport, monitoringConfig(), { from: at(30), to: now, extraFilter: 'x | delete' }), 'QUERY_REJECTED');
    await expectCode(() => searchErrors(transport, monitoringConfig((m) => { m.splunk.indexes = ['*']; }), { from: at(30), to: now }), 'QUERY_REJECTED');
    assert.equal(server.state.requests.length, before);
  });

  test('searchErrors retries a transient 503 because a search is a read', async () => {
    server.state.faults.failNext['POST /services/search/jobs/export'] = 1;
    const result = await searchErrors(transport, monitoringConfig(), { from: at(30), to: now });
    assert.equal(result.count, 2);
  });

  test('a saved search must be allow-listed', async () => {
    const before = server.state.requests.length;
    await expectCode(() => runSavedSearch(transport, monitoringConfig(), 'Errors by service', { from: at(30), to: now }), 'QUERY_REJECTED', /not listed/);
    await expectCode(() => runSavedSearch(transport, monitoringConfig((m) => { m.splunk.savedSearches = ['Other']; }), 'other', { from: at(30), to: now }), 'QUERY_REJECTED');
    assert.equal(server.state.requests.length, before);
  });

  test('an allow-listed saved search runs over a bounded window', async () => {
    const monitoring = monitoringConfig((m) => { m.splunk.savedSearches = ['Errors by service']; });
    const result = await runSavedSearch(transport, monitoring, 'Errors by service', { from: at(30), to: now });
    assert.equal(result.savedSearch, 'Errors by service');
    assert.equal(result.count, 2);
    await expectCode(() => runSavedSearch(transport, monitoring, 'Errors by service', { from: at(600), to: now }), 'QUERY_REJECTED');
  });
});

describe('splunk searchLink', () => {
  test('points at Splunk Web, dropping the REST port', () => {
    const link = new URL(searchLink('https://splunk.example.internal:8089', 'search index="a"', { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:10:00.500Z' }));
    assert.equal(link.origin, 'https://splunk.example.internal');
    assert.equal(link.pathname, '/app/search/search');
    assert.equal(link.searchParams.get('q'), 'search index="a"');
    assert.equal(link.searchParams.get('earliest'), '1767225600');
    assert.equal(link.searchParams.get('latest'), '1767226201');
  });
});
