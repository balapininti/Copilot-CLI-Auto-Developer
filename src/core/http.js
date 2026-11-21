/**
 * The only HTTP client adapters may use. It enforces, in one place:
 *   - HTTPS only (plain HTTP is accepted for loopback, for local mocks)
 *   - a host allowlist per call
 *   - certificate validation can never be switched off
 *   - timeouts, bounded retries with backoff, and Retry-After
 *   - no automatic redirects, so a bounce to a sign-in page is reported as
 *     AUTH_REQUIRED instead of being parsed as data
 *
 * Proxies and corporate certificate authorities are honoured through Node's
 * own settings (NODE_USE_ENV_PROXY, HTTPS_PROXY, NODE_EXTRA_CA_CERTS,
 * --use-system-ca); see docs/corporate-network.md.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { AutoDevError, ErrorCodes } from './errors.js';
import { nullLogger } from './logger.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_RETRY_AFTER_MS = 60_000;

/** Refuse to run at all if certificate validation has been disabled. */
export function assertTlsPolicy(env = process.env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new AutoDevError(
      ErrorCodes.TLS_POLICY_VIOLATION,
      'NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate validation. Unset it and install your corporate CA instead (see docs/corporate-network.md).',
    );
  }
}

/**
 * @param {string} rawUrl
 * @param {string[]} allowedHosts host names; "*.example.com" matches subdomains
 * @returns {URL}
 */
export function assertAllowedUrl(rawUrl, allowedHosts) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'Not a valid URL.');
  }
  const host = url.hostname.toLowerCase();
  const loopback = LOOPBACK.has(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new AutoDevError(ErrorCodes.TLS_POLICY_VIOLATION, `Only HTTPS is permitted (got ${url.protocol}//${host}).`);
  }
  if (url.username || url.password) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'URLs must not embed credentials.');
  }
  const allowed = allowedHosts.some((entry) => {
    const pattern = entry.toLowerCase();
    return pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern;
  });
  if (!allowed) {
    throw new AutoDevError(ErrorCodes.HOST_NOT_ALLOWED, `Host "${host}" is not on the allowlist for this call.`, {
      details: { host, allowedHosts },
    });
  }
  return url;
}

/**
 * @param {string | null | undefined} baseUrl
 * @returns {string[]} allowlist containing just that URL's host
 */
export function hostOf(baseUrl) {
  if (!baseUrl) return [];
  try {
    return [new URL(baseUrl).hostname.toLowerCase()];
  } catch {
    return [];
  }
}

/**
 * A limiter that spaces calls at least `minIntervalMs` apart.
 * @param {number} minIntervalMs
 * @returns {() => Promise<void>}
 */
export function createRateLimiter(minIntervalMs) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + minIntervalMs;
    if (wait > 0) await sleep(wait);
  };
}

/**
 * @param {number} status
 * @param {string} service
 * @param {string} bodySnippet
 * @returns {AutoDevError}
 */
function errorForStatus(status, service, bodySnippet) {
  const details = { status, service, body: bodySnippet };
  if (status === 401) {
    return new AutoDevError(ErrorCodes.AUTH_FAILED, `${service} rejected the credentials (HTTP 401). The token may be missing, expired or revoked.`, { details });
  }
  if (status === 403) {
    return new AutoDevError(ErrorCodes.ACCESS_DENIED, `${service} denied access (HTTP 403). The account lacks permission for this resource.`, { details });
  }
  if (status === 404) return new AutoDevError(ErrorCodes.NOT_FOUND, `${service} has no such resource (HTTP 404).`, { details });
  if (status === 409) return new AutoDevError(ErrorCodes.CONFLICT, `${service} reported a conflict (HTTP 409).`, { details });
  if (status === 429) return new AutoDevError(ErrorCodes.RATE_LIMITED, `${service} is rate limiting requests (HTTP 429).`, { details });
  if (status >= 300 && status < 400) {
    return new AutoDevError(
      ErrorCodes.AUTH_REQUIRED,
      `${service} redirected the request (HTTP ${status}), which usually means a sign-in page. A valid token or an interactive sign-in is needed.`,
      { details: { status, service } },
    );
  }
  return new AutoDevError(ErrorCodes.UPSTREAM_ERROR, `${service} returned HTTP ${status}.`, {
    details,
    retryable: RETRYABLE_STATUS.has(status),
  });
}

/**
 * @typedef {object} HttpRequest
 * @property {string} url
 * @property {string[]} allowedHosts
 * @property {string} [service] name used in error messages
 * @property {string} [method]
 * @property {Record<string, string>} [headers]
 * @property {unknown} [body] objects are sent as JSON; strings and URLSearchParams as-is
 * @property {number} [timeoutMs]
 * @property {number} [retries] retries after the first attempt
 * @property {boolean} [retryNonIdempotent] retry POST/PUT too (only when the call carries its own idempotency key)
 * @property {() => Promise<void>} [rateLimiter]
 * @property {typeof fetch} [fetchImpl]
 * @property {import('./logger.js').Logger} [logger]
 * @property {number} [backoffBaseMs]
 */

/**
 * @param {HttpRequest} request
 * @returns {Promise<{ status: number, headers: Headers, body: any, text: string }>}
 */
export async function httpRequest(request) {
  assertTlsPolicy();
  const url = assertAllowedUrl(request.url, request.allowedHosts);
  const method = (request.method ?? 'GET').toUpperCase();
  const service = request.service ?? url.hostname;
  const logger = request.logger ?? nullLogger;
  const fetchImpl = request.fetchImpl ?? fetch;
  const timeoutMs = request.timeoutMs ?? 30_000;
  const maxAttempts = 1 + (IDEMPOTENT.has(method) || request.retryNonIdempotent ? (request.retries ?? 2) : 0);
  const backoffBase = request.backoffBaseMs ?? 500;

  /** @type {Record<string, string>} */
  const headers = { accept: 'application/json', ...request.headers };
  /** @type {any} */
  let body = request.body;
  if (body !== undefined && body !== null && typeof body === 'object' && !(body instanceof URLSearchParams)) {
    body = JSON.stringify(body);
    headers['content-type'] ??= 'application/json';
  }

  /** @type {AutoDevError | null} */
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (request.rateLimiter) await request.rateLimiter();
    const started = Date.now();
    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        body: body ?? undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      logger.debug('http', { service, method, path: url.pathname, status: response.status, ms: Date.now() - started, attempt });

      if (response.ok) {
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('text/html') && /<form[^>]+(login|signin|saml)|name=["']SAMLRequest/i.test(text)) {
          throw new AutoDevError(ErrorCodes.AUTH_REQUIRED, `${service} answered with a sign-in page instead of data.`, { details: { service } });
        }
        return { status: response.status, headers: response.headers, body: parseBody(text, contentType), text };
      }

      lastError = errorForStatus(response.status, service, text.slice(0, 300));
      if (!RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts) throw lastError;
      await sleep(retryDelay(response.headers.get('retry-after'), attempt, backoffBase));
    } catch (error) {
      // Status-based retries were handled above (with backoff); anything that
      // reaches here as an AutoDevError is final.
      if (error instanceof AutoDevError) throw error;
      const name = /** @type {Error} */ (error).name;
      lastError =
        name === 'TimeoutError' || name === 'AbortError'
          ? new AutoDevError(ErrorCodes.TIMEOUT, `${service} did not answer within ${timeoutMs} ms.`, { details: { service } })
          : new AutoDevError(
              ErrorCodes.NETWORK,
              `Could not reach ${service}: ${networkReason(error)}. Check VPN, proxy and certificate settings (docs/corporate-network.md).`,
              { details: { service }, cause: error },
            );
      if (attempt === maxAttempts) throw lastError;
      await sleep(retryDelay(null, attempt, backoffBase));
    }
  }
  throw lastError ?? new AutoDevError(ErrorCodes.INTERNAL, 'HTTP request ended without a result.');
}

/**
 * @param {string} text
 * @param {string} contentType
 */
function parseBody(text, contentType) {
  if (text.length === 0) return null;
  if (contentType.includes('json') || /^[[{]/.test(text.trimStart())) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * @param {string | null} retryAfter
 * @param {number} attempt
 * @param {number} base
 */
function retryDelay(retryAfter, attempt, base) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(ms) && ms > 0) return Math.min(ms, MAX_RETRY_AFTER_MS);
  }
  const exponential = base * 2 ** (attempt - 1);
  return exponential / 2 + Math.random() * (exponential / 2);
}

/** @param {unknown} error */
function networkReason(error) {
  const cause = /** @type {any} */ (error)?.cause;
  return cause?.code ?? cause?.message ?? /** @type {Error} */ (error).message ?? 'network error';
}
