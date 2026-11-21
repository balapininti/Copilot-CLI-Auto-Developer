/**
 * Local Playwright smoke test: a real Chromium-based browser against a tiny
 * page served from 127.0.0.1. Skips cleanly when no such browser (or
 * playwright-core) is available.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

import { openBrowser, runSteps } from '../../src/adapters/browser/playwright.js';
import { removeDir, tempDir } from '../helpers.js';
import { chooseBrowser } from './support.js';

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Smoke</title></head>
<body>
  <h1 id="title">Auto Developer smoke page</h1>
  <form onsubmit="return false">
    <input id="name" type="text" name="name">
    <input id="pw" type="password" name="pw">
  </form>
  <p id="echo"></p>
  <a id="away" href="__AWAY__">leave</a>
  <script>
    document.getElementById('name').addEventListener('input', (e) => {
      document.getElementById('echo').textContent = 'Hello ' + e.target.value;
    });
  </script>
</body></html>`;

test('browser smoke: real browser against a local page', { timeout: 180_000 }, async (t) => {
  try {
    await import('playwright-core');
  } catch {
    t.skip('playwright-core is not installed');
    return;
  }
  if (process.env.CI && process.env.AUTODEV_BROWSER_SMOKE !== '1') {
    // Hosted CI runners start a browser slowly and unreliably; the smoke test
    // is run there in its own non-blocking step instead (npm run test:browser).
    t.skip('browser smoke test is opt-in on CI (set AUTODEV_BROWSER_SMOKE=1)');
    return;
  }
  const choice = chooseBrowser();
  if (!choice) {
    t.skip('no Chromium-based browser installed');
    return;
  }

  const root = tempDir('autodev-browser-');
  const hits = { away: 0 };
  /** @type {http.Server} */
  const server = http.createServer((request, response) => {
    // The page is served to 127.0.0.1; "localhost" is the same socket under a host that is NOT allowlisted.
    if ((request.headers.host ?? '').startsWith('localhost')) hits.away += 1;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE.replace('__AWAY__', `http://localhost:${/** @type {any} */ (server.address()).port}/away`));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const evidenceDir = path.join(root, 'evidence');
  const manifest = { id: 'smoke', browser: { preferred: 'msedge', chromiumFallback: choice.channel === 'chromium' ? 'approved' : 'allowed-only-if-approved', allowedHosts: [] } };
  const env = { ...process.env };
  if (choice.chromiumPath) env.AUTODEV_CHROMIUM_PATH = choice.chromiumPath;
  const allowedHosts = ['127.0.0.1'];

  /** @type {Awaited<ReturnType<typeof openBrowser>> | null} */
  let session = null;
  try {
    session = await openBrowser({ manifest, projectId: 'smoke', allowedHosts, channel: choice.channel, headless: true, env, userDataDir: path.join(root, 'profile') });
    assert.equal(session.channel, choice.channel);
    t.diagnostic(`browser used: ${choice.channel}${choice.chromiumPath ? ` (${choice.chromiumPath})` : ''}`);

    const happy = await runSteps(session, [
      { action: 'goto', url: `${baseUrl}/` },
      { action: 'text', selector: '#title' },
      { action: 'assertText', selector: '#title', contains: 'smoke page' },
      { action: 'fill', selector: '#name', value: 'Ada' },
      { action: 'assertText', selector: '#echo', contains: 'Hello Ada' },
      { action: 'assertVisible', selector: '#pw' },
      { action: 'assertUrl', contains: `127.0.0.1:${port}` },
      { action: 'screenshot', name: 'smoke-home' },
    ], { allowedHosts, evidenceDir });
    assert.equal(happy.ok, true, JSON.stringify(happy.results));
    assert.equal(happy.completed, 8);
    assert.equal(/** @type {any} */ (happy.results[0].output).status, 200);
    assert.equal(happy.results[1].output, 'Auto Developer smoke page');
    const shot = /** @type {any} */ (happy.results[7].output);
    assert.equal(shot.file, path.join(evidenceDir, 'smoke-home.png'));
    assert.ok(fs.existsSync(shot.file));
    assert.ok(shot.bytes > 100);
    assert.deepEqual([...fs.readFileSync(shot.file).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'screenshot is a PNG');

    // Automation never types into a password field, and the run stops there.
    const password = await runSteps(session, [
      { action: 'fill', selector: '#pw', value: 'hunter2hunter2' },
      { action: 'fill', selector: '#name', value: 'must not run' },
    ], { allowedHosts, evidenceDir });
    assert.equal(password.ok, false);
    assert.equal(password.results.length, 1);
    assert.equal(password.results[0].code, 'POLICY_PROHIBITED');
    assert.equal(await session.page.locator('#pw').inputValue(), '');
    assert.equal(await session.page.locator('#name').inputValue(), 'Ada');

    // A failing assertion is reported, not swallowed.
    const failing = await runSteps(session, [{ action: 'assertText', selector: '#title', contains: 'not on the page' }], { allowedHosts, evidenceDir });
    assert.equal(failing.ok, false);
    assert.match(String(failing.results[0].error), /Expected text to contain/);

    // goto to a host that is not allowlisted is refused before any request is made.
    const direct = await runSteps(session, [{ action: 'goto', url: `http://localhost:${port}/away` }], { allowedHosts, evidenceDir });
    assert.equal(direct.ok, false);
    assert.equal(direct.results[0].code, 'HOST_NOT_ALLOWED');

    // A link on the page that leaves the allowlist is blocked by the route guard.
    await runSteps(session, [{ action: 'click', selector: '#away', timeoutMs: 5000 }], { allowedHosts, evidenceDir });
    await session.page.waitForTimeout(300);
    const after = await runSteps(session, [{ action: 'assertUrl', contains: '127.0.0.1' }], { allowedHosts, evidenceDir });
    assert.deepEqual(after.blockedNavigations, ['localhost']);
    assert.ok(!session.page.url().includes('localhost'), session.page.url());
    assert.equal(hits.away, 0, 'the blocked host must never receive a request');
  } finally {
    await session?.close();
    await new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve(undefined));
    });
    removeDir(root);
  }
});
