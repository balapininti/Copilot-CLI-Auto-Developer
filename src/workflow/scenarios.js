/**
 * End-to-end scenarios: a project's baseline user journeys.
 *
 *   import   reads a HAR recorded by a person in their browser and keeps only
 *            a sanitized outline of the journey: which pages were opened and
 *            which API calls were made, in order. The HAR itself is never
 *            copied, and no header, cookie, token or response value survives.
 *   propose  the agent completes the outline into a scenario (browser steps
 *            and the API calls to expect), using the code base to find the
 *            screens and selectors, and requests approval for that exact
 *            document.
 *   apply    after approval, writes exactly the approved document.
 *   run      replays the steps in the approved browser and checks that the
 *            expected API calls happened.
 *
 * A scenario is what later runs are judged against, so it follows the same
 * rule as a learning: only `apply` writes one, it consumes an approval bound
 * to the hash of the exact content, and a scenario file that differs from
 * its integrity record is never run as approved. An agent therefore cannot
 * quietly rewrite a scenario to match behaviour it has just broken.
 */

import fs from 'node:fs';
import path from 'node:path';

import { Actions, consumeApproval, getApproval, requestApproval } from '../core/approvals.js';
import { appendAudit } from '../core/audit.js';
import { AutoDevError, ErrorCodes } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { containsSecret, redactString } from '../core/redact.js';
import { atomicWriteFile, atomicWriteJson, ensureDir, readJson, safeId, withLock } from '../core/state-store.js';
import { projectDir, stateDirFor } from '../core/workspace.js';

export const SCENARIO_SCHEMA = 1;
export const STEP_ACTIONS = Object.freeze(['goto', 'click', 'fill', 'press', 'waitFor', 'text', 'inspect', 'screenshot', 'assertVisible', 'assertText', 'assertUrl']);

const MAX_HAR_BYTES = 100 * 1024 * 1024;
const MAX_CALLS = 300;
const MAX_STEPS = 200;
const MAX_EXPECT = 100;
const MAX_CODE_REFS = 100;
const MAX_BODY_BYTES = 1024 * 1024;
const METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const STATIC_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media', 'manifest', 'texttrack', 'ping', 'websocket', 'eventsource', 'preflight']);
const STATIC_EXTENSION = /\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|otf|mp4|webm|mp3|wasm)$/i;
const STATIC_MIME = /^(image|font|audio|video)\/|javascript|text\/css|application\/wasm/i;

/* ----------------------------------------------------------------------------
 * Paths
 * ------------------------------------------------------------------------- */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Replace the parts of a path that change from run to run (numbers, UUIDs,
 * long opaque tokens) with `{id}`, so the same call is recognised next time.
 * @param {string} pathname
 */
export function templatePath(pathname) {
  return pathname
    .split('/')
    .map((segment) => {
      if (segment === '') return segment;
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // keep the raw segment
      }
      if (/^\d+$/.test(decoded) || UUID.test(decoded) || /^[0-9a-f]{16,}$/i.test(decoded) || (decoded.length >= 20 && /\d/.test(decoded) && /^[\w.~=-]+$/.test(decoded))) return '{id}';
      return segment;
    })
    .join('/');
}

/**
 * Does a real path match a template? `{name}` stands for exactly one segment.
 * @param {string} template
 * @param {string} pathname
 */
export function pathMatches(template, pathname) {
  const want = template.replace(/\/+$/, '').split('/');
  const have = pathname.replace(/\/+$/, '').split('/');
  if (want.length !== have.length) return false;
  return want.every((segment, index) => (/^\{[\w-]+\}$/.test(segment) ? have[index].length > 0 : segment === have[index]));
}

/* ----------------------------------------------------------------------------
 * HAR import
 * ------------------------------------------------------------------------- */

/**
 * The structure of a JSON value without any of its values.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function shapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return depth >= 4 || value.length === 0 ? ['…'] : [shapeOf(value[0], depth + 1)];
  if (typeof value === 'object') {
    if (depth >= 4) return '{…}';
    /** @type {Record<string, unknown>} */
    const shape = {};
    for (const key of Object.keys(/** @type {object} */ (value)).slice(0, 40)) {
      // A key is normally a field name, but a map keyed by a token or an
      // e-mail address would put that value into the outline.
      const safeKey = redactString(key.slice(0, 60), { pii: true });
      shape[safeKey] = shapeOf(/** @type {Record<string, unknown>} */ (value)[key], depth + 1);
    }
    return shape;
  }
  return typeof value;
}

/**
 * Request values, kept only on request and only after masking.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
function maskedValues(value, depth = 0) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactString(value.slice(0, 80), { pii: true });
  if (Array.isArray(value)) return depth >= 4 ? [] : value.slice(0, 5).map((item) => maskedValues(item, depth + 1));
  if (typeof value === 'object') {
    if (depth >= 4) return {};
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(/** @type {object} */ (value)).slice(0, 40)) {
      const safeKey = redactString(key.slice(0, 60), { pii: true });
      out[safeKey] = /pass(word|phrase)?|secret|token|authorization|api[-_]?key|credential|session|cookie|ssn|card|cvv|pin\b/i.test(key)
        ? '[REDACTED]'
        : maskedValues(/** @type {Record<string, unknown>} */ (value)[key], depth + 1);
    }
    return out;
  }
  return typeof value;
}

/**
 * @param {any} body HAR postData or response content
 * @returns {unknown | undefined} parsed JSON or form fields, when there are any
 */
function parseBody(body) {
  if (!body || typeof body !== 'object') return undefined;
  const mime = String(body.mimeType ?? '').toLowerCase();
  if (Array.isArray(body.params) && body.params.length > 0) {
    return Object.fromEntries(body.params.slice(0, 40).map((/** @type {any} */ param) => [String(param?.name ?? ''), String(param?.value ?? '')]));
  }
  let text = typeof body.text === 'string' ? body.text : '';
  if (!text || text.length > MAX_BODY_BYTES * 1.4) return undefined;
  if (body.encoding === 'base64') {
    try {
      text = Buffer.from(text, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  }
  if (mime.includes('json') || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  if (mime.includes('x-www-form-urlencoded')) {
    return Object.fromEntries([...new URLSearchParams(text)].slice(0, 40));
  }
  return undefined;
}

/**
 * @param {any} entry
 * @param {URL} url
 */
function isStatic(entry, url) {
  const type = String(entry._resourceType ?? '').toLowerCase();
  if (STATIC_TYPES.has(type)) return true;
  if (type === 'document' || type === 'xhr' || type === 'fetch') return false;
  const mime = String(entry.response?.content?.mimeType ?? '');
  return STATIC_EXTENSION.test(url.pathname) || STATIC_MIME.test(mime);
}

/**
 * Reduce a HAR to a sanitized outline of the journey it recorded.
 *
 * Kept per call: method, templated path, names of query parameters, status,
 * content types, and the shape (field names and types) of JSON bodies.
 * Dropped: every header and cookie, every response value, query values, and
 * anything sent to a host that is not the application under test.
 *
 * @param {unknown} har parsed HAR document
 * @param {{ appHosts: string[], host?: string | null, keepRequestValues?: boolean }} options
 */
export function outlineFromHar(har, options) {
  const entries = /** @type {any} */ (har)?.log?.entries;
  if (!Array.isArray(entries)) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'That file is not a HAR: it has no log.entries array. Export it from the browser developer tools (Network, "Export HAR").');
  }
  const appHosts = options.appHosts.map((host) => host.toLowerCase());
  const matchesApp = (/** @type {string} */ hostname) =>
    appHosts.some((pattern) => (pattern.startsWith('*.') ? hostname.endsWith(pattern.slice(1)) : hostname === pattern));

  /** @type {Array<{ entry: any, url: URL }>} */
  const candidates = [];
  /** @type {Map<string, number>} */
  const otherHosts = new Map();
  /** @type {Map<string, number>} */
  const hostCounts = new Map();
  let staticAssets = 0;
  let unreadable = 0;
  for (const entry of entries) {
    let url;
    try {
      url = new URL(String(entry?.request?.url));
    } catch {
      unreadable += 1;
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) {
      unreadable += 1;
      continue;
    }
    const hostname = url.hostname.toLowerCase();
    if (!matchesApp(hostname) || (options.host && hostname !== options.host.toLowerCase())) {
      otherHosts.set(hostname, (otherHosts.get(hostname) ?? 0) + 1);
      continue;
    }
    const method = String(entry.request?.method ?? '').toUpperCase();
    if (!METHODS.includes(method) || isStatic(entry, url)) {
      staticAssets += 1;
      continue;
    }
    hostCounts.set(url.origin, (hostCounts.get(url.origin) ?? 0) + 1);
    candidates.push({ entry, url });
  }

  // One scenario targets one origin: the one the journey mostly used.
  const baseUrl = [...hostCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  /** @type {Array<Record<string, any>>} */
  const calls = [];
  for (const { entry, url } of candidates) {
    if (url.origin !== baseUrl) {
      otherHosts.set(url.hostname.toLowerCase(), (otherHosts.get(url.hostname.toLowerCase()) ?? 0) + 1);
      continue;
    }
    const method = String(entry.request.method).toUpperCase();
    const type = String(entry._resourceType ?? '').toLowerCase();
    const responseMime = String(entry.response?.content?.mimeType ?? '').split(';')[0].trim().toLowerCase();
    const kind = type === 'document' || (type === '' && method === 'GET' && responseMime === 'text/html') ? 'page' : 'api';
    /** @type {Record<string, any>} */
    const call = {
      kind,
      method,
      path: templatePath(url.pathname),
      query: [...new Set([...url.searchParams.keys()].map((key) => redactString(key.slice(0, 60), { pii: true })))].sort(),
      status: Number(entry.response?.status) || 0,
      count: 1,
    };
    const requestBody = parseBody(entry.request.postData);
    if (requestBody !== undefined) {
      call.requestShape = shapeOf(requestBody);
      if (options.keepRequestValues) call.requestValues = maskedValues(requestBody);
    }
    if (kind === 'api') {
      const responseBody = parseBody(entry.response?.content);
      if (responseBody !== undefined) call.responseShape = shapeOf(responseBody);
      if (responseMime) call.responseType = responseMime;
    }
    const previous = calls[calls.length - 1];
    if (previous && previous.method === call.method && previous.path === call.path && previous.status === call.status) {
      previous.count += 1; // polling and retries collapse into one line
      continue;
    }
    calls.push(call);
  }

  const truncated = calls.length > MAX_CALLS;
  /** @type {Array<Record<string, any>>} */
  const kept = calls.slice(0, MAX_CALLS).map((call, index) => ({ seq: index + 1, ...call }));
  return {
    baseUrl,
    pages: [...new Set(kept.filter((call) => call.kind === 'page').map((call) => call.path))],
    calls: kept,
    summary: {
      entriesInHar: entries.length,
      callsKept: kept.length,
      truncated,
      staticAssetsDropped: staticAssets,
      unreadableDropped: unreadable,
      otherHostsDropped: Object.fromEntries([...otherHosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)),
      requestValuesKept: options.keepRequestValues === true,
    },
  };
}

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 */
function scenarioStateDir(workspace, projectId) {
  return stateDirFor(workspace, 'scenarios', projectId);
}

/**
 * Import a HAR as a draft outline. Writes only to framework state.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {{ projectId: string, name: string, harFile: string, appHosts: string[], host?: string | null, keepRequestValues?: boolean, dryRun?: boolean }} input
 */
export async function importHar(workspace, input) {
  const name = safeId(input.name, 'scenario name');
  if (input.appHosts.length === 0) {
    throw new AutoDevError(
      ErrorCodes.NOT_CONFIGURED,
      'No application host is configured. List the host of the application under test in browser.allowedHosts in project.yaml; calls to any other host are dropped from the recording.',
    );
  }
  let stat;
  try {
    stat = fs.statSync(input.harFile);
  } catch {
    throw new AutoDevError(ErrorCodes.NOT_FOUND, 'The HAR file was not found.');
  }
  if (!stat.isFile() || stat.size > MAX_HAR_BYTES) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `The HAR must be a file of at most ${MAX_HAR_BYTES / 1024 / 1024} MB. Record one scenario at a time.`);
  }
  const raw = fs.readFileSync(input.harFile);
  let har;
  try {
    har = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'The HAR file is not valid JSON.');
  }
  const outline = outlineFromHar(har, { appHosts: input.appHosts, host: input.host, keepRequestValues: input.keepRequestValues });
  if (outline.calls.length === 0) {
    throw new AutoDevError(
      ErrorCodes.INVALID_ARGUMENT,
      'Nothing in the HAR was sent to the application under test. Check that its host is in browser.allowedHosts.',
      { details: { appHosts: input.appHosts, hostsInHar: outline.summary.otherHostsDropped } },
    );
  }
  const draft = {
    schema: SCENARIO_SCHEMA,
    name,
    status: 'draft',
    baseUrl: outline.baseUrl,
    pages: outline.pages,
    calls: outline.calls,
    source: { kind: 'har', sha256: sha256(raw), importedAt: new Date().toISOString(), ...outline.summary },
  };
  const file = path.join(scenarioStateDir(workspace, input.projectId), 'drafts', `${name}.json`);
  if (input.dryRun) return { dryRun: true, wouldWrite: file, draft };
  ensureDir(path.dirname(file));
  atomicWriteJson(file, draft);
  await appendAudit(workspace, input.projectId, {
    action: 'scenario.imported',
    outcome: 'success',
    details: { name, harSha256: draft.source.sha256, callsKept: outline.summary.callsKept, requestValuesKept: outline.summary.requestValuesKept },
  });
  return {
    draftFile: file,
    draft,
    next: [
      'The outline says WHAT the journey did, not how. Find the screens and controls in the code base that make these calls, then write a complete scenario (steps + expect) and try it with: autodev scenario run --file <scenario.json>',
      'When it passes, request approval for it: autodev scenario propose --file <scenario.json> --reason "..."',
      'The HAR itself was not copied. Tell the user they can delete it; it contains their session.',
    ],
  };
}

/* ----------------------------------------------------------------------------
 * Scenario documents
 * ------------------------------------------------------------------------- */

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} max
 */
function requireText(value, label, max) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Scenario ${label} must be text of 1 to ${max} characters.`);
  }
  return value;
}

/**
 * Validate a scenario and return it in canonical form (unknown keys dropped).
 * @param {unknown} input
 * @returns {Record<string, any>}
 */
export function validateScenario(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'A scenario is a JSON object with name, title, baseUrl, steps and expect.');
  }
  const doc = /** @type {Record<string, any>} */ (input);
  const name = safeId(doc.name, 'scenario name');
  const title = requireText(doc.title, 'title', 160);

  let base;
  try {
    base = new URL(String(doc.baseUrl));
  } catch {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'Scenario baseUrl must be the origin of the application under test, for example https://orders-dev.corp.example.');
  }
  const loopback = ['127.0.0.1', 'localhost'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) {
    throw new AutoDevError(ErrorCodes.TLS_POLICY_VIOLATION, 'Scenario baseUrl must use https (http is accepted for loopback only).');
  }
  if (base.username || base.password || base.search || base.hash || base.pathname.replace(/\/+$/, '') !== '') {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'Scenario baseUrl must be an origin only: no path, query, fragment or credentials.');
  }

  if (!Array.isArray(doc.steps) || doc.steps.length === 0 || doc.steps.length > MAX_STEPS) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `A scenario needs 1 to ${MAX_STEPS} steps.`);
  }
  const steps = doc.steps.map((/** @type {any} */ step, /** @type {number} */ index) => {
    if (!step || typeof step !== 'object' || !STEP_ACTIONS.includes(step.action)) {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Step ${index + 1} has no known action. Use one of: ${STEP_ACTIONS.join(', ')}.`);
    }
    /** @type {Record<string, any>} */
    const clean = { action: step.action };
    for (const key of ['url', 'selector', 'value', 'key', 'state', 'name', 'contains']) {
      if (step[key] === undefined) continue;
      if (typeof step[key] !== 'string' || step[key].length > 2000) {
        throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Step ${index + 1}: "${key}" must be text of at most 2000 characters.`);
      }
      clean[key] = step[key];
    }
    if (step.fullPage === true) clean.fullPage = true;
    if (step.timeoutMs !== undefined) {
      if (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 1 || step.timeoutMs > 120_000) {
        throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Step ${index + 1}: timeoutMs must be 1 to 120000.`);
      }
      clean.timeoutMs = step.timeoutMs;
    }
    if (clean.action === 'goto' && !(typeof clean.url === 'string' && /^\/(?!\/)/.test(clean.url))) {
      // A scenario belongs to one application. Absolute URLs would let it wander.
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Step ${index + 1}: goto takes a path that starts with "/", relative to baseUrl.`);
    }
    return clean;
  });
  if (steps[0].action !== 'goto') {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'The first step must be a goto, so the scenario starts from a known page.');
  }

  const expectInput = doc.expect ?? [];
  if (!Array.isArray(expectInput) || expectInput.length > MAX_EXPECT) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `"expect" is a list of at most ${MAX_EXPECT} API calls.`);
  }
  const expect = expectInput.map((/** @type {any} */ item, /** @type {number} */ index) => {
    const method = String(item?.method ?? '').toUpperCase();
    if (!METHODS.includes(method)) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `expect[${index}]: method must be one of ${METHODS.join(', ')}.`);
    if (typeof item.path !== 'string' || !/^\/(?!\/)/.test(item.path) || item.path.length > 500 || /[?#]/.test(item.path)) {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `expect[${index}]: path must start with "/" and have no query. Use {id} for a segment that varies.`);
    }
    const statuses = (Array.isArray(item.status) ? item.status : [item.status]).map(Number);
    if (statuses.length === 0 || statuses.length > 10 || statuses.some((/** @type {number} */ status) => !Number.isInteger(status) || status < 100 || status > 599)) {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `expect[${index}]: status must be an HTTP status or a short list of them.`);
    }
    return { method, path: item.path, status: statuses.length === 1 ? statuses[0] : statuses };
  });

  const codeInput = doc.code ?? [];
  if (!Array.isArray(codeInput) || codeInput.length > MAX_CODE_REFS) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `"code" is a list of at most ${MAX_CODE_REFS} { repo, path } references.`);
  }
  const code = codeInput.map((/** @type {any} */ item, /** @type {number} */ index) => {
    const repo = safeId(item?.repo, `code[${index}].repo`);
    if (typeof item.path !== 'string' || item.path.length === 0 || item.path.length > 400 || path.isAbsolute(item.path) || /^[a-z]:/i.test(item.path) || item.path.split(/[\\/]/).includes('..')) {
      throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `code[${index}].path must be a path inside the repository.`);
    }
    return { repo, path: item.path.split('\\').join('/') };
  });

  /** @type {Record<string, any>} */
  const scenario = { schema: SCENARIO_SCHEMA, name, title, baseUrl: base.origin, steps, expect, code };
  if (doc.description !== undefined) scenario.description = requireText(doc.description, 'description', 1000);

  const serialized = JSON.stringify(scenario);
  if (containsSecret(serialized) || redactString(serialized, { pii: true }) !== serialized) {
    throw new AutoDevError(
      ErrorCodes.INVALID_ARGUMENT,
      'The scenario appears to contain a secret or personal data. Use made-up test data, and {{unique}} where a value must differ on every run.',
    );
  }
  for (const step of steps) {
    if (step.action === 'fill' && /pass(word|phrase)?|secret|token|otp|mfa/i.test(String(step.selector))) {
      throw new AutoDevError(ErrorCodes.POLICY_PROHIBITED, 'A scenario never fills a password, token or one-time-code field. The user signs in themselves in the project browser profile.');
    }
  }
  return scenario;
}

/** @param {Record<string, any>} scenario */
function serialize(scenario) {
  return `${JSON.stringify(scenario, null, 2)}\n`;
}

/** @param {string} name */
function relativeTarget(name) {
  return `scenarios/${name}.json`;
}

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 */
export function scenarioIntegrityFile(workspace, projectId) {
  return path.join(scenarioStateDir(workspace, projectId), 'integrity.json');
}

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @returns {Record<string, string>}
 */
function readIntegrity(workspace, projectId) {
  return readJson(scenarioIntegrityFile(workspace, projectId), /** @type {Record<string, string>} */ ({}));
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {string} approvalId
 */
function proposalFile(workspace, projectId, approvalId) {
  return path.join(scenarioStateDir(workspace, projectId), 'proposals', `${safeId(approvalId, 'approval id')}.json`);
}

/**
 * What a reviewer needs to see: how the proposed scenario differs from the
 * approved one.
 * @param {Record<string, any> | null} before
 * @param {Record<string, any>} after
 */
export function describeChange(before, after) {
  const key = (/** @type {any} */ call) => `${call.method} ${call.path} -> ${[].concat(call.status).join('|')}`;
  const stepKey = (/** @type {any} */ step) => JSON.stringify(step);
  const beforeExpect = new Set((before?.expect ?? []).map(key));
  const afterExpect = new Set(after.expect.map(key));
  const beforeSteps = (before?.steps ?? []).map(stepKey);
  const afterSteps = after.steps.map(stepKey);
  return {
    kind: before ? 'update' : 'new',
    baseUrlChanged: before ? before.baseUrl !== after.baseUrl : false,
    steps: { before: beforeSteps.length, after: afterSteps.length, added: afterSteps.filter((/** @type {string} */ step) => !beforeSteps.includes(step)).length, removed: beforeSteps.filter((/** @type {string} */ step) => !afterSteps.includes(step)).length },
    expectAdded: [...afterExpect].filter((item) => !beforeExpect.has(item)),
    // Removing an expectation is how a regression gets hidden; it is called out by name.
    expectRemoved: [...beforeExpect].filter((item) => !afterExpect.has(item)),
  };
}

/**
 * Read an approved scenario, or refuse if the file is not what was approved.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {string} name
 * @returns {Record<string, any>}
 */
export function loadApprovedScenario(workspace, projectId, name) {
  const target = relativeTarget(safeId(name, 'scenario name'));
  const content = readOrNull(path.join(projectDir(workspace, projectId), target));
  if (content === null) throw new AutoDevError(ErrorCodes.NOT_FOUND, `No scenario named "${name}" exists for this project.`);
  if (readIntegrity(workspace, projectId)[target] !== sha256(content)) {
    throw new AutoDevError(
      ErrorCodes.INTEGRITY_VIOLATION,
      `${target} was created or changed outside the approval process, so it is not run as a baseline. Propose the change with "autodev scenario propose", or have a person restore the approved file.`,
      { details: { targetPath: target, howToCheck: 'autodev scenario verify' } },
    );
  }
  return validateScenario(JSON.parse(content));
}

/**
 * Stage a scenario and request approval for its exact content.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {{ projectId: string, scenario: unknown, reason: string, appHosts: string[], trial?: Record<string, any> | null }} input
 */
export async function proposeScenario(workspace, input) {
  const scenario = validateScenario(input.scenario);
  const reason = String(input.reason ?? '').replace(/\s+/g, ' ').trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'Give a --reason of 10 to 500 characters: what the scenario covers, or why the approved one has to change.');
  }
  if (containsSecret(reason) || redactString(reason, { pii: true }) !== reason) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'The reason appears to contain a secret or personal data. Rephrase it without them.');
  }
  assertAppHost(scenario.baseUrl, input.appHosts);

  const target = relativeTarget(scenario.name);
  const current = readOrNull(path.join(projectDir(workspace, input.projectId), target));
  /** @type {Record<string, any> | null} */
  let before = null;
  if (current !== null) {
    if (readIntegrity(workspace, input.projectId)[target] !== sha256(current)) {
      throw new AutoDevError(ErrorCodes.INTEGRITY_VIOLATION, `${target} was changed outside the approval process. A person must restore or remove it before it can be updated.`, { details: { targetPath: target } });
    }
    before = JSON.parse(current);
  }
  const content = serialize(scenario);
  if (current === content) {
    throw new AutoDevError(ErrorCodes.CONFLICT, 'The proposed scenario is identical to the approved one. There is nothing to approve.');
  }
  const change = describeChange(before, scenario);
  // The change summary is part of what is approved, so the reviewer sees what
  // an update removes without comparing two documents by eye.
  const payload = { targetPath: target, baseHash: current === null ? null : sha256(current), reason, change, content };

  const approval = await requestApproval(workspace, {
    projectId: input.projectId,
    action: Actions.SCENARIO_WRITE,
    summary: `${before ? 'Change' : 'Add'} end-to-end scenario "${scenario.name}" (${scenario.steps.length} steps, ${scenario.expect.length} expected calls${change.expectRemoved.length ? `, REMOVES ${change.expectRemoved.length} expectation(s)` : ''})`,
    payload,
  });
  const file = proposalFile(workspace, input.projectId, approval.id);
  ensureDir(path.dirname(file));
  atomicWriteJson(file, { approvalId: approval.id, projectId: input.projectId, name: scenario.name, payload, change, trial: input.trial ?? null, stagedAt: new Date().toISOString() });
  return {
    approvalId: approval.id,
    status: approval.status,
    targetPath: `projects/${input.projectId}/${target}`,
    change,
    reason,
    next: `A person reviews it in their own terminal: autodev approvals review ${approval.id} --project ${input.projectId}. Then: autodev scenario apply --approval ${approval.id}`,
  };
}

/**
 * Write an approved scenario. Exactly the approved content is written.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {{ projectId: string, approvalId: string, dryRun?: boolean }} input
 */
export async function applyScenario(workspace, input) {
  const proposal = readJson(proposalFile(workspace, input.projectId, input.approvalId), /** @type {Record<string, any> | null} */ (null));
  if (!proposal) throw new AutoDevError(ErrorCodes.NOT_FOUND, `No staged scenario for approval ${input.approvalId}.`);
  const { payload } = proposal;
  if (payload.targetPath !== relativeTarget(safeId(proposal.name, 'scenario name'))) {
    throw new AutoDevError(ErrorCodes.INTEGRITY_VIOLATION, 'The staged scenario targets a path outside the scenarios folder.');
  }
  const absolute = path.join(projectDir(workspace, input.projectId), payload.targetPath);

  return withLock(`${scenarioIntegrityFile(workspace, input.projectId)}.lock`, async () => {
    const current = readOrNull(absolute);
    if ((current === null ? null : sha256(current)) !== payload.baseHash) {
      throw new AutoDevError(ErrorCodes.CONFLICT, 'The scenario file changed after this change was proposed. Propose it again so the approval matches the current file.', {
        details: { targetPath: payload.targetPath },
      });
    }
    if (input.dryRun) {
      return { dryRun: true, approvalStatus: getApproval(workspace, input.projectId, input.approvalId).status, wouldWrite: payload.targetPath, change: proposal.change };
    }
    await consumeApproval(workspace, { projectId: input.projectId, id: input.approvalId, action: Actions.SCENARIO_WRITE, payload });
    atomicWriteFile(absolute, payload.content);
    const integrity = readIntegrity(workspace, input.projectId);
    integrity[payload.targetPath] = sha256(payload.content);
    atomicWriteJson(scenarioIntegrityFile(workspace, input.projectId), integrity);
    fs.rmSync(proposalFile(workspace, input.projectId, input.approvalId), { force: true });
    await appendAudit(workspace, input.projectId, {
      action: 'scenario.written',
      outcome: 'success',
      details: { approvalId: input.approvalId, targetPath: payload.targetPath, fileHash: integrity[payload.targetPath], change: proposal.change },
    });
    return { written: true, targetPath: `projects/${input.projectId}/${payload.targetPath}`, approvalId: input.approvalId, change: proposal.change };
  });
}

/**
 * Every scenario file with its integrity state, plus pending proposals and drafts.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 */
export function listScenarios(workspace, projectId) {
  const dir = path.join(projectDir(workspace, projectId), 'scenarios');
  const integrity = readIntegrity(workspace, projectId);
  /** @type {Array<Record<string, any>>} */
  const scenarios = [];
  const seen = new Set();
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir).sort()) {
      if (!entry.endsWith('.json')) continue;
      const target = `scenarios/${entry}`;
      const content = readOrNull(path.join(dir, entry));
      if (content === null) continue;
      seen.add(target);
      const state = !integrity[target] ? 'never-approved' : integrity[target] === sha256(content) ? 'approved' : 'modified-outside-approval';
      /** @type {Record<string, any>} */
      const row = { name: entry.slice(0, -5), path: target, state };
      if (state === 'approved') {
        try {
          const doc = JSON.parse(content);
          Object.assign(row, { title: doc.title, baseUrl: doc.baseUrl, steps: doc.steps?.length ?? 0, expect: doc.expect?.length ?? 0, code: doc.code ?? [] });
        } catch {
          row.state = 'unreadable';
        }
      }
      scenarios.push(row);
    }
  }
  for (const target of Object.keys(integrity)) {
    if (!seen.has(target)) scenarios.push({ name: path.basename(target, '.json'), path: target, state: 'missing' });
  }
  const listJson = (/** @type {string} */ sub) => {
    const folder = path.join(scenarioStateDir(workspace, projectId), sub);
    return fs.existsSync(folder) ? fs.readdirSync(folder).filter((name) => name.endsWith('.json')).map((name) => path.join(folder, name)) : [];
  };
  const proposals = listJson('proposals').map((file) => {
    const proposal = readJson(file);
    let status = 'unknown';
    try {
      status = getApproval(workspace, projectId, proposal.approvalId).status;
    } catch {
      // approval record gone
    }
    return { approvalId: proposal.approvalId, name: proposal.name, status, change: proposal.change, stagedAt: proposal.stagedAt };
  });
  const drafts = listJson('drafts').map((file) => ({ name: path.basename(file, '.json'), file }));
  return { valid: scenarios.every((row) => row.state === 'approved'), scenarios, proposals, drafts };
}

/**
 * Approved scenarios whose code references overlap a set of changed files.
 * @param {import('../core/workspace.js').Workspace} workspace
 * @param {string} projectId
 * @param {{ repo: string, changedPaths: string[] }} input
 */
export function affectedScenarios(workspace, projectId, input) {
  const changed = input.changedPaths.map((file) => file.split('\\').join('/'));
  const { scenarios } = listScenarios(workspace, projectId);
  const approved = scenarios.filter((row) => row.state === 'approved');
  const affected = [];
  for (const row of approved) {
    const refs = /** @type {Array<{ repo: string, path: string }>} */ (row.code ?? []).filter((ref) => ref.repo === input.repo);
    const matched = changed.filter((file) => refs.some((ref) => file === ref.path || file.startsWith(`${ref.path.replace(/\/+$/, '')}/`)));
    if (matched.length > 0) affected.push({ name: row.name, title: row.title, matchedFiles: matched });
  }
  return {
    repository: input.repo,
    changedFiles: changed.length,
    affected,
    unmapped: approved.filter((row) => (row.code ?? []).length === 0).map((row) => row.name),
    note: 'A scenario is listed when a file it references changed. Scenarios with no code references ("unmapped") cannot be matched and should be run when in doubt.',
  };
}

/* ----------------------------------------------------------------------------
 * Running
 * ------------------------------------------------------------------------- */

/**
 * @param {string} baseUrl
 * @param {string[]} appHosts
 */
export function assertAppHost(baseUrl, appHosts) {
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  const allowed = appHosts.some((entry) => {
    const pattern = entry.toLowerCase();
    return pattern.startsWith('*.') ? hostname.endsWith(pattern.slice(1)) : hostname === pattern;
  });
  if (!allowed) {
    throw new AutoDevError(
      ErrorCodes.HOST_NOT_ALLOWED,
      `"${hostname}" is not an application host of this project. Scenarios run only against hosts in browser.allowedHosts that are not the ticketing, source-control or telemetry systems.`,
      { details: { host: hostname, appHosts } },
    );
  }
}

/**
 * Turn a scenario into concrete browser steps for one run.
 * @param {Record<string, any>} scenario validated scenario
 * @param {{ baseUrl?: string | null, unique?: string }} [options]
 */
export function materializeSteps(scenario, options = {}) {
  const baseUrl = (options.baseUrl ?? scenario.baseUrl).replace(/\/+$/, '');
  const unique = options.unique ?? `e2e${Date.now().toString(36)}`;
  const fillIn = (/** @type {string} */ value) => value.split('{{unique}}').join(unique);
  return {
    baseUrl,
    unique,
    steps: scenario.steps.map((/** @type {Record<string, any>} */ step) => {
      const out = { ...step };
      if (out.action === 'goto') out.url = `${baseUrl}${out.url}`;
      for (const key of ['value', 'contains']) if (typeof out[key] === 'string') out[key] = fillIn(out[key]);
      return out;
    }),
  };
}

/**
 * Compare the calls a run made with the calls the scenario expects.
 * @param {Array<{ method: string, path: string, status: number | number[] }>} expect
 * @param {Array<{ method: string, path: string, status: number }>} observed
 */
export function evaluateExpectations(expect, observed) {
  const results = expect.map((want) => {
    const statuses = /** @type {number[]} */ ([]).concat(want.status);
    const sameCall = observed.filter((call) => call.method === want.method && pathMatches(want.path, call.path));
    const matched = sameCall.filter((call) => statuses.includes(call.status));
    return {
      method: want.method,
      path: want.path,
      status: want.status,
      met: matched.length > 0,
      seen: sameCall.length,
      // The call happened but answered differently: the most useful thing to report.
      otherStatuses: matched.length > 0 ? [] : [...new Set(sameCall.map((call) => call.status))],
    };
  });
  const serverErrors = observed.filter((call) => call.status >= 500).map((call) => ({ method: call.method, path: templatePath(call.path), status: call.status }));
  return {
    ok: results.every((result) => result.met) && serverErrors.length === 0,
    met: results.filter((result) => result.met).length,
    total: results.length,
    results,
    serverErrors: serverErrors.slice(0, 20),
  };
}
