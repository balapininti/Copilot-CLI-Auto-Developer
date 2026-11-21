import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import YAML from 'yaml';

import { Actions, consumeApproval, getApproval, listApprovals } from '../../src/core/approvals.js';
import { readAudit, verifyAudit } from '../../src/core/audit.js';
import { AutoDevError } from '../../src/core/errors.js';
import { claimNext, listTasks } from '../../src/monitoring/handoff.js';
import { getIncident, listIncidents, readCheckpoint, saveIncident, writeCheckpoint } from '../../src/monitoring/incident-store.js';
import { collectSignals, planWindows, runMany, runOnce, ticketPolicy, verifyResolution } from '../../src/monitoring/worker.js';
import { expectCode, fullManifest, removeDir, setEnv, writeProject } from '../helpers.js';
import {
  decide, fakeSources, latencySeries, manifestWithDefaults, minutes, monitoredProject, npeEvent, problem,
  PROBLEM_LINK, SPAN, SPLUNK_LINK, TRACE,
} from './fixtures.js';

/** @type {string[]} */
const roots = [];
const restoreEnv = setEnv({ AUTODEV_PROJECT: undefined, AUTODEV_SESSION_ID: undefined, AUTODEV_ACTOR: undefined, AUTODEV_DRY_RUN: undefined });
after(() => {
  roots.forEach(removeDir);
  restoreEnv();
});

/** @param {Record<string, any>} [overrides] */
function project(overrides = {}) {
  const p = monitoredProject(overrides);
  roots.push(p.root);
  return p;
}

/** Monitoring block of the default manifest with some thresholds/policy replaced. */
function monitoringWith(/** @type {Record<string, any>} */ patch) {
  const base = fullManifest().monitoring;
  return { ...base, ...patch };
}

const NO_THRESHOLDS = { errorCount: null, errorRatePercent: null, p95LatencyMs: null };

/** Three NPE events (two with the shared trace id) plus the matching problem. */
function npeScenario(/** @type {Date} */ now) {
  return fakeSources({
    events: [npeEvent(minutes(now, -9), { trace_id: TRACE, span_id: SPAN }), npeEvent(minutes(now, -7), { trace_id: TRACE }), npeEvent(minutes(now, -4))],
    problems: [problem(minutes(now, -10))],
  });
}

describe('planWindows', () => {
  const now = new Date('2026-01-05T12:00:00.000Z');

  test('with no checkpoint the first window is one maximum window ending now', () => {
    const plan = planWindows(null, now, 60);
    assert.deepEqual(plan.windows, [{ from: '2026-01-05T11:00:00.000Z', to: '2026-01-05T12:00:00.000Z', id: '2026-01-05T11:00:00.000Z/2026-01-05T12:00:00.000Z' }]);
    assert.equal(plan.behind, false);
  });

  test('a short gap since the checkpoint is one window from the checkpoint to now', () => {
    const plan = planWindows('2026-01-05T11:50:00.000Z', now, 60);
    assert.equal(plan.windows.length, 1);
    assert.equal(plan.windows[0].from, '2026-01-05T11:50:00.000Z');
    assert.equal(plan.windows[0].to, now.toISOString());
  });

  test('a long gap is chunked oldest first, contiguous, each no longer than the maximum', () => {
    const plan = planWindows('2026-01-05T09:30:00.000Z', now, 60);
    assert.deepEqual(plan.windows.map((window) => [window.from, window.to]), [
      ['2026-01-05T09:30:00.000Z', '2026-01-05T10:30:00.000Z'],
      ['2026-01-05T10:30:00.000Z', '2026-01-05T11:30:00.000Z'],
      ['2026-01-05T11:30:00.000Z', '2026-01-05T12:00:00.000Z'],
    ]);
    assert.equal(plan.behind, false);
  });

  test('catch-up is limited per pass and reported as behind', () => {
    const plan = planWindows('2026-01-04T12:00:00.000Z', now, 60);
    assert.equal(plan.windows.length, 4);
    assert.equal(plan.behind, true);
    assert.equal(plan.windows[0].from, '2026-01-04T12:00:00.000Z');
    assert.equal(plan.windows.at(-1)?.to, '2026-01-04T16:00:00.000Z');
    assert.equal(planWindows('2026-01-04T12:00:00.000Z', now, 60, 2).windows.length, 2);
    assert.equal(planWindows('2026-01-04T12:00:00.000Z', now, 60, 1000).windows.length, 24);
  });

  test('window ids are deterministic so reprocessing is recognisable', () => {
    assert.deepEqual(planWindows('2026-01-05T11:00:00.000Z', now, 30).windows, planWindows('2026-01-05T11:00:00.000Z', now, 30).windows);
  });

  test('a checkpoint in the future or unparseable falls back to one window ending now', () => {
    for (const bad of ['2026-01-06T00:00:00.000Z', 'garbage', '']) {
      const plan = planWindows(bad, now, 60);
      assert.equal(plan.windows.length, 1, bad);
      assert.equal(plan.windows[0].to, now.toISOString());
      assert.equal(plan.windows[0].from, '2026-01-05T11:00:00.000Z');
    }
  });

  test('a checkpoint equal to now, or under a second ago, yields no window', () => {
    assert.deepEqual(planWindows(now.toISOString(), now, 60).windows, []);
    assert.deepEqual(planWindows(new Date(now.getTime() - 999).toISOString(), now, 60).windows, []);
    assert.equal(planWindows(new Date(now.getTime() - 1000).toISOString(), now, 60).windows.length, 1);
  });

  test('no window ever ends after now', () => {
    const plan = planWindows('2026-01-05T08:17:13.000Z', now, 45, 100);
    assert.ok(plan.windows.every((window) => Date.parse(window.to) <= now.getTime() && Date.parse(window.to) - Date.parse(window.from) <= 45 * 60_000));
    assert.equal(plan.windows.at(-1)?.to, now.toISOString());
  });
});

describe('ticketPolicy', () => {
  /** @param {string} createDefect @param {string} createTicket */
  const policy = (createDefect, createTicket) => ticketPolicy({ policies: { createDefect }, monitoring: { incidentPolicy: { createTicket } } });
  const strictness = ['allowed', 'approval-required', 'prohibited'];

  for (const a of strictness) {
    for (const b of strictness) {
      const expected = strictness[Math.max(strictness.indexOf(a), strictness.indexOf(b))];
      test(`createDefect=${a} + incidentPolicy.createTicket=${b} -> ${expected}`, () => {
        assert.equal(policy(a, b), expected);
      });
    }
  }

  test('a missing or unknown value is treated as approval-required, never as allowed', () => {
    assert.equal(policy(/** @type {any} */ (undefined), 'allowed'), 'approval-required');
    assert.equal(policy('allowed', 'yes-please'), 'approval-required');
  });

  test('the manifest defaults require approval', () => {
    assert.equal(ticketPolicy(manifestWithDefaults()), 'approval-required');
  });
});

describe('collectSignals', () => {
  test('counts events, problems, series and unparsed events; maps service aliases to the configured name', async () => {
    const now = new Date();
    const manifest = manifestWithDefaults({
      services: [{ name: 'orders-service', repository: 'service-api', aliases: ['orders-svc'], dynatraceEntityId: 'SERVICE-ORDERS0001' }, { name: 'payments-service', repository: 'service-api', dynatraceEntityId: 'SERVICE-PAYMENTS0002' }],
    });
    const { sources } = fakeSources({
      events: [npeEvent(minutes(now, -5), { service: 'ORDERS-SVC' }), { _time: 'garbage', _raw: 'ERROR no usable time' }],
      problems: [problem(minutes(now, -10))],
      series: [latencySeries()],
    });
    const { signals, counts } = await collectSignals(manifest, sources, { from: minutes(now, -60).toISOString(), to: now.toISOString() });
    assert.deepEqual(counts, { splunkEvents: 2, dynatraceProblems: 1, metricSeries: 1, unparsedEvents: 1 });
    assert.deepEqual(signals.map((signal) => signal.source).sort(), ['dynatrace-problem', 'splunk', 'threshold']);
    assert.equal(signals.find((signal) => signal.source === 'splunk')?.service, 'orders-service');
    assert.equal(signals.find((signal) => signal.source === 'splunk')?.evidenceLink, SPLUNK_LINK);
  });

  test('a source that is not configured is not queried', async () => {
    const manifest = manifestWithDefaults();
    manifest.monitoring.splunk.indexes = [];
    const { sources, state } = fakeSources({ events: [npeEvent(new Date())] });
    const { signals } = await collectSignals(manifest, sources, { from: minutes(new Date(), -5).toISOString(), to: minutes(new Date(), 1).toISOString() });
    assert.equal(state.calls.searchErrors, 0);
    assert.deepEqual(signals, []);

    const noDynatrace = manifestWithDefaults();
    noDynatrace.monitoring.dynatrace.entitySelectors = [];
    const second = fakeSources({ problems: [problem(new Date())], series: [latencySeries()] });
    await collectSignals(noDynatrace, second.sources, { from: minutes(new Date(), -5).toISOString(), to: minutes(new Date(), 1).toISOString() });
    assert.equal(second.state.calls.listProblems, 0);
    assert.equal(second.state.calls.queryMetrics, 0);
  });

  test('null sources are tolerated', async () => {
    const { sources } = fakeSources();
    const result = await collectSignals(manifestWithDefaults(), { ...sources, splunk: null, dynatrace: null }, { from: minutes(new Date(), -5).toISOString(), to: new Date().toISOString() });
    assert.deepEqual(result.signals, []);
  });
});

describe('runOnce: detection and correlation', () => {
  test('a Splunk exception and the matching Dynatrace problem become one incident with both evidence links', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const { sources, state } = npeScenario(now);
    const report = await runOnce(workspace, projectId, { sources, now });

    assert.equal(report.status, 'completed');
    assert.equal(report.environment, 'nonprod');
    const incidents = listIncidents(workspace, projectId);
    assert.equal(incidents.length, 1);
    const [incident] = incidents;
    assert.deepEqual(report.incidents.created, [incident.incidentId]);
    assert.equal(incident.service, 'orders-service');
    assert.equal(incident.exceptionClass, 'java.lang.NullPointerException');
    assert.deepEqual([...incident.sources].sort(), ['dynatrace-problem', 'splunk']);
    assert.deepEqual([...incident.evidenceLinks].sort(), [PROBLEM_LINK, SPLUNK_LINK].sort());
    assert.equal(incident.correlation.method, 'trace-id');
    assert.equal(incident.traceId, TRACE);
    assert.equal(incident.spanId, SPAN);
    assert.equal(incident.occurrences, 3);
    assert.equal(incident.confidence.label, 'high');
    assert.equal(incident.status, 'defect-proposed');
    assert.deepEqual(incident.candidateRepos, ['service-api']);
    assert.deepEqual(incident.relatedSchemas, ['APP']);
    assert.deepEqual(incident.deploymentVersions, ['2.14.0']);
    assert.notEqual(incident.classification, 'verified-root-cause');
    assert.ok(incident.hypotheses.every((/** @type {any} */ h) => h.verified === false));
    assert.equal(state.calls.createDefect, 0);
  });

  test('stored incidents and approval previews are sanitized (no customer email)', async () => {
    const { workspace, projectId, root } = project();
    const now = new Date();
    const { sources } = npeScenario(now);
    await runOnce(workspace, projectId, { sources, now });
    const [incident] = listIncidents(workspace, projectId);
    assert.ok(!JSON.stringify(incident).includes('jane.doe@example.com'));
    assert.ok(!JSON.stringify(listApprovals(workspace, projectId)).includes('jane.doe@example.com'));
    const stateText = fs.readdirSync(path.join(root, 'state'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))
      .join('\n');
    assert.ok(!stateText.includes('jane.doe@example.com'), 'nothing under state/ holds the raw email');
  });

  test('a repeated error creates no duplicate incident, approval or ticket', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const { sources, state } = npeScenario(now);
    await runOnce(workspace, projectId, { sources, now });
    const [first] = listIncidents(workspace, projectId);

    // Same error again in the next window, problem still open.
    state.events.push(npeEvent(new Date(now.getTime() + 30_000), { trace_id: TRACE }));
    const second = await runOnce(workspace, projectId, { sources, now: minutes(now, 1) });
    assert.deepEqual(second.incidents.created, []);
    assert.deepEqual(second.incidents.merged, [first.incidentId]);
    assert.deepEqual(second.actions, []);

    // A window with only the standing problem: still the same incident (alias key).
    const third = await runOnce(workspace, projectId, { sources, now: minutes(now, 2) });
    assert.deepEqual(third.incidents.created, []);

    const incidents = listIncidents(workspace, projectId);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].occurrences, 4);
    assert.equal(incidents[0].status, 'defect-proposed');
    assert.equal(listApprovals(workspace, projectId).length, 1);
    assert.equal(state.calls.createDefect, 0);
    assert.equal(readCheckpoint(workspace, projectId).runs, 3);
  });

  test('reprocessing the same window after a lost checkpoint does not double-count', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const { sources } = npeScenario(now);
    await runOnce(workspace, projectId, { sources, now });
    const checkpoint = readCheckpoint(workspace, projectId);
    assert.equal(checkpoint.lastWindowEnd, now.toISOString());
    writeCheckpoint(workspace, projectId, { ...checkpoint, lastWindowEnd: null });
    const again = await runOnce(workspace, projectId, { sources, now });
    assert.deepEqual(again.incidents.created, []);
    assert.deepEqual(again.incidents.merged, []);
    const incidents = listIncidents(workspace, projectId);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].occurrences, 3);
    assert.equal(listApprovals(workspace, projectId).length, 1);
  });

  test('a latency regression with no exception is proposed when a threshold is configured', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const { sources, state } = fakeSources({ series: [latencySeries()] });
    const report = await runOnce(workspace, projectId, { sources, now });
    const incidents = listIncidents(workspace, projectId);
    assert.equal(incidents.length, 1);
    const [incident] = incidents;
    assert.equal(incident.service, 'payments-service');
    assert.equal(incident.exceptionClass, null);
    assert.deepEqual(incident.triggers, ['threshold-breached']);
    assert.deepEqual(incident.observedMetric, { metric: 'builtin:service.response.time:percentile(95)', observed: 2410, threshold: 1500, baseline: 1406.25, unit: 'ms' });
    assert.equal(incident.status, 'defect-proposed');
    assert.equal(incident.traceId, null);
    assert.equal(incident.spanId, null);
    assert.ok(incident.correlation.missing.includes('traceId'));
    assert.equal(report.actions[0].outcome, 'defect-proposed');
    assert.equal(listApprovals(workspace, projectId, { status: 'pending' }).length, 1);
    assert.equal(state.calls.queryMetrics, 1);
    assert.equal(state.calls.createDefect, 0);
  });

  test('the same regression does NOT become an incident when the threshold is null', async () => {
    const { workspace, projectId } = project({ monitoring: monitoringWith({ thresholds: NO_THRESHOLDS }) });
    const now = new Date();
    const { sources, state } = fakeSources({ series: [latencySeries()] });
    const report = await runOnce(workspace, projectId, { sources, now });
    assert.equal(report.status, 'completed');
    assert.equal(listIncidents(workspace, projectId).length, 0);
    assert.equal(listApprovals(workspace, projectId).length, 0);
    assert.equal(state.calls.queryMetrics, 0, 'metrics are not even queried without a threshold');
  });

  test('a threshold set for a different metric does not fire on latency', async () => {
    const { workspace, projectId } = project({ monitoring: monitoringWith({ thresholds: { errorCount: null, errorRatePercent: 5, p95LatencyMs: null } }) });
    const { sources } = fakeSources({ series: [latencySeries()] });
    await runOnce(workspace, projectId, { sources, now: new Date() });
    assert.equal(listIncidents(workspace, projectId).length, 0);
  });

  test('missing trace and span ids: processing continues with lower confidence and nothing is fabricated', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const { sources } = fakeSources({
      events: [npeEvent(minutes(now, -9)), npeEvent(minutes(now, -7))],
      problems: [problem(minutes(now, -10), { traceIds: [] })],
    });
    const report = await runOnce(workspace, projectId, { sources, now });
    assert.equal(report.status, 'completed');
    const [incident] = listIncidents(workspace, projectId);
    assert.equal(incident.correlation.method, 'time-and-service');
    assert.equal(incident.confidence.label, 'medium');
    assert.ok(incident.confidence.score < 0.7);
    assert.equal(incident.traceId, null);
    assert.deepEqual(incident.traceIds, []);
    assert.equal(incident.spanId, null);
    assert.equal(incident.requestId, null);
    assert.deepEqual(incident.correlation.missing, ['traceId', 'spanId']);
    assert.ok(incident.confidence.reasons.includes('spanId not present in the source data'));
    const draft = incident.defect.draft.descriptionHtml;
    assert.ok(draft.includes('Span ID: not present in the source data'));
    assert.ok(draft.includes('Trace ID: not present in the source data'));
  });

  test('a trace id but no span id still correlates, with the span reported missing', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const { sources } = fakeSources({ events: [npeEvent(minutes(now, -9), { trace_id: TRACE })], problems: [problem(minutes(now, -10))] });
    await runOnce(workspace, projectId, { sources, now });
    const [incident] = listIncidents(workspace, projectId);
    assert.equal(incident.correlation.method, 'trace-id');
    assert.equal(incident.spanId, null);
    assert.deepEqual(incident.correlation.missing, ['spanId']);
  });

  test('an unknown service-to-repository mapping stops at needs-onboarding: no approval, no ticket, no handoff', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const at = minutes(now, -6).toISOString();
    const { sources, state } = fakeSources({ events: [{ _time: at, service: 'ledger-batch', _raw: `${at} ERROR [ledger-batch] BatchRunner - java.lang.IllegalStateException: ledger period is closed` }] });
    const report = await runOnce(workspace, projectId, { sources, now });
    const [incident] = listIncidents(workspace, projectId);
    assert.equal(incident.status, 'needs-onboarding');
    assert.deepEqual(incident.candidateRepos, []);
    assert.match(incident.mappingNote, /"ledger-batch" is not mapped to a repository/);
    assert.equal(incident.defect, null);
    assert.equal(incident.handoff, null);
    assert.deepEqual(report.incidents.needsOnboarding, [incident.incidentId]);
    assert.equal(report.actions[0].outcome, 'needs-onboarding');
    assert.equal(listApprovals(workspace, projectId).length, 0);
    assert.equal(listTasks(workspace, projectId).length, 0);
    assert.equal(state.calls.createDefect, 0);
    assert.equal(state.calls.findDefectsByMarker, 0);

    // Still nothing on later passes while the mapping is missing.
    await runOnce(workspace, projectId, { sources, now: minutes(now, 1) });
    assert.equal(getIncident(workspace, projectId, incident.incidentId).status, 'needs-onboarding');
    assert.equal(listApprovals(workspace, projectId).length, 0);
    assert.equal(listTasks(workspace, projectId).length, 0);
  });

  test('a service listed without a repository, and an event with no service at all, also need onboarding', async () => {
    const manifest = fullManifest();
    manifest.services.push({ name: 'ledger-batch', repository: null });
    const { workspace, projectId } = project({ services: manifest.services });
    const now = new Date();
    const at = minutes(now, -6).toISOString();
    const { sources } = fakeSources({
      events: [
        { _time: at, service: 'ledger-batch', _raw: 'ERROR java.lang.IllegalStateException: closed' },
        { _time: at, _raw: 'ERROR something with no service field java.io.IOException: x' },
      ],
    });
    await runOnce(workspace, projectId, { sources, now });
    const incidents = listIncidents(workspace, projectId);
    assert.equal(incidents.length, 2);
    assert.ok(incidents.every((incident) => incident.status === 'needs-onboarding'));
    assert.match(incidents.find((incident) => incident.service === null)?.mappingNote, /did not identify a service/);
    assert.equal(listApprovals(workspace, projectId).length, 0);
  });

  test('once the mapping is added to project.yaml the incident is picked up and proposed', async () => {
    const { workspace, projectId, rawManifest } = project();
    const now = new Date();
    const at = minutes(now, -6).toISOString();
    const { sources } = fakeSources({ events: [{ _time: at, service: 'ledger-batch', _raw: 'ERROR java.lang.IllegalStateException: ledger period is closed' }] });
    await runOnce(workspace, projectId, { sources, now });
    rawManifest.services.push({ name: 'ledger-batch', repository: 'service-api' });
    fs.writeFileSync(path.join(workspace.projectsDir, projectId, 'project.yaml'), YAML.stringify(rawManifest));
    const report = await runOnce(workspace, projectId, { sources, now: minutes(now, 1) });
    assert.equal(report.pending[0].outcome, 'mapping-resolved; defect-proposed');
    const [incident] = listIncidents(workspace, projectId);
    assert.equal(incident.status, 'defect-proposed');
    assert.deepEqual(incident.candidateRepos, ['service-api']);
    assert.equal(listApprovals(workspace, projectId, { status: 'pending' }).length, 1);
  });

  test('events without a usable timestamp are counted as unparsed and create nothing', async () => {
    const { workspace, projectId } = project();
    const { sources } = fakeSources({ events: [{ _time: 'not-a-time', service: 'orders-service', _raw: 'ERROR java.lang.NullPointerException' }] });
    const report = await runOnce(workspace, projectId, { sources, now: new Date() });
    assert.equal(report.windows[0].unparsedEvents, 1);
    assert.equal(listIncidents(workspace, projectId).length, 0);
  });

  test('errorCount threshold: below it nothing is recorded, at it an incident is', async () => {
    const { workspace, projectId } = project({ monitoring: monitoringWith({ thresholds: { errorCount: 3, errorRatePercent: null, p95LatencyMs: null } }) });
    const now = new Date();
    const { sources, state } = fakeSources({ events: [npeEvent(minutes(now, -9)), npeEvent(minutes(now, -8))] });
    await runOnce(workspace, projectId, { sources, now });
    assert.equal(listIncidents(workspace, projectId).length, 0);
    state.events.push(npeEvent(minutes(now, 0.2)), npeEvent(minutes(now, 0.4)), npeEvent(minutes(now, 0.6)));
    await runOnce(workspace, projectId, { sources, now: minutes(now, 1) });
    const [incident] = listIncidents(workspace, projectId);
    assert.equal(incident.occurrences, 3);
    assert.deepEqual(incident.triggers, ['errorCount >= 3']);
  });
});

describe('runOnce: approval gate for tickets', () => {
  test('no ticket is created without approval, however many passes run', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const { sources, state } = npeScenario(now);
    for (let pass = 0; pass < 4; pass += 1) await runOnce(workspace, projectId, { sources, now: minutes(now, pass) });
    assert.equal(state.calls.createDefect, 0);
    assert.equal(state.defects.length, 0);
    const pending = listApprovals(workspace, projectId, { status: 'pending' });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].action, Actions.CREATE_DEFECT);
    assert.equal(pending[0].requestedBy, 'monitoring-worker');
    assert.equal(listTasks(workspace, projectId).length, 0);
    assert.equal(listIncidents(workspace, projectId)[0].status, 'defect-proposed');
  });

  test('after approval the ticket is created exactly once, with exactly the approved draft, and queued for handoff', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const { sources, state } = npeScenario(now);
    await runOnce(workspace, projectId, { sources, now });
    const proposed = listIncidents(workspace, projectId)[0];
    const approvedDraft = structuredClone(proposed.defect.draft);
    await decide(workspace, projectId, proposed.defect.approvalId);

    const report = await runOnce(workspace, projectId, { sources, now: minutes(now, 1) });
    assert.deepEqual(report.pending, [{ incidentId: proposed.incidentId, outcome: 'defect-created' }]);
    assert.equal(state.defects.length, 1);
    assert.deepEqual(state.defects[0].draft, approvedDraft);
    assert.ok(state.defects[0].draft.descriptionHtml.includes(`autodev-incident:${proposed.incidentId}:`));
    assert.ok(!state.defects[0].draft.descriptionHtml.includes('jane.doe@example.com'));
    assert.ok(!/Verified root cause/.test(state.defects[0].draft.descriptionHtml));

    const incident = getIncident(workspace, projectId, proposed.incidentId);
    assert.equal(incident.status, 'handoff-queued');
    assert.equal(incident.defect.id, 'D-00001');
    assert.equal(incident.defect.state, 'created');
    assert.equal(incident.defect.linkedExisting, false);
    assert.equal(getApproval(workspace, projectId, proposed.defect.approvalId).status, 'consumed');

    const tasks = listTasks(workspace, projectId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].defectId, 'D-00001');
    assert.equal(tasks[0].status, 'awaiting-start-approval');
    assert.equal(incident.handoff.taskId, tasks[0].taskId);
    assert.equal(await claimNext(workspace, projectId), null, 'a created ticket is not permission to start development');

    // Later passes, with the error still occurring, never create it again.
    state.events.push(npeEvent(minutes(now, 1.5), { trace_id: TRACE }));
    await runOnce(workspace, projectId, { sources, now: minutes(now, 2) });
    await runOnce(workspace, projectId, { sources, now: minutes(now, 3) });
    assert.equal(state.defects.length, 1);
    assert.equal(state.calls.createDefect, 1);
    assert.equal(listIncidents(workspace, projectId).length, 1);
    assert.equal(listApprovals(workspace, projectId).length, 1);
    assert.equal(listTasks(workspace, projectId).length, 1);
    assert.equal(verifyAudit(workspace, projectId).valid, true);
    assert.equal(readAudit(workspace, projectId, { action: 'agility.defect.created' }).length, 1);
  });

  test('a denied approval moves the incident to defect-denied and it is never proposed or ticketed again', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const { sources, state } = npeScenario(now);
    await runOnce(workspace, projectId, { sources, now });
    const proposed = listIncidents(workspace, projectId)[0];
    await decide(workspace, projectId, proposed.defect.approvalId, 'denied');

    const report = await runOnce(workspace, projectId, { sources, now: minutes(now, 1) });
    assert.deepEqual(report.pending, [{ incidentId: proposed.incidentId, outcome: 'defect-denied' }]);
    const denied = getIncident(workspace, projectId, proposed.incidentId);
    assert.equal(denied.status, 'defect-denied');
    assert.equal(denied.history.at(-1).reason, 'not a defect');

    state.events.push(npeEvent(minutes(now, 1.5), { trace_id: TRACE }));
    await runOnce(workspace, projectId, { sources, now: minutes(now, 2) });
    await runOnce(workspace, projectId, { sources, now: minutes(now, 3) });
    assert.equal(getIncident(workspace, projectId, proposed.incidentId).status, 'defect-denied');
    assert.equal(listIncidents(workspace, projectId).length, 1);
    assert.equal(listApprovals(workspace, projectId).length, 1, 'no fresh approval request after a denial');
    assert.equal(state.calls.createDefect, 0);
    assert.equal(listTasks(workspace, projectId).length, 0);
  });

  test('an expired approval lapses back to detected without creating a ticket', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const { sources, state } = npeScenario(now);
    await runOnce(workspace, projectId, { sources, now });
    const proposed = listIncidents(workspace, projectId)[0];
    const file = path.join(workspace.stateDir, 'approvals', projectId, `${proposed.defect.approvalId}.json`);
    const approval = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...approval, status: 'approved', expiresAt: new Date(Date.now() - 1000).toISOString() }));
    state.events.length = 0;
    state.problems.length = 0;
    const report = await runOnce(workspace, projectId, { sources, now: minutes(now, 1) });
    assert.equal(report.pending[0].outcome, 'approval-lapsed');
    const incident = getIncident(workspace, projectId, proposed.incidentId);
    assert.equal(incident.status, 'detected');
    assert.equal(incident.defect, null);
    assert.equal(state.calls.createDefect, 0);
  });

  test('a draft edited on disk after approval is refused (APPROVAL_MISMATCH) and nothing is sent', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const { sources, state } = npeScenario(now);
    await runOnce(workspace, projectId, { sources, now });
    const proposed = listIncidents(workspace, projectId)[0];
    await decide(workspace, projectId, proposed.defect.approvalId);
    proposed.defect.draft.title = 'something nobody approved';
    saveIncident(workspace, proposed);
    const report = await runOnce(workspace, projectId, { sources, now: minutes(now, 1) });
    assert.equal(report.pending[0].outcome, 'retry-next-pass');
    assert.equal(report.pending[0].code, 'APPROVAL_MISMATCH');
    assert.equal(state.calls.createDefect, 0);
    assert.equal(report.status, 'completed', 'one stuck incident does not fail the pass');
  });

  test('policy prohibited: the incident is recorded only; no approval, no ticket', async () => {
    const { workspace, projectId } = project({ policies: { createDefect: 'prohibited' } });
    const now = new Date();
    const { sources, state } = npeScenario(now);
    const report = await runOnce(workspace, projectId, { sources, now });
    assert.equal(report.actions[0].outcome, 'recorded-only');
    const [incident] = listIncidents(workspace, projectId);
    assert.equal(incident.status, 'detected');
    assert.match(incident.ticketNote, /prohibited by policy/);
    await runOnce(workspace, projectId, { sources, now: minutes(now, 1) });
    assert.equal(listApprovals(workspace, projectId).length, 0);
    assert.equal(state.calls.createDefect, 0);
  });

  test('only when both policies say allowed is a ticket created without approval; one alone is not enough', async () => {
    const one = project({ policies: { createDefect: 'allowed' } });
    const now = new Date();
    const first = npeScenario(now);
    await runOnce(one.workspace, one.projectId, { sources: first.sources, now });
    assert.equal(first.state.calls.createDefect, 0);
    assert.equal(listApprovals(one.workspace, one.projectId, { status: 'pending' }).length, 1);

    const both = project({
      policies: { createDefect: 'allowed' },
      monitoring: monitoringWith({ incidentPolicy: { createTicket: 'allowed' } }),
    });
    const second = npeScenario(now);
    const report = await runOnce(both.workspace, both.projectId, { sources: second.sources, now });
    assert.equal(report.actions[0].outcome, 'defect-created');
    assert.equal(second.state.defects.length, 1);
    assert.equal(listIncidents(both.workspace, both.projectId)[0].status, 'handoff-queued');
    assert.equal(listTasks(both.workspace, both.projectId)[0].status, 'awaiting-start-approval');
    await runOnce(both.workspace, both.projectId, { sources: second.sources, now: minutes(now, 1) });
    assert.equal(second.state.defects.length, 1);
  });

  test('an existing ticket carrying the incident marker is linked instead of proposing a new one', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const { sources, state } = npeScenario(now);
    // Dry-run first to learn nothing is stored, then seed a remote defect with the marker.
    state.fail.findDefectsByMarker = undefined;
    const originalFind = sources.agility.findDefectsByMarker;
    sources.agility.findDefectsByMarker = async (/** @type {string} */ marker) => {
      await originalFind(marker);
      return [{ id: 'D-00777', url: 'https://agility.example.internal/defect/D-00777' }];
    };
    const report = await runOnce(workspace, projectId, { sources, now });
    assert.equal(report.actions[0].outcome, 'linked-existing-defect');
    const [incident] = listIncidents(workspace, projectId);
    assert.equal(incident.defect.id, 'D-00777');
    assert.equal(incident.defect.linkedExisting, true);
    assert.equal(incident.status, 'handoff-queued');
    assert.equal(state.calls.createDefect, 0);
    assert.equal(listApprovals(workspace, projectId).length, 0);
    assert.equal(listTasks(workspace, projectId)[0].defectId, 'D-00777');
  });

  test('when the existing-ticket check is unavailable the incident is still proposed and says the check was skipped', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const { sources, state } = npeScenario(now);
    state.fail.findDefectsByMarker = new AutoDevError('AUTH_REQUIRED', 'no token');
    const report = await runOnce(workspace, projectId, { sources, now });
    assert.equal(report.status, 'completed');
    const [incident] = listIncidents(workspace, projectId);
    assert.equal(incident.status, 'defect-proposed');
    assert.equal(incident.existingDefectCheck, 'not checked (AUTH_REQUIRED)');
    assert.equal(state.calls.createDefect, 0);
  });
});

describe('runOnce: crash recovery', () => {
  /** Run to the point where the ticket is proposed and approved. */
  async function approvedIncident() {
    const p = project();
    const now = new Date();
    const fake = npeScenario(now);
    await runOnce(p.workspace, p.projectId, { sources: fake.sources, now });
    const incident = listIncidents(p.workspace, p.projectId)[0];
    await decide(p.workspace, p.projectId, incident.defect.approvalId);
    return { ...p, now, ...fake, incident };
  }

  test('interrupted after the ticket was written but before it was recorded: recovered without a duplicate', async () => {
    const { workspace, projectId, sources, state, incident, now } = await approvedIncident();
    // What the worker does up to the crash point.
    await consumeApproval(workspace, { projectId, id: incident.defect.approvalId, action: Actions.CREATE_DEFECT, payload: incident.defect.draft });
    await sources.agility.createDefect(incident.defect.draft);
    incident.defect.state = 'creating';
    saveIncident(workspace, incident);
    assert.equal(state.defects.length, 1);

    const report = await runOnce(workspace, projectId, { sources, now: minutes(now, 1) });
    assert.deepEqual(report.pending, [{ incidentId: incident.incidentId, outcome: 'recovered-created-defect' }]);
    assert.equal(state.defects.length, 1);
    assert.equal(state.calls.createDefect, 1);
    const recovered = getIncident(workspace, projectId, incident.incidentId);
    assert.equal(recovered.defect.id, 'D-00001');
    assert.equal(recovered.status, 'handoff-queued');
    assert.equal(listTasks(workspace, projectId).length, 1);

    await runOnce(workspace, projectId, { sources, now: minutes(now, 2) });
    assert.equal(state.defects.length, 1);
    assert.equal(listTasks(workspace, projectId).length, 1);
  });

  test('interrupted after the approval was spent but before the ticket was written: nothing is created without a fresh approval', async () => {
    const { workspace, projectId, sources, state, incident, now } = await approvedIncident();
    await consumeApproval(workspace, { projectId, id: incident.defect.approvalId, action: Actions.CREATE_DEFECT, payload: incident.defect.draft });
    incident.defect.state = 'creating';
    saveIncident(workspace, incident);

    const report = await runOnce(workspace, projectId, { sources, now: minutes(now, 1) });
    assert.equal(report.pending[0].outcome, 'interrupted-write-not-found');
    assert.equal(state.calls.createDefect, 0);
    const after1 = getIncident(workspace, projectId, incident.incidentId);
    assert.ok(['detected', 'defect-proposed'].includes(after1.status));
    assert.equal(listIncidents(workspace, projectId).length, 1);

    await runOnce(workspace, projectId, { sources, now: minutes(now, 2) });
    await runOnce(workspace, projectId, { sources, now: minutes(now, 3) });
    assert.equal(state.calls.createDefect, 0, 'the spent approval cannot be reused');
    assert.equal(listApprovals(workspace, projectId, { status: 'approved' }).length, 0);
    assert.equal(getIncident(workspace, projectId, incident.incidentId).status, 'defect-proposed');
    assert.equal(listApprovals(workspace, projectId, { status: 'pending' }).length, 1);
  });

  test('the ticket service failing mid-create is retried on later passes and ends with exactly one ticket', async () => {
    const { workspace, projectId, sources, state, incident, now } = await approvedIncident();
    state.fail.createDefect = new AutoDevError('UPSTREAM_ERROR', 'Agility returned HTTP 500.');
    const failed = await runOnce(workspace, projectId, { sources, now: minutes(now, 1) });
    assert.equal(failed.status, 'completed');
    assert.equal(failed.pending[0].outcome, 'retry-next-pass');
    assert.equal(failed.pending[0].code, 'UPSTREAM_ERROR');
    assert.equal(getIncident(workspace, projectId, incident.incidentId).defect.state, 'creating');
    assert.equal(state.defects.length, 0);

    state.fail.createDefect = undefined;
    for (let pass = 2; pass <= 5; pass += 1) await runOnce(workspace, projectId, { sources, now: minutes(now, pass) });
    assert.ok(state.defects.length <= 1, 'never more than one ticket');
    assert.equal(listIncidents(workspace, projectId).length, 1);
  });

  test('interrupted between recording the ticket and queueing the handoff: the handoff is queued once', async () => {
    const { workspace, projectId, sources, state, incident, now } = await approvedIncident();
    incident.defect = { ...incident.defect, state: 'created', id: 'D-00042', url: 'https://agility.example.internal/defect/D-00042', draft: undefined };
    incident.status = 'defect-created';
    saveIncident(workspace, incident);
    const report = await runOnce(workspace, projectId, { sources, now: minutes(now, 1) });
    assert.deepEqual(report.pending, [{ incidentId: incident.incidentId, outcome: 'handoff-queued' }]);
    await runOnce(workspace, projectId, { sources, now: minutes(now, 2) });
    const tasks = listTasks(workspace, projectId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].defectId, 'D-00042');
    assert.equal(getIncident(workspace, projectId, incident.incidentId).status, 'handoff-queued');
    assert.equal(state.calls.createDefect, 0);
  });

  test('a stale worker lock left by a crashed pass is taken over', async () => {
    const { workspace, projectId } = project();
    const lock = path.join(workspace.stateDir, 'monitor', projectId, 'worker.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ owner: 'dead:1', acquiredAt: new Date(0).toISOString() }));
    const old = new Date(Date.now() - 31 * 60_000);
    fs.utimesSync(lock, old, old);
    const { sources } = fakeSources();
    assert.equal((await runOnce(workspace, projectId, { sources, now: new Date() })).status, 'completed');
    assert.equal(fs.existsSync(lock), false);
  });
});

describe('runOnce: failures, backoff and locking', () => {
  test('a failing source marks the pass failed, saves a backoff, and the next pass reports backing-off', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const { sources, state } = npeScenario(now);
    state.fail.searchErrors = new AutoDevError('NETWORK', 'Could not reach Splunk: ECONNREFUSED');

    const failed = await runOnce(workspace, projectId, { sources, now });
    assert.equal(failed.status, 'failed');
    assert.deepEqual(failed.error, { code: 'NETWORK', message: 'Could not reach Splunk: ECONNREFUSED' });
    assert.equal(failed.consecutiveFailures, 1);
    const checkpoint = readCheckpoint(workspace, projectId);
    assert.equal(checkpoint.consecutiveFailures, 1);
    assert.equal(checkpoint.lastWindowEnd, null, 'the failed window is not skipped');
    assert.match(String(checkpoint.lastError), /^NETWORK: /);
    const waitMs = Date.parse(String(checkpoint.nextAttemptAfter)) - Date.now();
    assert.ok(waitMs > 30_000 && waitMs <= 60_000, `first backoff is about a minute (${waitMs} ms)`);
    assert.equal(listIncidents(workspace, projectId).length, 0);
    assert.equal(readAudit(workspace, projectId, { action: 'monitoring.pass' }).at(-1)?.outcome, 'failure');

    state.fail.searchErrors = undefined;
    const callsBefore = state.calls.searchErrors;
    const waiting = await runOnce(workspace, projectId, { sources, now: new Date() });
    assert.equal(waiting.status, 'backing-off');
    assert.equal(waiting.nextAttemptAfter, checkpoint.nextAttemptAfter);
    assert.match(waiting.lastError, /NETWORK/);
    assert.equal(state.calls.searchErrors, callsBefore, 'no query is made while backing off');

    // Once the backoff has passed the window that failed is read and the counters reset.
    const resumed = await runOnce(workspace, projectId, { sources, now: minutes(new Date(), 2) });
    assert.equal(resumed.status, 'completed');
    assert.equal(listIncidents(workspace, projectId).length, 1);
    const cleared = readCheckpoint(workspace, projectId);
    assert.equal(cleared.consecutiveFailures, 0);
    assert.equal(cleared.nextAttemptAfter, null);
    assert.equal(cleared.lastError, null);
  });

  test('backoff doubles with consecutive failures and is capped at an hour', async () => {
    const { workspace, projectId } = project();
    const { sources, state } = fakeSources();
    state.fail.listProblems = new Error('boom (not an AutoDevError)');
    /** @type {number[]} */
    const waits = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await runOnce(workspace, projectId, { sources, now: new Date(), ignoreBackoff: true });
      assert.equal(result.status, 'failed');
      assert.equal(result.error.code, 'INTERNAL');
      waits.push(Date.parse(result.nextAttemptAfter) - Date.now());
    }
    assert.equal(readCheckpoint(workspace, projectId).consecutiveFailures, 3);
    assert.ok(waits[1] > waits[0] * 1.5 && waits[2] > waits[1] * 1.5, waits.join(','));
    writeCheckpoint(workspace, projectId, { ...readCheckpoint(workspace, projectId), consecutiveFailures: 40 });
    const capped = await runOnce(workspace, projectId, { sources, now: new Date(), ignoreBackoff: true });
    assert.ok(Date.parse(capped.nextAttemptAfter) - Date.now() <= 60 * 60_000);
  });

  test('a secret in a source error message does not reach the checkpoint or the report',
    async () => {
      const { workspace, projectId } = project();
      const { sources, state } = fakeSources();
      state.fail.searchErrors = new Error('upstream said: Authorization: Bearer abcdef1234567890abcdef');
      const result = await runOnce(workspace, projectId, { sources, now: new Date() });
      assert.ok(!JSON.stringify(result).includes('abcdef1234567890abcdef'));
      assert.ok(!JSON.stringify(readCheckpoint(workspace, projectId)).includes('abcdef1234567890abcdef'));
    });

  test('a dry run with a failing source throws and stores no backoff', async () => {
    const { workspace, projectId } = project();
    const { sources, state } = fakeSources();
    state.fail.searchErrors = new AutoDevError('TIMEOUT', 'Splunk did not answer');
    await expectCode(() => runOnce(workspace, projectId, { sources, now: new Date(), dryRun: true }), 'TIMEOUT');
    assert.equal(readCheckpoint(workspace, projectId).consecutiveFailures, 0);
    assert.equal(readCheckpoint(workspace, projectId).nextAttemptAfter, null);
  });

  test('while another pass holds the lock the worker reports already-running and does nothing', async () => {
    const { workspace, projectId } = project();
    const lock = path.join(workspace.stateDir, 'monitor', projectId, 'worker.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ owner: 'other:1', acquiredAt: new Date().toISOString() }));
    const { sources, state } = npeScenario(new Date());
    const result = await runOnce(workspace, projectId, { sources, now: new Date() });
    assert.equal(result.status, 'already-running');
    assert.equal(state.calls.searchErrors, 0);
    assert.equal(listIncidents(workspace, projectId).length, 0);
    assert.equal(fs.existsSync(lock), true, 'the other process\'s lock is left alone');
  });

  test('two passes started together: one runs, the other reports already-running, and no incident is duplicated', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const { sources } = npeScenario(now);
    const results = await Promise.all([runOnce(workspace, projectId, { sources, now }), runOnce(workspace, projectId, { sources, now })]);
    assert.deepEqual(results.map((result) => result.status).sort(), ['already-running', 'completed']);
    assert.equal(listIncidents(workspace, projectId).length, 1);
    assert.equal(listApprovals(workspace, projectId).length, 1);
  });

  test('the lock is released after a pass, including a failed one', async () => {
    const { workspace, projectId } = project();
    const { sources, state } = fakeSources();
    state.fail.searchErrors = new Error('x');
    await runOnce(workspace, projectId, { sources, now: new Date() });
    assert.equal(fs.existsSync(path.join(workspace.stateDir, 'monitor', projectId, 'worker.lock')), false);
    assert.equal((await runOnce(workspace, projectId, { sources, now: new Date(), ignoreBackoff: true })).status, 'failed');
  });
});

describe('runOnce: configuration, dry run and isolation', () => {
  test('monitoring disabled: nothing is queried', async () => {
    const { workspace, projectId } = project({ monitoring: monitoringWith({ enabled: false }) });
    const { sources, state } = npeScenario(new Date());
    const result = await runOnce(workspace, projectId, { sources });
    assert.equal(result.status, 'disabled');
    assert.deepEqual(state.calls, { searchErrors: 0, listProblems: 0, queryMetrics: 0, findDefectsByMarker: 0, createDefect: 0 });
  });

  test('no environment, or nothing scoped to query, is NOT_CONFIGURED', async () => {
    const noEnv = project({ monitoring: monitoringWith({ environment: null }) });
    await expectCode(() => runOnce(noEnv.workspace, noEnv.projectId, { sources: fakeSources().sources }), 'NOT_CONFIGURED', /environment/);
    const noScope = project({ monitoring: monitoringWith({ splunk: { indexes: [] }, dynatrace: { entitySelectors: [] } }) });
    await expectCode(() => runOnce(noScope.workspace, noScope.projectId, { sources: fakeSources().sources }), 'NOT_CONFIGURED');
  });

  test('an unknown project is PROJECT_NOT_FOUND', async () => {
    const { workspace } = project();
    await expectCode(() => runOnce(workspace, 'no-such-project', { sources: fakeSources().sources }), 'PROJECT_NOT_FOUND');
  });

  test('a dry run reports what it would record and stores nothing: no incident, approval, checkpoint or audit entry', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    const { sources, state } = npeScenario(now);
    const report = await runOnce(workspace, projectId, { sources, now, dryRun: true });
    assert.equal(report.dryRun, true);
    assert.equal(report.actions.length, 1);
    assert.equal(report.actions[0].wouldRecord.service, 'orders-service');
    assert.equal(report.actions[0].wouldRecord.occurrences, 3);
    assert.equal(listIncidents(workspace, projectId).length, 0);
    assert.equal(listApprovals(workspace, projectId).length, 0);
    assert.equal(readAudit(workspace, projectId).length, 0);
    assert.equal(readCheckpoint(workspace, projectId).runs, 0);
    assert.equal(state.calls.createDefect, 0);
    assert.equal(state.calls.findDefectsByMarker, 0);
    assert.ok(!JSON.stringify(report).includes('jane.doe@example.com'));
  });

  test('a dry run does not advance the checkpoint, so the real pass still sees the window',
    async () => {
      const { workspace, projectId } = project();
      const now = new Date();
      const { sources } = npeScenario(now);
      await runOnce(workspace, projectId, { sources, now, dryRun: true });
      assert.equal(readCheckpoint(workspace, projectId).lastWindowEnd, null);
      await runOnce(workspace, projectId, { sources, now: new Date(now.getTime() + 2000) });
      assert.equal(listIncidents(workspace, projectId).length, 1);
    });

  test('project A\'s incidents, approvals, tasks and checkpoint are invisible to project B', async () => {
    const { workspace, projectId } = project();
    const billing = fullManifest({ id: 'billing', name: 'Billing' });
    billing.agility = { ...billing.agility, boardIds: ['999'] };
    writeProject(workspace, billing, { 'guidelines/architecture.md': '# x\n' });
    const now = new Date();
    const a = npeScenario(now);
    const b = fakeSources();
    await runOnce(workspace, projectId, { sources: a.sources, now });
    const reportB = await runOnce(workspace, 'billing', { sources: b.sources, now });
    const [incidentA] = listIncidents(workspace, projectId);

    assert.equal(reportB.status, 'completed');
    assert.deepEqual(reportB.incidents.created, []);
    assert.deepEqual(listIncidents(workspace, 'billing'), []);
    assert.deepEqual(listApprovals(workspace, 'billing'), []);
    assert.deepEqual(listTasks(workspace, 'billing'), []);
    await expectCode(() => getIncident(workspace, 'billing', incidentA.incidentId), 'NOT_FOUND');
    await expectCode(() => getApproval(workspace, 'billing', incidentA.defect.approvalId), 'NOT_FOUND');
    assert.equal(b.state.calls.findDefectsByMarker, 0);
    assert.ok(readAudit(workspace, 'billing').every((entry) => entry.projectId === 'billing' && !JSON.stringify(entry).includes(incidentA.incidentId)));

    // The same error seen by project B is B's own incident, with its own id and key.
    b.state.events.push(npeEvent(minutes(now, 0.5)));
    await runOnce(workspace, 'billing', { sources: b.sources, now: minutes(now, 1) });
    const [incidentB] = listIncidents(workspace, 'billing');
    assert.equal(incidentB.projectId, 'billing');
    assert.notEqual(incidentB.dedupeKey, incidentA.dedupeKey);
    assert.notEqual(incidentB.incidentId, incidentA.incidentId);
    assert.equal(listIncidents(workspace, projectId).length, 1);
    assert.equal(getIncident(workspace, projectId, incidentA.incidentId).occurrences, 3);
  });

  test('catching up after an outage reads bounded windows oldest first and reports it is behind', async () => {
    const { workspace, projectId } = project();
    const now = new Date();
    writeCheckpoint(workspace, projectId, { ...readCheckpoint(workspace, projectId), lastWindowEnd: minutes(now, -10 * 60).toISOString() });
    const { sources, state } = fakeSources({ events: [npeEvent(minutes(now, -5))] });
    const report = await runOnce(workspace, projectId, { sources, now });
    assert.equal(report.windows.length, 4);
    assert.equal(report.behind, true);
    assert.ok(state.windows.every((window) => Date.parse(window.to) - Date.parse(window.from) <= 60 * 60_000));
    assert.equal(readCheckpoint(workspace, projectId).lastWindowEnd, minutes(now, -6 * 60).toISOString());
    assert.equal(listIncidents(workspace, projectId).length, 0, 'the recent event is in a window not reached yet');
    const next = await runOnce(workspace, projectId, { sources, now, maxChunks: 10 });
    assert.equal(next.behind, false);
    assert.equal(listIncidents(workspace, projectId).length, 1);
  });

  test('runMany isolates projects: one failing project does not stop the others, and order is kept', async () => {
    const { workspace } = project();
    const results = await runMany(workspace, ['a', 'b', 'c'], async (id) => {
      if (id === 'b') throw new AutoDevError('NOT_CONFIGURED', 'b is broken');
      return { projectId: id, status: 'completed' };
    }, 2);
    assert.deepEqual(results.map((result) => [result.projectId, result.status]), [['a', 'completed'], ['b', 'failed'], ['c', 'completed']]);
    assert.equal(results[1].error.code, 'NOT_CONFIGURED');
    assert.deepEqual(await runMany(workspace, [], async () => ({})), []);
  });
});

describe('verifyResolution', () => {
  /** An incident advanced to pr-created. */
  async function withPrCreated() {
    const p = project();
    const detectedAt = new Date(Date.now() - 6 * 60 * 60_000);
    const fake = fakeSources({ events: [npeEvent(minutes(detectedAt, -5), { trace_id: TRACE })] });
    await runOnce(p.workspace, p.projectId, { sources: fake.sources, now: detectedAt });
    const incident = listIncidents(p.workspace, p.projectId)[0];
    incident.status = 'pr-created';
    incident.links.pullRequests.push('https://bitbucket.example.internal/pr/1');
    saveIncident(p.workspace, incident);
    fake.state.events.length = 0;
    return { ...p, ...fake, incident, deployedAt: minutes(detectedAt, 60) };
  }

  test('without a deployment time validation stays pending and nothing changes', async () => {
    const { workspace, projectId, sources, incident } = await withPrCreated();
    const result = await verifyResolution(workspace, projectId, incident.incidentId, { sources });
    assert.equal(result.verified, false);
    assert.equal(result.status, 'pr-created');
    assert.match(result.reason, /No deployment time/);
    const invalid = await verifyResolution(workspace, projectId, incident.incidentId, { sources, deployedAt: 'yesterday-ish' });
    assert.equal(invalid.verified, false);
    assert.equal(getIncident(workspace, projectId, incident.incidentId).status, 'pr-created');
  });

  test('too early after deployment: not verified, status validation-pending, no telemetry query', async () => {
    const { workspace, projectId, sources, state, incident, deployedAt } = await withPrCreated();
    const before = state.calls.searchErrors;
    const result = await verifyResolution(workspace, projectId, incident.incidentId, { sources, deployedAt: deployedAt.toISOString(), deploymentRef: 'release-2.15.1', now: minutes(deployedAt, 59) });
    assert.equal(result.verified, false);
    assert.equal(result.status, 'validation-pending');
    assert.match(result.reason, /Only 59 minute\(s\) since deployment; 60 are needed/);
    assert.equal(state.calls.searchErrors, before);
    const stored = getIncident(workspace, projectId, incident.incidentId);
    assert.equal(stored.status, 'validation-pending');
    assert.deepEqual(stored.links.deployments, [{ at: deployedAt.toISOString(), ref: 'release-2.15.1' }]);
  });

  test('a full dedupe window with no recurrence: resolved-verified, with the evidence recorded', async () => {
    const { workspace, projectId, sources, incident, deployedAt } = await withPrCreated();
    const now = minutes(deployedAt, 61);
    const result = await verifyResolution(workspace, projectId, incident.incidentId, { sources, deployedAt: deployedAt.toISOString(), now });
    assert.equal(result.verified, true);
    assert.equal(result.status, 'resolved-verified');
    assert.deepEqual(result.evidence, { checkedFrom: deployedAt.toISOString(), checkedTo: now.toISOString(), windows: 2, signalsChecked: 0, recurrences: 0 });
    const stored = getIncident(workspace, projectId, incident.incidentId);
    assert.equal(stored.status, 'resolved-verified');
    assert.equal(stored.history.at(-1).event, 'resolution-verified');
    assert.equal(readAudit(workspace, projectId, { action: 'incident.resolution-check' }).at(-1)?.outcome, 'success');
  });

  test('the same error after the deployment: still occurring, not verified, stays validation-pending', async () => {
    const { workspace, projectId, sources, state, incident, deployedAt } = await withPrCreated();
    state.events.push(npeEvent(minutes(deployedAt, 20)), npeEvent(minutes(deployedAt, 30)));
    const result = await verifyResolution(workspace, projectId, incident.incidentId, { sources, deployedAt: deployedAt.toISOString(), now: minutes(deployedAt, 90) });
    assert.equal(result.verified, false);
    assert.equal(result.status, 'validation-pending');
    assert.equal(result.evidence?.recurrences, 2);
    assert.equal(getIncident(workspace, projectId, incident.incidentId).history.at(-1).event, 'still-occurring');
    assert.equal(readAudit(workspace, projectId, { action: 'incident.resolution-check' }).at(-1)?.outcome, 'failure');

    // It can be checked again later and verified once the error has stopped.
    state.events.length = 0;
    const later = await verifyResolution(workspace, projectId, incident.incidentId, { sources, now: minutes(deployedAt, 200) });
    assert.equal(later.verified, true);
  });

  test('a different error, or the same error in another service, is not counted as a recurrence', async () => {
    const { workspace, projectId, sources, state, incident, deployedAt } = await withPrCreated();
    const at = minutes(deployedAt, 20);
    state.events.push(
      { _time: at.toISOString(), service: 'orders-service', _raw: 'ERROR java.lang.IllegalArgumentException: other\n\tat com.example.Other.run(Other.java:1)' },
      npeEvent(at, { service: 'payments-service' }),
    );
    const result = await verifyResolution(workspace, projectId, incident.incidentId, { sources, deployedAt: deployedAt.toISOString(), now: minutes(deployedAt, 61) });
    assert.equal(result.evidence?.signalsChecked, 2);
    assert.equal(result.evidence?.recurrences, 0);
    assert.equal(result.verified, true);
  });

  test('errors from before the deployment are not counted', async () => {
    const { workspace, projectId, sources, state, incident, deployedAt } = await withPrCreated();
    state.events.push(npeEvent(minutes(deployedAt, -1)));
    const result = await verifyResolution(workspace, projectId, incident.incidentId, { sources, deployedAt: deployedAt.toISOString(), now: minutes(deployedAt, 61) });
    assert.equal(result.verified, true);
  });

  test('telemetry unavailable: never verified, validation remains pending', async () => {
    const { workspace, projectId, sources, state, incident, deployedAt } = await withPrCreated();
    state.fail.searchErrors = new AutoDevError('NETWORK', 'Could not reach Splunk');
    const result = await verifyResolution(workspace, projectId, incident.incidentId, { sources, deployedAt: deployedAt.toISOString(), now: minutes(deployedAt, 61) });
    assert.equal(result.verified, false);
    assert.equal(result.status, 'validation-pending');
    assert.match(result.reason, /Telemetry could not be read \(NETWORK\)/);
    const stored = getIncident(workspace, projectId, incident.incidentId);
    assert.equal(stored.status, 'validation-pending');
    assert.ok(stored.history.every((/** @type {any} */ entry) => entry.event !== 'resolution-verified'));
  });

  test('resolution cannot be verified before a PR exists, or for another project', async () => {
    const { workspace, projectId, sources, incident } = await withPrCreated();
    incident.status = 'handoff-queued';
    saveIncident(workspace, incident);
    await expectCode(() => verifyResolution(workspace, projectId, incident.incidentId, { sources, deployedAt: new Date().toISOString() }), 'CONFLICT');
    assert.equal(getIncident(workspace, projectId, incident.incidentId).status, 'handoff-queued');
    await expectCode(() => verifyResolution(workspace, projectId, 'INC-20260101-00000000', { sources }), 'NOT_FOUND');
  });

  test('a deployment time in the future is never judged as verified', async () => {
    const { workspace, projectId, sources, incident } = await withPrCreated();
    const now = new Date();
    await expectCode(() => verifyResolution(workspace, projectId, incident.incidentId, { sources, deployedAt: minutes(now, 600).toISOString(), now }), 'INVALID_ARGUMENT');
    assert.equal(getIncident(workspace, projectId, incident.incidentId).status, 'pr-created');
  });
});
