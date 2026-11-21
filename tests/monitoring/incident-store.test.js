import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import { dedupeKeyOf } from '../../src/monitoring/correlate.js';
import {
  getIncident, listIncidents, readCheckpoint, saveIncident, upsertIncident, writeCheckpoint,
} from '../../src/monitoring/incident-store.js';
import { expectCode, removeDir, tempWorkspace } from '../helpers.js';

const T0 = Date.parse('2026-01-05T10:00:00.000Z');
const iso = (/** @type {number} */ minutes) => new Date(T0 + minutes * 60_000).toISOString();

/** @param {Record<string, any>} [extra] */
function candidate(extra = {}) {
  return /** @type {any} */ ({
    service: 'orders-service', fingerprint: 'fp-log', firstSeen: iso(0), lastSeen: iso(5), occurrences: 3,
    sources: ['splunk'], summary: 'ERROR boom', exceptionClass: 'java.lang.NullPointerException',
    traceIds: [], spanId: null, requestId: null, evidenceLinks: ['https://splunk/s'], sourceTimeZones: ['Z'],
    deploymentVersions: ['2.14.0'], metric: null, severity: 'medium', triggers: ['exception-observed'],
    correlation: { method: 'none', missing: ['traceId', 'spanId'] }, samples: ['ERROR boom'], absorbedFingerprints: [],
    ...extra,
  });
}

describe('incident store', () => {
  /** @type {ReturnType<typeof tempWorkspace>} */
  let ws;
  /** @type {string[]} */
  const roots = [];
  beforeEach(() => {
    ws = tempWorkspace();
    roots.push(ws.root);
  });
  after(() => roots.forEach(removeDir));

  /** @param {any} c @param {string} windowId @param {Record<string, any>} [extra] */
  const upsert = (c, windowId, extra = {}) =>
    upsertIncident(ws.workspace, { projectId: 'orders', environment: 'nonprod', candidate: c, windowId, dedupeWindowMinutes: 60, ...extra });

  test('a new candidate creates one incident with the full model and nothing fabricated', () => {
    const result = upsert(candidate(), 'w1');
    assert.equal(result.created, true);
    assert.equal(result.merged, false);
    const incident = result.incident;
    assert.match(incident.incidentId, /^INC-20260105-[0-9a-f]{8}$/);
    assert.equal(incident.status, 'detected');
    assert.equal(incident.projectId, 'orders');
    assert.equal(incident.environment, 'nonprod');
    assert.equal(incident.occurrences, 3);
    assert.equal(incident.traceId, null);
    assert.equal(incident.spanId, null);
    assert.equal(incident.requestId, null);
    assert.equal(incident.classification, 'insufficient-evidence');
    assert.equal(incident.defect, null);
    assert.equal(incident.handoff, null);
    assert.deepEqual(incident.candidateRepos, []);
    assert.deepEqual(incident.windowsProcessed, ['w1']);
    assert.equal(incident.dedupeKey, dedupeKeyOf('orders', 'nonprod', 'orders-service', 'fp-log'));
    assert.equal(incident.history[0].to, 'detected');
    assert.deepEqual(getIncident(ws.workspace, 'orders', incident.incidentId), incident);
    assert.equal(listIncidents(ws.workspace, 'orders').length, 1);
  });

  test('the same candidate in a new window merges: occurrences add up, range widens, still one incident', () => {
    const first = upsert(candidate(), 'w1').incident;
    const second = upsert(candidate({ firstSeen: iso(10), lastSeen: iso(15), occurrences: 2, traceIds: ['trace-0001'], spanId: 'span-0001', severity: 'high', deploymentVersions: ['2.15.0'] }), 'w2');
    assert.equal(second.created, false);
    assert.equal(second.merged, true);
    assert.equal(second.recurrence, false);
    assert.equal(second.incident.incidentId, first.incidentId);
    assert.equal(second.incident.occurrences, 5);
    assert.equal(second.incident.firstSeen, iso(0));
    assert.equal(second.incident.lastSeen, iso(15));
    assert.equal(second.incident.traceId, 'trace-0001');
    assert.equal(second.incident.spanId, 'span-0001');
    assert.equal(second.incident.severity, 'high');
    assert.deepEqual(second.incident.deploymentVersions, ['2.14.0', '2.15.0']);
    assert.deepEqual(second.incident.windowsProcessed, ['w1', 'w2']);
    assert.equal(listIncidents(ws.workspace, 'orders').length, 1);
  });

  test('reprocessing the same window is idempotent: nothing is double-counted', () => {
    upsert(candidate(), 'w1');
    const again = upsert(candidate(), 'w1');
    assert.deepEqual({ created: again.created, merged: again.merged, recurrence: again.recurrence }, { created: false, merged: false, recurrence: false });
    assert.equal(again.incident.occurrences, 3);
    upsert(candidate({ occurrences: 4 }), 'w2');
    assert.equal(upsert(candidate({ occurrences: 4 }), 'w2').incident.occurrences, 7);
    assert.equal(upsert(candidate({ occurrences: 4 }), 'w1').incident.occurrences, 7);
    assert.equal(listIncidents(ws.workspace, 'orders').length, 1);
  });

  test('a merge never moves severity down or erases ids already known', () => {
    upsert(candidate({ severity: 'critical', traceIds: ['trace-0001'], spanId: 'span-0001' }), 'w1');
    const merged = upsert(candidate({ severity: 'low', traceIds: [], spanId: null }), 'w2').incident;
    assert.equal(merged.severity, 'critical');
    assert.equal(merged.traceId, 'trace-0001');
    assert.equal(merged.spanId, 'span-0001');
  });

  test('seen again after the dedupe window while still open: a recurrence of the same incident, not a second one', () => {
    const first = upsert(candidate(), 'w1').incident;
    const later = upsert(candidate({ firstSeen: iso(5 + 61), lastSeen: iso(5 + 62) }), 'w2');
    assert.equal(later.created, false);
    assert.equal(later.merged, true);
    assert.equal(later.recurrence, true);
    assert.equal(later.incident.incidentId, first.incidentId);
    assert.equal(later.incident.recurrences, 1);
    assert.equal(listIncidents(ws.workspace, 'orders').length, 1);
  });

  test('the dedupe window boundary is inclusive', () => {
    upsert(candidate(), 'w1'); // lastSeen = +5 min
    assert.equal(upsert(candidate({ firstSeen: iso(65), lastSeen: iso(65) }), 'w2').recurrence, false);
    // lastSeen is now +65; one millisecond past the window is a recurrence.
    const past = new Date(T0 + (65 + 60) * 60_000 + 1).toISOString();
    assert.equal(upsert(candidate({ firstSeen: past, lastSeen: past }), 'w3').recurrence, true);
  });

  test('after an incident is closed or verified, the same error opens a new incident', () => {
    const first = upsert(candidate(), 'w1').incident;
    first.status = 'closed';
    saveIncident(ws.workspace, first);
    const second = upsert(candidate({ firstSeen: iso(30), lastSeen: iso(31) }), 'w2');
    assert.equal(second.created, true);
    assert.notEqual(second.incident.incidentId, first.incidentId);
    second.incident.status = 'resolved-verified';
    saveIncident(ws.workspace, second.incident);
    assert.equal(upsert(candidate({ firstSeen: iso(40), lastSeen: iso(41) }), 'w3').created, true);
    assert.equal(listIncidents(ws.workspace, 'orders').length, 3);
  });

  for (const status of ['needs-onboarding', 'defect-proposed', 'defect-denied', 'defect-created', 'handoff-queued', 'development-started', 'pr-created', 'validation-pending']) {
    test(`an incident in state ${status} absorbs repeats instead of spawning a duplicate`, () => {
      const first = upsert(candidate(), 'w1').incident;
      first.status = status;
      saveIncident(ws.workspace, first);
      const again = upsert(candidate({ firstSeen: iso(10), lastSeen: iso(11) }), 'w2');
      assert.equal(again.created, false);
      assert.equal(again.incident.status, status);
      assert.equal(listIncidents(ws.workspace, 'orders').length, 1);
    });
  }

  test('a different environment, service or fingerprint is a different incident', () => {
    upsert(candidate(), 'w1');
    assert.equal(upsert(candidate(), 'w1', { environment: 'prod' }).created, true);
    assert.equal(upsert(candidate({ service: 'payments-service' }), 'w1').created, true);
    assert.equal(upsert(candidate({ fingerprint: 'fp-other' }), 'w1').created, true);
    assert.equal(listIncidents(ws.workspace, 'orders').length, 4);
  });

  test('alias keys: a problem correlated into an incident is the same incident when it later shows up alone', () => {
    const correlated = candidate({ sources: ['splunk', 'dynatrace-problem'], absorbedFingerprints: ['fp-problem'], correlation: { method: 'trace-id', missing: [] }, traceIds: ['trace-0001'] });
    const first = upsert(correlated, 'w1').incident;
    assert.deepEqual(first.aliasKeys, [dedupeKeyOf('orders', 'nonprod', 'orders-service', 'fp-problem')]);

    const alone = candidate({ fingerprint: 'fp-problem', sources: ['dynatrace-problem'], occurrences: 1, exceptionClass: null, firstSeen: iso(-1), lastSeen: iso(-1), triggers: ['dynatrace-problem'] });
    const second = upsert(alone, 'w2');
    assert.equal(second.created, false);
    assert.equal(second.merged, true);
    assert.equal(second.incident.incidentId, first.incidentId);
    assert.equal(second.incident.occurrences, 3, 'a standing problem is not a new log occurrence');
    assert.equal(second.incident.correlation.method, 'trace-id');
    assert.equal(second.incident.errorFingerprint, 'fp-log');
    assert.equal(listIncidents(ws.workspace, 'orders').length, 1);
  });

  test('alias keys do not cross services', () => {
    upsert(candidate({ absorbedFingerprints: ['fp-problem'], sources: ['splunk', 'dynatrace-problem'] }), 'w1');
    const other = upsert(candidate({ service: 'payments-service', fingerprint: 'fp-problem', sources: ['dynatrace-problem'] }), 'w2');
    assert.equal(other.created, true);
  });

  test('alias keys, reverse order: a problem seen alone first and then correlated with logs stays one incident',
    () => {
      const alone = candidate({ fingerprint: 'fp-problem', sources: ['dynatrace-problem'], occurrences: 1, exceptionClass: null, triggers: ['dynatrace-problem'] });
      const first = upsert(alone, 'w1').incident;
      const correlated = candidate({ sources: ['splunk', 'dynatrace-problem'], absorbedFingerprints: ['fp-problem'], firstSeen: iso(6), lastSeen: iso(8) });
      const second = upsert(correlated, 'w2');
      assert.equal(second.created, false);
      assert.equal(second.incident.incidentId, first.incidentId);
      assert.equal(listIncidents(ws.workspace, 'orders').length, 1);
    });

  test('a higher-confidence merge upgrades confidence and correlation; a weaker one does not downgrade them', () => {
    const first = upsert(candidate(), 'w1').incident;
    assert.equal(first.confidence.label, 'low');
    const strong = upsert(candidate({ sources: ['splunk', 'dynatrace-problem'], correlation: { method: 'trace-id', missing: [] }, traceIds: ['trace-0001'], firstSeen: iso(6), lastSeen: iso(7) }), 'w2').incident;
    assert.equal(strong.confidence.label, 'high');
    assert.equal(strong.correlation.method, 'trace-id');
    const weak = upsert(candidate({ firstSeen: iso(8), lastSeen: iso(9) }), 'w3').incident;
    assert.equal(weak.confidence.label, 'high');
    assert.equal(weak.correlation.method, 'trace-id');
  });

  test('windowsProcessed is bounded', () => {
    upsert(candidate(), 'w0');
    for (let index = 1; index <= 205; index += 1) upsert(candidate({ occurrences: 1, firstSeen: iso(5), lastSeen: iso(5) }), `w${index}`);
    const [incident] = listIncidents(ws.workspace, 'orders');
    assert.equal(incident.windowsProcessed.length, 200);
    assert.equal(incident.occurrences, 3 + 205);
  });

  test('incidents are stored per project: another project cannot list or read them', async () => {
    const { incident } = upsert(candidate(), 'w1');
    assert.deepEqual(listIncidents(ws.workspace, 'billing'), []);
    await expectCode(() => getIncident(ws.workspace, 'billing', incident.incidentId), 'NOT_FOUND');
  });

  test('an incident file copied into another project\'s folder is refused as a scope violation', async () => {
    const { incident } = upsert(candidate(), 'w1');
    const from = path.join(ws.workspace.stateDir, 'incidents', 'orders', `${incident.incidentId}.json`);
    const toDir = path.join(ws.workspace.stateDir, 'incidents', 'billing');
    fs.mkdirSync(toDir, { recursive: true });
    fs.copyFileSync(from, path.join(toDir, `${incident.incidentId}.json`));
    await expectCode(() => getIncident(ws.workspace, 'billing', incident.incidentId), 'PROJECT_SCOPE_VIOLATION');
  });

  test('incident ids and project ids that could traverse paths are rejected', async () => {
    await expectCode(() => getIncident(ws.workspace, 'orders', '../../audit/orders/audit'), 'INVALID_ARGUMENT');
    await expectCode(() => getIncident(ws.workspace, 'orders', 'a/b'), 'INVALID_ARGUMENT');
    await expectCode(() => getIncident(ws.workspace, '..', 'INC-1'), 'INVALID_ARGUMENT');
    await expectCode(() => listIncidents(ws.workspace, '../x'), 'INVALID_ARGUMENT');
    await expectCode(() => saveIncident(ws.workspace, { projectId: 'orders', incidentId: '..' }), 'INVALID_ARGUMENT');
  });

  test('an unknown incident is NOT_FOUND', async () => {
    await expectCode(() => getIncident(ws.workspace, 'orders', 'INC-20260105-deadbeef'), 'NOT_FOUND');
  });

  test('listIncidents is ordered by firstSeen and ignores non-JSON files', () => {
    upsert(candidate({ fingerprint: 'b', firstSeen: iso(10), lastSeen: iso(10) }), 'w1');
    upsert(candidate({ fingerprint: 'a', firstSeen: iso(-10), lastSeen: iso(-10) }), 'w1');
    fs.writeFileSync(path.join(ws.workspace.stateDir, 'incidents', 'orders', 'notes.txt'), 'not json');
    assert.deepEqual(listIncidents(ws.workspace, 'orders').map((incident) => incident.errorFingerprint), ['a', 'b']);
  });

  test('a corrupt incident file is reported, not silently skipped', async () => {
    upsert(candidate(), 'w1');
    fs.writeFileSync(path.join(ws.workspace.stateDir, 'incidents', 'orders', 'INC-broken.json'), '{ nope');
    await expectCode(() => listIncidents(ws.workspace, 'orders'), 'INTEGRITY_VIOLATION');
  });

  test('checkpoint: defaults when absent, round-trips, and is per project', () => {
    assert.deepEqual(readCheckpoint(ws.workspace, 'orders'), { lastWindowEnd: null, consecutiveFailures: 0, nextAttemptAfter: null, lastRunAt: null, lastError: null, runs: 0 });
    writeCheckpoint(ws.workspace, 'orders', { ...readCheckpoint(ws.workspace, 'orders'), lastWindowEnd: iso(0), runs: 2 });
    assert.equal(readCheckpoint(ws.workspace, 'orders').lastWindowEnd, iso(0));
    assert.equal(readCheckpoint(ws.workspace, 'orders').runs, 2);
    assert.equal(readCheckpoint(ws.workspace, 'billing').lastWindowEnd, null);
  });
});
