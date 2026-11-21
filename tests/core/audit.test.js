import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { appendAudit, readAudit, verifyAudit } from '../../src/core/audit.js';
import { expectCode, setEnv, tempWorkspace } from '../helpers.js';

/** @type {ReturnType<typeof tempWorkspace>} */
let ws;
/** @type {() => void} */
let restoreEnv;
beforeEach(() => {
  ws = tempWorkspace();
  restoreEnv = setEnv({ AUTODEV_ACTOR: undefined });
});
afterEach(() => {
  restoreEnv();
  ws.cleanup();
});

const file = (/** @type {string} */ projectId = 'orders') => path.join(ws.workspace.stateDir, 'audit', projectId, 'audit.jsonl');
const lines = () => fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean);
const writeLines = (/** @type {string[]} */ next) => fs.writeFileSync(file(), `${next.join('\n')}\n`);

async function seed(count = 4) {
  for (let i = 1; i <= count; i += 1) {
    await appendAudit(ws.workspace, 'orders', { action: `step.${i}`, outcome: 'success', details: { n: i } });
  }
}

describe('audit log', () => {
  test('an empty log verifies and reads as empty', () => {
    assert.deepEqual(verifyAudit(ws.workspace, 'orders'), { valid: true, entries: 0, brokenAtSeq: null });
    assert.deepEqual(readAudit(ws.workspace, 'orders'), []);
  });

  test('appends form a hash chain: seq increments and prevHash is the previous hash', async () => {
    const first = /** @type {any} */ (await appendAudit(ws.workspace, 'orders', { action: 'a.one' }));
    const second = /** @type {any} */ (await appendAudit(ws.workspace, 'orders', { action: 'a.two', actor: 'jane', outcome: 'denied', details: { x: 1 } }));
    assert.equal(first.seq, 1);
    assert.equal(first.prevHash, '0'.repeat(64));
    assert.match(first.hash, /^[0-9a-f]{64}$/);
    assert.equal(first.actor, 'autodev');
    assert.equal(first.outcome, 'info');
    assert.equal(second.seq, 2);
    assert.equal(second.prevHash, first.hash);
    assert.equal(second.actor, 'jane');
    assert.deepEqual(readAudit(ws.workspace, 'orders').map((entry) => entry.action), ['a.one', 'a.two']);
    assert.deepEqual(verifyAudit(ws.workspace, 'orders'), { valid: true, entries: 2, brokenAtSeq: null });
  });

  test('the file is one JSON object per line', async () => {
    await seed(3);
    const raw = lines();
    assert.equal(raw.length, 3);
    for (const line of raw) assert.equal(typeof JSON.parse(line).hash, 'string');
  });

  test('concurrent appends keep one unbroken chain', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => appendAudit(ws.workspace, 'orders', { action: `parallel.${i}` })));
    const entries = readAudit(ws.workspace, 'orders');
    assert.deepEqual(entries.map((entry) => entry.seq), Array.from({ length: 12 }, (_, i) => i + 1));
    assert.equal(verifyAudit(ws.workspace, 'orders').valid, true);
  });

  test('verifyAudit detects an edited line', async () => {
    await seed();
    const raw = lines();
    const edited = JSON.parse(raw[1]);
    edited.outcome = 'failure';
    raw[1] = JSON.stringify(edited);
    writeLines(raw);
    assert.deepEqual(verifyAudit(ws.workspace, 'orders'), { valid: false, entries: 4, brokenAtSeq: 2 });
  });

  test('verifyAudit detects an edited line even when its hash was recomputed', async () => {
    await seed();
    const { hashOf } = await import('../../src/core/hash.js');
    const raw = lines();
    const { hash: _old, ...body } = JSON.parse(raw[1]);
    body.details = { n: 999 };
    raw[1] = JSON.stringify({ ...body, hash: hashOf(body) });
    writeLines(raw);
    const result = verifyAudit(ws.workspace, 'orders');
    assert.equal(result.valid, false);
    assert.equal(result.brokenAtSeq, 3, 'the next entry no longer chains to it');
  });

  test('verifyAudit detects a deleted line', async () => {
    await seed();
    const raw = lines();
    raw.splice(1, 1);
    writeLines(raw);
    const result = verifyAudit(ws.workspace, 'orders');
    assert.equal(result.valid, false);
    assert.equal(result.brokenAtSeq, 3);
  });

  test('verifyAudit detects a deleted first line, reordered lines and an inserted line', async () => {
    await seed();
    const original = lines();
    writeLines(original.slice(1));
    assert.equal(verifyAudit(ws.workspace, 'orders').valid, false);
    writeLines([original[0], original[2], original[1], original[3]]);
    assert.equal(verifyAudit(ws.workspace, 'orders').valid, false);
    writeLines([original[0], original[1], original[1], original[2], original[3]]);
    assert.equal(verifyAudit(ws.workspace, 'orders').valid, false);
    writeLines(original);
    assert.equal(verifyAudit(ws.workspace, 'orders').valid, true);
  });

  test('verifyAudit detects deletion of the most recent line(s)', async () => {
    await seed();
    writeLines(lines().slice(0, 2));
    assert.equal(verifyAudit(ws.workspace, 'orders').valid, false);
  });

  test('a line corrupted into invalid JSON is reported as an invalid chain, not a crash', async () => {
    await seed(2);
    fs.appendFileSync(file(), '{"seq":3,"ts":"2026-01-01T00:00');
    const result = verifyAudit(ws.workspace, 'orders');
    assert.equal(result.valid, false);
  });

  test('secrets in details are redacted before they are written', async () => {
    await appendAudit(ws.workspace, 'orders', { action: 'x', details: { token: 'abc', note: 'Authorization: Bearer abcdefgh12345678', url: 'https://u:pw123456@host/x' } });
    const text = fs.readFileSync(file(), 'utf8');
    assert.ok(!text.includes('abcdefgh12345678'));
    assert.ok(!text.includes('pw123456'));
    assert.equal(readAudit(ws.workspace, 'orders')[0].details.token, '[REDACTED:field]');
    assert.equal(verifyAudit(ws.workspace, 'orders').valid, true, 'the hash covers the redacted form');
  });

  test('details that do not survive JSON unchanged (dates, undefined) still verify', async () => {
    await appendAudit(ws.workspace, 'orders', { action: 'x', details: { at: new Date(0), gone: undefined, list: [undefined, 1], nan: Number.NaN } });
    assert.equal(verifyAudit(ws.workspace, 'orders').valid, true);
  });

  test('actor defaults to AUTODEV_ACTOR when set', async () => {
    const restore = setEnv({ AUTODEV_ACTOR: 'launcher-user' });
    try {
      const entry = /** @type {any} */ (await appendAudit(ws.workspace, 'orders', { action: 'x' }));
      assert.equal(entry.actor, 'launcher-user');
    } finally {
      restore();
    }
  });

  test('readAudit filters by action prefix and limit', async () => {
    await seed(3);
    await appendAudit(ws.workspace, 'orders', { action: 'approval.requested' });
    await appendAudit(ws.workspace, 'orders', { action: 'approval.approved' });
    assert.equal(readAudit(ws.workspace, 'orders', { action: 'approval.' }).length, 2);
    assert.deepEqual(readAudit(ws.workspace, 'orders', { limit: 2 }).map((entry) => entry.seq), [4, 5]);
  });

  test('each project has its own log', async () => {
    await seed(2);
    await appendAudit(ws.workspace, 'billing', { action: 'other' });
    assert.equal(readAudit(ws.workspace, 'orders').length, 2);
    assert.equal(readAudit(ws.workspace, 'billing').length, 1);
    assert.equal(/** @type {any} */ (readAudit(ws.workspace, 'billing')[0]).seq, 1);
    assert.ok(fs.existsSync(file('billing')));
  });

  test('a hostile project id cannot direct the log outside the state folder', async () => {
    await expectCode(() => appendAudit(ws.workspace, '../../escape', { action: 'x' }), 'INVALID_ARGUMENT');
    await expectCode(() => verifyAudit(ws.workspace, '..'), 'INVALID_ARGUMENT');
  });
});
