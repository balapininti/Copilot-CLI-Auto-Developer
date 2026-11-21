/**
 * Error contract shared by every script, adapter and workflow.
 *
 * Every failure that leaves this framework is an AutoDevError with a stable
 * machine-readable code, so agents can branch on `error.code` instead of
 * parsing prose.
 */

export const ErrorCodes = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  CONFIG_INVALID: 'CONFIG_INVALID',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UNSUPPORTED: 'UNSUPPORTED',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  PROJECT_AMBIGUOUS: 'PROJECT_AMBIGUOUS',
  PROJECT_SCOPE_VIOLATION: 'PROJECT_SCOPE_VIOLATION',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_FAILED: 'AUTH_FAILED',
  ACCESS_DENIED: 'ACCESS_DENIED',
  NOT_FOUND: 'NOT_FOUND',
  HOST_NOT_ALLOWED: 'HOST_NOT_ALLOWED',
  TLS_POLICY_VIOLATION: 'TLS_POLICY_VIOLATION',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_DENIED: 'APPROVAL_DENIED',
  APPROVAL_MISMATCH: 'APPROVAL_MISMATCH',
  POLICY_PROHIBITED: 'POLICY_PROHIBITED',
  DIRTY_WORKTREE: 'DIRTY_WORKTREE',
  BRANCH_MISSING: 'BRANCH_MISSING',
  REPO_URL_NOT_APPROVED: 'REPO_URL_NOT_APPROVED',
  SQL_REJECTED: 'SQL_REJECTED',
  QUERY_REJECTED: 'QUERY_REJECTED',
  GATE_FAILED: 'GATE_FAILED',
  CONFLICT: 'CONFLICT',
  LOCKED: 'LOCKED',
  INTEGRITY_VIOLATION: 'INTEGRITY_VIOLATION',
  INTERNAL: 'INTERNAL',
});

/** Codes that a caller may retry without changing anything. @type {Set<string>} */
const RETRYABLE = new Set([
  ErrorCodes.RATE_LIMITED,
  ErrorCodes.TIMEOUT,
  ErrorCodes.NETWORK,
  ErrorCodes.LOCKED,
]);

/**
 * Process exit codes. 0 success, 1 unexpected, 2 usage/config, 3 blocked on a
 * human (approval or sign-in), 4 refused by policy, 5 upstream/transient.
 */
const EXIT_CODES = Object.freeze({
  INVALID_ARGUMENT: 2,
  CONFIG_INVALID: 2,
  NOT_CONFIGURED: 2,
  UNSUPPORTED: 2,
  PROJECT_NOT_FOUND: 2,
  PROJECT_AMBIGUOUS: 2,
  APPROVAL_REQUIRED: 3,
  AUTH_REQUIRED: 3,
  PROJECT_SCOPE_VIOLATION: 4,
  POLICY_PROHIBITED: 4,
  APPROVAL_DENIED: 4,
  APPROVAL_MISMATCH: 4,
  HOST_NOT_ALLOWED: 4,
  TLS_POLICY_VIOLATION: 4,
  SQL_REJECTED: 4,
  QUERY_REJECTED: 4,
  REPO_URL_NOT_APPROVED: 4,
  DIRTY_WORKTREE: 4,
  BRANCH_MISSING: 4,
  GATE_FAILED: 4,
  INTEGRITY_VIOLATION: 4,
  RATE_LIMITED: 5,
  TIMEOUT: 5,
  NETWORK: 5,
  UPSTREAM_ERROR: 5,
  AUTH_FAILED: 5,
  ACCESS_DENIED: 5,
  NOT_FOUND: 5,
  CONFLICT: 5,
  LOCKED: 5,
});

export class AutoDevError extends Error {
  /**
   * @param {string} code One of ErrorCodes.
   * @param {string} message Human-readable, already free of secrets.
   * @param {{ retryable?: boolean, details?: Record<string, unknown>, cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AutoDevError';
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.details = options.details ?? {};
  }
}

/**
 * Coerce anything thrown into an AutoDevError. Unknown errors become INTERNAL
 * and keep only their message; stacks never leave the process boundary.
 * @param {unknown} error
 * @returns {AutoDevError}
 */
export function toAutoDevError(error) {
  if (error instanceof AutoDevError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AutoDevError(ErrorCodes.INTERNAL, message, { cause: error });
}

/**
 * @param {string} code
 * @returns {number}
 */
export function exitCodeFor(code) {
  return Object.hasOwn(EXIT_CODES, code) ? EXIT_CODES[/** @type {keyof typeof EXIT_CODES} */ (code)] : 1;
}

/**
 * Throw INVALID_ARGUMENT unless the condition holds.
 * @param {unknown} condition
 * @param {string} message
 * @returns {asserts condition}
 */
export function requireArg(condition, message) {
  if (!condition) throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, message);
}
