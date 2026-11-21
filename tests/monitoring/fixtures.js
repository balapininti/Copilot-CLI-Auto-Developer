/**
 * Fixtures for the monitoring tests: fake telemetry sources (no HTTP) and
 * builders for events, problems and metric series in the adapters' shapes.
 */

import { decideApproval } from '../../src/core/approvals.js';
import { applyDefaults } from '../../src/core/manifest.js';
import { fullManifest, tempWorkspace, writeProject } from '../helpers.js';

export const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
export const SPAN = '00f067aa0ba902b7';
export const SPLUNK_LINK = 'https://splunk.example.internal/app/search?sid=1';
export const PROBLEM_LINK = 'https://dynatrace.example.internal/#problems/problemdetails;pid=P-1';

/** Manifest with defaults applied, as loadManifest would return it. */
export function manifestWithDefaults(overrides = {}) {
  return applyDefaults(fullManifest(overrides));
}

/**
 * @param {Date} at
 * @param {Record<string, unknown>} [extra]
 */
export function npeEvent(at, extra = {}) {
  const iso = at.toISOString();
  return {
    _time: iso,
    service: 'orders-service',
    version: '2.14.0',
    _raw: `${iso} ERROR [orders-service] OrderController - Failed to price order ${Math.floor(Math.random() * 1e5)} for customer jane.doe@example.com\njava.lang.NullPointerException: Cannot invoke "Discount.getRate()" because "discount" is null\n\tat com.example.orders.PricingService.applyDiscount(PricingService.java:87)\n\tat com.example.orders.OrderController.create(OrderController.java:42)`,
    ...extra,
  };
}

/**
 * A Dynatrace problem in the adapter's normalised shape.
 * @param {Date} start
 * @param {Record<string, unknown>} [extra]
 */
export function problem(start, extra = {}) {
  return {
    problemId: 'P-1',
    displayId: 'P-1',
    title: 'Failure rate increase',
    severityLevel: 'ERROR',
    impactLevel: 'SERVICES',
    status: 'OPEN',
    startTime: start.toISOString(),
    endTime: null,
    affectedEntities: [{ id: 'SERVICE-ORDERS0001', name: 'orders-service' }],
    rootCauseEntity: { id: 'SERVICE-ORDERS0001', name: 'orders-service' },
    traceIds: [TRACE],
    url: PROBLEM_LINK,
    ...extra,
  };
}

/** A latency series (microseconds) for payments-service, breaching 1500 ms. */
export function latencySeries(extra = {}) {
  return {
    metricId: 'builtin:service.response.time:percentile(95)',
    dimensions: { 'dt.entity.service': 'SERVICE-PAYMENTS0002' },
    entity: 'SERVICE-PAYMENTS0002',
    points: 4,
    max: 2_410_000,
    avg: 1_406_250,
    last: 2_410_000,
    unit: 'MicroSecond',
    ...extra,
  };
}

/**
 * Fake sources. Events are filtered to the queried window like a real search;
 * problems are returned while they overlap it; series are returned as given.
 * @param {{ events?: any[], problems?: any[], series?: any[] }} [seed]
 */
export function fakeSources(seed = {}) {
  const state = {
    events: seed.events ?? [],
    problems: seed.problems ?? [],
    series: seed.series ?? [],
    /** @type {Array<{ id: string, url: string, draft: any }>} */
    defects: [],
    /** @type {Record<string, any>} */
    fail: {},
    calls: { searchErrors: 0, listProblems: 0, queryMetrics: 0, findDefectsByMarker: 0, createDefect: 0 },
    /** @type {Array<{ from: string, to: string }>} */
    windows: [],
  };
  const maybeFail = (/** @type {string} */ name) => {
    if (state.fail[name]) throw state.fail[name];
  };
  const sources = {
    splunk: {
      searchErrors: async (/** @type {{ from: string, to: string }} */ window) => {
        state.calls.searchErrors += 1;
        state.windows.push({ from: window.from, to: window.to });
        maybeFail('searchErrors');
        const from = Date.parse(window.from);
        const to = Date.parse(window.to);
        const events = state.events.filter((event) => {
          const time = Date.parse(event._time);
          return Number.isNaN(time) || (time >= from && time < to);
        });
        return { events, link: SPLUNK_LINK };
      },
    },
    dynatrace: {
      listProblems: async (/** @type {{ from: string, to: string }} */ window) => {
        state.calls.listProblems += 1;
        maybeFail('listProblems');
        const from = Date.parse(window.from);
        const to = Date.parse(window.to);
        return {
          problems: state.problems.filter(
            (item) => Date.parse(item.startTime) < to && (item.endTime === null || Date.parse(item.endTime) >= from),
          ),
        };
      },
      queryMetrics: async () => {
        state.calls.queryMetrics += 1;
        maybeFail('queryMetrics');
        return { series: state.series };
      },
    },
    agility: {
      findDefectsByMarker: async (/** @type {string} */ marker) => {
        state.calls.findDefectsByMarker += 1;
        maybeFail('findDefectsByMarker');
        return state.defects.filter((defect) => String(defect.draft.descriptionHtml).includes(marker));
      },
      createDefect: async (/** @type {any} */ draft) => {
        state.calls.createDefect += 1;
        maybeFail('createDefect');
        const number = `D-${String(state.defects.length + 1).padStart(5, '0')}`;
        const defect = { id: number, url: `https://agility.example.internal/defect/${number}`, draft };
        state.defects.push(defect);
        return { id: defect.id, url: defect.url };
      },
    },
  };
  return { sources: /** @type {any} */ (sources), state };
}

/**
 * A workspace holding one monitored project.
 * @param {Record<string, any>} [overrides] top-level manifest overrides
 */
export function monitoredProject(overrides = {}) {
  const ws = tempWorkspace();
  const manifest = fullManifest(overrides);
  writeProject(ws.workspace, manifest, { 'guidelines/architecture.md': '# Architecture\n' });
  return { ...ws, projectId: manifest.id, rawManifest: manifest };
}

/**
 * @param {import('../../src/core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {string} id
 * @param {'approved' | 'denied'} [decision]
 */
export function decide(workspace, projectId, id, decision = 'approved') {
  return decideApproval(workspace, { projectId, id, decision, decidedBy: 'test-approver', reason: decision === 'denied' ? 'not a defect' : undefined });
}

/** @param {Date} base @param {number} minutes */
export function minutes(base, minutes) {
  return new Date(base.getTime() + minutes * 60_000);
}
