import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';

import { assertAllowedUrl, assertTlsPolicy, createRateLimiter, hostOf, httpRequest } from '../../src/core/http.js';
import { expectCode, fakeFetch, setEnv } from '../helpers.js';

const URL_OK = 'https://api.example.com/v1/things';
const HOSTS = ['api.example.com'];
/** @param {Record<string, any>} extra */
const req = (extra) => httpRequest({ url: URL_OK, allowedHosts: HOSTS, service: 'Example', backoffBaseMs: 1, ...extra });

describe('URL policy', () => {
  test('https-only: plain http to a non-loopback host is refused', async () => {
    await expectCode(() => assertAllowedUrl('http://api.example.com/x', HOSTS), 'TLS_POLICY_VIOLATION');
    for (const url of ['ftp://api.example.com/x', 'file:///etc/passwd', 'ws://api.example.com/', 'javascript:alert(1)']) {
      await expectCode(() => assertAllowedUrl(url, HOSTS), 'TLS_POLICY_VIOLATION');
    }
    const fetchImpl = fakeFetch([{ body: {} }]);
    await expectCode(() => httpRequest({ url: 'http://api.example.com/x', allowedHosts: HOSTS, fetchImpl }), 'TLS_POLICY_VIOLATION');
    assert.equal(fetchImpl.calls.length, 0);
  });

  test('loopback http is allowed (for local mocks), but still subject to the allowlist', async () => {
    assert.equal(assertAllowedUrl('http://127.0.0.1:8080/x', ['127.0.0.1']).port, '8080');
    assert.ok(assertAllowedUrl('http://localhost:8080/x', ['localhost']));
    assert.ok(assertAllowedUrl('http://[::1]:8080/x', ['[::1]']));
    await expectCode(() => assertAllowedUrl('http://127.0.0.1:8080/x', HOSTS), 'HOST_NOT_ALLOWED');
  });

  test('look-alike loopback hosts do not get the http exemption', async () => {
    for (const url of ['http://127.0.0.1.evil.example/x', 'http://localhost.evil.example/x', 'http://127.0.0.2/x', 'http://0.0.0.0/x']) {
      await expectCode(() => assertAllowedUrl(url, ['127.0.0.1.evil.example', 'localhost.evil.example', '127.0.0.2', '0.0.0.0']), 'TLS_POLICY_VIOLATION');
    }
  });

  test('host allowlist: exact and wildcard matches, everything else HOST_NOT_ALLOWED', async () => {
    assert.ok(assertAllowedUrl('https://API.Example.com/x', HOSTS), 'case-insensitive');
    assert.ok(assertAllowedUrl('https://a.b.example.com/x', ['*.example.com']));
    for (const [url, hosts] of /** @type {Array<[string, string[]]>} */ ([
      ['https://evil.com/x', HOSTS],
      ['https://api.example.com.evil.com/x', HOSTS],
      ['https://xapi.example.com/x', HOSTS],
      ['https://example.com/x', ['*.example.com']],
      ['https://notexample.com/x', ['*.example.com']],
      ['https://example.com.evil.com/x', ['*.example.com']],
      ['https://api.example.com/x', []],
      ['https://api.example.com/x', ['*']],
      ['https://api.example.com/x', ['']],
    ])) {
      const error = await expectCode(() => assertAllowedUrl(url, hosts), 'HOST_NOT_ALLOWED');
      assert.deepEqual(error.details.allowedHosts, hosts);
    }
  });

  test('userinfo tricks do not move the request to another host', async () => {
    await expectCode(() => assertAllowedUrl('https://api.example.com@evil.com/x', HOSTS), 'INVALID_ARGUMENT');
    await expectCode(() => assertAllowedUrl('https://user:pw@api.example.com/x', HOSTS), 'INVALID_ARGUMENT');
    await expectCode(() => assertAllowedUrl('https://evil.com\\@api.example.com/x', HOSTS), 'HOST_NOT_ALLOWED');
    await expectCode(() => assertAllowedUrl('https://evil.com#@api.example.com/x', HOSTS), 'HOST_NOT_ALLOWED');
  });

  test('garbage is INVALID_ARGUMENT', async () => {
    await expectCode(() => assertAllowedUrl('not a url', HOSTS), 'INVALID_ARGUMENT');
    await expectCode(() => assertAllowedUrl('', HOSTS), 'INVALID_ARGUMENT');
    await expectCode(() => assertAllowedUrl('//api.example.com/x', HOSTS), 'INVALID_ARGUMENT');
  });

  test('hostOf gives the single-host allowlist for a base URL', () => {
    assert.deepEqual(hostOf('https://Agility.Example.com:8443/base'), ['agility.example.com']);
    assert.deepEqual(hostOf('nonsense'), []);
    assert.deepEqual(hostOf(null), []);
  });

  test('refuses NODE_TLS_REJECT_UNAUTHORIZED=0', async () => {
    await expectCode(() => assertTlsPolicy({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }), 'TLS_POLICY_VIOLATION');
    assert.doesNotThrow(() => assertTlsPolicy({ NODE_TLS_REJECT_UNAUTHORIZED: '1' }));
    assert.doesNotThrow(() => assertTlsPolicy({}));
    const restore = setEnv({ NODE_TLS_REJECT_UNAUTHORIZED: '0' });
    try {
      const fetchImpl = fakeFetch([{ body: {} }]);
      await expectCode(() => req({ fetchImpl }), 'TLS_POLICY_VIOLATION', /certificate validation/);
      assert.equal(fetchImpl.calls.length, 0, 'nothing is sent');
    } finally {
      restore();
    }
  });
});

describe('httpRequest: success path', () => {
  test('parses JSON, sends accept header, never follows redirects automatically', async () => {
    const fetchImpl = fakeFetch([{ body: { a: 1 } }]);
    const response = await req({ fetchImpl, headers: { authorization: 'Bearer x' } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { a: 1 });
    assert.equal(response.text, '{"a":1}');
    const { init } = fetchImpl.calls[0];
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.accept, 'application/json');
    assert.equal(init.headers.authorization, 'Bearer x');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.body, undefined);
  });

  test('object bodies are sent as JSON; strings and form data as-is', async () => {
    const fetchImpl = fakeFetch([{ body: {} }]);
    await req({ fetchImpl, method: 'post', body: { a: 1 } });
    await req({ fetchImpl, method: 'POST', body: 'raw text' });
    const form = new URLSearchParams({ search: 'x' });
    await req({ fetchImpl, method: 'POST', body: form });
    assert.equal(fetchImpl.calls[0].init.method, 'POST');
    assert.equal(fetchImpl.calls[0].init.body, '{"a":1}');
    assert.equal(fetchImpl.calls[0].init.headers['content-type'], 'application/json');
    assert.equal(fetchImpl.calls[1].init.body, 'raw text');
    assert.equal(fetchImpl.calls[1].init.headers['content-type'], undefined);
    assert.equal(fetchImpl.calls[2].init.body, form);
  });

  test('an empty body is null; text is returned as text; JSON-looking text without a JSON content type is parsed', async () => {
    assert.equal((await req({ fetchImpl: fakeFetch([{ status: 204 }]) })).body, null);
    assert.equal((await req({ fetchImpl: fakeFetch([{ body: 'plain words' }]) })).body, 'plain words');
    assert.deepEqual((await req({ fetchImpl: fakeFetch([{ body: '{"a":1}\n', headers: { 'content-type': 'text/plain' } }]) })).body, { a: 1 });
    assert.equal((await req({ fetchImpl: fakeFetch([{ body: '{broken', headers: { 'content-type': 'application/json' } }]) })).body, '{broken');
  });

  test('waits on the rate limiter before every attempt', async () => {
    let waits = 0;
    const fetchImpl = fakeFetch([{ status: 503 }, { body: {} }]);
    await req({ fetchImpl, rateLimiter: async () => { waits += 1; } });
    assert.equal(waits, 2);
  });
});

describe('httpRequest: retries', () => {
  test('retries on 503 with injected fetchImpl then succeeds', async () => {
    const fetchImpl = fakeFetch([{ status: 503, body: { error: 'busy' } }, { status: 503 }, { body: { ok: true } }]);
    const response = await req({ fetchImpl });
    assert.deepEqual(response.body, { ok: true });
    assert.equal(fetchImpl.calls.length, 3);
  });

  test('gives up after the retry budget and reports the last status', async () => {
    const fetchImpl = fakeFetch([{ status: 503 }]);
    const error = await expectCode(() => req({ fetchImpl }), 'UPSTREAM_ERROR', /HTTP 503/);
    assert.equal(fetchImpl.calls.length, 3, 'one attempt plus two retries by default');
    assert.equal(error.retryable, true);
    assert.equal(error.details.status, 503);
    const once = fakeFetch([{ status: 502 }]);
    await expectCode(() => req({ fetchImpl: once, retries: 0 }), 'UPSTREAM_ERROR');
    assert.equal(once.calls.length, 1);
  });

  test('no retry for POST by default', async () => {
    const fetchImpl = fakeFetch([{ status: 503 }, { body: {} }]);
    await expectCode(() => req({ fetchImpl, method: 'POST', body: { a: 1 } }), 'UPSTREAM_ERROR');
    assert.equal(fetchImpl.calls.length, 1);
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const impl = fakeFetch([{ status: 503 }, { body: {} }]);
      await expectCode(() => req({ fetchImpl: impl, method }), 'UPSTREAM_ERROR');
      assert.equal(impl.calls.length, 1, method);
    }
  });

  test('POST is retried only when the caller opts in with retryNonIdempotent', async () => {
    const fetchImpl = fakeFetch([{ status: 503 }, { body: { created: true } }]);
    const response = await req({ fetchImpl, method: 'POST', body: {}, retryNonIdempotent: true });
    assert.deepEqual(response.body, { created: true });
    assert.equal(fetchImpl.calls.length, 2);
  });

  test('a network failure is retried for GET and surfaces as NETWORK without leaking internals', async () => {
    const boom = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const recovering = fakeFetch([{ throws: boom }, { body: { ok: true } }]);
    assert.deepEqual((await req({ fetchImpl: recovering })).body, { ok: true });
    const dead = fakeFetch([{ throws: boom }]);
    const error = await expectCode(() => req({ fetchImpl: dead, retries: 1 }), 'NETWORK', /ECONNREFUSED/);
    assert.equal(dead.calls.length, 2);
    assert.equal(error.retryable, true);
    const post = fakeFetch([{ throws: boom }]);
    await expectCode(() => req({ fetchImpl: post, method: 'POST' }), 'NETWORK');
    assert.equal(post.calls.length, 1);
  });

  test('honours a numeric Retry-After', async () => {
    const fetchImpl = fakeFetch([{ status: 429, headers: { 'retry-after': '0.05' } }, { body: {} }]);
    const started = Date.now();
    await req({ fetchImpl });
    assert.ok(Date.now() - started >= 40, 'waited roughly the advertised time');
    assert.equal(fetchImpl.calls.length, 2);
  });

  test('client errors are not retried', async () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      const fetchImpl = fakeFetch([{ status }, { body: {} }]);
      await assert.rejects(req({ fetchImpl }));
      assert.equal(fetchImpl.calls.length, 1, `HTTP ${status}`);
    }
  });

  test('HTTP 500 is not in the retryable set, so it is not retried', async () => {
    const fetchImpl = fakeFetch([{ status: 500 }, { body: {} }]);
    await expectCode(() => req({ fetchImpl }), 'UPSTREAM_ERROR');
    assert.equal(fetchImpl.calls.length, 1);
  });
});

describe('httpRequest: status mapping', () => {
  test('401 -> AUTH_FAILED, 403 -> ACCESS_DENIED, 404 -> NOT_FOUND, 409 -> CONFLICT, 429 -> RATE_LIMITED', async () => {
    const expected = { 401: 'AUTH_FAILED', 403: 'ACCESS_DENIED', 404: 'NOT_FOUND', 409: 'CONFLICT', 429: 'RATE_LIMITED', 400: 'UPSTREAM_ERROR', 500: 'UPSTREAM_ERROR' };
    for (const [status, code] of Object.entries(expected)) {
      const error = await expectCode(() => req({ fetchImpl: fakeFetch([{ status: Number(status), body: { error: 'x' } }]), retries: 0 }), code);
      assert.match(error.message, /Example/);
      assert.equal(error.details.service, 'Example');
    }
    assert.equal((await expectCode(() => req({ fetchImpl: fakeFetch([{ status: 429 }]), retries: 0 }), 'RATE_LIMITED')).retryable, true);
    assert.equal((await expectCode(() => req({ fetchImpl: fakeFetch([{ status: 400 }]), retries: 0 }), 'UPSTREAM_ERROR')).retryable, false);
  });

  test('redirect -> AUTH_REQUIRED, and the redirect target is never requested', async () => {
    for (const status of [301, 302, 303, 307]) {
      const fetchImpl = fakeFetch([{ status, headers: { location: 'https://login.example.com/sso' } }, { body: { secret: 'data' } }]);
      const error = await expectCode(() => req({ fetchImpl }), 'AUTH_REQUIRED', /sign-in/);
      assert.equal(fetchImpl.calls.length, 1);
      assert.equal(error.retryable, false);
    }
  });

  test('HTML login page -> AUTH_REQUIRED instead of being parsed as data', async () => {
    for (const html of [
      '<html><body><form action="/login" method="post"><input name="user"></form></body></html>',
      '<html><form id="signin-form"></form></html>',
      '<html><form method="post" action="https://idp.example.com/saml/sso"></form></html>',
      '<input type="hidden" name="SAMLRequest" value="abc">',
    ]) {
      const fetchImpl = fakeFetch([{ status: 200, body: html, headers: { 'content-type': 'text/html; charset=utf-8' } }]);
      await expectCode(() => req({ fetchImpl }), 'AUTH_REQUIRED', /sign-in page/);
      assert.equal(fetchImpl.calls.length, 1);
    }
  });

  test('an ordinary HTML document is returned as text, not treated as a login page', async () => {
    const fetchImpl = fakeFetch([{ body: '<html><p>report</p></html>', headers: { 'content-type': 'text/html' } }]);
    assert.equal((await req({ fetchImpl })).body, '<html><p>report</p></html>');
  });

  test('error details carry at most a 300 character body snippet', async () => {
    const error = await expectCode(() => req({ fetchImpl: fakeFetch([{ status: 400, body: 'x'.repeat(5_000) }]) }), 'UPSTREAM_ERROR');
    assert.equal(error.details.body.length, 300);
  });

  test('timeout -> TIMEOUT, retryable', async () => {
    const fetchImpl = fakeFetch([{ delayMs: 2_000, body: {} }]);
    const started = Date.now();
    const error = await expectCode(() => req({ fetchImpl, timeoutMs: 40, retries: 0 }), 'TIMEOUT', /40 ms/);
    assert.ok(Date.now() - started < 1_500);
    assert.equal(error.retryable, true);
  });
});

describe('httpRequest against a real loopback server', () => {
  /** @type {http.Server} */
  let server;
  let baseUrl = '';
  let hits = 0;
  before(async () => {
    server = http.createServer((request, response) => {
      hits += 1;
      if (request.url === '/slow') return void setTimeout(() => response.end('{}'), 1_000);
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/data' });
        return void response.end();
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ path: request.url, method: request.method }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    baseUrl = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  test('plain http works on 127.0.0.1 with the real fetch', async () => {
    const response = await httpRequest({ url: `${baseUrl}/data`, allowedHosts: ['127.0.0.1'] });
    assert.deepEqual(response.body, { path: '/data', method: 'GET' });
  });

  test('a real redirect is reported, not followed', async () => {
    hits = 0;
    await expectCode(() => httpRequest({ url: `${baseUrl}/redirect`, allowedHosts: ['127.0.0.1'] }), 'AUTH_REQUIRED');
    assert.equal(hits, 1);
  });

  test('a real slow response times out', async () => {
    await expectCode(() => httpRequest({ url: `${baseUrl}/slow`, allowedHosts: ['127.0.0.1'], timeoutMs: 50, retries: 0 }), 'TIMEOUT');
  });

  test('a refused connection is NETWORK', async () => {
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', () => resolve(undefined)));
    const port = /** @type {any} */ (closed.address()).port;
    await new Promise((resolve) => closed.close(() => resolve(undefined)));
    await expectCode(() => httpRequest({ url: `http://127.0.0.1:${port}/x`, allowedHosts: ['127.0.0.1'], retries: 0 }), 'NETWORK');
  });
});

describe('createRateLimiter', () => {
  test('spaces calls at least the interval apart; the first is immediate', async () => {
    const limiter = createRateLimiter(30);
    const started = Date.now();
    await limiter();
    const first = Date.now() - started;
    await limiter();
    await limiter();
    const total = Date.now() - started;
    assert.ok(first < 25, `first call waited ${first} ms`);
    assert.ok(total >= 55, `three calls took ${total} ms`);
  });

  test('a zero interval never waits', async () => {
    const limiter = createRateLimiter(0);
    const started = Date.now();
    for (let i = 0; i < 20; i += 1) await limiter();
    assert.ok(Date.now() - started < 50);
  });
});
