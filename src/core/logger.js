/**
 * Structured, redacted logging. One JSON object per line on stderr, so stdout
 * stays reserved for the command's result envelope.
 */

import { redact } from './redact.js';

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

/** @typedef {keyof typeof LEVELS} LogLevel */

/**
 * @param {string | undefined} name
 * @returns {LogLevel}
 */
function parseLevel(name) {
  const key = (name ?? '').toLowerCase();
  return key in LEVELS ? /** @type {LogLevel} */ (key) : 'info';
}

/**
 * @typedef {object} Logger
 * @property {(message: string, fields?: Record<string, unknown>) => void} debug
 * @property {(message: string, fields?: Record<string, unknown>) => void} info
 * @property {(message: string, fields?: Record<string, unknown>) => void} warn
 * @property {(message: string, fields?: Record<string, unknown>) => void} error
 * @property {(bindings: Record<string, unknown>) => Logger} child
 */

/**
 * @param {{ level?: LogLevel, bindings?: Record<string, unknown>, sink?: (line: string) => void }} [options]
 * @returns {Logger}
 */
export function createLogger(options = {}) {
  const level = options.level ?? parseLevel(process.env.AUTODEV_LOG_LEVEL);
  const bindings = options.bindings ?? {};
  const sink = options.sink ?? ((line) => process.stderr.write(`${line}\n`));

  /** @param {LogLevel} entryLevel */
  const emit = (entryLevel) => (/** @type {string} */ message, /** @type {Record<string, unknown>} */ fields = {}) => {
    if (LEVELS[entryLevel] < LEVELS[level]) return;
    const entry = redact({ ts: new Date().toISOString(), level: entryLevel, msg: message, ...bindings, ...fields });
    sink(JSON.stringify(entry));
  };

  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (extra) => createLogger({ level, sink, bindings: { ...bindings, ...extra } }),
  };
}

/** Logger that discards everything; the default for library calls and tests. */
export const nullLogger = createLogger({ level: 'silent' });
