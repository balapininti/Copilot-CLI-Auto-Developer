/**
 * Authentication: one transport per service, token first.
 *
 *   1. If the service's API token is available (environment or OS credential
 *      store), requests go straight to the REST API with it.
 *   2. Otherwise, where the service supports it and the project allows it, the
 *      request is made through the user's signed-in browser profile. If that
 *      profile is not signed in, a headed browser opens and the user completes
 *      corporate SSO and MFA themselves.
 *   3. Otherwise the call fails with AUTH_REQUIRED and says exactly what is
 *      missing. Nothing is fabricated and nothing is bypassed.
 *
 * DB2 is not handled here: it authenticates natively (see adapters/db2).
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { AutoDevError, ErrorCodes } from './errors.js';
import { hostOf, httpRequest } from './http.js';
import { nullLogger } from './logger.js';
import { isMissing, requireEnvValue } from './manifest.js';
import { getSecret } from './secrets.js';

/**
 * Per-service wiring. `browserFallback` states whether session-based access is
 * implemented for that service; where it is not, the state is explicit.
 * @type {Record<string, { label: string, baseUrlEnv: (m: any) => string | null, baseUrlField: string, tokenSecret: (m: any) => string, header: (token: string) => Record<string, string>, browserFallback: (m: any) => boolean, probePath: string }>}
 */
export const SERVICES = {
  agility: {
    label: 'Digital.ai Agility',
    baseUrlEnv: (m) => m.agility.baseUrlEnv,
    baseUrlField: 'agility.baseUrlEnv',
    tokenSecret: (m) => m.agility.tokenSecret ?? 'AGILITY_TOKEN',
    header: (token) => ({ authorization: `Bearer ${token}` }),
    browserFallback: (m) => m.agility.browserFallback !== false,
    probePath: "/rest-1.v1/Data/Member?where=IsSelf='true'&sel=Name",
  },
  bitbucket: {
    label: 'Bitbucket',
    baseUrlEnv: (m) => m.bitbucket.baseUrlEnv,
    baseUrlField: 'bitbucket.baseUrlEnv',
    tokenSecret: (m) => m.bitbucket.tokenSecret ?? 'BITBUCKET_TOKEN',
    header: (token) => ({ authorization: `Bearer ${token}` }),
    browserFallback: () => false,
    probePath: '/rest/api/1.0/application-properties',
  },
  splunk: {
    label: 'Splunk',
    baseUrlEnv: (m) => m.observability.splunkBaseUrlEnv,
    baseUrlField: 'observability.splunkBaseUrlEnv',
    tokenSecret: (m) => m.observability.splunkTokenSecret ?? 'SPLUNK_TOKEN',
    header: (token) => ({ authorization: `Bearer ${token}` }),
    browserFallback: () => false,
    probePath: '/services/authentication/current-context?output_mode=json',
  },
  dynatrace: {
    label: 'Dynatrace',
    baseUrlEnv: (m) => m.observability.dynatraceBaseUrlEnv,
    baseUrlField: 'observability.dynatraceBaseUrlEnv',
    tokenSecret: (m) => m.observability.dynatraceTokenSecret ?? 'DYNATRACE_TOKEN',
    header: (token) => ({ authorization: `Api-Token ${token}` }),
    browserFallback: () => false,
    probePath: '/api/v2/problems?pageSize=1',
  },
};

/**
 * @typedef {object} TransportRequest
 * @property {string} path path and query, starting with "/"
 * @property {string} [method]
 * @property {Record<string, string>} [headers]
 * @property {unknown} [body]
 * @property {number} [timeoutMs]
 * @property {number} [retries]
 * @property {boolean} [retryNonIdempotent]
 *
 * @typedef {object} Transport
 * @property {'token' | 'browser'} mode
 * @property {string} service
 * @property {string} baseUrl
 * @property {(request: TransportRequest) => Promise<{ status: number, body: any, text: string }>} request
 * @property {() => Promise<void>} close
 */

/**
 * @param {string} baseUrl
 * @param {string} requestPath
 */
function joinUrl(baseUrl, requestPath) {
  if (!requestPath.startsWith('/') || requestPath.startsWith('//')) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'Request paths must start with a single "/".');
  }
  return `${baseUrl.replace(/\/+$/, '')}${requestPath}`;
}

/**
 * @param {string} service key of SERVICES
 * @param {Record<string, any>} manifest
 * @param {{ projectId?: string, env?: NodeJS.ProcessEnv, logger?: import('./logger.js').Logger, fetchImpl?: typeof fetch, interactive?: boolean, browserChannel?: string | null, rateLimiter?: () => Promise<void>, useCredentialStore?: boolean, browserModule?: any, loginTimeoutMs?: number }} [options]
 * @returns {Promise<Transport>}
 */
export async function createTransport(service, manifest, options = {}) {
  const spec = Object.hasOwn(SERVICES, service) ? SERVICES[service] : null;
  if (!spec) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Unknown service "${service}".`);
  const env = options.env ?? process.env;
  const logger = options.logger ?? nullLogger;
  const baseUrl = requireEnvValue(spec.baseUrlEnv(manifest), spec.baseUrlField, env);
  const allowedHosts = hostOf(baseUrl);
  if (allowedHosts.length === 0) {
    throw new AutoDevError(ErrorCodes.CONFIG_INVALID, `The ${spec.label} base URL is not a valid URL.`);
  }

  const secretName = spec.tokenSecret(manifest);
  const token = isMissing(secretName) ? null : await getSecret(secretName, { env, useCredentialStore: options.useCredentialStore });

  if (token) {
    return {
      mode: 'token',
      service,
      baseUrl,
      request: (request) =>
        httpRequest({
          url: joinUrl(baseUrl, request.path),
          allowedHosts,
          service: spec.label,
          method: request.method,
          headers: { ...spec.header(token), ...request.headers },
          body: request.body,
          timeoutMs: request.timeoutMs,
          retries: request.retries,
          retryNonIdempotent: request.retryNonIdempotent,
          rateLimiter: options.rateLimiter,
          fetchImpl: options.fetchImpl,
          logger,
        }),
      close: async () => {},
    };
  }

  if (!spec.browserFallback(manifest)) {
    throw new AutoDevError(
      ErrorCodes.AUTH_REQUIRED,
      `No API token is available for ${spec.label}, and browser sign-in is not ${service === 'agility' ? 'enabled for this project' : 'supported for this service'}.`,
      {
        details: {
          service,
          secretName,
          howToFix: `Provide the token as environment variable ${secretName} or store it in the OS credential store as autodev/${secretName} (see docs/secrets.md).`,
        },
      },
    );
  }

  return createBrowserTransport(service, spec, manifest, baseUrl, allowedHosts, options);
}

/**
 * @param {string} service
 * @param {(typeof SERVICES)[string]} spec
 * @param {Record<string, any>} manifest
 * @param {string} baseUrl
 * @param {string[]} allowedHosts
 * @param {Parameters<typeof createTransport>[2] & {}} options
 * @returns {Promise<Transport>}
 */
async function createBrowserTransport(service, spec, manifest, baseUrl, allowedHosts, options) {
  const logger = options.logger ?? nullLogger;
  const browser = options.browserModule ?? (await import('../adapters/browser/playwright.js'));
  const interactive = options.interactive ?? true;
  const open = (/** @type {boolean} */ headless) =>
    browser.openBrowser({
      manifest,
      projectId: options.projectId ?? manifest.id,
      allowedHosts,
      channel: options.browserChannel,
      headless,
      env: options.env,
      logger,
    });

  /** @param {any} session */
  const signedIn = async (session) => {
    const probe = await browser.browserFetch(session, { url: joinUrl(baseUrl, spec.probePath) });
    return probe.status >= 200 && probe.status < 300 && !/text\/html/.test(probe.contentType);
  };

  let session = await open(true);
  try {
    if (!(await signedIn(session))) {
      await session.close();
      if (!interactive) {
        throw new AutoDevError(
          ErrorCodes.AUTH_REQUIRED,
          `The browser profile is not signed in to ${spec.label}, and this run is not interactive.`,
          { details: { service, howToFix: `Run interactively once: autodev auth login --service ${service}` } },
        );
      }
      // The user signs in. Automation only waits; it does not type credentials or touch MFA.
      session = await open(false);
      await session.page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      logger.info('waiting for the user to complete sign-in in the browser window', { service });
      const deadline = Date.now() + (options.loginTimeoutMs ?? 5 * 60_000);
      let ok = false;
      while (Date.now() < deadline) {
        await sleep(3_000);
        if (await signedIn(session).catch(() => false)) {
          ok = true;
          break;
        }
      }
      if (!ok) {
        throw new AutoDevError(ErrorCodes.AUTH_REQUIRED, `Sign-in to ${spec.label} was not completed in time.`, { details: { service } });
      }
    }
  } catch (error) {
    await session.close();
    throw error;
  }

  return {
    mode: 'browser',
    service,
    baseUrl,
    request: async (request) => {
      const response = await browser.browserFetch(session, {
        url: joinUrl(baseUrl, request.path),
        method: request.method,
        headers: request.headers,
        body: request.body,
        timeoutMs: request.timeoutMs,
      });
      if (response.status >= 300 && response.status < 400) {
        throw new AutoDevError(ErrorCodes.AUTH_REQUIRED, `The ${spec.label} browser session has expired. Sign in again.`, { details: { service } });
      }
      if (response.status === 401) throw new AutoDevError(ErrorCodes.AUTH_FAILED, `${spec.label} rejected the browser session (HTTP 401).`, { details: { service } });
      if (response.status === 403) throw new AutoDevError(ErrorCodes.ACCESS_DENIED, `${spec.label} denied access (HTTP 403).`, { details: { service } });
      if (response.status === 404) throw new AutoDevError(ErrorCodes.NOT_FOUND, `${spec.label} has no such resource (HTTP 404).`, { details: { service } });
      if (response.status >= 400) {
        throw new AutoDevError(ErrorCodes.UPSTREAM_ERROR, `${spec.label} returned HTTP ${response.status}.`, {
          details: { service, status: response.status },
          retryable: response.status >= 500,
        });
      }
      return { status: response.status, body: response.body, text: response.text };
    },
    close: () => session.close(),
  };
}
