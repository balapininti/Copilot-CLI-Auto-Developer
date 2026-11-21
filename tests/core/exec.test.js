import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { buildSpawn, runChecked, runCommand } from '../../src/core/exec.js';
import { clearRegisteredSecrets, registerSecret } from '../../src/core/redact.js';
import { expectCode } from '../helpers.js';

const NODE = process.execPath;
afterEach(() => clearRegisteredSecrets());

describe('buildSpawn', () => {
  test('ordinary programs are spawned directly with their argument array on every platform', () => {
    for (const platform of /** @type {NodeJS.Platform[]} */ (['win32', 'linux', 'darwin'])) {
      assert.deepEqual(buildSpawn('git', ['commit', '-m', 'a & b | c > d'], platform), { file: 'git', argv: ['commit', '-m', 'a & b | c > d'], windowsVerbatimArguments: false });
    }
  });

  test('.cmd and .bat on win32 go through cmd.exe /d /s /c with verbatim arguments', () => {
    const spec = buildSpawn('mvnw.cmd', ['-q', 'test'], 'win32');
    assert.match(spec.file, /cmd(\.exe)?$/i);
    assert.deepEqual(spec.argv, ['/d', '/s', '/c', '"mvnw.cmd -q test"']);
    assert.equal(spec.windowsVerbatimArguments, true);
    assert.equal(buildSpawn('gradlew.BAT', ['build'], 'win32').windowsVerbatimArguments, true);
  });

  test('arguments and commands containing whitespace are quoted for cmd.exe', () => {
    assert.deepEqual(buildSpawn('C:\\Program Files\\tool\\run.cmd', ['-Dname=a b', 'x'], 'win32').argv, ['/d', '/s', '/c', '""C:\\Program Files\\tool\\run.cmd" "-Dname=a b" x"']);
  });

  test('refuses shell metacharacters for .cmd on win32', async () => {
    for (const hostile of ['a&b', 'a|b', 'a<b', 'a>b', 'a^b', '%PATH%', 'say "hi"', 'a!b!', 'line\nbreak', 'cr\rhere', '& calc.exe', '&&whoami', '|| del /q *']) {
      const error = await expectCode(() => buildSpawn('mvnw.cmd', ['-q', hostile], 'win32'), 'INVALID_ARGUMENT', /shell metacharacters/);
      assert.equal(error.details.command, 'mvnw.cmd');
    }
    await expectCode(() => buildSpawn('evil&calc.cmd', [], 'win32'), 'INVALID_ARGUMENT');
    await expectCode(() => buildSpawn('x.bat', ['ok', 'a&b'], 'win32'), 'INVALID_ARGUMENT');
  });

  test('the same .cmd command on POSIX is not rewritten (no cmd.exe there)', () => {
    assert.deepEqual(buildSpawn('mvnw.cmd', ['a&b'], 'linux'), { file: 'mvnw.cmd', argv: ['a&b'], windowsVerbatimArguments: false });
  });

  test('an empty-string argument to a batch file is preserved', () => {
    assert.match(buildSpawn('x.cmd', ['a', '', 'b'], 'win32').argv[3], /a "" b/);
  });
});

describe('runCommand', () => {
  test('captures stdout, stderr and the exit code without a shell', async () => {
    const result = await runCommand(NODE, ['-e', 'console.log(process.argv[1]); console.error("warn"); process.exit(3)', '$HOME && echo injected; `id` %PATH%']);
    assert.equal(result.exitCode, 3);
    assert.equal(result.stdout.trim(), '$HOME && echo injected; `id` %PATH%', 'the argument reached the program verbatim');
    assert.equal(result.stderr.trim(), 'warn');
    assert.equal(result.timedOut, false);
    assert.equal(result.truncated, false);
    assert.ok(result.durationMs >= 0);
  });

  test('passes input on stdin, and cwd and env to the child', async () => {
    const cwd = process.cwd();
    const result = await runCommand(NODE, ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify([s,process.env.ONLY_THIS,process.cwd()])))'], {
      input: 'from stdin', cwd, env: { ...process.env, ONLY_THIS: 'yes' },
    });
    const [stdin, envValue, childCwd] = JSON.parse(result.stdout);
    assert.equal(stdin, 'from stdin');
    assert.equal(envValue, 'yes');
    assert.equal(childCwd.toLowerCase(), cwd.toLowerCase());
  });

  test('timeout: the child is killed and the result says timedOut', async () => {
    const started = Date.now();
    const result = await runCommand(NODE, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 250 });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
    assert.ok(Date.now() - started < 10_000);
  });

  test('missing program -> NOT_CONFIGURED naming it', async () => {
    const error = await expectCode(() => runCommand('autodev-no-such-program-xyz', ['--version']), 'NOT_CONFIGURED', /autodev-no-such-program-xyz/);
    assert.equal(error.details.command, 'autodev-no-such-program-xyz');
  });

  test('output is redacted by default and raw only when asked', async () => {
    registerSecret('zq9-opaque-value', 'TOKEN');
    const script = 'console.log("Authorization: Bearer abcdefgh12345678 zq9-opaque-value"); console.error("password=hunter2")';
    const redacted = await runCommand(NODE, ['-e', script]);
    assert.ok(!redacted.stdout.includes('abcdefgh12345678') && !redacted.stdout.includes('zq9-opaque-value'));
    assert.equal(redacted.stderr.trim(), 'password=[REDACTED:assignment]');
    const raw = await runCommand(NODE, ['-e', script], { redactOutput: false });
    assert.ok(raw.stdout.includes('zq9-opaque-value'));
  });

  test('output beyond the limit is truncated and flagged', async () => {
    const result = await runCommand(NODE, ['-e', 'process.stdout.write("x".repeat(50000))'], { maxOutputBytes: 1000 });
    assert.equal(result.stdout.length, 1000);
    assert.equal(result.truncated, true);
    assert.equal(result.exitCode, 0);
  });
});

describe('runChecked', () => {
  test('returns the result on exit 0', async () => {
    assert.equal((await runChecked(NODE, ['-e', 'console.log("ok")'])).stdout.trim(), 'ok');
  });

  test('non-zero exit -> UPSTREAM_ERROR with the tail of stderr, redacted', async () => {
    const error = await expectCode(() => runChecked(NODE, ['-e', 'console.error("fatal: password=hunter2"); process.exit(2)'], { what: 'the build' }), 'UPSTREAM_ERROR', /the build failed with exit code 2/);
    assert.match(error.details.stderr, /fatal: password=\[REDACTED:assignment\]/);
  });

  test('timeout -> TIMEOUT', async () => {
    await expectCode(() => runChecked(NODE, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 200 }), 'TIMEOUT', /200 ms/);
  });

  test('missing program -> NOT_CONFIGURED', async () => {
    await expectCode(() => runChecked('autodev-no-such-program-xyz', []), 'NOT_CONFIGURED');
  });
});
