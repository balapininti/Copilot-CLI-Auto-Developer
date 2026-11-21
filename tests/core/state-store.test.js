import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  atomicWriteFile,
  atomicWriteJson,
  ensureDir,
  readJson,
  resolveInside,
  safeId,
  withLock,
} from '../../src/core/state-store.js';
import { projectDir, resolveWorkspace, stateDirFor } from '../../src/core/workspace.js';
import { expectCode, removeDir, tempDir } from '../helpers.js';

/** @type {string} */
let dir;
before(() => {
  dir = tempDir();
});
after(() => removeDir(dir));

describe('atomic writes', () => {
  test('atomicWriteJson writes pretty JSON, creating parent folders', () => {
    const file = path.join(dir, 'a', 'b', 'state.json');
    atomicWriteJson(file, { b: 1, a: [1, 2] });
    assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}\n');
  });

  test('atomic write replaces existing content and leaves no temp file behind', () => {
    const folder = path.join(dir, 'replace');
    const file = path.join(folder, 'state.json');
    atomicWriteJson(file, { version: 1 });
    atomicWriteJson(file, { version: 2 });
    atomicWriteFile(path.join(folder, 'note.txt'), 'hello');
    assert.deepEqual(readJson(file), { version: 2 });
    assert.deepEqual(fs.readdirSync(folder).sort(), ['note.txt', 'state.json']);
  });

  test('a failed write leaves the previous content and no temp file', () => {
    const folder = path.join(dir, 'failed');
    const file = path.join(folder, 'state.json');
    atomicWriteJson(file, { version: 1 });
    /** @type {any} */
    const cyclic = {};
    cyclic.self = cyclic;
    assert.throws(() => atomicWriteJson(file, cyclic));
    // Renaming a file over a directory fails: the temp file must be cleaned up.
    const asDir = path.join(folder, 'is-a-dir');
    fs.mkdirSync(asDir);
    fs.writeFileSync(path.join(asDir, 'keep'), 'x');
    assert.throws(() => atomicWriteFile(asDir, 'content'));
    assert.deepEqual(readJson(file), { version: 1 });
    assert.deepEqual(fs.readdirSync(folder).sort(), ['is-a-dir', 'state.json']);
  });

  test('state files are created private to the user (POSIX)', { skip: process.platform === 'win32' && 'POSIX modes only' }, () => {
    const file = path.join(dir, 'mode', 'state.json');
    atomicWriteJson(file, {});
    assert.equal(fs.statSync(file).mode & 0o077, 0);
  });
});

describe('readJson', () => {
  test('returns the fallback when the file does not exist', () => {
    assert.deepEqual(readJson(path.join(dir, 'missing.json'), { empty: true }), { empty: true });
    assert.equal(readJson(path.join(dir, 'missing.json')), undefined);
    assert.equal(readJson(path.join(dir, 'missing.json'), null), null);
  });

  test('a corrupt file is INTEGRITY_VIOLATION, not the fallback', async () => {
    const file = path.join(dir, 'corrupt.json');
    fs.writeFileSync(file, '{"half":');
    const error = await expectCode(() => readJson(file, {}), 'INTEGRITY_VIOLATION');
    assert.equal(error.details.file, file);
    fs.writeFileSync(file, '');
    await expectCode(() => readJson(file, {}), 'INTEGRITY_VIOLATION');
  });

  test('errors other than "not found" are not swallowed', () => {
    assert.throws(() => readJson(dir, {}), (/** @type {any} */ e) => typeof e.code === 'string' && e.code !== 'INTEGRITY_VIOLATION');
  });
});

describe('withLock', () => {
  test('gives mutual exclusion to concurrent callers and returns the value', async () => {
    const lock = path.join(dir, 'locks', 'mutex.lock');
    let inside = 0;
    let maxInside = 0;
    /** @type {number[]} */
    const order = [];
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        withLock(lock, async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await sleep(15);
          order.push(n);
          inside -= 1;
          return n * 2;
        }, { pollMs: 5 }),
      ),
    );
    assert.equal(maxInside, 1);
    assert.deepEqual(results, [2, 4, 6, 8, 10]);
    assert.equal(order.length, 5);
    assert.equal(fs.existsSync(lock), false, 'lock released');
  });

  test('releases the lock when the function throws', async () => {
    const lock = path.join(dir, 'locks', 'throws.lock');
    await assert.rejects(withLock(lock, () => { throw new Error('inner'); }), /inner/);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(await withLock(lock, () => 'again'), 'again');
  });

  test('fails with LOCKED (retryable) when the lock is held past the wait time', async () => {
    const lock = path.join(dir, 'locks', 'held.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ owner: 'someone-else', acquiredAt: new Date().toISOString() }));
    let ran = false;
    const started = Date.now();
    const error = await expectCode(() => withLock(lock, () => { ran = true; }, { waitMs: 60, pollMs: 10 }), 'LOCKED');
    assert.equal(error.retryable, true);
    assert.equal(ran, false);
    assert.ok(Date.now() - started >= 50, 'waited before giving up');
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).owner, 'someone-else', 'the other holder keeps its lock');
    fs.rmSync(lock);
  });

  test('takes over a stale lock left by a crashed process', async () => {
    const lock = path.join(dir, 'locks', 'stale.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ owner: 'dead:1' }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const value = await withLock(lock, () => JSON.parse(fs.readFileSync(lock, 'utf8')).owner, { staleMs: 1_000, waitMs: 0 });
    assert.notEqual(value, 'dead:1');
    assert.equal(fs.existsSync(lock), false);
  });

  test('a lock younger than staleMs is not taken over', async () => {
    const lock = path.join(dir, 'locks', 'young.lock');
    fs.writeFileSync(lock, JSON.stringify({ owner: 'alive:1' }));
    await expectCode(() => withLock(lock, () => 1, { staleMs: 60_000, waitMs: 0 }), 'LOCKED');
    fs.rmSync(lock);
  });

  test('does not remove a lock that another owner took over meanwhile', async () => {
    const lock = path.join(dir, 'locks', 'stolen.lock');
    await withLock(lock, () => {
      fs.writeFileSync(lock, JSON.stringify({ owner: 'thief:1' }));
    });
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).owner, 'thief:1');
    fs.rmSync(lock);
  });

  test('a lock file that vanished during the critical section is not an error', async () => {
    const lock = path.join(dir, 'locks', 'vanished.lock');
    assert.equal(await withLock(lock, () => { fs.rmSync(lock); return 7; }), 7);
  });
});

describe('resolveInside', () => {
  test('resolves paths under the root', () => {
    assert.equal(resolveInside(dir, path.join('a', 'b.txt')), path.join(dir, 'a', 'b.txt'));
    assert.equal(resolveInside(dir, 'a/../b.txt'), path.join(dir, 'b.txt'));
    assert.equal(resolveInside(dir, '.'), dir);
  });

  test('rejects traversal out of the root', async () => {
    for (const hostile of ['..', '../x', 'a/../../x', path.join('..', path.basename(dir) + '-sibling', 'x'), path.resolve(dir, '..', 'x'), path.parse(dir).root]) {
      await expectCode(() => resolveInside(dir, hostile), 'INVALID_ARGUMENT');
    }
  });

  test('a sibling folder sharing the root as a name prefix is outside', async () => {
    await expectCode(() => resolveInside(dir, `../${path.basename(dir)}evil/x`), 'INVALID_ARGUMENT');
  });

  test('backslash traversal is rejected on Windows', { skip: process.platform !== 'win32' && 'Windows path separators only' }, async () => {
    await expectCode(() => resolveInside(dir, '..\\..\\x'), 'INVALID_ARGUMENT');
    await expectCode(() => resolveInside(dir, 'D:\\other'), 'INVALID_ARGUMENT');
  });

  test('a file whose name merely starts with two dots is still inside the root', () => {
    assert.equal(resolveInside(dir, '..notes.md'), path.join(dir, '..notes.md'));
  });
});

describe('safeId', () => {
  test('accepts ordinary identifiers and returns them', () => {
    for (const id of ['orders', 'S-01001', 'project_a.v2', 'A', 'a'.repeat(100), '0abc']) assert.equal(safeId(id), id);
  });

  test('rejects traversal, separators, whitespace, control characters and over-long ids', async () => {
    for (const hostile of ['', '.', '..', 'a..b', '.hidden', '-x', '_x', 'a/b', 'a\\b', 'a b', 'a\n', 'a\0b', 'C:', 'a:b', 'a*', 'é', 'a'.repeat(101)]) {
      const error = await expectCode(() => safeId(hostile, 'project id'), 'INVALID_ARGUMENT');
      assert.match(error.message, /project id/);
    }
  });

  test('rejects non-strings', async () => {
    for (const hostile of [null, undefined, 5, {}, ['a']]) await expectCode(() => safeId(/** @type {any} */ (hostile)), 'INVALID_ARGUMENT');
  });

  test('rejects names Windows cannot use as file names (reserved devices, trailing dot)', async () => {
    for (const hostile of ['CON', 'nul', 'AUX', 'COM1', 'LPT1', 'name.']) await expectCode(() => safeId(hostile), 'INVALID_ARGUMENT');
  });
});

describe('workspace layout', () => {
  test('resolveWorkspace prefers the option, then AUTODEV_WORKSPACE', () => {
    const fromOption = resolveWorkspace({ workspace: dir, env: { AUTODEV_WORKSPACE: path.join(dir, 'other') } });
    assert.equal(fromOption.root, dir);
    assert.equal(fromOption.projectsDir, path.join(dir, 'projects'));
    assert.equal(fromOption.stateDir, path.join(dir, 'state'));
    assert.equal(resolveWorkspace({ env: { AUTODEV_WORKSPACE: dir } }).root, dir);
  });

  test('projectDir and stateDirFor refuse ids that would escape', async () => {
    const workspace = resolveWorkspace({ workspace: dir });
    assert.equal(projectDir(workspace, 'orders'), path.join(dir, 'projects', 'orders'));
    assert.equal(stateDirFor(workspace, 'approvals', 'orders'), path.join(dir, 'state', 'approvals', 'orders'));
    await expectCode(() => projectDir(workspace, '../x'), 'INVALID_ARGUMENT');
    await expectCode(() => stateDirFor(workspace, 'approvals', '..'), 'INVALID_ARGUMENT');
    await expectCode(() => stateDirFor(workspace, '../audit', 'orders'), 'INVALID_ARGUMENT');
  });

  test('ensureDir is idempotent', () => {
    const target = path.join(dir, 'x', 'y');
    ensureDir(target);
    ensureDir(target);
    assert.ok(fs.statSync(target).isDirectory());
  });
});
