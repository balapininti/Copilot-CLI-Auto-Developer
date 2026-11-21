import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { collectJUnit, runStages, STAGES } from '../../src/adapters/testing/runner.js';
import { expectCode, removeDir, tempDir } from '../helpers.js';

const root = tempDir('autodev-runner-');
after(() => removeDir(root));

let counter = 0;
function emptyRepo() {
  counter += 1;
  const dir = path.join(root, `repo-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {Record<string, Partial<{ exitCode: number | null, stdout: string, stderr: string, timedOut: boolean, throws: Error, sideEffect: (cwd: string) => void }>>} [byCommand]
 */
function fakeRunner(byCommand = {}) {
  /** @type {Array<{ command: string, args: string[], options: any }>} */
  const calls = [];
  /** @type {any} */
  const runner = async (/** @type {string} */ command, /** @type {string[]} */ args, /** @type {any} */ options) => {
    calls.push({ command, args, options });
    const spec = byCommand[command] ?? {};
    if (spec.throws) throw spec.throws;
    spec.sideEffect?.(options.cwd);
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 1, ...spec };
  };
  runner.calls = calls;
  return runner;
}

const repoWith = (/** @type {Record<string, string[][]>} */ tests) => ({ name: 'service-api', tests });

describe('runStages', () => {
  test('all configured required stages pass', async () => {
    const repoPath = emptyRepo();
    const runner = fakeRunner();
    const result = await runStages({
      repoPath, repo: repoWith({ compile: [['build-tool', 'compile']], unit: [['build-tool', 'test'], ['build-tool', 'more']] }),
      required: ['compile', 'unit'], timeoutMinutes: 2, runner,
    });
    assert.equal(result.passed, true);
    assert.deepEqual(result.blockers, []);
    assert.equal(result.repository, 'service-api');
    assert.equal(result.buildTool, null);
    assert.equal(result.results.length, STAGES.length);
    assert.deepEqual(result.results.filter((r) => r.status === 'passed').map((r) => r.stage), ['compile', 'unit']);
    assert.equal(result.results.find((r) => r.stage === 'unit').source, 'project.yaml');
    assert.equal(runner.calls.length, 3);
    assert.equal(runner.calls[0].options.cwd, repoPath);
    assert.equal(runner.calls[0].options.timeoutMs, 120_000);
    assert.deepEqual(runner.calls[0].args, ['compile']);
  });

  test('stages with no command are not-configured, never passed', async () => {
    const result = await runStages({ repoPath: emptyRepo(), repo: repoWith({ unit: [['t']] }), required: ['unit'], timeoutMinutes: 1, runner: fakeRunner() });
    const integration = result.results.find((r) => r.stage === 'integration');
    assert.equal(integration.status, 'not-configured');
    assert.equal(integration.required, false);
    assert.equal(result.passed, true);
  });

  test('a failing stage stops later stages and fails the gate', async () => {
    const runner = fakeRunner({ compiler: { exitCode: 1, stderr: 'cannot find symbol' } });
    const result = await runStages({
      repoPath: emptyRepo(), repo: repoWith({ compile: [['compiler'], ['never-run']], unit: [['tester']], e2e: [['e2e-tool']] }),
      required: ['compile', 'unit'], timeoutMinutes: 1, runner,
    });
    assert.equal(result.passed, false);
    const byStage = Object.fromEntries(result.results.map((r) => [r.stage, r]));
    assert.equal(byStage.compile.status, 'failed');
    assert.equal(byStage.compile.runs.length, 1, 'second command of the failed stage must not run');
    assert.match(byStage.compile.runs[0].outputTail, /cannot find symbol/);
    assert.equal(byStage.unit.status, 'skipped');
    assert.equal(byStage.e2e.status, 'skipped');
    assert.deepEqual(runner.calls.map((c) => c.command), ['compiler']);
    assert.deepEqual(result.blockers.map((b) => `${b.stage}:${b.status}`), ['compile:failed', 'unit:skipped']);
  });

  test('a required stage that is not configured fails the gate', async () => {
    const result = await runStages({ repoPath: emptyRepo(), repo: repoWith({ compile: [['c']] }), required: ['compile', 'unit'], timeoutMinutes: 1, runner: fakeRunner() });
    assert.equal(result.passed, false);
    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0].stage, 'unit');
    assert.equal(result.blockers[0].status, 'not-configured');
    assert.match(result.blockers[0].reason, /cannot run does not pass/);
  });

  test('a repo with no tests key at all fails every required stage as not-configured', async () => {
    const runner = fakeRunner();
    const result = await runStages({ repoPath: emptyRepo(), repo: { name: 'x' }, required: ['compile', 'unit'], timeoutMinutes: 1, runner });
    assert.equal(result.passed, false);
    assert.equal(runner.calls.length, 0);
    assert.deepEqual(result.blockers.map((b) => b.status), ['not-configured', 'not-configured']);
  });

  test('a required stage left out of the requested stages is a blocker (not-run)', async () => {
    const result = await runStages({ repoPath: emptyRepo(), repo: repoWith({ compile: [['c']], unit: [['u']] }), stages: ['compile'], required: ['compile', 'unit'], timeoutMinutes: 1, runner: fakeRunner() });
    assert.equal(result.passed, false);
    assert.deepEqual(result.blockers, [{ stage: 'unit', status: 'not-run', reason: 'Required stage was not included in this run.' }]);
    assert.equal(result.results.length, 1);
  });

  test('a timed-out command marks the stage timed-out and fails the gate', async () => {
    const runner = fakeRunner({ slow: { exitCode: null, timedOut: true } });
    const result = await runStages({ repoPath: emptyRepo(), repo: repoWith({ unit: [['slow']], integration: [['later']] }), required: ['unit'], timeoutMinutes: 1, runner });
    const unit = result.results.find((r) => r.stage === 'unit');
    assert.equal(unit.status, 'timed-out');
    assert.equal(unit.runs[0].timedOut, true);
    assert.equal(result.passed, false);
    assert.equal(result.results.find((r) => r.stage === 'integration').status, 'skipped');
  });

  test('an optional stage that ran and failed still blocks', async () => {
    const runner = fakeRunner({ flaky: { exitCode: 3 } });
    const result = await runStages({ repoPath: emptyRepo(), repo: repoWith({ unit: [['ok']], e2e: [['flaky']] }), required: ['unit'], timeoutMinutes: 1, runner });
    assert.equal(result.passed, false);
    assert.deepEqual(result.blockers, [{ stage: 'e2e', status: 'failed', reason: 'Stage ran and failed.' }]);
  });

  test('a runner that throws (program missing) fails the stage instead of crashing', async () => {
    const runner = fakeRunner({ ghost: { throws: new Error('Program not found on PATH: ghost') } });
    const result = await runStages({ repoPath: emptyRepo(), repo: repoWith({ unit: [['ghost']] }), required: ['unit'], timeoutMinutes: 1, runner });
    const unit = result.results.find((r) => r.stage === 'unit');
    assert.equal(unit.status, 'failed');
    assert.equal(unit.runs[0].exitCode, null);
    assert.match(unit.runs[0].error, /not found/);
    assert.equal(result.passed, false);
  });

  test('junit XML failures flip a zero-exit stage to failed', async () => {
    const writeReport = (/** @type {string} */ cwd) => {
      const dir = path.join(cwd, 'target', 'surefire-reports');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'TEST-com.example.A.xml'), '<?xml version="1.0"?>\n<testsuite name="A" tests="5" failures="1" errors="1" skipped="2"></testsuite>\n');
      fs.writeFileSync(path.join(dir, 'TEST-com.example.B.xml'), '<testsuite name="B" tests="3" failures="0" errors="0" skipped="0"></testsuite>\n');
      fs.writeFileSync(path.join(dir, 'other.xml'), '<testsuite tests="99" failures="99"></testsuite>');
    };
    const runner = fakeRunner({ tester: { exitCode: 0, sideEffect: writeReport } });
    const result = await runStages({ repoPath: emptyRepo(), repo: repoWith({ unit: [['tester']] }), required: ['unit'], timeoutMinutes: 1, runner });
    const unit = result.results.find((r) => r.stage === 'unit');
    assert.deepEqual(unit.junit, { tests: 8, failures: 1, errors: 1, skipped: 2, reports: 2 });
    assert.equal(unit.status, 'failed');
    assert.equal(result.passed, false);
  });

  test('clean junit XML keeps the stage passed and is reported', async () => {
    const runner = fakeRunner({
      tester: { sideEffect: (cwd) => fs.writeFileSync(path.join(cwd, 'TEST-ok.xml'), '<testsuite tests="4" failures="0" errors="0" skipped="1">') },
    });
    const result = await runStages({ repoPath: emptyRepo(), repo: repoWith({ unit: [['tester']] }), required: ['unit'], timeoutMinutes: 1, runner });
    assert.equal(result.passed, true);
    assert.deepEqual(result.results.find((r) => r.stage === 'unit').junit, { tests: 4, failures: 0, errors: 0, skipped: 1, reports: 1 });
  });

  test('stale junit reports from an earlier run are ignored', async () => {
    const repoPath = emptyRepo();
    const stale = path.join(repoPath, 'TEST-old.xml');
    fs.writeFileSync(stale, '<testsuite tests="1" failures="1" errors="0" skipped="0">');
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(stale, old, old);
    const result = await runStages({ repoPath, repo: repoWith({ unit: [['tester']] }), required: ['unit'], timeoutMinutes: 1, runner: fakeRunner() });
    assert.equal(result.results.find((r) => r.stage === 'unit').junit, null);
    assert.equal(result.passed, true);
  });

  test('junit is not collected for compile and static stages', async () => {
    const runner = fakeRunner({
      c: { sideEffect: (cwd) => fs.writeFileSync(path.join(cwd, 'TEST-x.xml'), '<testsuite tests="1" failures="1" errors="0">') },
    });
    const result = await runStages({ repoPath: emptyRepo(), repo: repoWith({ compile: [['c']] }), stages: ['compile'], required: ['compile'], timeoutMinutes: 1, runner });
    assert.equal(result.results[0].junit, null);
    assert.equal(result.passed, true);
  });

  test('an unknown stage is rejected before anything runs', async () => {
    const runner = fakeRunner();
    await expectCode(() => runStages({ repoPath: emptyRepo(), repo: repoWith({}), stages: ['unit', 'deploy'], required: [], timeoutMinutes: 1, runner }), 'INVALID_ARGUMENT', /deploy/);
    await expectCode(() => runStages({ repoPath: emptyRepo(), repo: repoWith({}), stages: ['__proto__'], required: [], timeoutMinutes: 1, runner }), 'INVALID_ARGUMENT');
    assert.equal(runner.calls.length, 0);
  });

  test('a missing clone is NOT_FOUND', async () => {
    await expectCode(() => runStages({ repoPath: path.join(root, 'nope'), repo: repoWith({}), required: [], timeoutMinutes: 1, runner: fakeRunner() }), 'NOT_FOUND');
  });

  test('defaults detected from the build tool are used when the project configures nothing', async () => {
    const repoPath = emptyRepo();
    fs.writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }));
    const runner = fakeRunner();
    const result = await runStages({ repoPath, repo: { name: 'ui' }, required: ['unit'], timeoutMinutes: 1, runner });
    assert.equal(result.buildTool, 'npm');
    assert.equal(result.passed, true);
    const unit = result.results.find((r) => r.stage === 'unit');
    assert.equal(unit.source, 'default for npm');
    assert.deepEqual(runner.calls.map((c) => c.args.join(' ')), ['run lint', 'test']);
    assert.equal(result.results.find((r) => r.stage === 'compile').status, 'not-configured');
  });

  test('command lines and output tails are redacted (secrets and PII)', async () => {
    const runner = fakeRunner({ tool: { stdout: 'user jane.doe@example.com\npassword=hunter2hunter2\n', stderr: 'Authorization: Bearer abcdefghijklmnop123' } });
    const result = await runStages({ repoPath: emptyRepo(), repo: repoWith({ unit: [['tool', '--token=supersecretvalue1']] }), required: ['unit'], timeoutMinutes: 1, runner });
    const run = result.results.find((r) => r.stage === 'unit').runs[0];
    assert.ok(!run.command.includes('supersecretvalue1'), run.command);
    assert.ok(!run.outputTail.includes('hunter2hunter2'));
    assert.ok(!run.outputTail.includes('jane.doe@example.com'));
    assert.ok(!run.outputTail.includes('abcdefghijklmnop123'));
  });
});

describe('collectJUnit', () => {
  test('returns null when there are no reports, and skips node_modules', () => {
    const repoPath = emptyRepo();
    fs.mkdirSync(path.join(repoPath, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'node_modules', 'x', 'TEST-a.xml'), '<testsuite tests="1" failures="1">');
    assert.equal(collectJUnit(repoPath, 0), null);
  });

  test('ignores TEST-*.xml files with no testsuite element', () => {
    const repoPath = emptyRepo();
    fs.writeFileSync(path.join(repoPath, 'TEST-garbage.xml'), 'not xml at all');
    assert.equal(collectJUnit(repoPath, 0), null);
  });
});
