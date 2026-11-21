import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { CHANNELS, hostAllowed, openBrowser, profileDir, resolveChannel, runSteps } from '../../src/adapters/browser/playwright.js';
import { expectCode } from '../helpers.js';

/** @param {Record<string, any>} browser */
const manifestWith = (browser) => ({ id: 'orders', browser: { preferred: 'msedge', chromiumFallback: 'allowed-only-if-approved', allowedHosts: [], ...browser } });

describe('browser resolveChannel', () => {
  test('defaults to Microsoft Edge', () => {
    assert.equal(resolveChannel(manifestWith({}), null), 'msedge');
    assert.equal(resolveChannel(manifestWith({}), undefined), 'msedge');
    assert.equal(resolveChannel(manifestWith({ preferred: undefined }), null), 'msedge');
    assert.deepEqual([...CHANNELS], ['msedge', 'chromium']);
  });

  test('refuses chromium unless the manifest marks it approved', async () => {
    for (const chromiumFallback of ['allowed-only-if-approved', 'prohibited', undefined, 'APPROVED', true]) {
      const error = await expectCode(() => resolveChannel(manifestWith({ chromiumFallback }), 'chromium'), 'POLICY_PROHIBITED', /not approved/);
      assert.equal(error.details.chromiumFallback, chromiumFallback);
    }
  });

  test('a manifest that merely prefers chromium is still refused without approval', async () => {
    await expectCode(() => resolveChannel(manifestWith({ preferred: 'chromium' }), null), 'POLICY_PROHIBITED');
  });

  test('allows chromium when approved and requested or preferred', () => {
    assert.equal(resolveChannel(manifestWith({ chromiumFallback: 'approved' }), 'chromium'), 'chromium');
    assert.equal(resolveChannel(manifestWith({ chromiumFallback: 'approved', preferred: 'chromium' }), null), 'chromium');
  });

  test('approval of chromium does not switch browser silently', () => {
    assert.equal(resolveChannel(manifestWith({ chromiumFallback: 'approved' }), null), 'msedge');
  });

  test('unsupported browsers are rejected', async () => {
    for (const channel of ['firefox', 'chrome', 'webkit', 'MSEDGE', '', 'chromium ']) {
      await expectCode(() => resolveChannel(manifestWith({ chromiumFallback: 'approved' }), channel), 'INVALID_ARGUMENT');
    }
  });
});

describe('browser hostAllowed', () => {
  test('exact hosts match case-insensitively', () => {
    assert.equal(hostAllowed('Agility.Example.com', ['agility.example.com']), true);
    assert.equal(hostAllowed('agility.example.com', ['AGILITY.EXAMPLE.COM']), true);
    assert.equal(hostAllowed('other.example.com', ['agility.example.com']), false);
  });

  test('wildcard matches subdomains at any depth but not the bare domain', () => {
    assert.equal(hostAllowed('a.example.com', ['*.example.com']), true);
    assert.equal(hostAllowed('a.b.example.com', ['*.example.com']), true);
    assert.equal(hostAllowed('example.com', ['*.example.com']), false);
  });

  test('wildcard cannot be satisfied by look-alike hosts', () => {
    assert.equal(hostAllowed('evilexample.com', ['*.example.com']), false);
    assert.equal(hostAllowed('example.com.evil.net', ['*.example.com']), false);
    assert.equal(hostAllowed('a.example.com.evil.net', ['*.example.com']), false);
    assert.equal(hostAllowed('xexample.com', ['example.com']), false);
    assert.equal(hostAllowed('sub.example.com', ['example.com']), false, 'an exact entry does not cover subdomains');
  });

  test('an empty allowlist allows nothing and "*" is not a catch-all', () => {
    assert.equal(hostAllowed('example.com', []), false);
    assert.equal(hostAllowed('example.com', ['*']), false);
    assert.equal(hostAllowed('example.com', ['']), false);
    assert.equal(hostAllowed('', ['example.com']), false);
  });
});

describe('browser profileDir', () => {
  test('AUTODEV_BROWSER_PROFILE_DIR overrides the base and the folder is per project and channel', () => {
    const base = path.join(os.tmpdir(), 'profiles-base');
    assert.equal(profileDir('orders', 'msedge', { AUTODEV_BROWSER_PROFILE_DIR: base }), path.join(base, 'orders-msedge'));
    assert.equal(profileDir('orders', 'chromium', { AUTODEV_BROWSER_PROFILE_DIR: base }), path.join(base, 'orders-chromium'));
    assert.notEqual(profileDir('billing', 'msedge', { AUTODEV_BROWSER_PROFILE_DIR: base }), profileDir('orders', 'msedge', { AUTODEV_BROWSER_PROFILE_DIR: base }));
  });

  test('the default location follows the platform convention', () => {
    const dir = profileDir('orders', 'msedge', { LOCALAPPDATA: path.join(os.tmpdir(), 'LocalAppData'), XDG_DATA_HOME: path.join(os.tmpdir(), 'xdg') });
    const expected =
      process.platform === 'win32'
        ? path.join(os.tmpdir(), 'LocalAppData', 'AutoDev', 'browser-profiles', 'orders-msedge')
        : process.platform === 'darwin'
          ? path.join(os.homedir(), 'Library', 'Application Support', 'AutoDev', 'browser-profiles', 'orders-msedge')
          : path.join(os.tmpdir(), 'xdg', 'autodev', 'browser-profiles', 'orders-msedge');
    assert.equal(dir, expected);
  });

  test('falls back to the home folder when the platform variables are unset', () => {
    const dir = profileDir('orders', 'msedge', {});
    assert.ok(dir.startsWith(os.homedir()), dir);
    assert.equal(path.basename(dir), 'orders-msedge');
  });

  test('project ids that could traverse paths are rejected', async () => {
    for (const id of ['../other', '..', 'a/b', 'a\\b', '', '.hidden']) {
      await expectCode(() => profileDir(id, 'msedge', { AUTODEV_BROWSER_PROFILE_DIR: os.tmpdir() }), 'INVALID_ARGUMENT');
    }
  });
});

describe('browser openBrowser refusals (no browser is started)', () => {
  test('refuses to open with an empty host allowlist', async () => {
    await expectCode(() => openBrowser({ manifest: manifestWith({}), projectId: 'orders', allowedHosts: [], headless: true }), 'NOT_CONFIGURED', /allowed hosts/i);
  });

  test('refuses unapproved chromium before anything else', async () => {
    await expectCode(() => openBrowser({ manifest: manifestWith({}), projectId: 'orders', allowedHosts: ['127.0.0.1'], channel: 'chromium', headless: true }), 'POLICY_PROHIBITED');
  });
});

describe('browser runSteps policy checks with a stub page (no browser needed)', () => {
  function stubSession() {
    /** @type {string[]} */
    const visited = [];
    const page = {
      url: () => 'about:blank',
      goto: async (/** @type {string} */ href) => {
        visited.push(href);
        return { status: () => 200 };
      },
    };
    return { session: /** @type {any} */ ({ page, context: {}, channel: 'msedge', blockedNavigations: [], close: async () => {} }), visited };
  }
  const allow = { allowedHosts: ['app.example.com', '127.0.0.1', 'localhost'] };

  test('goto refuses hosts that are not on the allowlist', async () => {
    for (const url of ['https://evil.example.net/', 'https://app.example.com@evil.example.net/', 'https://app.example.com.evil.example.net/x', 'https://sub.app.example.com/']) {
      const { session, visited } = stubSession();
      const result = await runSteps(session, [{ action: 'goto', url }], allow);
      assert.equal(result.ok, false, url);
      assert.equal(result.results[0].code, 'HOST_NOT_ALLOWED', url);
      assert.deepEqual(visited, [], url);
    }
  });

  test('goto refuses plain http except to loopback, and non-web schemes', async () => {
    for (const url of ['http://app.example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://app.example.com/']) {
      const { session, visited } = stubSession();
      const result = await runSteps(session, [{ action: 'goto', url }], allow);
      assert.equal(result.results[0].code, 'TLS_POLICY_VIOLATION', url);
      assert.deepEqual(visited, [], url);
    }
    const { session, visited } = stubSession();
    const ok = await runSteps(session, [{ action: 'goto', url: 'http://127.0.0.1:8080/x' }, { action: 'goto', url: 'https://app.example.com/y' }], allow);
    assert.equal(ok.ok, true);
    assert.deepEqual(visited, ['http://127.0.0.1:8080/x', 'https://app.example.com/y']);
  });

  test('loopback http is still subject to the allowlist', async () => {
    const { session, visited } = stubSession();
    const result = await runSteps(session, [{ action: 'goto', url: 'http://localhost:1/' }], { allowedHosts: ['app.example.com'] });
    assert.equal(result.results[0].code, 'HOST_NOT_ALLOWED');
    assert.deepEqual(visited, []);
  });

  test('a failed step stops the run; unknown actions and missing fields are INVALID_ARGUMENT', async () => {
    const { session, visited } = stubSession();
    const result = await runSteps(session, [{ action: 'teleport' }, { action: 'goto', url: 'https://app.example.com/' }], allow);
    assert.equal(result.ok, false);
    assert.equal(result.completed, 0);
    assert.equal(result.total, 2);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].code, 'INVALID_ARGUMENT');
    assert.deepEqual(visited, []);
    const missing = await runSteps(stubSession().session, [{ action: 'goto' }], allow);
    assert.equal(missing.results[0].code, 'INVALID_ARGUMENT');
  });

  test('screenshot needs an evidence folder and a safe file name', async () => {
    const none = await runSteps(stubSession().session, [{ action: 'screenshot', name: 'home' }], allow);
    assert.equal(none.results[0].code, 'INVALID_ARGUMENT');
    const traversal = await runSteps(stubSession().session, [{ action: 'screenshot', name: '../../escape' }], { ...allow, evidenceDir: path.join(os.tmpdir(), 'autodev-never-created-evidence', 'x') });
    assert.equal(traversal.results[0].code, 'INVALID_ARGUMENT');
  });
});
