/**
 * `autodev scenario ...`: end-to-end scenarios built from a recorded HAR.
 * The rules live in workflow/scenarios.js; this file binds them to the
 * project scope, the browser and the evidence folder.
 */

import fs from 'node:fs';
import path from 'node:path';

import * as git from '../../adapters/bitbucket/git.js';
import { openBrowser, runSteps } from '../../adapters/browser/playwright.js';
import { appendAudit } from '../../core/audit.js';
import { SERVICES } from '../../core/auth.js';
import { AutoDevError, ErrorCodes } from '../../core/errors.js';
import { hostOf } from '../../core/http.js';
import { envValue } from '../../core/manifest.js';
import { atomicWriteJson, resolveInside, safeId } from '../../core/state-store.js';
import { stateDirFor } from '../../core/workspace.js';
import { loadRun } from '../../workflow/run-store.js';
import {
  affectedScenarios, applyScenario, assertAppHost, evaluateExpectations, importHar, listScenarios, loadApprovedScenario,
  materializeSteps, proposeScenario, validateScenario,
} from '../../workflow/scenarios.js';

const SETTLE_MS = 10_000;
const MAX_OBSERVED = 5000;

/**
 * Hosts of the application under test: the browser allowlist minus the
 * ticketing, source-control and telemetry systems, which are never operated
 * through the browser.
 * @param {Record<string, any>} manifest
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function appHostsOf(manifest, env) {
  const serviceHosts = Object.values(SERVICES).flatMap((spec) => hostOf(envValue(spec.baseUrlEnv(manifest), env)));
  return (manifest.browser.allowedHosts ?? []).filter((/** @type {string} */ host) => !serviceHosts.includes(host.toLowerCase()));
}

/**
 * @param {string} file
 * @returns {unknown}
 */
function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Could not read ${path.basename(file)} as JSON: ${/** @type {Error} */ (error).message.split('\n')[0]}`);
  }
}

/**
 * Run one scenario in an open browser session.
 * @param {import('../../adapters/browser/playwright.js').BrowserSession} session
 * @param {Record<string, any>} scenario validated
 * @param {{ baseUrl?: string | null, appHosts: string[], evidenceDir: string, approved: boolean, settleMs?: number }} options
 */
export async function runScenario(session, scenario, options) {
  const plan = materializeSteps(scenario, { baseUrl: options.baseUrl });
  const origin = new URL(plan.baseUrl).origin;
  /** @type {Array<{ method: string, path: string, status: number }>} */
  const observed = [];
  const onResponse = (/** @type {any} */ response) => {
    try {
      const request = response.request();
      if (!['document', 'xhr', 'fetch'].includes(request.resourceType())) return;
      const url = new URL(response.url());
      if (url.origin !== origin || observed.length >= MAX_OBSERVED) return;
      observed.push({ method: String(request.method()).toUpperCase(), path: url.pathname, status: response.status() });
    } catch {
      // a response that cannot be read is not evidence of anything
    }
  };
  session.context.on('response', onResponse);
  try {
    const steps = await runSteps(session, plan.steps, { allowedHosts: options.appHosts, evidenceDir: path.join(options.evidenceDir, scenario.name) });
    let expectations = evaluateExpectations(scenario.expect, observed);
    // The last click may still be in flight; give expected calls a moment to land.
    const deadline = Date.now() + (options.settleMs ?? SETTLE_MS);
    while (steps.ok && expectations.results.some((result) => !result.met) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      expectations = evaluateExpectations(scenario.expect, observed);
    }
    return {
      name: scenario.name,
      title: scenario.title,
      approved: options.approved,
      ranAgainst: plan.baseUrl,
      passed: steps.ok && expectations.ok,
      steps,
      expectations,
      callsObserved: observed.length,
    };
  } finally {
    session.context.off('response', onResponse);
  }
}

/** @type {Record<string, import('../main.js').Command>} */
export const scenarioCommands = {
  'scenario import': {
    summary: 'Turn a HAR recorded in the browser into a sanitized outline of the journey (pages and API calls). Copies no header, cookie or response value.',
    usage: 'scenario import --har <file.har> --name <scenario-name> [--host <app host>] [--keep-request-values]',
    run: (ctx) => {
      const { projectId, manifest } = ctx.project();
      return importHar(ctx.workspace, {
        projectId,
        name: ctx.need('name'),
        harFile: path.resolve(ctx.need('har')),
        appHosts: appHostsOf(manifest, ctx.env),
        host: ctx.flags.host ?? null,
        keepRequestValues: ctx.flags['keep-request-values'] === true,
        dryRun: ctx.dryRun,
      });
    },
  },

  'scenario run': {
    summary: 'Replay scenario steps in the approved browser and check the expected API calls happened. Evidence, not a gate.',
    usage: 'scenario run (--name <scenario> | --all | --file <trial.json>) [--base-url <origin>] [--story <S-01234>] [--headless] [--strict]',
    run: async (ctx) => {
      const { projectId, manifest } = ctx.project();
      const appHosts = appHostsOf(manifest, ctx.env);
      /** @type {Array<{ scenario: Record<string, any>, approved: boolean }>} */
      const selected = [];
      /** @type {Array<Record<string, any>>} */
      const notRunnable = [];
      if (ctx.flags.file) {
        // A trial: the agent iterating on a scenario that nobody has approved yet.
        selected.push({ scenario: validateScenario(readJsonFile(path.resolve(String(ctx.flags.file)))), approved: false });
      } else if (ctx.flags.all === true) {
        for (const row of listScenarios(ctx.workspace, projectId).scenarios) {
          if (row.state === 'approved') selected.push({ scenario: loadApprovedScenario(ctx.workspace, projectId, row.name), approved: true });
          else notRunnable.push({ name: row.name, state: row.state });
        }
      } else {
        selected.push({ scenario: loadApprovedScenario(ctx.workspace, projectId, ctx.need('name')), approved: true });
      }
      if (selected.length === 0) {
        throw new AutoDevError(ErrorCodes.NOT_FOUND, 'This project has no approved scenarios yet. Import a HAR with "autodev scenario import" to start one.', { details: { notRunnable } });
      }
      const baseUrl = ctx.flags['base-url'] ? new URL(String(ctx.flags['base-url'])).origin : null;
      for (const { scenario } of selected) assertAppHost(baseUrl ?? scenario.baseUrl, appHosts);

      const storyId = ctx.flags.story ? safeId(String(ctx.flags.story).toUpperCase(), 'story id') : 'scenarios';
      const evidenceDir = path.join(stateDirFor(ctx.workspace, 'evidence', projectId), storyId);
      if (ctx.dryRun) {
        return { dryRun: true, wouldRun: selected.map(({ scenario, approved }) => ({ name: scenario.name, approved, steps: scenario.steps.length, expect: scenario.expect.length, against: baseUrl ?? scenario.baseUrl })), notRunnable };
      }
      const session = await openBrowser({
        manifest, projectId, allowedHosts: appHosts, exactHosts: true, channel: ctx.flags.browser, headless: ctx.flags.headless === true, env: ctx.env, logger: ctx.logger,
      });
      /** @type {Array<Awaited<ReturnType<typeof runScenario>>>} */
      const results = [];
      try {
        for (const { scenario, approved } of selected) {
          results.push(await runScenario(session, scenario, { baseUrl, appHosts, evidenceDir, approved }));
        }
      } finally {
        await session.close();
      }
      const passed = results.every((result) => result.passed) && notRunnable.length === 0;
      const summary = {
        passed,
        browser: session.channel,
        results,
        notRunnable,
        note: 'This shows how the application at "ranAgainst" behaved. It is evidence for the reviewer; it is not the tests gate, because the framework cannot tell which build that host is running.',
      };
      const evidenceFile = path.join(evidenceDir, `scenarios-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      atomicWriteJson(evidenceFile, summary);
      await appendAudit(ctx.workspace, projectId, {
        action: 'scenario.run',
        outcome: passed ? 'success' : 'failure',
        details: { story: ctx.flags.story ? storyId : null, scenarios: results.map((result) => ({ name: result.name, approved: result.approved, passed: result.passed, ranAgainst: result.ranAgainst })), notRunnable },
      });
      if (!passed && ctx.flags.strict === true) {
        throw new AutoDevError(ErrorCodes.GATE_FAILED, 'One or more scenarios did not pass.', {
          details: { evidenceFile, failed: results.filter((result) => !result.passed).map((result) => result.name), notRunnable },
        });
      }
      return { ...summary, evidenceFile };
    },
  },

  'scenario propose': {
    summary: 'Request approval to add or change a scenario. Stages the exact document; writes nothing to the project.',
    usage: 'scenario propose --file <scenario.json> --reason "what it covers, or why the approved one must change"',
    run: (ctx) => {
      const { projectId, manifest } = ctx.project();
      const scenario = readJsonFile(path.resolve(ctx.need('file')));
      if (ctx.dryRun) {
        const valid = validateScenario(scenario);
        return { dryRun: true, wouldPropose: { name: valid.name, steps: valid.steps.length, expect: valid.expect.length } };
      }
      return proposeScenario(ctx.workspace, { projectId, scenario, reason: ctx.need('reason'), appHosts: appHostsOf(manifest, ctx.env) });
    },
  },

  'scenario apply': {
    summary: 'Write a scenario that a person has approved. Writes exactly the approved document.',
    usage: 'scenario apply --approval <id>',
    run: (ctx) => applyScenario(ctx.workspace, { projectId: ctx.project().projectId, approvalId: ctx.need('approval'), dryRun: ctx.dryRun }),
  },

  'scenario list': {
    summary: 'List scenarios with their approval state, pending proposals and imported drafts.',
    run: (ctx) => listScenarios(ctx.workspace, ctx.project().projectId),
  },

  'scenario show': {
    summary: 'Show one approved scenario, or an imported draft outline with --draft.',
    usage: 'scenario show --name <scenario> [--draft]',
    run: (ctx) => {
      const { projectId } = ctx.project();
      const name = safeId(ctx.need('name'), 'scenario name');
      if (ctx.flags.draft === true) {
        const file = path.join(stateDirFor(ctx.workspace, 'scenarios', projectId), 'drafts', `${name}.json`);
        if (!fs.existsSync(file)) throw new AutoDevError(ErrorCodes.NOT_FOUND, `No imported draft named "${name}".`);
        return readJsonFile(file);
      }
      return loadApprovedScenario(ctx.workspace, projectId, name);
    },
  },

  'scenario affected': {
    summary: 'Which approved scenarios reference files changed by a story. Run those before review.',
    usage: 'scenario affected --story <S-01234> --repo <name>',
    run: async (ctx) => {
      const project = ctx.project();
      const repoName = ctx.need('repo');
      const repo = project.manifest.repositories.find((/** @type {any} */ candidate) => candidate.name === repoName);
      if (!repo) throw new AutoDevError(ErrorCodes.PROJECT_SCOPE_VIOLATION, `Repository "${repoName}" is not mapped to project "${project.projectId}".`);
      const storyId = safeId(String(ctx.need('story')).toUpperCase(), 'story id');
      const base = loadRun(ctx.workspace, project.projectId, storyId).repos[repo.name]?.baseBranch;
      if (!base) throw new AutoDevError(ErrorCodes.GATE_FAILED, 'No release branch recorded for this repository and story. Run: autodev repo prepare');
      const diff = await git.diffAgainstBase(resolveInside(project.dir, repo.localPath), base);
      return affectedScenarios(ctx.workspace, project.projectId, { repo: repo.name, changedPaths: diff.files.map((/** @type {any} */ file) => file.path) });
    },
  },
};
