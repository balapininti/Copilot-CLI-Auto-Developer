import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  clearRegisteredSecrets,
  containsSecret,
  redact,
  redactString,
  registerSecret,
} from '../../src/core/redact.js';

afterEach(() => clearRegisteredSecrets());

describe('redactString: secret shapes', () => {
  test('masks a bearer token', () => {
    const out = redactString('sent Bearer abcdefgh12345678 to host');
    assert.ok(!out.includes('abcdefgh12345678'));
    assert.match(out, /\[REDACTED:bearer\]/);
  });

  test('masks an Api-Token value', () => {
    assert.ok(!redactString('Api-Token dt0c01.ABCDEFGH.ABCDEFGHIJKLMNOP').includes('ABCDEFGHIJKLMNOP'));
  });

  test('masks a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = redactString(`jwt=${jwt}`);
    assert.ok(!out.includes('dozjgNryP4J3'));
    assert.ok(!redactString(`value ${jwt} end`).includes(jwt));
  });

  test('masks Authorization and Proxy-Authorization headers with any scheme', () => {
    for (const line of [
      'Authorization: Bearer abcdefgh12345678',
      'authorization: Basic dXNlcjpwYXNz',
      'Proxy-Authorization: Basic dXNlcjpwYXNz',
      '"Authorization":"Splunk 12345678-aaaa"',
      'Authorization=Api-Token short',
    ]) {
      const out = redactString(line);
      assert.match(out, /\[REDACTED:authorization\]/, line);
      assert.ok(!/dXNlcjpwYXNz|abcdefgh12345678|12345678-aaaa|short/.test(out), `${line} -> ${out}`);
    }
  });

  test('masks password=... and similar assignments, keeping the key', () => {
    assert.equal(redactString('password=hunter2'), 'password=[REDACTED:assignment]');
    assert.equal(redactString('pwd:hunter2'), 'pwd:[REDACTED:assignment]');
    assert.equal(redactString('"password": "hunter2"'), '"password": [REDACTED:assignment]');
    assert.ok(!redactString('jdbc:db2://h:50000/DB:user=bob;password=s3cretXYZ;').includes('s3cretXYZ'));
    assert.ok(!redactString('X-Api-Key: abcdefghijk').includes('abcdefghijk'));
    assert.ok(!redactString('client_secret=zzzzzzzz').includes('zzzzzzzz'));
    assert.ok(!redactString('Cookie: JSESSIONID=abc123').includes('abc123'));
  });

  test('masks credentials embedded in a URL but keeps scheme and host', () => {
    assert.equal(
      redactString('clone https://user:p%40ss@bitbucket.example.internal/scm/a/b.git'),
      'clone https://[REDACTED:url_credentials]@bitbucket.example.internal/scm/a/b.git',
    );
  });

  test('masks a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nabc\n-----END RSA PRIVATE KEY-----';
    const out = redactString(`before\n${pem}\nafter`);
    assert.equal(out, 'before\n[REDACTED:private_key]\nafter');
  });

  test('masks GitHub, Dynatrace and AWS key shapes', () => {
    assert.ok(!redactString('ghp_abcdefghijklmnopqrstuvwxyz0123').includes('abcdefghijklmnop'));
    assert.match(redactString('key AKIAABCDEFGHIJKLMNOP'), /\[REDACTED:aws_key\]/);
    assert.match(redactString('dt0c01.ABCDEFGH12.ABCDEFGHIJKLMNOPQRST'), /\[REDACTED:dynatrace_token\]/);
  });

  test('leaves ordinary text, ids and timestamps alone', () => {
    for (const text of [
      'java.lang.NullPointerException at PricingService.java:87',
      'trace 4bf92f3577b34da6a3ce929d0e0e4736',
      'https://bitbucket.example.internal/projects/ORD/repos/service-api',
      '2026-01-15T12:00:00.000Z order 88213',
      'tokenSecret: AGILITY_TOKEN',
      'baseUrlEnv: AGILITY_URL',
    ]) {
      assert.equal(redactString(text), text);
    }
  });

  test('non-string and empty input is returned unchanged', () => {
    assert.equal(redactString(''), '');
    assert.equal(redactString(/** @type {any} */ (null)), null);
    assert.equal(redactString(/** @type {any} */ (42)), 42);
  });

  test('is stable across repeated calls (no regex lastIndex state)', () => {
    const line = 'password=hunter2 and Bearer abcdefgh12345678';
    const first = redactString(line);
    for (let i = 0; i < 5; i += 1) assert.equal(redactString(line), first);
    assert.equal(redactString(first), first, 'redacting twice changes nothing');
  });

  test('masks an environment-style assignment such as DB_PASSWORD=... or SPLUNK_TOKEN=...', () => {
    assert.ok(!redactString('DB_PASSWORD=hunter2hunter2').includes('hunter2hunter2'));
    assert.ok(!redactString('SPLUNK_TOKEN=abcdefghijklmnop').includes('abcdefghijklmnop'));
    assert.ok(!redactString('dbPassword=hunter2hunter2').includes('hunter2hunter2'));
    assert.ok(!redactString('{"access_token":"abcdefghijkl"}').includes('abcdefghijkl'));
  });

  test('masks a quoted password that contains whitespace', () => {
    assert.ok(!redactString('password="my secret pass"').includes('my secret pass'));
    assert.ok(!redactString("password: 'two words'").includes('two words'));
  });

  test('masks the whole value of an assignment containing , ; or &', () => {
    assert.ok(!redactString('password=abc,def').includes('def'));
  });

  test('masks a token used as the user part of a URL (https://<token>@host)', () => {
    assert.ok(!redactString('https://x7Yt0kenValue1234567@bitbucket.example.internal/scm/a/b.git').includes('x7Yt0kenValue1234567'));
  });

  test('an empty assignment does not swallow the next line', () => {
    assert.equal(redactString('PASSWORD=\nnext line'), 'PASSWORD=\nnext line');
  });
});

describe('redactString: registered secrets', () => {
  test('masks an exact registered value wherever it appears, labelled', () => {
    registerSecret('zq9-opaque-value', 'AGILITY_TOKEN');
    assert.equal(redactString('got zq9-opaque-value twice zq9-opaque-value'), 'got [REDACTED:AGILITY_TOKEN] twice [REDACTED:AGILITY_TOKEN]');
  });

  test('a secret containing another is masked whole (longest first)', () => {
    registerSecret('abcdef', 'SHORT');
    registerSecret('abcdef-and-more', 'LONG');
    assert.equal(redactString('x abcdef-and-more y'), 'x [REDACTED:LONG] y');
  });

  test('ignores values too short to be secrets and non-strings', () => {
    registerSecret('abc', 'TINY');
    registerSecret(/** @type {any} */ (null));
    registerSecret(/** @type {any} */ (123456789));
    assert.equal(redactString('abc 123456789'), 'abc 123456789');
  });

  test('a registered secret with regex metacharacters is matched literally', () => {
    registerSecret('a.b*c+(d)[e]$', 'META');
    assert.equal(redactString('v=a.b*c+(d)[e]$;'), 'v=[REDACTED:META];');
    assert.equal(redactString('v=aXb*c+(d)[e]$;'), 'v=aXb*c+(d)[e]$;');
  });

  test('clearRegisteredSecrets forgets them', () => {
    registerSecret('zq9-opaque-value');
    clearRegisteredSecrets();
    assert.equal(redactString('zq9-opaque-value'), 'zq9-opaque-value');
  });
});

describe('redact: objects', () => {
  test('masks values under sensitive keys whole, at any depth', () => {
    const out = redact({
      password: 'x',
      nested: { Authorization: 'anything', list: [{ token: 't', apiKey: 'k', api_key: 'k', cookie: 'c' }] },
      connectionString: 'DATABASE=X',
      session_id: 's',
      privateKey: 'p',
    });
    assert.equal(out.password, '[REDACTED:field]');
    assert.equal(out.nested.Authorization, '[REDACTED:field]');
    assert.deepEqual(out.nested.list[0], { token: '[REDACTED:field]', apiKey: '[REDACTED:field]', api_key: '[REDACTED:field]', cookie: '[REDACTED:field]' });
    assert.equal(out.connectionString, '[REDACTED:field]');
    assert.equal(out.session_id, '[REDACTED:field]');
    assert.equal(out.privateKey, '[REDACTED:field]');
  });

  test('keeps reference-only keys such as tokenSecret and baseUrlEnv', () => {
    const input = { tokenSecret: 'AGILITY_TOKEN', baseUrlEnv: 'AGILITY_URL', splunkTokenSecret: 'SPLUNK_TOKEN', connectionProfile: 'nonprod', payloadHash: 'abc' };
    assert.deepEqual(redact(input), input);
  });

  test('null, undefined and booleans under sensitive keys are kept', () => {
    assert.deepEqual(redact({ password: null, token: undefined, secret: false }), { password: null, token: undefined, secret: false });
  });

  test('pattern-scans every string value, including array members', () => {
    const out = redact({ log: ['ok', 'Authorization: Bearer abcdefgh12345678'], note: 'password=hunter2' });
    assert.equal(out.log[1], 'Authorization: [REDACTED:authorization]');
    assert.equal(out.note, 'password=[REDACTED:assignment]');
  });

  test('does not mutate its input and survives cycles', () => {
    /** @type {any} */
    const input = { password: 'x', child: { note: 'password=hunter2' } };
    input.child.self = input;
    const out = redact(input);
    assert.equal(input.password, 'x');
    assert.equal(input.child.note, 'password=hunter2');
    assert.equal(out.child.self, '[Circular]');
  });

  test('converts Dates to ISO strings and Errors to name + redacted message', () => {
    const out = /** @type {any} */ (redact({ at: new Date(0), err: new Error('failed with password=hunter2') }));
    assert.equal(out.at, '1970-01-01T00:00:00.000Z');
    assert.deepEqual(out.err, { name: 'Error', message: 'failed with password=[REDACTED:assignment]' });
  });

  test('extraSensitiveKeys are masked case-insensitively', () => {
    assert.deepEqual(redact({ CustomerRef: 'c-1', other: 'o' }, { extraSensitiveKeys: ['customerref'] }), { CustomerRef: '[REDACTED:field]', other: 'o' });
  });

  test('primitives pass through', () => {
    assert.equal(redact(5), 5);
    assert.equal(redact(null), null);
    assert.equal(redact(true), true);
  });

  test('masks a real secret stored under a camelCase key ending in Secret, e.g. clientSecret', () => {
    assert.equal(/** @type {any} */ (redact({ clientSecret: 'kJ8s-real-value' })).clientSecret, '[REDACTED:field]');
  });

  test('does not mask harmless keys that merely contain "pass", e.g. a numeric `passed` count', () => {
    assert.deepEqual(redact({ passed: 3 }), { passed: 3 });
  });
});

describe('redact: pii mode', () => {
  test('masks email, SSN, a Luhn-valid card number and phone numbers', () => {
    const out = redactString('jane.doe@example.com ssn 123-45-6789 card 4111 1111 1111 1111 call 555-123-4567 or +1 (555) 123-4567', { pii: true });
    assert.match(out, /^\[REDACTED:email\] ssn \[REDACTED:ssn\] card \[REDACTED:card_number\] ?call \[REDACTED:phone\] or \[REDACTED:phone\]$/);
    assert.ok(!/\d{3}/.test(out), out);
  });

  test('a digit run that fails the Luhn check is not treated as a card', () => {
    assert.equal(redactString('card 4111111111111112', { pii: true }), 'card 4111111111111112');
    assert.equal(redactString('epoch 1700000000000', { pii: true }), 'epoch 1700000000000');
  });

  test('trace ids, dates and stack frames are not mistaken for personal data', () => {
    const text = 'trace 4bf92f3577b34da6a3ce929d0e0e4736 at 2024-01-15 12:00 PricingService.java:87';
    assert.equal(redactString(text, { pii: true }), text);
  });

  test('non-pii mode leaves emails and phone numbers alone', () => {
    const text = 'jane.doe@example.com 555-123-4567 123-45-6789';
    assert.equal(redactString(text), text);
    assert.deepEqual(redact({ contact: text }), { contact: text });
  });

  test('pii mode applies through redact() to nested strings', () => {
    assert.deepEqual(redact({ a: ['mail jane.doe@example.com'] }, { pii: true }), { a: ['mail [REDACTED:email]'] });
  });
});

describe('containsSecret', () => {
  test('true for text with a secret shape or a registered secret', () => {
    assert.equal(containsSecret('password=hunter2'), true);
    assert.equal(containsSecret('Authorization: Bearer abcdefgh12345678'), true);
    registerSecret('zq9-opaque-value');
    assert.equal(containsSecret('x zq9-opaque-value'), true);
  });

  test('false for clean text, names of secrets, emails and non-strings', () => {
    assert.equal(containsSecret('tokenSecret: AGILITY_TOKEN\nbaseUrlEnv: AGILITY_URL'), false);
    assert.equal(containsSecret('contact jane.doe@example.com'), false);
    assert.equal(containsSecret(''), false);
    assert.equal(containsSecret(/** @type {any} */ (undefined)), false);
    assert.equal(containsSecret(/** @type {any} */ ({ password: 'x' })), false);
  });
});
