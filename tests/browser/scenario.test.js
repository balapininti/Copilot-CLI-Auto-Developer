/**
 * A scenario replayed in a real browser against a tiny application served
 * from 127.0.0.1. Skips cleanly when no Chromium-based browser is available.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

import { openBrowser } from '../../src/adapters/browser/playwright.js';
import { runScenario } from '../../src/cli/commands/scenario.js';
import { validateScenario } from '../../src/workflow/scenarios.js';
import { removeDir, tempDir } from '../helpers.js';
import { chooseBrowser } from './support.js';

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Orders</title></head>
<body>
  <p id="customer-name"></p>
  <input id="reference" type="text">
  <button id="submit">Place order</button>
  <button id="broken">Break</button>
  <p id="result"></p>
  <script>
    fetch('/api/customers/42').then((r) => r.json()).then((c) => { document.getElementById('customer-name').textContent = c.name; });
    document.getElementById('submit').addEventListener('click', async () => {
      const response = await fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reference: document.getElementById('reference').value }) });
      const order = await response.json();
      document.getElementById('result').textContent = 'Order placed ' + order.reference;
    });
    document.getElementById('broken').addEventListener('click', async () => {
      await fetch('/api/recommendations/42');
      document.getElementById('result').textContent = 'Looks fine';
    });
  </script>
</body></html>`;

test('scenario run: steps and expected API calls in a real browser', { timeout: 180_000 }, async (t) => {
  try {
    await import('playwright-core');
  } catch {
    t.skip('playwright-core is not installed');
    return;
  }
  if (process.env.CI && process.env.AUTODEV_BROWSER_SMOKE !== '1') {
    t.skip('real-browser tests are opt-in on CI (set AUTODEV_BROWSER_SMOKE=1)');
    return;
  }
  const choice = chooseBrowser();
  if (!choice) {
    t.skip('no Chromium-based browser installed');
    return;
  }

  const root = tempDir('autodev-scenario-');
  /** @type {string[]} */
  const references = [];
  const server = http.createServer((request, response) => {
    const send = (/** @type {number} */ status, /** @type {unknown} */ body, type = 'application/json') => {
      response.writeHead(status, { 'content-type': type });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (request.url === '/orders') return send(200, PAGE, 'text/html; charset=utf-8');
    if (request.url === '/api/customers/42') return send(200, { id: 42, name: 'Test Customer' });
    if (request.url === '/api/recommendations/42') return send(503, { error: 'unavailable' });
    if (request.url === '/api/orders' && request.method === 'POST') {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        const reference = JSON.parse(raw).reference;
        references.push(reference);
        send(201, { orderId: references.length, reference });
      });
      return undefined;
    }
    return send(404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const evidenceDir = path.join(root, 'evidence');
  const appHosts = ['127.0.0.1'];
  const manifest = { id: 'smoke', browser: { preferred: 'msedge', chromiumFallback: choice.channel === 'chromium' ? 'approved' : 'allowed-only-if-approved', allowedHosts: [] } };
  const env = { ...process.env };
  if (choice.chromiumPath) env.AUTODEV_CHROMIUM_PATH = choice.chromiumPath;

  const base = {
    name: 'place-order',
    title: 'Place an order',
    baseUrl,
    steps: [
      { action: 'goto', url: '/orders' },
      { action: 'assertText', selector: '#customer-name', contains: 'Test Customer' },
      { action: 'fill', selector: '#reference', value: 'ref-{{unique}}' },
      { action: 'click', selector: '#submit' },
      { action: 'assertText', selector: '#result', contains: 'Order placed ref-' },
      { action: 'screenshot', name: 'placed' },
    ],
    expect: [
      { method: 'GET', path: '/api/customers/{id}', status: 200 },
      { method: 'POST', path: '/api/orders', status: 201 },
    ],
  };

  /** @type {Awaited<ReturnType<typeof openBrowser>> | null} */
  let session = null;
  try {
    session = await openBrowser({ manifest, projectId: 'smoke', allowedHosts: appHosts, exactHosts: true, channel: choice.channel, headless: true, env, userDataDir: path.join(root, 'profile') });
    const options = { appHosts, evidenceDir, approved: true, settleMs: 1500 };

    const passed = await runScenario(session, validateScenario(base), options);
    assert.equal(passed.passed, true, JSON.stringify(passed));
    assert.equal(passed.ranAgainst, baseUrl);
    assert.equal(passed.steps.completed, 6);
    assert.equal(passed.expectations.met, 2);
    assert.ok(fs.existsSync(path.join(evidenceDir, 'place-order', 'placed.png')));

    // {{unique}} gives every run its own data.
    await runScenario(session, validateScenario(base), options);
    assert.equal(references.length, 2);
    assert.notEqual(references[0], '');
    assert.match(references[0], /^ref-e2e/);

    // The page still looks right, but the call the scenario expects never happens.
    const moved = await runScenario(session, validateScenario({ ...base, expect: [{ method: 'POST', path: '/api/v2/orders', status: 201 }] }), options);
    assert.equal(moved.steps.ok, true);
    assert.equal(moved.passed, false);
    assert.equal(moved.expectations.results[0].seen, 0);

    // The call happens but answers differently.
    const wrongStatus = await runScenario(session, validateScenario({ ...base, expect: [{ method: 'POST', path: '/api/orders', status: 200 }] }), options);
    assert.equal(wrongStatus.passed, false);
    assert.deepEqual(wrongStatus.expectations.results[0].otherStatuses, [201]);

    // A server error fails the run even though every step and assertion passed.
    const broken = await runScenario(session, validateScenario({
      ...base,
      steps: [{ action: 'goto', url: '/orders' }, { action: 'click', selector: '#broken' }, { action: 'assertText', selector: '#result', contains: 'Looks fine' }],
      expect: [],
    }), options);
    assert.equal(broken.steps.ok, true);
    assert.equal(broken.passed, false);
    assert.deepEqual(broken.expectations.serverErrors, [{ method: 'GET', path: '/api/recommendations/{id}', status: 503 }]);

    // A failing step fails the run without waiting for expectations.
    const failingStep = await runScenario(session, validateScenario({ ...base, steps: [{ action: 'goto', url: '/orders' }, { action: 'assertText', selector: '#result', contains: 'never shown' }] }), options);
    assert.equal(failingStep.passed, false);
    assert.equal(failingStep.steps.ok, false);
  } finally {
    await session?.close();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    removeDir(root);
  }
});
