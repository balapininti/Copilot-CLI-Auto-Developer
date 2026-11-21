/**
 * Deterministic code-review checks over a diff.
 *
 * These catch what a pattern can catch reliably (secrets, disabled TLS,
 * string-built SQL, schema changes, disabled tests, oversized changes). They
 * are the automated half of the review gate; the code-reviewer agent supplies
 * the judgement half and records its own verdict.
 *
 * Severity: blocker stops the PR; major must be resolved or explicitly
 * accepted by the reviewer; minor and info are advisory.
 */

import { containsHardcodedSecret } from '../../core/redact.js';

/**
 * @typedef {{ path: string, isNew: boolean, isBinary: boolean, added: Array<{ line: number, text: string }>, deleted: number }} DiffFile
 * @typedef {{ rule: string, severity: 'blocker' | 'major' | 'minor' | 'info', file: string | null, line: number | null, message: string }} Finding
 */

/**
 * Parse a unified diff into per-file added lines.
 * @param {string} patch
 * @returns {DiffFile[]}
 */
export function parseDiff(patch) {
  /** @type {DiffFile[]} */
  const files = [];
  /** @type {DiffFile | null} */
  let current = null;
  let newLine = 0;
  // Lines still expected in the current hunk. While either is above zero we are
  // inside hunk content, where "+++x" and "---x" are ordinary changed lines.
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of patch.split('\n')) {
    if (current && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith('+')) {
        current.added.push({ line: newLine, text: line.slice(1) });
        newLine += 1;
        newLeft -= 1;
        continue;
      }
      if (line.startsWith('-')) {
        current.deleted += 1;
        oldLeft -= 1;
        continue;
      }
      if (line.startsWith(' ') || line === '') {
        newLine += 1;
        oldLeft -= 1;
        newLeft -= 1;
        continue;
      }
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
      oldLeft = 0; // anything else ends the hunk
      newLeft = 0;
    }
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      current = { path: match?.[2] ?? 'unknown', isNew: false, isBinary: false, added: [], deleted: 0 };
      files.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith('new file mode')) {
      current.isNew = true;
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.isBinary = true;
    } else if (line.startsWith('+++ b/')) {
      current.path = line.slice(6);
    } else if (line.startsWith('@@')) {
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      newLine = Number(hunk?.[2] ?? 1);
      oldLeft = hunk ? Number(hunk[1] ?? 1) : 0;
      newLeft = hunk ? Number(hunk[3] ?? 1) : 0;
    }
  }
  return files;
}

const isTest = (/** @type {string} */ file) => /(^|\/)(src\/test\/|tests?\/|__tests__\/|e2e\/)|(Test|Tests|IT|Spec)\.(java|kt)$|\.(test|spec)\.[jt]sx?$/.test(file);
const isSource = (/** @type {string} */ file) => /\.(java|kt|[jt]sx?|vue)$/.test(file) && !isTest(file);
const isSchemaChange = (/** @type {string} */ file) =>
  /\.(sql|ddl)$/i.test(file) || /(^|\/)(db\/migration|migrations?|liquibase|flyway|changelog)\//i.test(file) || /changelog.*\.(xml|ya?ml|json)$/i.test(file);
const isDependencyFile = (/** @type {string} */ file) =>
  /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|libs\.versions\.toml|package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(file);

/** @type {Array<{ rule: string, severity: Finding['severity'], pattern: RegExp, message: string, appliesTo?: (file: string) => boolean }>} */
const LINE_RULES = [
  {
    rule: 'tls-validation-disabled',
    severity: 'blocker',
    pattern: /NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized\s*:\s*false|InsecureTrustManagerFactory|TrustAll|ALLOW_ALL_HOSTNAME_VERIFIER|NoopHostnameVerifier|HostnameVerifier\s*\(\s*\([^)]*\)\s*->\s*true|verify\s*=\s*False|ignoreHTTPSErrors\s*:\s*true|--insecure\b/,
    message: 'Disables TLS certificate or hostname validation.',
  },
  {
    rule: 'sql-string-concatenation',
    severity: 'major',
    pattern: /"\s*(SELECT|INSERT|UPDATE|DELETE|MERGE)\b[^"]*"\s*\+|\+\s*"\s*(WHERE|AND|OR|VALUES|SET)\b|String\.format\(\s*"\s*(SELECT|INSERT|UPDATE|DELETE)\b/i,
    message: 'SQL appears to be built by string concatenation. Use bind parameters.',
    appliesTo: isSource,
  },
  {
    rule: 'sensitive-data-logged',
    severity: 'major',
    pattern: /\b(log|logger|LOG|console)\.\w+\([^)]*\b(password|passwd|secret|token|ssn|cardNumber|authorization)\b/i,
    message: 'A log statement references what looks like sensitive data.',
    appliesTo: isSource,
  },
  {
    rule: 'test-disabled',
    severity: 'major',
    pattern: /@Disabled\b|@Ignore\b|\b(describe|it|test)\.(skip|only)\(|\bxit\(|\bxdescribe\(/,
    message: 'A test is disabled or focused. Remove it or justify it in the PR.',
  },
  {
    rule: 'debug-output',
    severity: 'minor',
    pattern: /System\.(out|err)\.print|\.printStackTrace\(\)|\bconsole\.(log|debug)\(|\bdebugger\b/,
    message: 'Debug output left in production code. Use the project logger.',
    appliesTo: isSource,
  },
  {
    rule: 'swallowed-exception',
    severity: 'minor',
    pattern: /catch\s*\([^)]*\)\s*\{\s*\}/,
    message: 'Exception is caught and ignored.',
    appliesTo: isSource,
  },
  { rule: 'todo-added', severity: 'minor', pattern: /\b(TODO|FIXME|HACK|XXX)\b/, message: 'New TODO/FIXME marker.' },
  {
    rule: 'hardcoded-url',
    severity: 'minor',
    pattern: /https?:\/\/(?!localhost|127\.0\.0\.1|example\.(com|org)|www\.w3\.org|maven\.apache\.org|xmlns|schemas\.)[\w.-]+\.[a-z]{2,}/i,
    message: 'Hard-coded URL. Environment-specific endpoints belong in configuration.',
    appliesTo: isSource,
  },
];

/**
 * @param {DiffFile[]} files
 * @param {{ maxFiles?: number, maxLines?: number, schemaChangeAuthorized?: boolean }} [options]
 */
export function reviewDiff(files, options = {}) {
  const maxFiles = options.maxFiles ?? 50;
  const maxLines = options.maxLines ?? 2000;
  /** @type {Finding[]} */
  const findings = [];
  const addedTotal = files.reduce((sum, file) => sum + file.added.length, 0);

  for (const file of files) {
    for (const { line, text } of file.added) {
      if (containsHardcodedSecret(text, { code: isSource(file.path) || isTest(file.path) })) {
        findings.push({ rule: 'secret-in-diff', severity: 'blocker', file: file.path, line, message: 'Added line appears to contain a secret or credential.' });
      }
      for (const rule of LINE_RULES) {
        if (rule.appliesTo && !rule.appliesTo(file.path)) continue;
        if (rule.pattern.test(text)) {
          findings.push({ rule: rule.rule, severity: rule.severity, file: file.path, line, message: rule.message });
        }
      }
    }
    if (isSchemaChange(file.path)) {
      findings.push({
        rule: 'schema-change',
        severity: options.schemaChangeAuthorized ? 'info' : 'blocker',
        file: file.path,
        line: null,
        message: options.schemaChangeAuthorized
          ? 'Schema or migration file changed (authorized for this story).'
          : 'Schema or migration file changed. Schema modifications need explicit authorization.',
      });
    }
    if (isDependencyFile(file.path)) {
      const addsDependency = file.added.some(({ text }) => /<dependency>|<artifactId>|implementation\s|api\s|compile\s|"[\w@/.-]+"\s*:\s*"[\^~\d]/.test(text));
      findings.push({
        rule: 'dependency-change',
        severity: addsDependency ? 'major' : 'info',
        file: file.path,
        line: null,
        message: addsDependency
          ? 'Dependencies were added or changed. Confirm the version, licence and that it is approved.'
          : 'Build configuration changed.',
      });
    }
    if (/(^|\/)\.env(\.|$)|\.(pem|p12|pfx|jks|keystore)$/i.test(file.path)) {
      findings.push({ rule: 'credential-file', severity: 'blocker', file: file.path, line: null, message: 'Credential or key material file in the change.' });
    }
  }

  const sourceChanged = files.some((file) => isSource(file.path) && file.added.length > 0);
  const testsChanged = files.some((file) => isTest(file.path));
  if (sourceChanged && !testsChanged) {
    findings.push({ rule: 'no-test-change', severity: 'major', file: null, line: null, message: 'Source changed but no test was added or updated.' });
  }
  if (files.length > maxFiles || addedTotal > maxLines) {
    findings.push({
      rule: 'change-too-large',
      severity: 'major',
      file: null,
      line: null,
      message: `Change is large (${files.length} files, ${addedTotal} added lines). It needs a human reviewer and probably splitting.`,
    });
  }

  const counts = { blocker: 0, major: 0, minor: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return {
    passed: counts.blocker === 0,
    counts,
    stats: { files: files.length, addedLines: addedTotal, sourceChanged, testsChanged },
    findings,
  };
}
