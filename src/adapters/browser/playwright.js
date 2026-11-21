/**
 * Browser automation through Playwright, with no MCP server involved.
 *
 * Rules enforced here:
 *   - Microsoft Edge by default; Chromium only when the project manifest marks
 *     it approved AND the caller asks for it. Nothing switches browser silently.
 *   - A persistent profile per project and browser, so a corporate sign-in done
 *     once by the user is reused. Cookies are never read out or exported.
 *   - Top-level navigation is limited to an allowlist of hosts.
 *   - Certificate errors are never ignored.
 *   - Password fields are never filled by automation; the user types credentials
 *     and completes MFA in the headed window.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AutoDevError, ErrorCodes } from '../../core/errors.js';
import { nullLogger } from '../../core/logger.js';
import { redactString } from '../../core/redact.js';
import { ensureDir, safeId } from '../../core/state-store.js';

export const CHANNELS = Object.freeze(['msedge', 'chromium']);

/**
 * Decide which browser to use, or refuse.
 * @param {Record<string, any>} manifest
 * @param {string | null | undefined} requested
 * @returns {'msedge' | 'chromium'}
 */
export function resolveChannel(manifest, requested) {
  const channel = requested ?? manifest.browser.preferred ?? 'msedge';
  if (!CHANNELS.includes(channel)) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Unsupported browser "${channel}". Use msedge or chromium.`);
  }
  if (channel === 'chromium' && manifest.browser.chromiumFallback !== 'approved') {
    throw new AutoDevError(
      ErrorCodes.POLICY_PROHIBITED,
      'Chromium is not approved for this project. Set browser.chromiumFallback: approved in project.yaml once your organization allows it.',
      { details: { chromiumFallback: manifest.browser.chromiumFallback } },
    );
  }
  return /** @type {'msedge' | 'chromium'} */ (channel);
}

/**
 * @param {string} projectId
 * @param {string} channel
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function profileDir(projectId, channel, env = process.env) {
  const base =
    env.AUTODEV_BROWSER_PROFILE_DIR ||
    (process.platform === 'win32'
      ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AutoDev', 'browser-profiles')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'AutoDev', 'browser-profiles')
        : path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'autodev', 'browser-profiles'));
  return path.join(base, `${safeId(projectId, 'project id')}-${channel}`);
}

/**
 * @param {string} hostname
 * @param {string[]} allowedHosts
 */
export function hostAllowed(hostname, allowedHosts) {
  const host = hostname.toLowerCase();
  return allowedHosts.some((entry) => {
    const pattern = entry.toLowerCase();
    return pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern;
  });
}

async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch (error) {
    throw new AutoDevError(
      ErrorCodes.UNSUPPORTED,
      'Browser automation needs the playwright-core package. Run "npm install" in the automation folder (it uses the installed Edge; no browser download is required).',
      { cause: error },
    );
  }
}

/**
 * @typedef {object} BrowserSession
 * @property {any} context Playwright BrowserContext
 * @property {any} page
 * @property {string} channel
 * @property {string[]} blockedNavigations
 * @property {() => Promise<void>} close
 */

/**
 * Launch the approved browser with the project's persistent profile.
 * @param {{ manifest: Record<string, any>, projectId: string, allowedHosts: string[], channel?: string | null, headless?: boolean, env?: NodeJS.ProcessEnv, logger?: import('../../core/logger.js').Logger, userDataDir?: string, exactHosts?: boolean }} options
 *   `exactHosts`: use `allowedHosts` as given instead of adding the manifest's browser hosts.
 * @returns {Promise<BrowserSession>}
 */
export async function openBrowser(options) {
  const env = options.env ?? process.env;
  const logger = options.logger ?? nullLogger;
  const channel = resolveChannel(options.manifest, options.channel);
  const allowedHosts = options.exactHosts
    ? [...new Set(options.allowedHosts)]
    : [...new Set([...options.allowedHosts, ...(options.manifest.browser.allowedHosts ?? [])])];
  if (allowedHosts.length === 0) {
    throw new AutoDevError(ErrorCodes.NOT_CONFIGURED, 'No allowed hosts are configured for the browser. Add them under browser.allowedHosts.');
  }
  const { chromium } = await loadPlaywright();
  const userDataDir = options.userDataDir ?? profileDir(options.projectId, channel, env);
  ensureDir(userDataDir);

  /** @type {Record<string, unknown>} */
  const launch = { headless: options.headless ?? false, ignoreHTTPSErrors: false, acceptDownloads: false };
  if (channel === 'msedge') launch.channel = 'msedge';
  else if (env.AUTODEV_CHROMIUM_PATH) launch.executablePath = env.AUTODEV_CHROMIUM_PATH;
  else launch.channel = 'chromium';

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, launch);
  } catch (error) {
    throw new AutoDevError(
      ErrorCodes.NOT_CONFIGURED,
      channel === 'msedge'
        ? 'Could not start Microsoft Edge. Confirm Edge is installed and not blocked by policy. The framework will not switch to another browser on its own.'
        : 'Could not start Chromium. Set AUTODEV_CHROMIUM_PATH to an approved Chromium executable.',
      { details: { channel, reason: redactString(/** @type {Error} */ (error).message.split('\n')[0]) }, cause: error },
    );
  }

  /** @type {string[]} */
  const blockedNavigations = [];
  await context.route('**/*', (/** @type {any} */ route) => {
    const request = route.request();
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return route.continue();
    }
    const topLevel = request.isNavigationRequest() && request.frame().parentFrame() === null;
    if (topLevel && /^https?:$/.test(url.protocol) && !hostAllowed(url.hostname, allowedHosts)) {
      blockedNavigations.push(url.hostname);
      logger.warn('browser navigation blocked', { host: url.hostname });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });

  const page = context.pages()[0] ?? (await context.newPage());
  return {
    context,
    page,
    channel,
    blockedNavigations,
    close: async () => {
      await context.close().catch(() => {});
    },
  };
}

const STEP_TIMEOUT_MS = 30_000;
const ASSERT_TIMEOUT_MS = 5_000;
const MAX_TEXT = 20_000;

/**
 * Poll a condition until it holds or the time runs out.
 * @param {() => boolean | Promise<boolean>} condition
 * @param {number} timeoutMs
 */
async function eventually(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let holds = false;
    try {
      holds = await condition();
    } catch {
      // the element may not exist yet; keep waiting until the deadline
    }
    if (holds) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Run a list of browser steps and return what each produced.
 *
 * Step shapes:
 *   { action: "goto", url }
 *   { action: "click", selector }
 *   { action: "fill", selector, value }
 *   { action: "press", selector, key }
 *   { action: "waitFor", selector, state? }
 *   { action: "text", selector? }                 -> text content
 *   { action: "inspect", selector? }              -> trimmed HTML
 *   { action: "screenshot", name, fullPage? }     -> file under evidenceDir
 *   { action: "assertVisible", selector }
 *   { action: "assertText", selector?, contains }
 *   { action: "assertUrl", contains }
 *
 * @param {BrowserSession} session
 * @param {Array<Record<string, any>>} steps
 * @param {{ allowedHosts: string[], evidenceDir?: string }} options
 */
export async function runSteps(session, steps, options) {
  const { page } = session;
  /** @type {Array<Record<string, unknown>>} */
  const results = [];
  for (const [index, step] of steps.entries()) {
    const started = Date.now();
    /** @type {Record<string, unknown>} */
    const record = { index, action: step.action };
    try {
      record.output = await runStep(page, step, options);
      record.ok = true;
    } catch (error) {
      record.ok = false;
      record.error = redactString(/** @type {Error} */ (error).message.split('\n')[0]);
      if (error instanceof AutoDevError) record.code = error.code;
      record.durationMs = Date.now() - started;
      results.push(record);
      break; // later steps depend on earlier ones
    }
    record.durationMs = Date.now() - started;
    results.push(record);
  }
  return {
    ok: results.length === steps.length && results.every((result) => result.ok),
    completed: results.filter((result) => result.ok).length,
    total: steps.length,
    finalUrl: redactString(page.url()),
    blockedNavigations: [...new Set(session.blockedNavigations)],
    results,
  };
}

/**
 * @param {any} page
 * @param {Record<string, any>} step
 * @param {{ allowedHosts: string[], evidenceDir?: string }} options
 */
async function runStep(page, step, options) {
  const timeout = Math.min(Number(step.timeoutMs) || STEP_TIMEOUT_MS, 120_000);
  const assertTimeout = Math.min(Number(step.timeoutMs) || ASSERT_TIMEOUT_MS, 120_000);
  const need = (/** @type {string} */ key) => {
    if (typeof step[key] !== 'string' || step[key].length === 0) {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Step "${step.action}" needs "${key}".`);
    }
    return step[key];
  };

  switch (step.action) {
    case 'goto': {
      const url = new URL(need('url'));
      const loopback = ['127.0.0.1', 'localhost'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        throw new AutoDevError(ErrorCodes.TLS_POLICY_VIOLATION, 'Only HTTPS pages may be opened.');
      }
      if (!hostAllowed(url.hostname, options.allowedHosts)) {
        throw new AutoDevError(ErrorCodes.HOST_NOT_ALLOWED, `Host "${url.hostname}" is not on the browser allowlist.`);
      }
      const response = await page.goto(url.href, { timeout, waitUntil: 'domcontentloaded' });
      return { status: response?.status() ?? null, url: redactString(page.url()) };
    }
    case 'click':
      await page.locator(need('selector')).first().click({ timeout });
      return null;
    case 'fill': {
      const locator = page.locator(need('selector')).first();
      const type = await locator.getAttribute('type', { timeout });
      if ((type ?? '').toLowerCase() === 'password') {
        throw new AutoDevError(
          ErrorCodes.POLICY_PROHIBITED,
          'Automation never types into password fields. The user signs in themselves in the browser window.',
        );
      }
      await locator.fill(String(step.value ?? ''), { timeout });
      return null;
    }
    case 'press':
      await page.locator(need('selector')).first().press(need('key'), { timeout });
      return null;
    case 'waitFor':
      await page.locator(need('selector')).first().waitFor({ state: step.state ?? 'visible', timeout });
      return null;
    case 'text': {
      const text = await page.locator(step.selector ?? 'body').first().innerText({ timeout });
      return redactString(text.slice(0, MAX_TEXT), { pii: true });
    }
    case 'inspect': {
      const html = await page.locator(step.selector ?? 'body').first().evaluate((/** @type {any} */ el) => el.outerHTML, undefined, { timeout });
      return redactString(String(html).slice(0, MAX_TEXT), { pii: true });
    }
    case 'screenshot': {
      if (!options.evidenceDir) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'No evidence folder is configured for screenshots.');
      ensureDir(options.evidenceDir);
      const file = path.join(options.evidenceDir, `${safeId(need('name'), 'screenshot name')}.png`);
      await page.screenshot({ path: file, fullPage: step.fullPage === true, timeout });
      return { file, bytes: fs.statSync(file).size };
    }
    // Assertions wait: what they check is usually the result of a request the
    // previous step started, and that has not finished when the step returns.
    case 'assertVisible': {
      const locator = page.locator(need('selector')).first();
      if (!(await eventually(() => locator.isVisible(), assertTimeout))) throw new Error(`Expected "${step.selector}" to be visible.`);
      return null;
    }
    case 'assertText': {
      const locator = page.locator(step.selector ?? 'body').first();
      const contains = need('contains');
      const found = await eventually(async () => (await locator.innerText({ timeout: assertTimeout })).includes(contains), assertTimeout);
      if (!found) throw new Error(`Expected text to contain "${step.contains}".`);
      return null;
    }
    case 'assertUrl': {
      const contains = need('contains');
      if (!(await eventually(() => page.url().includes(contains), assertTimeout))) throw new Error(`Expected the URL to contain "${step.contains}".`);
      return null;
    }
    default:
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Unknown browser step "${step.action}".`);
  }
}

/**
 * HTTP through the signed-in browser profile. Requests carry the session the
 * user established in that profile; no cookie is read or copied out.
 * @param {BrowserSession} session
 * @param {{ url: string, method?: string, headers?: Record<string, string>, body?: unknown, timeoutMs?: number }} request
 * @returns {Promise<{ status: number, body: any, text: string, contentType: string }>}
 */
export async function browserFetch(session, request) {
  const response = await session.context.request.fetch(request.url, {
    method: request.method ?? 'GET',
    headers: { accept: 'application/json', ...request.headers },
    data: request.body ?? undefined,
    timeout: request.timeoutMs ?? 30_000,
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  const text = await response.text();
  const contentType = response.headers()['content-type'] ?? '';
  let body = text;
  if (contentType.includes('json')) {
    try {
      body = JSON.parse(text);
    } catch {
      // keep the raw text
    }
  }
  return { status: response.status(), body, text, contentType };
}
