import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { decideApproval, listApprovals } from '../../src/core/approvals.js';
import { readAudit } from '../../src/core/audit.js';
import { protectedPathReason, shellDenyReason } from '../../src/core/hook-policy.js';
import {
  affectedScenarios, applyScenario, assertAppHost, describeChange, evaluateExpectations, importHar, listScenarios, loadApprovedScenario,
  materializeSteps, outlineFromHar, pathMatches, proposeScenario, scenarioIntegrityFile, shapeOf, templatePath, validateScenario,
} from '../../src/workflow/scenarios.js';
import { expectCode, fullManifest, tempWorkspace, writeProject } from '../helpers.js';

const P = 'orders';
const APP = 'orders-dev.example.internal';
const APP_HOSTS = [APP];
const SECRET_COOKIE = 'JSESSIONID=9F8E7D6C5B4A39281706F5E4D3C2B1A0';
const BEARER = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJlLXZhbHVlLWhlcmU';

/**
 * @param {string} method
 * @param {string} url
 * @param {number} status
 * @param {Record<string, any>} [extra]
 */
function entry(method, url, status, extra = {}) {
  return {
    _resourceType: extra.type ?? 'xhr',
    request: {
      method,
      url,
      headers: [{ name: 'Cookie', value: SECRET_COOKIE }, { name: 'Authorization', value: `Bearer ${BEARER}` }],
      cookies: [{ name: 'JSESSIONID', value: '9F8E7D6C5B4A39281706F5E4D3C2B1A0' }],
      ...(extra.postData ? { postData: extra.postData } : {}),
    },
    response: {
      status,
      headers: [{ name: 'Set-Cookie', value: SECRET_COOKIE }],
      content: { mimeType: extra.mime ?? 'application/json', text: extra.body ?? '' },
    },
  };
}

function sampleHar() {
  return {
    log: {
      version: '1.2',
      entries: [
        entry('GET', `https://${APP}/orders`, 200, { type: 'document', mime: 'text/html', body: '<html>Jane Doe</html>' }),
        entry('GET', `https://${APP}/static/app.9f3c.js`, 200, { type: 'script', mime: 'application/javascript' }),
        entry('GET', `https://${APP}/assets/logo.png`, 200, { type: 'image', mime: 'image/png' }),
        entry('GET', 'https://telemetry.vendor.example/collect?id=1', 204, {}),
        entry('GET', `https://${APP}/api/customers/88213?include=discounts&apiKey=sk_live_abcdefghijklmnop`, 200, {
          body: JSON.stringify({ id: 88213, name: 'Jane Doe', email: 'jane.doe@example.com', discounts: [{ code: 'LOYAL', rate: 0.1 }] }),
        }),
        entry('GET', `https://${APP}/api/orders/status/3f2b8c1e-7a4d-4e9b-9c1a-2d3e4f5a6b7c`, 202, {}),
        entry('GET', `https://${APP}/api/orders/status/3f2b8c1e-7a4d-4e9b-9c1a-2d3e4f5a6b7c`, 202, {}),
        entry('GET', `https://${APP}/api/orders/status/3f2b8c1e-7a4d-4e9b-9c1a-2d3e4f5a6b7c`, 202, {}),
        entry('POST', `https://${APP}/api/orders`, 201, {
          postData: { mimeType: 'application/json', text: JSON.stringify({ customerId: 88213, password: 'hunter2hunter2', contact: 'jane.doe@example.com', lines: [{ sku: 'A-1', qty: 2 }] }) },
          body: JSON.stringify({ orderId: 5512, total: 18.0, customerEmail: 'jane.doe@example.com' }),
        }),
        entry('OPTIONS', `https://${APP}/api/orders`, 204, { type: 'preflight' }),
        { request: { url: 'data:text/plain,hello', method: 'GET' }, response: { status: 200 } },
      ],
    },
  };
}

const scenarioDoc = () => ({
  name: 'place-order',
  title: 'A customer with a loyalty discount places an order',
  baseUrl: `https://${APP}`,
  steps: [
    { action: 'goto', url: '/orders' },
    { action: 'fill', selector: '#customer', value: '88213' },
    { action: 'fill', selector: '#reference', value: 'ref-{{unique}}' },
    { action: 'click', selector: 'button[data-testid=submit]' },
    { action: 'assertText', selector: '#result', contains: 'Order placed' },
    { action: 'screenshot', name: 'order-placed' },
  ],
  expect: [
    { method: 'GET', path: '/api/customers/{id}', status: 200 },
    { method: 'post', path: '/api/orders', status: [200, 201] },
  ],
  code: [{ repo: 'service-api', path: 'src/main/java/orders/OrderController.java' }, { repo: 'service-api', path: 'web/src/orders' }],
});

describe('scenario paths', () => {
  test('numbers, UUIDs and opaque tokens become {id}; words stay', () => {
    assert.equal(templatePath('/api/customers/88213'), '/api/customers/{id}');
    assert.equal(templatePath('/api/orders/status/3f2b8c1e-7a4d-4e9b-9c1a-2d3e4f5a6b7c'), '/api/orders/status/{id}');
    assert.equal(templatePath('/files/9f8e7d6c5b4a39281706f5e4d3c2b1a0/meta'), '/files/{id}/meta');
    assert.equal(templatePath('/t/AbC123xyz_456-defGHI789'), '/t/{id}');
    assert.equal(templatePath('/api/v2/orders/search'), '/api/v2/orders/search');
    assert.equal(templatePath('/'), '/');
  });

  test('a template matches one segment per placeholder and nothing looser', () => {
    assert.equal(pathMatches('/api/customers/{id}', '/api/customers/42'), true);
    assert.equal(pathMatches('/api/customers/{id}', '/api/customers/42/'), true);
    assert.equal(pathMatches('/api/customers/{id}', '/api/customers'), false);
    assert.equal(pathMatches('/api/customers/{id}', '/api/customers/42/orders'), false);
    assert.equal(pathMatches('/api/customers/{id}', '/api/accounts/42'), false);
    assert.equal(pathMatches('/api/orders', '/api/orders'), true);
    assert.equal(pathMatches('/api/orders', '/api/orders2'), false);
  });

  test('shapeOf keeps field names and types and no values', () => {
    const shape = shapeOf({ id: 7, name: 'Jane Doe', tags: ['a'], nested: { ok: true, none: null }, empty: [] });
    assert.deepEqual(shape, { id: 'number', name: 'string', tags: ['string'], nested: { ok: 'boolean', none: 'null' }, empty: ['…'] });
    assert.equal(JSON.stringify(shape).includes('Jane'), false);
  });
});

describe('scenario HAR outline', () => {
  test('keeps the journey and drops static assets, other hosts and preflights', () => {
    const outline = outlineFromHar(sampleHar(), { appHosts: APP_HOSTS });
    assert.equal(outline.baseUrl, `https://${APP}`);
    assert.deepEqual(outline.pages, ['/orders']);
    assert.deepEqual(outline.calls.map((call) => `${call.kind} ${call.method} ${call.path} ${call.status} x${call.count}`), [
      'page GET /orders 200 x1',
      'api GET /api/customers/{id} 200 x1',
      'api GET /api/orders/status/{id} 202 x3',
      'api POST /api/orders 201 x1',
    ]);
    assert.equal(outline.summary.entriesInHar, 11);
    assert.equal(outline.summary.staticAssetsDropped, 3);
    assert.equal(outline.summary.unreadableDropped, 1);
    assert.deepEqual(outline.summary.otherHostsDropped, { 'telemetry.vendor.example': 1 });
  });

  test('no cookie, token, header, query value, response value or personal data survives', () => {
    const text = JSON.stringify(outlineFromHar(sampleHar(), { appHosts: APP_HOSTS, keepRequestValues: true }));
    for (const leak of ['JSESSIONID', '9F8E7D6C', BEARER, 'Bearer', 'Cookie', 'sk_live', 'Jane', 'jane.doe', 'LOYAL', '5512', 'hunter2', 'Authorization']) {
      assert.equal(text.includes(leak), false, `outline leaked "${leak}"`);
    }
  });

  test('records query parameter names, body shapes, and request values only on request', () => {
    const plain = outlineFromHar(sampleHar(), { appHosts: APP_HOSTS });
    const customer = plain.calls[1];
    assert.deepEqual(customer.query, ['apiKey', 'include']);
    assert.deepEqual(customer.responseShape, { id: 'number', name: 'string', email: 'string', discounts: [{ code: 'string', rate: 'number' }] });
    const order = plain.calls[3];
    assert.deepEqual(order.requestShape, { customerId: 'number', password: 'string', contact: 'string', lines: [{ sku: 'string', qty: 'number' }] });
    assert.equal('requestValues' in order, false);
    assert.equal(plain.summary.requestValuesKept, false);

    const kept = outlineFromHar(sampleHar(), { appHosts: APP_HOSTS, keepRequestValues: true });
    assert.deepEqual(kept.calls[3].requestValues, { customerId: 88213, password: '[REDACTED]', contact: '[REDACTED:email]', lines: [{ sku: 'A-1', qty: 2 }] });
    assert.equal(kept.summary.requestValuesKept, true);
  });

  test('reads form posts and base64 bodies', () => {
    const har = { log: { entries: [
      entry('POST', `https://${APP}/login/search`, 200, { postData: { mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'q', value: 'smith' }] }, body: Buffer.from('{"hits":3}').toString('base64') }),
    ] } };
    har.log.entries[0].response.content.encoding = 'base64';
    const [call] = outlineFromHar(har, { appHosts: APP_HOSTS }).calls;
    assert.deepEqual(call.requestShape, { q: 'string' });
    assert.deepEqual(call.responseShape, { hits: 'number' });
  });

  test('one origin per scenario: the one the journey mostly used', () => {
    const har = { log: { entries: [
      entry('GET', `https://${APP}/api/a`, 200),
      entry('GET', `https://${APP}/api/b`, 200),
      entry('GET', 'https://other-app.example.internal/api/c', 200),
    ] } };
    const outline = outlineFromHar(har, { appHosts: [APP, 'other-app.example.internal'] });
    assert.equal(outline.baseUrl, `https://${APP}`);
    assert.equal(outline.calls.length, 2);
    assert.deepEqual(outline.summary.otherHostsDropped, { 'other-app.example.internal': 1 });
    assert.equal(outlineFromHar(har, { appHosts: [APP, 'other-app.example.internal'], host: 'other-app.example.internal' }).baseUrl, 'https://other-app.example.internal');
  });

  test('wildcard application hosts match subdomains only', () => {
    const har = { log: { entries: [entry('GET', 'https://a.apps.example.internal/api/x', 200), entry('GET', 'https://apps.example.internal.evil.example/api/x', 200)] } };
    const outline = outlineFromHar(har, { appHosts: ['*.apps.example.internal'] });
    assert.equal(outline.calls.length, 1);
    assert.equal(outline.baseUrl, 'https://a.apps.example.internal');
  });

  test('something that is not a HAR is refused', async () => {
    await expectCode(() => outlineFromHar({ entries: [] }, { appHosts: APP_HOSTS }), 'INVALID_ARGUMENT', /not a HAR/);
    await expectCode(() => outlineFromHar(null, { appHosts: APP_HOSTS }), 'INVALID_ARGUMENT');
  });
});

describe('scenario validation', () => {
  test('accepts a complete scenario and returns it in canonical form', () => {
    const scenario = validateScenario({ ...scenarioDoc(), surprise: 'dropped', steps: [{ action: 'goto', url: '/orders', extra: 1 }] });
    assert.deepEqual(Object.keys(scenario), ['schema', 'name', 'title', 'baseUrl', 'steps', 'expect', 'code']);
    assert.deepEqual(scenario.steps, [{ action: 'goto', url: '/orders' }]);
    assert.deepEqual(scenario.expect[1], { method: 'POST', path: '/api/orders', status: [200, 201] });
  });

  test('a scenario stays inside one application', async () => {
    const withStep = (/** @type {any} */ step) => ({ ...scenarioDoc(), steps: [step] });
    await expectCode(() => validateScenario(withStep({ action: 'goto', url: 'https://elsewhere.example/orders' })), 'INVALID_ARGUMENT', /path that starts with/);
    await expectCode(() => validateScenario(withStep({ action: 'goto', url: '//elsewhere.example/orders' })), 'INVALID_ARGUMENT');
    await expectCode(() => validateScenario(withStep({ action: 'click', selector: '#go' })), 'INVALID_ARGUMENT', /first step must be a goto/);
    await expectCode(() => validateScenario({ ...scenarioDoc(), baseUrl: `http://${APP}` }), 'TLS_POLICY_VIOLATION');
    await expectCode(() => validateScenario({ ...scenarioDoc(), baseUrl: `https://${APP}/app` }), 'INVALID_ARGUMENT', /origin only/);
    await expectCode(() => validateScenario({ ...scenarioDoc(), baseUrl: `https://user:pw@${APP}` }), 'INVALID_ARGUMENT');
    assert.equal(validateScenario({ ...scenarioDoc(), baseUrl: 'http://127.0.0.1:8080' }).baseUrl, 'http://127.0.0.1:8080');
  });

  test('refuses malformed steps, expectations and code references', async () => {
    const doc = scenarioDoc();
    await expectCode(() => validateScenario({ ...doc, steps: [] }), 'INVALID_ARGUMENT');
    await expectCode(() => validateScenario({ ...doc, steps: [{ action: 'goto', url: '/' }, { action: 'evaluate', script: 'x' }] }), 'INVALID_ARGUMENT', /no known action/);
    await expectCode(() => validateScenario({ ...doc, steps: [{ action: 'goto', url: '/', timeoutMs: 999_999 }] }), 'INVALID_ARGUMENT');
    await expectCode(() => validateScenario({ ...doc, expect: [{ method: 'TRACE', path: '/x', status: 200 }] }), 'INVALID_ARGUMENT');
    await expectCode(() => validateScenario({ ...doc, expect: [{ method: 'GET', path: 'https://x/y', status: 200 }] }), 'INVALID_ARGUMENT');
    await expectCode(() => validateScenario({ ...doc, expect: [{ method: 'GET', path: '/x?y=1', status: 200 }] }), 'INVALID_ARGUMENT');
    await expectCode(() => validateScenario({ ...doc, expect: [{ method: 'GET', path: '/x', status: 99 }] }), 'INVALID_ARGUMENT');
    await expectCode(() => validateScenario({ ...doc, code: [{ repo: 'service-api', path: '../../etc/passwd' }] }), 'INVALID_ARGUMENT');
    await expectCode(() => validateScenario({ ...doc, code: [{ repo: 'service-api', path: 'C:\\Windows\\x' }] }), 'INVALID_ARGUMENT');
    await expectCode(() => validateScenario({ ...doc, name: '../escape' }), 'INVALID_ARGUMENT');
    await expectCode(() => validateScenario([]), 'INVALID_ARGUMENT');
  });

  test('refuses secrets, personal data and password fields', async () => {
    const doc = scenarioDoc();
    const fill = (/** @type {string} */ selector, /** @type {string} */ value) => ({ ...doc, steps: [doc.steps[0], { action: 'fill', selector, value }] });
    await expectCode(() => validateScenario(fill('#api', `Bearer ${BEARER}`)), 'INVALID_ARGUMENT', /secret or personal data/);
    await expectCode(() => validateScenario(fill('#contact', 'jane.doe@example.com')), 'INVALID_ARGUMENT', /secret or personal data/);
    await expectCode(() => validateScenario(fill('input[name=password]', 'x')), 'POLICY_PROHIBITED', /never fills a password/);
    await expectCode(() => validateScenario(fill('#otp-code', '123456')), 'POLICY_PROHIBITED');
  });

  test('materializeSteps resolves paths against the base URL and fills {{unique}}', () => {
    const scenario = validateScenario(scenarioDoc());
    const plan = materializeSteps(scenario, { unique: 'u1' });
    assert.equal(plan.steps[0].url, `https://${APP}/orders`);
    assert.equal(plan.steps[2].value, 'ref-u1');
    assert.equal(scenario.steps[2].value, 'ref-{{unique}}', 'the scenario itself is not changed');
    assert.equal(materializeSteps(scenario, { baseUrl: 'https://orders-test.example.internal/' }).steps[0].url, 'https://orders-test.example.internal/orders');
    assert.notEqual(materializeSteps(scenario).unique, '');
  });

  test('scenarios run only against application hosts', async () => {
    assertAppHost(`https://${APP}`, APP_HOSTS);
    assertAppHost('https://a.apps.example.internal', ['*.apps.example.internal']);
    const error = await expectCode(() => assertAppHost('https://agility.example.internal', APP_HOSTS), 'HOST_NOT_ALLOWED');
    assert.equal(error.details.host, 'agility.example.internal');
  });
});

describe('scenario expectations', () => {
  const expect = /** @type {any} */ (validateScenario(scenarioDoc()).expect);

  test('met when every expected call was seen with an accepted status', () => {
    const result = evaluateExpectations(expect, [
      { method: 'GET', path: '/orders', status: 200 },
      { method: 'GET', path: '/api/customers/88213', status: 200 },
      { method: 'POST', path: '/api/orders', status: 201 },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.met, 2);
    assert.deepEqual(result.serverErrors, []);
  });

  test('a call that answered differently is reported with what it answered', () => {
    const result = evaluateExpectations(expect, [
      { method: 'GET', path: '/api/customers/88213', status: 200 },
      { method: 'POST', path: '/api/orders', status: 400 },
    ]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.results[1], { method: 'POST', path: '/api/orders', status: [200, 201], met: false, seen: 1, otherStatuses: [400] });
  });

  test('a call that never happened is not met', () => {
    const result = evaluateExpectations(expect, [{ method: 'GET', path: '/api/customers/88213', status: 200 }]);
    assert.equal(result.ok, false);
    assert.equal(result.results[1].seen, 0);
  });

  test('any server error fails the run even when expectations are met', () => {
    const result = evaluateExpectations(expect, [
      { method: 'GET', path: '/api/customers/88213', status: 200 },
      { method: 'POST', path: '/api/orders', status: 201 },
      { method: 'GET', path: '/api/recommendations/88213', status: 503 },
    ]);
    assert.equal(result.met, 2);
    assert.equal(result.ok, false);
    assert.deepEqual(result.serverErrors, [{ method: 'GET', path: '/api/recommendations/{id}', status: 503 }]);
  });

  test('a scenario with no expectations passes on steps alone', () => {
    assert.equal(evaluateExpectations([], [{ method: 'GET', path: '/', status: 200 }]).ok, true);
  });
});

describe('scenario store', () => {
  /** @type {ReturnType<typeof tempWorkspace>} */
  let ws;
  /** @type {string} */
  let dir;
  /** @type {string} */
  let scenarioFile;
  beforeEach(() => {
    ws = tempWorkspace();
    dir = writeProject(ws.workspace, fullManifest({ browser: { allowedHosts: [APP] } }));
    scenarioFile = path.join(dir, 'scenarios', 'place-order.json');
  });
  afterEach(() => ws.cleanup());

  const approve = (/** @type {string} */ id) => decideApproval(ws.workspace, { projectId: P, id, decision: 'approved', decidedBy: 'tester' });
  const propose = (/** @type {any} */ scenario = scenarioDoc(), reason = 'Baseline for the order journey recorded by the team.') =>
    proposeScenario(ws.workspace, { projectId: P, scenario, reason, appHosts: APP_HOSTS });
  const approveAndApply = async (/** @type {any} */ scenario) => {
    const proposal = await propose(scenario);
    await approve(proposal.approvalId);
    return applyScenario(ws.workspace, { projectId: P, approvalId: proposal.approvalId });
  };

  test('import writes a sanitized draft to framework state only, and never copies the HAR', async () => {
    const harFile = path.join(ws.root, 'recording.har');
    fs.writeFileSync(harFile, JSON.stringify(sampleHar()));
    const result = /** @type {any} */ (await importHar(ws.workspace, { projectId: P, name: 'place-order', harFile, appHosts: APP_HOSTS }));
    assert.equal(result.draftFile, path.join(ws.workspace.stateDir, 'scenarios', P, 'drafts', 'place-order.json'));
    assert.equal(result.draft.status, 'draft');
    assert.equal(result.draft.calls.length, 4);
    assert.match(result.draft.source.sha256, /^[0-9a-f]{64}$/);
    assert.equal(fs.existsSync(path.join(dir, 'scenarios')), false);
    const stored = fs.readFileSync(result.draftFile, 'utf8');
    for (const leak of ['JSESSIONID', BEARER, 'jane.doe', 'hunter2']) assert.equal(stored.includes(leak), false);
    const everything = fs.readdirSync(ws.workspace.stateDir, { recursive: true }).map(String);
    assert.equal(everything.some((name) => name.endsWith('.har')), false);
    assert.equal(readAudit(ws.workspace, P).some((item) => item.action === 'scenario.imported'), true);
    assert.deepEqual(listScenarios(ws.workspace, P).drafts.map((draft) => draft.name), ['place-order']);
  });

  test('import refuses when no application host is configured or nothing matches', async () => {
    const harFile = path.join(ws.root, 'recording.har');
    fs.writeFileSync(harFile, JSON.stringify(sampleHar()));
    await expectCode(() => importHar(ws.workspace, { projectId: P, name: 'x', harFile, appHosts: [] }), 'NOT_CONFIGURED', /browser\.allowedHosts/);
    const error = await expectCode(() => importHar(ws.workspace, { projectId: P, name: 'x', harFile, appHosts: ['unrelated.example.internal'] }), 'INVALID_ARGUMENT', /Nothing in the HAR/);
    assert.ok(error.details.hostsInHar[APP] > 0);
    await expectCode(() => importHar(ws.workspace, { projectId: P, name: 'x', harFile: path.join(ws.root, 'missing.har'), appHosts: APP_HOSTS }), 'NOT_FOUND');
    fs.writeFileSync(harFile, 'not json');
    await expectCode(() => importHar(ws.workspace, { projectId: P, name: 'x', harFile, appHosts: APP_HOSTS }), 'INVALID_ARGUMENT', /not valid JSON/);
  });

  test('a dry-run import writes nothing', async () => {
    const harFile = path.join(ws.root, 'recording.har');
    fs.writeFileSync(harFile, JSON.stringify(sampleHar()));
    const result = /** @type {any} */ (await importHar(ws.workspace, { projectId: P, name: 'place-order', harFile, appHosts: APP_HOSTS, dryRun: true }));
    assert.equal(result.dryRun, true);
    assert.equal(fs.existsSync(path.join(ws.workspace.stateDir, 'scenarios')), false);
  });

  test('propose stages an approval and writes nothing to the project', async () => {
    const proposal = await propose();
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.targetPath, 'projects/orders/scenarios/place-order.json');
    assert.equal(proposal.change.kind, 'new');
    assert.equal(fs.existsSync(scenarioFile), false);
    assert.equal(fs.existsSync(scenarioIntegrityFile(ws.workspace, P)), false);
    const [approval] = listApprovals(ws.workspace, P);
    assert.equal(approval.action, 'scenario.write');
    assert.match(approval.summary, /Add end-to-end scenario "place-order" \(6 steps, 2 expected calls\)/);
    await expectCode(() => loadApprovedScenario(ws.workspace, P, 'place-order'), 'NOT_FOUND');
  });

  test('apply needs the approval, then writes exactly the approved document once', async () => {
    const proposal = await propose();
    await expectCode(() => applyScenario(ws.workspace, { projectId: P, approvalId: proposal.approvalId }), 'APPROVAL_REQUIRED');
    assert.equal(fs.existsSync(scenarioFile), false);
    await approve(proposal.approvalId);
    const dry = /** @type {any} */ (await applyScenario(ws.workspace, { projectId: P, approvalId: proposal.approvalId, dryRun: true }));
    assert.equal(dry.dryRun, true);
    assert.equal(fs.existsSync(scenarioFile), false);

    const applied = /** @type {any} */ (await applyScenario(ws.workspace, { projectId: P, approvalId: proposal.approvalId }));
    assert.equal(applied.written, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(scenarioFile, 'utf8')), validateScenario(scenarioDoc()));
    assert.deepEqual(loadApprovedScenario(ws.workspace, P, 'place-order'), validateScenario(scenarioDoc()));
    await expectCode(() => applyScenario(ws.workspace, { projectId: P, approvalId: proposal.approvalId }), 'NOT_FOUND');
    assert.equal(readAudit(ws.workspace, P).some((item) => item.action === 'scenario.written'), true);
    const listed = listScenarios(ws.workspace, P);
    assert.equal(listed.valid, true);
    assert.equal(listed.scenarios[0].state, 'approved');
    assert.equal(listed.scenarios[0].steps, 6);
    assert.deepEqual(listed.proposals, []);
  });

  test('a denied proposal cannot be applied', async () => {
    const proposal = await propose();
    await decideApproval(ws.workspace, { projectId: P, id: proposal.approvalId, decision: 'denied', decidedBy: 'tester' });
    await expectCode(() => applyScenario(ws.workspace, { projectId: P, approvalId: proposal.approvalId }), 'APPROVAL_DENIED');
    assert.equal(fs.existsSync(scenarioFile), false);
  });

  test('a staged proposal altered after approval is refused', async () => {
    const proposal = await propose();
    await approve(proposal.approvalId);
    const staged = path.join(ws.workspace.stateDir, 'scenarios', P, 'proposals', `${proposal.approvalId}.json`);
    const doc = JSON.parse(fs.readFileSync(staged, 'utf8'));
    doc.payload.content = doc.payload.content.replace('"/api/orders"', '"/api/anything"');
    fs.writeFileSync(staged, JSON.stringify(doc));
    await expectCode(() => applyScenario(ws.workspace, { projectId: P, approvalId: proposal.approvalId }), 'APPROVAL_MISMATCH');
    assert.equal(fs.existsSync(scenarioFile), false);
  });

  test('a scenario written or edited around the gate is never run as approved', async () => {
    fs.mkdirSync(path.dirname(scenarioFile), { recursive: true });
    fs.writeFileSync(scenarioFile, `${JSON.stringify(validateScenario(scenarioDoc()), null, 2)}\n`);
    await expectCode(() => loadApprovedScenario(ws.workspace, P, 'place-order'), 'INTEGRITY_VIOLATION', /outside the approval process/);
    assert.equal(listScenarios(ws.workspace, P).scenarios[0].state, 'never-approved');
    await expectCode(() => propose({ ...scenarioDoc(), title: 'Take over the unapproved file' }), 'INTEGRITY_VIOLATION');
    fs.rmSync(scenarioFile);

    await approveAndApply(scenarioDoc());
    const weakened = fs.readFileSync(scenarioFile, 'utf8').replace('"Order placed"', '"Order"');
    fs.writeFileSync(scenarioFile, weakened);
    await expectCode(() => loadApprovedScenario(ws.workspace, P, 'place-order'), 'INTEGRITY_VIOLATION');
    const listed = listScenarios(ws.workspace, P);
    assert.equal(listed.valid, false);
    assert.equal(listed.scenarios[0].state, 'modified-outside-approval');
    fs.rmSync(scenarioFile);
    assert.equal(listScenarios(ws.workspace, P).scenarios[0].state, 'missing');
  });

  test('an update names every expectation it removes, in the approval itself', async () => {
    await approveAndApply(scenarioDoc());
    const next = scenarioDoc();
    next.expect = [{ method: 'GET', path: '/api/customers/{id}', status: 200 }, { method: 'POST', path: '/api/v2/orders', status: 201 }];
    next.steps.splice(4, 1);
    const proposal = await propose(next, 'Story S-01234 moves order creation to the v2 endpoint.');
    assert.equal(proposal.change.kind, 'update');
    assert.deepEqual(proposal.change.expectRemoved, ['POST /api/orders -> 200|201']);
    assert.deepEqual(proposal.change.expectAdded, ['POST /api/v2/orders -> 201']);
    assert.deepEqual(proposal.change.steps, { before: 6, after: 5, added: 0, removed: 1 });
    const approval = listApprovals(ws.workspace, P).find((item) => item.id === proposal.approvalId);
    assert.match(String(approval?.summary), /REMOVES 1 expectation/);
    assert.deepEqual(loadApprovedScenario(ws.workspace, P, 'place-order').expect[1].path, '/api/orders', 'the approved scenario is unchanged until a person approves');

    await approve(proposal.approvalId);
    await applyScenario(ws.workspace, { projectId: P, approvalId: proposal.approvalId });
    assert.equal(loadApprovedScenario(ws.workspace, P, 'place-order').expect[1].path, '/api/v2/orders');
  });

  test('an approval for an older version of the file cannot be applied over a newer one', async () => {
    await approveAndApply(scenarioDoc());
    const first = await propose({ ...scenarioDoc(), title: 'First competing change to the order journey' });
    const second = await propose({ ...scenarioDoc(), title: 'Second competing change to the order journey' });
    await approve(first.approvalId);
    await approve(second.approvalId);
    await applyScenario(ws.workspace, { projectId: P, approvalId: first.approvalId });
    await expectCode(() => applyScenario(ws.workspace, { projectId: P, approvalId: second.approvalId }), 'CONFLICT', /Propose it again/);
    assert.equal(loadApprovedScenario(ws.workspace, P, 'place-order').title, 'First competing change to the order journey');
  });

  test('propose refuses an identical scenario, a weak reason, and a host that is not the application', async () => {
    await approveAndApply(scenarioDoc());
    await expectCode(() => propose(scenarioDoc()), 'CONFLICT', /identical/);
    await expectCode(() => propose({ ...scenarioDoc(), title: 'Changed' }, 'short'), 'INVALID_ARGUMENT', /--reason/);
    await expectCode(() => propose({ ...scenarioDoc(), baseUrl: 'https://agility.example.internal' }), 'HOST_NOT_ALLOWED');
    await expectCode(() => propose({ ...scenarioDoc(), title: 'Changed' }, `Because the token is Bearer ${BEARER}`), 'INVALID_ARGUMENT');
  });

  test('describeChange reports a moved base URL', () => {
    const before = validateScenario(scenarioDoc());
    const after = validateScenario({ ...scenarioDoc(), baseUrl: 'https://orders-test.example.internal' });
    assert.equal(describeChange(before, after).baseUrlChanged, true);
    assert.equal(describeChange(null, after).baseUrlChanged, false);
  });

  test('affected scenarios are found from the files a change touched', async () => {
    await approveAndApply(scenarioDoc());
    await approveAndApply({ ...scenarioDoc(), name: 'search-orders', title: 'Search for an order by reference', code: [] });
    const hit = affectedScenarios(ws.workspace, P, { repo: 'service-api', changedPaths: ['web\\src\\orders\\OrderForm.tsx', 'README.md'] });
    assert.deepEqual(hit.affected, [{ name: 'place-order', title: 'A customer with a loyalty discount places an order', matchedFiles: ['web/src/orders/OrderForm.tsx'] }]);
    assert.deepEqual(hit.unmapped, ['search-orders']);
    assert.deepEqual(affectedScenarios(ws.workspace, P, { repo: 'service-api', changedPaths: ['web/src/ordersummary/x.ts'] }).affected, []);
    assert.deepEqual(affectedScenarios(ws.workspace, P, { repo: 'web-ui', changedPaths: ['web/src/orders/OrderForm.tsx'] }).affected, []);
    const exact = affectedScenarios(ws.workspace, P, { repo: 'service-api', changedPaths: ['src/main/java/orders/OrderController.java'] });
    assert.equal(exact.affected.length, 1);
  });

  test('the hook keeps agents out of the scenarios folder and scenario state', () => {
    const roots = { automationRoot: path.join(ws.root, 'automation'), workspaceRoot: ws.root };
    assert.match(String(protectedPathReason(scenarioFile, roots)), /scenario propose/);
    assert.match(String(protectedPathReason(scenarioIntegrityFile(ws.workspace, P), roots)), /written only by the autodev CLI/);
    assert.equal(protectedPathReason(path.join(dir, 'repos', 'service-api', 'e2e', 'trial.json'), roots), null);
    assert.notEqual(shellDenyReason('Set-Content C:\\DevWorkspace\\projects\\orders\\scenarios\\place-order.json "{}"'), null);
    assert.notEqual(shellDenyReason('echo {} > /ws/state/scenarios/orders/integrity.json'), null);
  });
});
