import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { AutoDevError, ErrorCodes, exitCodeFor, requireArg, toAutoDevError } from '../../src/core/errors.js';
import { hashOf, sha256, stableStringify } from '../../src/core/hash.js';
import { createLogger, nullLogger } from '../../src/core/logger.js';
import { clearRegisteredSecrets, registerSecret } from '../../src/core/redact.js';
import { fail, ok } from '../../src/core/result.js';

afterEach(() => clearRegisteredSecrets());

describe('errors', () => {
  test('AutoDevError carries code, retryable and details', () => {
    const error = new AutoDevError(ErrorCodes.NOT_FOUND, 'nope', { details: { a: 1 } });
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'AutoDevError');
    assert.equal(error.code, 'NOT_FOUND');
    assert.equal(error.retryable, false);
    assert.deepEqual(error.details, { a: 1 });
  });

  test('transient codes are retryable by default and can be overridden', () => {
    for (const code of ['RATE_LIMITED', 'TIMEOUT', 'NETWORK', 'LOCKED']) assert.equal(new AutoDevError(code, 'x').retryable, true, code);
    assert.equal(new AutoDevError('TIMEOUT', 'x', { retryable: false }).retryable, false);
    assert.equal(new AutoDevError('UPSTREAM_ERROR', 'x', { retryable: true }).retryable, true);
  });

  test('unknown errors become INTERNAL and keep only their message', () => {
    const converted = toAutoDevError(new TypeError('boom'));
    assert.equal(converted.code, 'INTERNAL');
    assert.equal(converted.message, 'boom');
    assert.equal(converted.retryable, false);
    assert.equal(toAutoDevError('plain string').message, 'plain string');
    assert.equal(toAutoDevError(undefined).code, 'INTERNAL');
    assert.equal(toAutoDevError({ code: 'NOT_FOUND', message: 'look-alike' }).code, 'INTERNAL');
  });

  test('an AutoDevError passes through toAutoDevError unchanged', () => {
    const error = new AutoDevError('CONFLICT', 'x');
    assert.equal(toAutoDevError(error), error);
  });

  test('exit code mapping: 2 usage, 3 human needed, 4 refused, 5 upstream, 1 otherwise', () => {
    const expected = {
      INVALID_ARGUMENT: 2, CONFIG_INVALID: 2, NOT_CONFIGURED: 2, UNSUPPORTED: 2, PROJECT_NOT_FOUND: 2, PROJECT_AMBIGUOUS: 2,
      APPROVAL_REQUIRED: 3, AUTH_REQUIRED: 3,
      PROJECT_SCOPE_VIOLATION: 4, POLICY_PROHIBITED: 4, APPROVAL_DENIED: 4, APPROVAL_MISMATCH: 4, HOST_NOT_ALLOWED: 4,
      TLS_POLICY_VIOLATION: 4, SQL_REJECTED: 4, QUERY_REJECTED: 4, REPO_URL_NOT_APPROVED: 4, DIRTY_WORKTREE: 4,
      BRANCH_MISSING: 4, GATE_FAILED: 4, INTEGRITY_VIOLATION: 4,
      RATE_LIMITED: 5, TIMEOUT: 5, NETWORK: 5, UPSTREAM_ERROR: 5, AUTH_FAILED: 5, ACCESS_DENIED: 5, NOT_FOUND: 5, CONFLICT: 5, LOCKED: 5,
      INTERNAL: 1,
    };
    for (const [code, exit] of Object.entries(expected)) assert.equal(exitCodeFor(code), exit, code);
    assert.equal(exitCodeFor('SOMETHING_NEW'), 1);
  });

  test('a code that collides with an Object.prototype member still maps to a number', () => {
    assert.equal(exitCodeFor('toString'), 1);
    assert.equal(exitCodeFor('constructor'), 1);
  });

  test('every declared error code has an exit code that is never 0', () => {
    for (const code of Object.values(ErrorCodes)) {
      const exit = exitCodeFor(code);
      assert.ok(Number.isInteger(exit) && exit >= 1 && exit <= 5, `${code} -> ${exit}`);
    }
  });

  test('requireArg throws INVALID_ARGUMENT only for falsy conditions', () => {
    assert.doesNotThrow(() => requireArg('x', 'needed'));
    assert.throws(() => requireArg('', 'needed'), (/** @type {any} */ e) => e.code === 'INVALID_ARGUMENT' && e.message === 'needed');
  });
});

describe('result envelope', () => {
  test('ok() has ok, data and meta.timestamp, with caller meta merged', () => {
    const result = ok({ a: 1 }, { command: 'x y', projectId: 'p' });
    assert.deepEqual(Object.keys(result).sort(), ['data', 'meta', 'ok']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { a: 1 });
    assert.equal(result.meta.command, 'x y');
    assert.ok(!Number.isNaN(Date.parse(String(result.meta.timestamp))));
  });

  test('fail() has ok:false and error { code, message, retryable, details }', () => {
    const result = fail(new AutoDevError('LOCKED', 'busy', { details: { lockFile: 'x' } }), { command: 'c' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.error, { code: 'LOCKED', message: 'busy', retryable: true, details: { lockFile: 'x' } });
    assert.equal(result.meta.command, 'c');
    assert.ok(!('data' in result));
  });

  test('fail() turns an unknown error into INTERNAL without a stack', () => {
    const result = fail(new RangeError('bad'));
    assert.equal(result.error.code, 'INTERNAL');
    assert.equal(result.error.message, 'bad');
    assert.ok(!JSON.stringify(result).includes('at '), 'no stack frames in the envelope');
  });

  test('ok() data is redacted', () => {
    registerSecret('zq9-opaque-value', 'T');
    const result = /** @type {any} */ (ok({ password: 'p', log: 'Authorization: Bearer abcdefgh12345678', echo: 'zq9-opaque-value' }));
    assert.equal(result.data.password, '[REDACTED:field]');
    assert.equal(result.data.log, 'Authorization: [REDACTED:authorization]');
    assert.equal(result.data.echo, '[REDACTED:T]');
  });

  test('fail() message and details are redacted', () => {
    const result = fail(new AutoDevError('UPSTREAM_ERROR', 'server said password=hunter2', { details: { body: 'Bearer abcdefgh12345678', token: 't' } }));
    const text = JSON.stringify(result);
    assert.ok(!text.includes('hunter2'));
    assert.ok(!text.includes('abcdefgh12345678'));
    assert.equal(result.error.details.token, '[REDACTED:field]');
  });

  test('the envelope survives JSON serialisation', () => {
    assert.doesNotThrow(() => JSON.stringify(ok({ when: new Date(), nothing: undefined })));
    /** @type {any} */
    const cyclic = {};
    cyclic.self = cyclic;
    assert.doesNotThrow(() => JSON.stringify(ok(cyclic)));
  });
});

describe('hash', () => {
  test('stableStringify sorts keys at every level and drops undefined', () => {
    assert.equal(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
    assert.equal(stableStringify(null), 'null');
    assert.equal(stableStringify(undefined), 'null');
    assert.equal(stableStringify('x'), '"x"');
  });

  test('hashOf is independent of key order and sensitive to values and array order', () => {
    assert.equal(hashOf({ a: 1, b: [1, 2] }), hashOf({ b: [1, 2], a: 1 }));
    assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }));
    assert.notEqual(hashOf([1, 2]), hashOf([2, 1]));
    assert.notEqual(hashOf({ a: '1' }), hashOf({ a: 1 }));
    assert.match(hashOf({}), /^[0-9a-f]{64}$/);
    assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('a key cannot be forged from a value (no delimiter injection)', () => {
    assert.notEqual(hashOf({ a: 'x","b":"y' }), hashOf({ a: 'x', b: 'y' }));
  });

  test('two different Date values hash differently', () => {
    assert.notEqual(hashOf({ at: new Date(0) }), hashOf({ at: new Date(1_000_000_000_000) }));
  });
});

describe('logger', () => {
  test('writes one redacted JSON line per entry and honours the level', () => {
    /** @type {string[]} */
    const lines = [];
    const logger = createLogger({ level: 'info', sink: (line) => lines.push(line), bindings: { projectId: 'p' } });
    logger.debug('hidden');
    logger.info('hello', { password: 'x', note: 'Bearer abcdefgh12345678' });
    logger.child({ run: 1 }).error('bad');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.level, 'info');
    assert.equal(first.msg, 'hello');
    assert.equal(first.projectId, 'p');
    assert.equal(first.password, '[REDACTED:field]');
    assert.ok(!lines[0].includes('abcdefgh12345678'));
    assert.equal(JSON.parse(lines[1]).run, 1);
  });

  test('nullLogger discards everything', () => {
    assert.doesNotThrow(() => nullLogger.error('x', { a: 1 }));
  });
});
