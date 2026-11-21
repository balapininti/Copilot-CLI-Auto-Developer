/**
 * A local stand-in for Agility, Bitbucket, Splunk and Dynatrace, used by the
 * tests and by `autodev demo e2e` so every workflow can be run end to end
 * without corporate access.
 *
 * It listens on 127.0.0.1 only, requires an Authorization header (so the
 * token path is really exercised), and speaks just enough of each API for the
 * adapters. It is a test double, not evidence that a live integration works.
 */

import http from 'node:http';

/**
 * @typedef {object} MockState
 * @property {Array<Record<string, any>>} stories rest-1.v1 assets
 * @property {Array<Record<string, any>>} defects
 * @property {Array<Record<string, any>>} comments
 * @property {Array<Record<string, any>>} attachments
 * @property {Array<Record<string, any>>} pullRequests
 * @property {Array<Record<string, any>>} splunkEvents
 * @property {Array<Record<string, any>>} problems
 * @property {Array<Record<string, any>>} metrics
 * @property {Array<{ method: string, path: string }>} requests
 * @property {{ failNext: Record<string, number> }} faults
 */

/**
 * @param {Partial<MockState>} [seed]
 * @returns {MockState}
 */
export function createMockState(seed = {}) {
  return {
    stories: [],
    defects: [],
    comments: [],
    attachments: [],
    pullRequests: [],
    splunkEvents: [],
    problems: [],
    metrics: [],
    requests: [],
    faults: { failNext: {} },
    ...seed,
  };
}

/**
 * @param {string} id e.g. "Story:1001"
 * @param {Record<string, unknown>} attributes
 */
export function asset(id, attributes) {
  return {
    _type: 'Asset',
    id,
    Attributes: Object.fromEntries(Object.entries(attributes).map(([name, value]) => [name, { _type: 'Attribute', name, value }])),
  };
}

/**
 * Evaluate the small subset of rest-1.v1 `where` used by the adapter:
 * Field='value' terms joined by ";".
 * @param {Record<string, any>} item
 * @param {string | null} where
 */
function matchesWhere(item, where) {
  if (!where) return true;
  return where.split(';').every((term) => {
    const match = /^([\w.]+)='((?:[^']|'')*)'$/.exec(term.trim());
    if (!match) return false;
    const wanted = match[2].replace(/''/g, "'");
    if (match[1] === 'IsSelf') return true;
    const value = item.Attributes?.[match[1]]?.value;
    return Array.isArray(value) ? value.includes(wanted) : String(value) === wanted;
  });
}

/**
 * @param {http.IncomingMessage} request
 * @returns {Promise<string>}
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) request.destroy();
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

/**
 * @param {MockState} state
 * @returns {(request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>}
 */
function handler(state) {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = request.method ?? 'GET';
    state.requests.push({ method, path: url.pathname });
    const send = (/** @type {number} */ status, /** @type {unknown} */ body, contentType = 'application/json') => {
      response.writeHead(status, { 'content-type': contentType });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (!request.headers.authorization) return send(401, { error: 'missing credentials' });

    const faultKey = `${method} ${url.pathname}`;
    if (state.faults.failNext[faultKey] > 0) {
      state.faults.failNext[faultKey] -= 1;
      return send(503, { error: 'injected fault' });
    }

    const raw = method === 'GET' ? '' : await readBody(request);
    const where = url.searchParams.get('where');

    // ---- Agility rest-1.v1 -------------------------------------------------
    const data = /^\/rest-1\.v1\/Data\/(\w+)(?:\/(\d+))?$/.exec(url.pathname);
    if (data) {
      const [, type, id] = data;
      if (method === 'GET') {
        /** @type {Array<Record<string, any>>} */
        let items;
        if (type === 'Member') items = [asset('Member:20', { Name: 'Mock User', Username: 'mock.user' })];
        else if (type === 'TeamRoom') items = [asset('TeamRoom:501', { Name: 'Orders Team Room', 'Team.Name': 'Orders' })];
        else if (type === 'Team') items = [asset('Team:77', { Name: 'Orders' })];
        else if (type === 'StoryStatus') items = [asset('StoryStatus:135', { Name: 'In Progress' }), asset('StoryStatus:137', { Name: 'Done' })];
        else if (type === 'Story') items = state.stories;
        else if (type === 'Defect') items = state.defects;
        else if (type === 'Expression') items = state.comments;
        else if (type === 'Attachment') items = state.attachments;
        else return send(404, { error: `unknown asset type ${type}` });
        items = items.filter((item) => matchesWhere(item, where));
        const find = url.searchParams.get('find');
        if (find) {
          const field = url.searchParams.get('findin') ?? 'Name';
          items = items.filter((item) => String(item.Attributes?.[field]?.value ?? '').includes(find));
        }
        return send(200, { _type: 'Assets', total: items.length, Assets: items });
      }
      if (method === 'POST') {
        const payload = JSON.parse(raw || '{}');
        const values = Object.fromEntries(Object.entries(payload.Attributes ?? {}).map(([name, attribute]) => [name, /** @type {any} */ (attribute).value]));
        if (type === 'Defect' && !id) {
          const number = `D-${String(state.defects.length + 1).padStart(5, '0')}`;
          const created = asset(`Defect:${9000 + state.defects.length}`, { ...values, Number: number, 'Status.Name': 'New' });
          state.defects.push(created);
          return send(200, created);
        }
        if (type === 'Expression' && !id) {
          const mention = values.Mentions?.[0]?.idref ?? null;
          const created = asset(`Expression:${7000 + state.comments.length}`, { Content: values.Content, Mentions: [mention], 'Author.Name': 'Mock User', AuthoredAt: new Date().toISOString() });
          state.comments.push(created);
          return send(200, created);
        }
        if ((type === 'Story' || type === 'Defect') && id) {
          const list = type === 'Story' ? state.stories : state.defects;
          const target = list.find((item) => item.id === `${type}:${id}`);
          if (!target) return send(404, { error: 'not found' });
          if (values.Status) {
            target.Attributes['Status.Name'] = { _type: 'Attribute', name: 'Status.Name', value: values.Status === 'StoryStatus:137' ? 'Done' : 'In Progress' };
          }
          return send(200, target);
        }
      }
      return send(405, { error: 'unsupported' });
    }

    // ---- Bitbucket Server REST 1.0 ----------------------------------------
    const prs = /^\/rest\/api\/1\.0\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests$/.exec(url.pathname);
    if (prs) {
      const [, key, slug] = prs;
      if (method === 'GET') {
        const at = url.searchParams.get('at');
        const values = state.pullRequests.filter((pr) => pr.key === key && pr.slug === slug && pr.state === 'OPEN' && (!at || pr.fromRef.id === at));
        return send(200, { size: values.length, values });
      }
      if (method === 'POST') {
        const payload = JSON.parse(raw || '{}');
        const id = state.pullRequests.length + 1;
        const created = {
          id,
          key,
          slug,
          title: payload.title,
          description: payload.description,
          state: 'OPEN',
          fromRef: { id: payload.fromRef?.id, displayId: String(payload.fromRef?.id ?? '').replace('refs/heads/', '') },
          toRef: { id: payload.toRef?.id },
          links: { self: [{ href: `http://127.0.0.1/projects/${key}/repos/${slug}/pull-requests/${id}` }] },
        };
        state.pullRequests.push(created);
        return send(201, created);
      }
    }
    if (url.pathname === '/rest/api/1.0/application-properties') return send(200, { version: 'mock' });

    // ---- Splunk -------------------------------------------------------------
    if (url.pathname === '/services/search/jobs/export' && method === 'POST') {
      const form = new URLSearchParams(raw);
      const from = Date.parse(form.get('earliest_time') ?? '');
      const to = Date.parse(form.get('latest_time') ?? '');
      const lines = state.splunkEvents
        .filter((event) => {
          const time = Date.parse(event._time);
          return (!Number.isFinite(from) || time >= from) && (!Number.isFinite(to) || time < to);
        })
        .map((event) => JSON.stringify({ preview: false, result: event }));
      return send(200, lines.join('\n'), 'application/json');
    }
    if (url.pathname === '/services/authentication/current-context') return send(200, { entry: [{ content: { username: 'mock' } }] });

    // ---- Dynatrace ----------------------------------------------------------
    if (url.pathname === '/api/v2/problems') {
      const from = Date.parse(url.searchParams.get('from') ?? '');
      const to = Date.parse(url.searchParams.get('to') ?? '');
      const problems = state.problems.filter(
        (problem) => (!Number.isFinite(to) || problem.startTime < to) && (!Number.isFinite(from) || problem.endTime <= 0 || problem.endTime >= from),
      );
      return send(200, { totalCount: problems.length, problems });
    }
    if (url.pathname === '/api/v2/metrics/query') {
      const selector = url.searchParams.get('metricSelector');
      return send(200, { result: state.metrics.filter((metric) => metric.metricId === selector) });
    }

    return send(404, { error: `no mock route for ${method} ${url.pathname}` });
  };
}

/**
 * @param {MockState} [state]
 * @param {{ port?: number }} [options]
 * @returns {Promise<{ baseUrl: string, port: number, state: MockState, close: () => Promise<void> }>}
 */
export async function startMockServer(state = createMockState(), options = {}) {
  const handle = handler(state);
  const server = http.createServer((request, response) => {
    handle(request, response).catch((/** @type {Error} */ error) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve(undefined));
  });
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * A realistic scenario, timed relative to `now`:
 *   - a story with a release branch, acceptance criteria, a comment and an attachment
 *   - a NullPointerException in orders-service, with a matching Dynatrace problem (shared trace id)
 *   - a latency regression in orders-service with no exception
 *   - an error from a service that is not mapped to any repository
 * @param {Date} [now]
 * @returns {MockState}
 */
export function demoScenario(now = new Date()) {
  const at = (/** @type {number} */ minutesAgo) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  const trace = '4bf92f3577b34da6a3ce929d0e0e4736';
  const npe = (/** @type {number} */ minutesAgo, /** @type {Record<string, unknown>} */ extra = {}) => ({
    _time: at(minutesAgo),
    service: 'orders-service',
    version: '2.14.0',
    _raw: `${at(minutesAgo)} ERROR [orders-service] OrderController - Failed to price order 88213 for customer jane.doe@example.com\njava.lang.NullPointerException: Cannot invoke "Discount.getRate()" because "discount" is null\n\tat com.example.orders.PricingService.applyDiscount(PricingService.java:87)\n\tat com.example.orders.OrderController.create(OrderController.java:42)`,
    ...extra,
  });
  return createMockState({
    stories: [
      asset('Story:1001', {
        Name: 'Apply loyalty discount when pricing an order',
        Number: 'S-01001',
        Description: '<p>Orders for loyalty members must apply the member discount.</p><p>Release branch: release/2.15</p>',
        'Status.Name': 'Ready',
        'Team.Name': 'Orders',
        'Scope.Name': 'Orders Platform',
        'Timebox.Name': 'Sprint 42',
        'Owners.Name': ['Mock User'],
        Estimate: 3,
        'Priority.Name': 'High',
        'Dependencies.Number': [],
        'Dependants.Number': ['S-01002'],
        Custom_AcceptanceCriteria: '<ul><li>Loyalty members get the configured discount rate.</li><li>Non-members are priced as before.</li></ul>',
      }),
    ],
    comments: [asset('Expression:7000', { Content: 'Discount rates live in APP.DISCOUNT.', Mentions: ['Story:1001'], 'Author.Name': 'Product Owner', AuthoredAt: at(600) })],
    attachments: [asset('Attachment:3001', { Name: 'Pricing rules', Filename: 'pricing-rules.pdf', ContentType: 'application/pdf', Asset: 'Story:1001' })],
    splunkEvents: [
      npe(9, { trace_id: trace, span_id: '00f067aa0ba902b7' }),
      npe(7, { trace_id: trace }),
      npe(4),
      {
        _time: at(6),
        service: 'ledger-batch',
        _raw: `${at(6)} ERROR [ledger-batch] BatchRunner - java.lang.IllegalStateException: ledger period is closed`,
      },
    ],
    problems: [
      {
        problemId: 'P-240117',
        displayId: 'P-240117',
        title: 'Failure rate increase',
        severityLevel: 'ERROR',
        impactLevel: 'SERVICES',
        status: 'OPEN',
        startTime: now.getTime() - 10 * 60_000,
        endTime: -1,
        affectedEntities: [{ entityId: { id: 'SERVICE-ORDERS0001' }, name: 'orders-service' }],
        rootCauseEntity: { entityId: { id: 'SERVICE-ORDERS0001' }, name: 'orders-service' },
        evidenceDetails: { details: [{ data: { traceId: trace } }] },
      },
    ],
    metrics: [
      {
        metricId: 'builtin:service.response.time:percentile(95)',
        unit: 'MicroSecond',
        data: [{ dimensionMap: { 'dt.entity.service': 'SERVICE-PAYMENTS0002' }, values: [410_000, 455_000, 2_350_000, 2_410_000] }],
      },
    ],
  });
}
