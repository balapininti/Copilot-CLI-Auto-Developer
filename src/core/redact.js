/**
 * Redaction applied to everything that leaves the process: logs, CLI results,
 * ticket bodies, test evidence and prompts.
 *
 * Two layers: exact values of secrets this process has loaded (registered by
 * the secrets module) and shape-based patterns for secrets and personal data
 * that arrive from elsewhere, such as log lines pulled from Splunk.
 */

const MIN_SECRET_LENGTH = 6;

/** @type {Map<string, string>} exact secret value -> label */
const knownSecrets = new Map();

/**
 * Register a secret value so any later occurrence is masked.
 * @param {string | null | undefined} value
 * @param {string} [label]
 */
export function registerSecret(value, label = 'secret') {
  if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return;
  knownSecrets.set(value, label);
}

/** Test hook. */
export function clearRegisteredSecrets() {
  knownSecrets.clear();
}

const SENSITIVE_KEY =
  /pass(word|wd|phrase)|^pass$|secret|token|authorization|cookie|api[-_]?key|credential|private[-_]?key|session[-_]?id|connection[-_]?string|pwd/i;

/**
 * Field names of this framework that contain a sensitive word but only ever
 * hold the NAME of a secret (which variable or credential entry to read),
 * never a secret. Listed exactly; a suffix rule would also exempt real
 * secrets such as `clientSecret`.
 */
const SAFE_NAMES = new Set(['tokenSecret', 'splunkTokenSecret', 'dynatraceTokenSecret', 'connectionSecret', 'secretName', 'tokenAvailable']);

const ASSIGNMENT =
  /([A-Za-z0-9_.-]*(?:pass(?:word|wd|phrase)|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|cookie)[A-Za-z0-9_]*)(["']?[ \t]*[:=][ \t]*)(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"']+))/gi;

/** Values that are clearly not a secret: placeholders, references, empties. */
const PLACEHOLDER_VALUE = /^(|null|none|nil|true|false|undefined|changeme|xxx+|\*+|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%s|\?)$/i;

/** @type {Array<{ label: string, pattern: RegExp, replace?: (match: string, ...groups: string[]) => string }>} */
const SECRET_PATTERNS = [
  { label: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    label: 'authorization',
    pattern: /\b(authorization|proxy-authorization)(["']?[ \t]*[:=][ \t]*["']?)((?:bearer|basic|api-token|splunk|negotiate)[ \t]+)?[^\s"',;]+/gi,
    replace: (_m, key, sep) => `${key}${sep}[REDACTED:authorization]`,
  },
  { label: 'bearer', pattern: /\b(bearer|api-token)\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { label: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g },
  { label: 'github_token', pattern: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { label: 'dynatrace_token', pattern: /\bdt0[a-z]\d{2}\.[A-Z0-9]{8,}\.[A-Z0-9]{16,}/g },
  { label: 'aws_key', pattern: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g },
  {
    // user:password@ and token@ forms; the conventional "git@" user is not a secret.
    label: 'url_credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)(?!git@)[^\s/:@]+(?::[^\s/@]*)?@/gi,
    replace: (_m, scheme) => `${scheme}[REDACTED:url_credentials]@`,
  },
  {
    label: 'assignment',
    pattern: ASSIGNMENT,
    replace: (match, key, sep, dq, sq, bare) => {
      const value = dq ?? sq ?? bare ?? '';
      if (SAFE_NAMES.has(key) || value === '' || value.startsWith('[REDACTED:')) return match;
      return `${key}${sep}[REDACTED:assignment]`;
    },
  },
];

/** Personal data patterns, applied only in `pii` mode (ticket bodies, evidence). */
const PII_PATTERNS = [
  { label: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { label: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: 'card_number', pattern: /\b(?:\d[ -]?){13,19}\b/g, validate: luhnValid },
  { label: 'phone', pattern: /(?<![\w.-])\+?1?[ .-]?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\w-])/g },
];

/**
 * @param {string} candidate
 * @returns {boolean}
 */
function luhnValid(candidate) {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Mask secrets (and, optionally, personal data) in a string.
 * @param {string} text
 * @param {{ pii?: boolean }} [options]
 * @returns {string}
 */
export function redactString(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let output = text;
  // Longest first so a secret containing another is masked whole.
  const secrets = [...knownSecrets.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [value, label] of secrets) {
    if (output.includes(value)) output = output.split(value).join(`[REDACTED:${label}]`);
  }
  for (const { label, pattern, replace } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    output = replace
      ? output.replace(pattern, /** @type {any} */ (replace))
      : output.replace(pattern, `[REDACTED:${label}]`);
  }
  if (options.pii) {
    for (const { label, pattern, validate } of PII_PATTERNS) {
      pattern.lastIndex = 0;
      output = output.replace(pattern, (match) =>
        validate && !validate(match) ? match : `[REDACTED:${label}]`,
      );
    }
  }
  return output;
}

/**
 * Deep-copy a value with secrets masked. Values under sensitive key names are
 * masked whole; every string is pattern-scanned.
 * @template T
 * @param {T} value
 * @param {{ pii?: boolean, extraSensitiveKeys?: string[] }} [options]
 * @returns {T}
 */
export function redact(value, options = {}) {
  const extra = new Set((options.extraSensitiveKeys ?? []).map((key) => key.toLowerCase()));
  const seen = new WeakSet();

  /** @param {unknown} node @returns {unknown} */
  const walk = (node) => {
    if (typeof node === 'string') return redactString(node, options);
    if (node === null || typeof node !== 'object') return node;
    if (seen.has(node)) return '[Circular]';
    seen.add(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node instanceof Date) return node.toISOString();
    if (node instanceof Error) return { name: node.name, message: redactString(node.message, options) };
    /** @type {Record<string, unknown>} */
    const copy = {};
    for (const [key, child] of Object.entries(node)) {
      const sensitive = extra.has(key.toLowerCase()) || (SENSITIVE_KEY.test(key) && !SAFE_NAMES.has(key));
      if (sensitive && child !== null && child !== undefined && typeof child !== 'boolean' && typeof child !== 'number') {
        copy[key] = '[REDACTED:field]';
      } else {
        copy[key] = walk(child);
      }
    }
    return copy;
  };

  return /** @type {T} */ (walk(value));
}

/**
 * True when the text appears to contain a secret. Used to refuse writing
 * secrets into manifests, knowledge files and ticket bodies.
 * @param {string} text
 * @returns {boolean}
 */
export function containsSecret(text) {
  return typeof text === 'string' && redactString(text) !== text;
}

/**
 * True when a line of a change hard-codes a secret. Stricter about what counts
 * than `containsSecret`, so ordinary code such as `token = service.issue()` or
 * a `${PLACEHOLDER}` in configuration is not reported.
 * @param {string} text one line
 * @param {{ code?: boolean }} [options] `code: true` for source files, where only quoted literals count
 * @returns {boolean}
 */
export function containsHardcodedSecret(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return false;
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (label === 'assignment') continue;
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(ASSIGNMENT)) {
    const [, key, , dq, sq, bare] = match;
    if (SAFE_NAMES.has(key)) continue;
    const literal = dq ?? sq;
    const value = (literal ?? bare ?? '').replace(/[,;]+$/, '');
    if (PLACEHOLDER_VALUE.test(value) || value.includes('${') || value.includes('{{')) continue;
    if (options.code) {
      if (literal !== undefined && literal.length >= 6) return true;
    } else if (value.length >= 4) {
      return true;
    }
  }
  return false;
}
