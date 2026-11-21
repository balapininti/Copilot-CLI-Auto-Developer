import assert from 'node:assert/strict';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';

import { SERVICES, createTransport } from '../../src/core/auth.js';
import { applyDefaults } from '../../src/core/manifest.js';
import { clearRegisteredSecrets, redactString } from '../../src/core/redact.js';
import { getSecret } from '../../src/core/secrets.js';
import { createMockState, startMockServer } from '../../src/mocks/server.js';
import { expectCode, fakeFetch, fullManifest, serviceEnv } from '../helpers.js';

afterEach(() => clearRegisteredSecrets());

/** A credential-store runner that records calls and replays one result. */
function fakeRunner(/** @type {{ exitCode?: number | null, stdout?: string, throws?: Error }} */ result = {}) {
  /** @type {Array<{ command: string, args: string[], options: any }>} */
  const calls = [];
  const runner = async (/** @type {string} */ command, /** @type {string[]} */ args, /** @type {any} */ options) => {
    calls.push({ command, args, options });
    if (result.throws) throw result.throws;
    return { exitCode: 'exitCode' in result ? /** @type {number | null} */ (result.exitCode) : 0, stdout: result.stdout ?? 'stored-secret-value\n' };
  };
  return { runner, calls };
}

describe('getSecret', () => {
  test('env lookup: returns the trimmed variable and never consults the store', async () => {
    const { runner, calls } = fakeRunner();
    assert.equal(await getSecret('MY_TOKEN', { env: { MY_TOKEN: '  env-secret-value  ' }, runner, platform: 'win32' }), 'env-secret-value');
    assert.equal(calls.length, 0);
  });

  test('a secret that was read is registered for redaction under its name', async () => {
    await getSecret('MY_TOKEN', { env: { MY_TOKEN: 'env-secret-value' }, useCredentialStore: false });
    assert.equal(redactString('got env-secret-value'), 'got [REDACTED:MY_TOKEN]');
  });

  test('returns null when the secret is nowhere, and for an empty name', async () => {
    assert.equal(await getSecret('MY_TOKEN', { env: {}, useCredentialStore: false }), null);
    assert.equal(await getSecret('MY_TOKEN', { env: { MY_TOKEN: '   ' }, useCredentialStore: false }), null);
    assert.equal(await getSecret(null, { env: {} }), null);
    assert.equal(await getSecret('', { env: {} }), null);
  });

  test('credential store on Windows: PowerShell reads generic credential autodev/<name> without a profile', async () => {
    const { runner, calls } = fakeRunner({ stdout: 'stored-secret-value\r\n' });
    assert.equal(await getSecret('MY_TOKEN', { env: {}, runner, platform: 'win32' }), 'stored-secret-value');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'powershell.exe');
    const args = calls[0].args;
    assert.ok(args.includes('-NoProfile') && args.includes('-NonInteractive'));
    assert.equal(args[args.indexOf('-Target') + 1], 'autodev/MY_TOKEN');
    assert.equal(path.basename(args[args.indexOf('-File') + 1]), 'Get-AutoDevCredential.ps1');
    assert.equal(calls[0].options.redactOutput, false, 'the raw value must come back unredacted');
    assert.equal(redactString('x stored-secret-value'), 'x [REDACTED:MY_TOKEN]');
  });

  test('credential store on macOS: security find-generic-password -s autodev/<name> -w', async () => {
    const { runner, calls } = fakeRunner();
    assert.equal(await getSecret('MY_TOKEN', { env: {}, runner, platform: 'darwin' }), 'stored-secret-value');
    assert.deepEqual([calls[0].command, calls[0].args], ['security', ['find-generic-password', '-s', 'autodev/MY_TOKEN', '-w']]);
  });

  test('credential store on Linux: secret-tool lookup service autodev name <name>', async () => {
    const { runner, calls } = fakeRunner();
    assert.equal(await getSecret('MY_TOKEN', { env: {}, runner, platform: 'linux' }), 'stored-secret-value');
    assert.deepEqual([calls[0].command, calls[0].args], ['secret-tool', ['lookup', 'service', 'autodev', 'name', 'MY_TOKEN']]);
  });

  test('an unsupported platform has no store', async () => {
    const { runner, calls } = fakeRunner();
    assert.equal(await getSecret('MY_TOKEN', { env: {}, runner, platform: 'freebsd' }), null);
    assert.equal(calls.length, 0);
  });

  test('store misses are null: non-zero exit, empty output, or the tool not installed', async () => {
    assert.equal(await getSecret('MY_TOKEN', { env: {}, platform: 'darwin', runner: fakeRunner({ exitCode: 44, stdout: 'error text' }).runner }), null);
    assert.equal(await getSecret('MY_TOKEN', { env: {}, platform: 'darwin', runner: fakeRunner({ stdout: '\n' }).runner }), null);
    assert.equal(await getSecret('MY_TOKEN', { env: {}, platform: 'linux', runner: fakeRunner({ throws: new Error('ENOENT') }).runner }), null);
    assert.equal(await getSecret('MY_TOKEN', { env: {}, platform: 'linux', runner: fakeRunner({ exitCode: null }).runner }), null);
  });

  test('the store is skipped with useCredentialStore:false or AUTODEV_DISABLE_CREDENTIAL_STORE=1', async () => {
    const a = fakeRunner();
    assert.equal(await getSecret('MY_TOKEN', { env: {}, runner: a.runner, platform: 'darwin', useCredentialStore: false }), null);
    const b = fakeRunner();
    assert.equal(await getSecret('MY_TOKEN', { env: { AUTODEV_DISABLE_CREDENTIAL_STORE: '1' }, runner: b.runner, platform: 'darwin' }), null);
    assert.equal(a.calls.length + b.calls.length, 0);
  });

  test('hostile secret names are rejected before any lookup', async () => {
    const { runner, calls } = fakeRunner();
    for (const name of ['a b', '-Target', '../x', 'a;b', 'a"b', "a'b", '$(x)', 'a\nb', '9lives', 'x'.repeat(101)]) {
      await expectCode(() => getSecret(name, { env: {}, runner, platform: 'win32' }), 'CONFIG_INVALID');
    }
    assert.equal(calls.length, 0);
  });
});

describe('createTransport', () => {
  /** @type {Awaited<ReturnType<typeof startMockServer>>} */
  let server;
  /** @type {Record<string, any>} */
  let manifest;
  /** @type {Record<string, string>} */
  let env;
  before(async () => {
    server = await startMockServer(createMockState());
    manifest = applyDefaults(fullManifest());
    env = serviceEnv(server.baseUrl);
  });
  after(() => server.close());

  /** Real fetch against the mock, recording the headers that were sent. */
  function recordingFetch() {
    /** @type {Array<Record<string, string>>} */
    const seen = [];
    /** @type {any} */
    const impl = (/** @type {any} */ url, /** @type {any} */ init) => {
      seen.push(init.headers);
      return fetch(url, init);
    };
    return { impl, seen };
  }

  test('token transport sends the right header per service against the mock (Bearer vs Api-Token)', async () => {
    const expected = {
      agility: 'Bearer test-agility-token-1',
      bitbucket: 'Bearer test-bitbucket-token-1',
      splunk: 'Bearer test-splunk-token-1',
      dynatrace: 'Api-Token test-dynatrace-token-1',
    };
    for (const [service, header] of Object.entries(expected)) {
      const { impl, seen } = recordingFetch();
      const transport = await createTransport(service, manifest, { env, fetchImpl: impl, useCredentialStore: false });
      assert.equal(transport.mode, 'token');
      assert.equal(transport.service, service);
      assert.equal(transport.baseUrl, server.baseUrl);
      const response = await transport.request({ path: SERVICES[service].probePath });
      assert.equal(response.status, 200, `${service} probe is accepted by the mock`);
      assert.equal(seen[0].authorization, header);
      await transport.close();
    }
  });

  test('the token never appears in errors raised by the transport', async () => {
    const transport = await createTransport('agility', manifest, { env, useCredentialStore: false });
    const error = await expectCode(() => transport.request({ path: '/rest-1.v1/Data/Nonexistent' }), 'NOT_FOUND');
    assert.ok(!JSON.stringify({ m: error.message, d: error.details }).includes('test-agility-token-1'));
  });

  test('requests are confined to the configured host', async () => {
    const fetchImpl = fakeFetch([{ body: {} }]);
    const transport = await createTransport('splunk', manifest, { env, fetchImpl, useCredentialStore: false });
    for (const hostile of ['//evil.example.com/x', 'https://evil.example.com/x', 'relative/path', '']) {
      await expectCode(() => transport.request({ path: hostile }), 'INVALID_ARGUMENT');
    }
    await transport.request({ path: '/@evil.example.com/x' });
    await transport.request({ path: '/\\evil.example.com/x' });
    for (const call of fetchImpl.calls) assert.equal(new URL(call.url).host, new URL(server.baseUrl).host);
  });

  test('a trailing slash on the base URL does not produce a double slash', async () => {
    const fetchImpl = fakeFetch([{ body: {} }]);
    const transport = await createTransport('bitbucket', manifest, { env: { ...env, TEST_BITBUCKET_URL: `${server.baseUrl}/base//` }, fetchImpl, useCredentialStore: false });
    await transport.request({ path: '/rest/api/1.0/x' });
    assert.equal(new URL(fetchImpl.calls[0].url).pathname, '/base/rest/api/1.0/x');
  });

  test('caller headers are merged with, and method/body passed alongside, the auth header', async () => {
    const fetchImpl = fakeFetch([{ body: {} }]);
    const transport = await createTransport('splunk', manifest, { env, fetchImpl, useCredentialStore: false });
    await transport.request({ path: '/services/x', method: 'POST', headers: { 'x-extra': '1' }, body: new URLSearchParams({ a: 'b' }) });
    const { init } = fetchImpl.calls[0];
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['x-extra'], '1');
    assert.equal(init.headers.authorization, 'Bearer test-splunk-token-1');
  });

  test('missing token with no browser fallback -> AUTH_REQUIRED naming the secret', async () => {
    for (const [service, secretName] of [['bitbucket', 'TEST_BITBUCKET_TOKEN'], ['splunk', 'TEST_SPLUNK_TOKEN'], ['dynatrace', 'TEST_DYNATRACE_TOKEN']]) {
      const without = { ...env };
      delete without[secretName];
      const error = await expectCode(() => createTransport(service, manifest, { env: without, useCredentialStore: false }), 'AUTH_REQUIRED');
      assert.equal(error.details.secretName, secretName);
      assert.equal(error.details.service, service);
      assert.ok(error.details.howToFix.includes(secretName) && error.details.howToFix.includes(`autodev/${secretName}`));
    }
  });

  test('agility with browserFallback:false and no token -> AUTH_REQUIRED naming the secret', async () => {
    const noBrowser = structuredClone(manifest);
    noBrowser.agility.browserFallback = false;
    const without = { ...env };
    delete without.TEST_AGILITY_TOKEN;
    const error = await expectCode(() => createTransport('agility', noBrowser, { env: without, useCredentialStore: false }), 'AUTH_REQUIRED', /not enabled for this project/);
    assert.equal(error.details.secretName, 'TEST_AGILITY_TOKEN');
  });

  test('the default secret name is used when the manifest names none', async () => {
    const bare = structuredClone(manifest);
    delete bare.observability.dynatraceTokenSecret;
    const error = await expectCode(() => createTransport('dynatrace', bare, { env: { TEST_DYNATRACE_URL: server.baseUrl }, useCredentialStore: false }), 'AUTH_REQUIRED');
    assert.equal(error.details.secretName, 'DYNATRACE_TOKEN');
  });

  test('missing base URL env -> NOT_CONFIGURED naming field and variable', async () => {
    const without = { ...env };
    delete without.TEST_SPLUNK_URL;
    const error = await expectCode(() => createTransport('splunk', manifest, { env: without, useCredentialStore: false }), 'NOT_CONFIGURED');
    assert.deepEqual(error.details, { field: 'observability.splunkBaseUrlEnv', envName: 'TEST_SPLUNK_URL' });
    const unset = structuredClone(manifest);
    unset.agility.baseUrlEnv = null;
    const fieldError = await expectCode(() => createTransport('agility', unset, { env, useCredentialStore: false }), 'NOT_CONFIGURED');
    assert.deepEqual(fieldError.details, { field: 'agility.baseUrlEnv' });
  });

  test('an unusable base URL is CONFIG_INVALID and an unknown service INVALID_ARGUMENT', async () => {
    await expectCode(() => createTransport('agility', manifest, { env: { ...env, TEST_AGILITY_URL: 'not a url' }, useCredentialStore: false }), 'CONFIG_INVALID');
    await expectCode(() => createTransport('jira', manifest, { env, useCredentialStore: false }), 'INVALID_ARGUMENT');
  });

  test('a plain-http base URL on a non-loopback host is refused when a request is made', async () => {
    const fetchImpl = fakeFetch([{ body: {} }]);
    const transport = await createTransport('agility', manifest, { env: { ...env, TEST_AGILITY_URL: 'http://agility.example.com' }, fetchImpl, useCredentialStore: false });
    await expectCode(() => transport.request({ path: '/rest-1.v1/Data/Member' }), 'TLS_POLICY_VIOLATION');
    assert.equal(fetchImpl.calls.length, 0, 'the token is never sent over plain http');
  });

  describe('agility browser fallback (fake browser module)', () => {
    /** @param {{ signedIn: boolean }} state */
    function fakeBrowser(state) {
      /** @type {{ opened: Array<Record<string, any>>, closed: number, fetched: string[] }} */
      const log = { opened: [], closed: 0, fetched: [] };
      return {
        log,
        openBrowser: async (/** @type {Record<string, any>} */ options) => {
          log.opened.push(options);
          return { page: { goto: async () => {} }, close: async () => { log.closed += 1; } };
        },
        browserFetch: async (/** @type {any} */ _session, /** @type {{ url: string }} */ request) => {
          log.fetched.push(request.url);
          return state.signedIn
            ? { status: 200, contentType: 'application/json', body: { ok: true }, text: '{"ok":true}' }
            : { status: 200, contentType: 'text/html', body: '<html>login</html>', text: '<html>login</html>' };
        },
      };
    }
    const noToken = () => {
      const without = { ...env };
      delete without.TEST_AGILITY_TOKEN;
      return without;
    };

    test('a signed-in profile yields a browser transport restricted to the Agility host', async () => {
      const browser = fakeBrowser({ signedIn: true });
      const transport = await createTransport('agility', manifest, { env: noToken(), useCredentialStore: false, browserModule: browser, interactive: false });
      assert.equal(transport.mode, 'browser');
      assert.equal(browser.log.opened.length, 1);
      assert.equal(browser.log.opened[0].headless, true);
      assert.deepEqual(browser.log.opened[0].allowedHosts, ['127.0.0.1']);
      assert.equal(browser.log.opened[0].projectId, 'orders');
      assert.deepEqual((await transport.request({ path: '/rest-1.v1/Data/Story' })).body, { ok: true });
      await transport.close();
      assert.equal(browser.log.closed, 1);
    });

    test('a profile that is not signed in, in a non-interactive run, is AUTH_REQUIRED and the browser is closed', async () => {
      const browser = fakeBrowser({ signedIn: false });
      const error = await expectCode(() => createTransport('agility', manifest, { env: noToken(), useCredentialStore: false, browserModule: browser, interactive: false }), 'AUTH_REQUIRED', /not interactive/);
      assert.match(error.details.howToFix, /auth login --service agility/);
      assert.equal(browser.log.opened.length, 1, 'no headed window is opened');
      assert.ok(browser.log.closed >= 1);
    });
  });
});
