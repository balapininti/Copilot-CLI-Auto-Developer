/**
 * Test and build runner.
 *
 * Runs the commands a project configured for each stage (compile, static,
 * unit, integration, contract, regression, e2e), or the defaults detected
 * from the build tool. A stage with no command is reported as
 * "not-configured", and a required stage that is not configured fails the
 * gate: a test that cannot run is not a passing test.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AutoDevError, ErrorCodes } from '../../core/errors.js';
import { runCommand } from '../../core/exec.js';
import { redactString } from '../../core/redact.js';
import { detectBuild } from '../java/detect.js';

export const STAGES = Object.freeze(['compile', 'static', 'unit', 'integration', 'contract', 'regression', 'e2e']);

const OUTPUT_TAIL = 4000;

/**
 * Sum JUnit XML reports (Surefire, Failsafe, Gradle) modified since `since`.
 * @param {string} repoPath
 * @param {number} since epoch ms
 */
export function collectJUnit(repoPath, since) {
  const totals = { tests: 0, failures: 0, errors: 0, skipped: 0, reports: 0 };
  /** @param {string} dir @param {number} depth */
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full, depth + 1);
      } else if (/^TEST-.*\.xml$/.test(entry.name) && fs.statSync(full).mtimeMs >= since) {
        const head = fs.readFileSync(full, 'utf8').slice(0, 2000);
        const suite = /<testsuite\b[^>]*>/.exec(head)?.[0];
        if (!suite) continue;
        totals.reports += 1;
        for (const key of /** @type {const} */ (['tests', 'failures', 'errors', 'skipped'])) {
          totals[key] += Number(new RegExp(`\\b${key}="(\\d+)"`).exec(suite)?.[1] ?? 0);
        }
      }
    }
  };
  walk(repoPath, 0);
  return totals.reports > 0 ? totals : null;
}

/**
 * @param {{ repoPath: string, repo: Record<string, any>, stages?: string[], required: string[], timeoutMinutes: number, runner?: typeof runCommand }} input
 */
export async function runStages(input) {
  const stages = input.stages?.length ? input.stages : STAGES;
  for (const stage of stages) {
    if (!STAGES.includes(stage)) {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Unknown test stage "${stage}". Use: ${STAGES.join(', ')}.`);
    }
  }
  if (!fs.existsSync(input.repoPath)) {
    throw new AutoDevError(ErrorCodes.NOT_FOUND, `No clone of "${input.repo.name}" exists.`);
  }
  const build = detectBuild(input.repoPath);
  const run = input.runner ?? runCommand;
  const started = Date.now();
  /** @type {Array<Record<string, any>>} */
  const results = [];
  let stop = false;

  for (const stage of stages) {
    /** @type {string[][] | undefined} */
    const configured = input.repo.tests?.[stage];
    /** @type {string[][] | undefined} */
    const commands = configured?.length ? configured : /** @type {any} */ (build.defaults)[stage];
    if (!commands?.length) {
      results.push({ stage, status: 'not-configured', required: input.required.includes(stage) });
      continue;
    }
    if (stop) {
      results.push({ stage, status: 'skipped', reason: 'An earlier stage failed.', required: input.required.includes(stage) });
      continue;
    }
    const stageStart = Date.now();
    /** @type {Array<Record<string, any>>} */
    const runs = [];
    let status = 'passed';
    for (const [command, ...args] of commands) {
      /** @type {Awaited<ReturnType<typeof runCommand>>} */
      let result;
      try {
        result = await run(command, args, { cwd: input.repoPath, timeoutMs: input.timeoutMinutes * 60_000, maxOutputBytes: 4 * 1024 * 1024 });
      } catch (error) {
        runs.push({ command: [command, ...args].join(' '), exitCode: null, error: /** @type {Error} */ (error).message });
        status = 'failed';
        break;
      }
      runs.push({
        command: redactString([command, ...args].join(' ')),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        outputTail: redactString(`${result.stdout}\n${result.stderr}`.trim().slice(-OUTPUT_TAIL), { pii: true }),
      });
      if (result.timedOut) status = 'timed-out';
      else if (result.exitCode !== 0) status = 'failed';
      if (status !== 'passed') break;
    }
    const junit = stage === 'compile' || stage === 'static' ? null : collectJUnit(input.repoPath, stageStart - 1000);
    if (status === 'passed' && junit && junit.failures + junit.errors > 0) status = 'failed';
    results.push({
      stage,
      status,
      required: input.required.includes(stage),
      source: configured?.length ? 'project.yaml' : `default for ${build.tool}`,
      durationMs: Date.now() - stageStart,
      junit,
      runs,
    });
    if (status !== 'passed') stop = true;
  }

  const byStage = new Map(results.map((result) => [result.stage, result]));
  const blockers = input.required
    .filter((stage) => byStage.get(stage)?.status !== 'passed')
    .map((stage) => ({
      stage,
      status: byStage.get(stage)?.status ?? 'not-run',
      reason:
        byStage.get(stage)?.status === 'not-configured'
          ? 'Required stage has no command configured. A stage that cannot run does not pass.'
          : !byStage.has(stage)
            ? 'Required stage was not included in this run.'
            : 'Required stage did not pass.',
    }));
  const failedOptional = results.filter((result) => !result.required && (result.status === 'failed' || result.status === 'timed-out'));
  for (const result of failedOptional) blockers.push({ stage: result.stage, status: result.status, reason: 'Stage ran and failed.' });

  return {
    repository: input.repo.name,
    buildTool: build.tool,
    passed: blockers.length === 0,
    blockers,
    durationMs: Date.now() - started,
    results,
  };
}
