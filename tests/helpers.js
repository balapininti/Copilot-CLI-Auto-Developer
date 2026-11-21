/**
 * Shared fixtures for the test suite. Everything here is hermetic: temp
 * folders under os.tmpdir(), no network beyond 127.0.0.1, no real credentials.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import YAML from 'yaml';

import { runChecked } from '../src/core/exec.js';
import { resolveWorkspace } from '../src/core/workspace.js';

/**
 * @param {string} [prefix]
 * @returns {string} a new temp directory
 */
export function tempDir(prefix = 'autodev-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** @param {string} dir */
export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/**
 * A throwaway workspace. Call `cleanup()` in `after`.
 * @returns {{ root: string, workspace: import('../src/core/workspace.js').Workspace, cleanup: () => void }}
 */
export function tempWorkspace() {
  const root = tempDir('autodev-ws-');
  return { root, workspace: resolveWorkspace({ workspace: root }), cleanup: () => removeDir(root) };
}

/**
 * Write projects/<id>/project.yaml (and any extra files) into a workspace.
 * @param {import('../src/core/workspace.js').Workspace} workspace
 * @param {Record<string, any>} manifest
 * @param {Record<string, string>} [files] relative path -> content
 * @returns {string} the project directory
 */
export function writeProject(workspace, manifest, files = {}) {
  const dir = path.join(workspace.projectsDir, manifest.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.yaml'), YAML.stringify(manifest));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

/**
 * A complete manifest in the shape demo.js uses. Env names are prefixed TEST_.
 * @param {Record<string, any>} [overrides] shallow-merged at the top level
 */
export function fullManifest(overrides = {}) {
  return {
    id: 'orders',
    name: 'Orders (test)',
    agility: {
      baseUrlEnv: 'TEST_AGILITY_URL',
      tokenSecret: 'TEST_AGILITY_TOKEN',
      boardIds: ['501'],
      defectScope: 'Scope:1',
      fields: { acceptanceCriteria: 'Custom_AcceptanceCriteria' },
      releaseBranchPattern: 'Release branch:\\s*(\\S+)',
    },
    bitbucket: {
      flavor: 'server',
      baseUrlEnv: 'TEST_BITBUCKET_URL',
      tokenSecret: 'TEST_BITBUCKET_TOKEN',
      projectKey: 'ORD',
      allowedHosts: ['bitbucket.example.internal'],
    },
    repositories: [
      { name: 'service-api', urlEnv: 'TEST_SERVICE_API_URL', localPath: 'repos/service-api', schemas: ['APP'] },
    ],
    services: [
      { name: 'orders-service', repository: 'service-api', schemas: ['APP'], dynatraceEntityId: 'SERVICE-ORDERS0001' },
      { name: 'payments-service', repository: 'service-api', dynatraceEntityId: 'SERVICE-PAYMENTS0002' },
    ],
    database: { engine: 'db2', connectionProfile: 'test', schemas: ['APP', 'COMMON'] },
    observability: {
      splunkBaseUrlEnv: 'TEST_SPLUNK_URL',
      splunkTokenSecret: 'TEST_SPLUNK_TOKEN',
      dynatraceBaseUrlEnv: 'TEST_DYNATRACE_URL',
      dynatraceTokenSecret: 'TEST_DYNATRACE_TOKEN',
    },
    guidelines: ['guidelines/architecture.md'],
    monitoring: {
      enabled: true,
      environment: 'nonprod',
      limits: { maxWindowMinutes: 60, maxEventsPerQuery: 500, minSecondsBetweenQueries: 0 },
      splunk: { indexes: ['app_nonprod'], sourcetypes: ['app:json'] },
      dynatrace: {
        entitySelectors: ['type(SERVICE),tag(app:orders)'],
        metricSelectors: ['builtin:service.response.time:percentile(95)'],
      },
      thresholds: { errorCount: null, errorRatePercent: null, p95LatencyMs: 1500 },
    },
    ...overrides,
  };
}

/**
 * Env for the four HTTP services, all pointing at one mock server.
 * @param {string} baseUrl
 * @returns {Record<string, string>}
 */
export function serviceEnv(baseUrl) {
  return {
    TEST_AGILITY_URL: baseUrl,
    TEST_BITBUCKET_URL: baseUrl,
    TEST_SPLUNK_URL: baseUrl,
    TEST_DYNATRACE_URL: baseUrl,
    TEST_AGILITY_TOKEN: 'test-agility-token-1',
    TEST_BITBUCKET_TOKEN: 'test-bitbucket-token-1',
    TEST_SPLUNK_TOKEN: 'test-splunk-token-1',
    TEST_DYNATRACE_TOKEN: 'test-dynatrace-token-1',
    AUTODEV_DISABLE_CREDENTIAL_STORE: '1',
  };
}

/**
 * Set process.env entries (undefined deletes) and return a restore function.
 * @param {Record<string, string | undefined>} values
 * @returns {() => void}
 */
export function setEnv(values) {
  /** @type {Record<string, string | undefined>} */
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * Isolate git from the machine's configuration. Returns a restore function.
 * @param {string} dir a temp dir to hold the empty global config
 */
export function setGitEnv(dir) {
  const emptyGitConfig = path.join(dir, 'gitconfig-empty');
  fs.writeFileSync(emptyGitConfig, '');
  return setEnv({
    AUTODEV_ALLOW_FILE_REMOTES: '1',
    AUTODEV_DISABLE_CREDENTIAL_STORE: '1',
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Auto Developer Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Auto Developer Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
    AUTODEV_PROJECT: undefined,
    AUTODEV_SESSION_ID: undefined,
    AUTODEV_WORKSPACE: undefined,
    AUTODEV_DRY_RUN: undefined,
  });
}

/**
 * @param {string[]} args
 * @param {string} [cwd]
 */
export function git(args, cwd) {
  return runChecked('git', args, { cwd });
}

/**
 * Create a bare "remote" with main + release/2.15 holding the given files.
 * Call setGitEnv first.
 * @param {string} root temp dir to create things under
 * @param {Record<string, string>} [files]
 * @returns {Promise<{ bare: string, url: string, seed: string }>}
 */
export async function makeRemote(root, files = { 'README.md': '# service\n', 'src/app.js': 'export const a = 1;\n' }) {
  const bare = path.join(root, 'remote', 'service-api.git');
  const seed = path.join(root, 'seed');
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(seed, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  await git(['init', '--quiet', '--bare', '--initial-branch=main', bare]);
  await git(['init', '--quiet', '--initial-branch=main'], seed);
  await git(['add', '--all'], seed);
  await git(['commit', '--quiet', '-m', 'Initial commit'], seed);
  await git(['branch', 'release/2.15'], seed);
  const url = pathToFileURL(bare).href;
  await git(['remote', 'add', 'origin', url], seed);
  await git(['push', '--quiet', 'origin', 'main', 'release/2.15'], seed);
  return { bare, url, seed };
}

/**
 * Assert that `fn` throws / rejects with an AutoDevError of the given code.
 * @param {() => unknown} fn
 * @param {string} code
 * @param {RegExp} [messagePattern]
 * @returns {Promise<any>} the error
 */
export async function expectCode(fn, code, messagePattern) {
  let error;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `expected an error with code ${code}, but nothing was thrown`);
  assert.equal(
    /** @type {any} */ (error).code,
    code,
    `expected code ${code}, got ${/** @type {any} */ (error).code}: ${/** @type {any} */ (error).message}`,
  );
  if (messagePattern) assert.match(/** @type {any} */ (error).message, messagePattern);
  return error;
}

/**
 * A fetch stand-in that replays canned responses and records calls.
 * @param {Array<{ status?: number, body?: unknown, headers?: Record<string, string>, throws?: Error, delayMs?: number }>} responses
 */
export function fakeFetch(responses) {
  /** @type {Array<{ url: string, init: any }>} */
  const calls = [];
  let index = 0;
  /** @type {any} */
  const impl = async (/** @type {any} */ url, /** @type {any} */ init) => {
    calls.push({ url: String(url), init });
    const spec = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (spec.delayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, spec.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }
    if (spec.throws) throw spec.throws;
    const body = typeof spec.body === 'string' ? spec.body : spec.body === undefined ? '' : JSON.stringify(spec.body);
    const headers = { 'content-type': typeof spec.body === 'string' ? 'text/plain' : 'application/json', ...spec.headers };
    const status = spec.status ?? 200;
    return new Response([204, 304].includes(status) ? null : body, { status, headers });
  };
  impl.calls = calls;
  return impl;
}
