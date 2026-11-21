/**
 * SQL guard for DB2 access.
 *
 * Only a single read-only SELECT (optionally with a leading WITH) against the
 * project's own schemas passes. The guard is a conservative filter, not a SQL
 * parser: anything it cannot classify as safe is rejected. It complements, and
 * does not replace, connecting with a read-only database account.
 */

import { AutoDevError, ErrorCodes } from '../../core/errors.js';

const FORBIDDEN = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'CREATE', 'ALTER', 'DROP', 'RENAME', 'GRANT', 'REVOKE',
  'CALL', 'EXECUTE', 'PREPARE', 'SET', 'LOCK', 'COMMENT', 'LABEL', 'REFRESH', 'COMMIT', 'ROLLBACK', 'SAVEPOINT',
  'EXPORT', 'IMPORT', 'LOAD', 'REORG', 'RUNSTATS', 'DECLARE', 'BEGIN', 'CONNECT', 'TRANSFER', 'FLUSH', 'AUDIT',
];

/** Catalog schemas that are always readable for introspection. */
export const CATALOG_SCHEMAS = Object.freeze(['SYSCAT', 'SYSIBM', 'SYSSTAT']);

/** Words that can follow a table reference without being its alias. */
const CLAUSE_KEYWORDS = new Set([
  'WHERE', 'ON', 'ORDER', 'GROUP', 'HAVING', 'FETCH', 'UNION', 'EXCEPT', 'INTERSECT', 'JOIN', 'INNER', 'LEFT', 'RIGHT',
  'FULL', 'CROSS', 'OUTER', 'LIMIT', 'OFFSET', 'WITH', 'FOR', 'AS', 'AND', 'OR', 'USING', 'SELECT', 'FROM', 'NOT', 'IN',
  'IS', 'THEN', 'ELSE', 'END', 'WHEN', 'BETWEEN', 'LIKE', 'OVER', 'ASC', 'DESC',
]);

const IDENTIFIER =/^[A-Za-z_#@$][A-Za-z0-9_#@$]{0,127}$/;

/**
 * @param {string} reason
 * @returns {never}
 */
function reject(reason) {
  throw new AutoDevError(ErrorCodes.SQL_REJECTED, `SQL rejected: ${reason}`, { details: { reason } });
}

/**
 * Replace string literals, quoted identifiers and comments with placeholders
 * so keyword checks cannot be fooled by their contents.
 * @param {string} sql
 * @returns {string}
 */
export function stripLiteralsAndComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      out += ' ';
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) reject('unterminated comment');
      i = end + 2;
      out += ' ';
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      for (;;) {
        const close = sql.indexOf(ch, j);
        if (close === -1) reject('unterminated quoted text');
        if (sql[close + 1] === ch) {
          j = close + 2; // doubled quote = escaped quote
          continue;
        }
        j = close + 1;
        break;
      }
      // Quoted identifiers could hide a schema name; they are not supported.
      if (ch === '"') reject('quoted identifiers are not supported; use plain SCHEMA.TABLE names');
      out += "''";
      i = j;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/**
 * @param {string} name
 * @param {string} label
 */
export function assertIdentifier(name, label = 'identifier') {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, `Invalid ${label}.`);
  }
  return name.toUpperCase();
}

/** Scalar functions whose argument syntax contains the word FROM. */
const FROM_FUNCTIONS = new Set(['EXTRACT', 'TRIM', 'SUBSTRING', 'OVERLAY', 'POSITION', 'LTRIM', 'RTRIM']);

const IDENT_TOKEN = /^[A-Z_#@$][A-Z0-9_#@$]*$/;

/** Keywords that end a FROM clause at the same parenthesis depth. */
const FROM_END = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'FETCH', 'UNION', 'EXCEPT', 'INTERSECT', 'LIMIT', 'OFFSET', 'FOR', 'SELECT', 'WINDOW', 'QUALIFY']);

/**
 * Validate a query. Returns the normalised statement and the schemas it reads.
 *
 * The statement is tokenised (after literals and comments are removed) and
 * walked once. Every position where a table can be named is checked: after
 * FROM, after JOIN, and at the start of a parenthesised join. Commas at
 * FROM-clause level are refused, because they would introduce a table without
 * a keyword in front of it.
 * @param {string} sql
 * @param {{ allowedSchemas: string[], params?: unknown[], allowCatalog?: boolean }} options `allowCatalog` is for the built-in introspection helpers only
 * @returns {{ sql: string, schemas: string[], paramCount: number }}
 */
export function validateSelect(sql, options) {
  if (typeof sql !== 'string' || sql.trim().length === 0) reject('empty statement');
  if (sql.length > 20_000) reject('statement too long');
  const trimmed = sql.trim().replace(/;\s*$/, '');
  const bare = stripLiteralsAndComments(trimmed);
  if (bare.includes(';')) reject('multiple statements are not allowed');

  const upper = bare.toUpperCase();
  if (!/^\s*(SELECT|WITH)\b/.test(upper)) reject('only SELECT statements are allowed');
  for (const keyword of FORBIDDEN) {
    if (new RegExp(`(^|[^A-Z0-9_#@$])${keyword}([^A-Z0-9_#@$]|$)`).test(upper)) reject(`keyword ${keyword} is not allowed`);
  }
  if (/\bFOR\s+UPDATE\b/.test(upper)) reject('FOR UPDATE is not allowed');
  if (/\b(FINAL|NEW|OLD)\s+TABLE\b/.test(upper)) reject('data-change table references are not allowed');
  if (/\bINTO\b/.test(upper)) reject('SELECT INTO is not allowed');
  if (/\b(NEXT|PREVIOUS)\s+VALUE\s+FOR\b|\b(NEXTVAL|PREVVAL)\b/.test(upper)) reject('sequence expressions are not allowed (NEXT VALUE advances a sequence)');

  // Catalog views can expose other schemas' definitions and sampled data, so
  // free-form queries may read the project's schemas only.
  const allowed = new Set([...options.allowedSchemas, ...(options.allowCatalog ? CATALOG_SCHEMAS : [])].map((schema) => schema.toUpperCase()));
  const cteNames = new Set([...upper.matchAll(/(?:\bWITH|,)\s*([A-Z_#@$][A-Z0-9_#@$]*)\s*(?:\([^()]*\))?\s*\bAS\s*\(/g)].map((match) => match[1]));
  const tokens = upper.match(/[A-Z_#@$][A-Z0-9_#@$]*|\d+(?:\.\d+)?|''|[(),.*?]|[^\sA-Z0-9_#@$(),.*?']+/g) ?? [];
  const isIdent = (/** @type {string | undefined} */ token) => typeof token === 'string' && IDENT_TOKEN.test(token);

  /** @type {Set<string>} */
  const schemas = new Set();
  /** Names that may legitimately appear before a dot: aliases, table names, CTEs. */
  const qualifiers = new Set(cteNames);
  /** One entry per open parenthesis: is a FROM clause active at this depth? */
  const fromActive = [false];
  /** Parallel to fromActive: is this parenthesis the argument list of a function that uses FROM as syntax? */
  const functionParen = [false];
  let found = 0;

  /**
   * Read a table reference starting at tokens[index]; returns the index after it.
   * @param {number} index
   * @returns {number}
   */
  const readTable = (index) => {
    const token = tokens[index];
    if (token === '(') {
      const next = tokens[index + 1];
      fromActive.push(false);
      if (next === 'SELECT' || next === 'WITH') return index + 1; // subquery: its own FROM is checked when reached
      // Parenthesised join: a table reference starts right here.
      fromActive[fromActive.length - 1] = true;
      return readTable(index + 1);
    }
    if (token === 'LATERAL') {
      if (tokens[index + 1] !== '(') reject('LATERAL must be followed by a subquery');
      return index + 1;
    }
    if (token === 'TABLE') reject('table functions are not allowed');
    if (!isIdent(token)) reject('expected a table name written as SCHEMA.TABLE');
    let cursor = index + 1;
    if (tokens[cursor] === '.') {
      const table = tokens[cursor + 1];
      if (!isIdent(table)) reject('expected a table name after the schema');
      if (!allowed.has(token)) reject(`schema "${token}" is not mapped to this project`);
      schemas.add(token);
      qualifiers.add(table);
      cursor += 2;
      if (tokens[cursor] === '.') reject('three-part names are not supported');
    } else if (!cteNames.has(token)) {
      reject(`table "${token}" must be schema-qualified (SCHEMA.TABLE)`);
    }
    if (tokens[cursor] === '(') reject('table functions are not allowed');
    found += 1;
    return readAlias(cursor);
  };

  /**
   * Read an optional "[AS] alias" at tokens[index]; returns the index after it.
   * @param {number} index
   * @returns {number}
   */
  const readAlias = (index) => {
    let cursor = index;
    if (tokens[cursor] === 'AS') cursor += 1;
    const alias = tokens[cursor];
    if (isIdent(alias) && !CLAUSE_KEYWORDS.has(alias)) {
      qualifiers.add(alias);
      return cursor + 1;
    }
    return index;
  };

  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i];
    const depth = fromActive.length - 1;
    if ((token === 'FROM' || token === 'JOIN') && !(token === 'FROM' && functionParen[depth])) {
      if (token === 'FROM') fromActive[depth] = true;
      i = readTable(i + 1);
      // readTable may have opened a parenthesis (subquery or parenthesised join).
      while (functionParen.length < fromActive.length) functionParen.push(false);
    } else if (token === '(') {
      fromActive.push(false);
      // EXTRACT(YEAR FROM x), TRIM(BOTH ' ' FROM x), SUBSTRING(x FROM 1): not a table FROM.
      functionParen.push(FROM_FUNCTIONS.has(tokens[i - 1]));
      i += 1;
    } else if (token === ')') {
      if (fromActive.length === 1) reject('unbalanced parentheses');
      fromActive.pop();
      functionParen.pop();
      // A derived table or parenthesised join may carry an alias.
      i = fromActive[fromActive.length - 1] ? readAlias(i + 1) : i + 1;
    } else if (token === ',' && fromActive[depth]) {
      reject('comma-separated table lists are not supported; use explicit JOIN');
    } else {
      if (FROM_END.has(token)) fromActive[depth] = false;
      i += 1;
    }
  }
  if (fromActive.length !== 1) reject('unbalanced parentheses');
  if (found === 0) reject('no table reference found');

  // Every "X." qualifier must be a mapped schema or a name introduced by this query.
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    if (tokens[i + 1] !== '.' || !isIdent(tokens[i])) continue;
    if (!isIdent(tokens[i + 2]) && tokens[i + 2] !== '*') continue;
    if (tokens[i - 1] === '.') continue; // second part of SCHEMA.TABLE.COLUMN
    if (!allowed.has(tokens[i]) && !qualifiers.has(tokens[i])) {
      reject(`"${tokens[i]}" is neither a schema mapped to this project nor an alias defined in the query`);
    }
    // X.F(...) calls a function in schema X; an alias cannot stand in for a schema there.
    if (tokens[i + 3] === '(' && !allowed.has(tokens[i])) {
      reject(`function "${tokens[i]}.${tokens[i + 2]}" is not in a schema mapped to this project`);
    }
  }

  const paramCount = (bare.match(/\?/g) ?? []).length;
  const supplied = options.params?.length ?? 0;
  if (paramCount !== supplied) reject(`statement has ${paramCount} parameter marker(s) but ${supplied} value(s) were supplied`);
  return { sql: trimmed, schemas: [...schemas], paramCount };
}

const DEFAULT_SENSITIVE_COLUMN = /pass(word|wd)?|secret|token|ssn|social|tax_?id|card|cvv|iban|account_?n(o|um)|dob|birth|email|phone|address/i;

/**
 * Mask values in sensitive columns and cap long values.
 * @param {Array<Record<string, unknown>>} rows
 * @param {string[]} [extraColumns]
 */
export function redactRows(rows, extraColumns = []) {
  const extra = new Set(extraColumns.map((column) => column.toUpperCase()));
  return rows.map((row) => {
    /** @type {Record<string, unknown>} */
    const copy = {};
    for (const [column, value] of Object.entries(row)) {
      if (value !== null && (extra.has(column.toUpperCase()) || DEFAULT_SENSITIVE_COLUMN.test(column))) {
        copy[column] = '[REDACTED:column]';
      } else if (typeof value === 'string' && value.length > 500) {
        copy[column] = `${value.slice(0, 500)}… (${value.length} chars)`;
      } else if (Buffer.isBuffer(value)) {
        copy[column] = `[binary ${value.length} bytes]`;
      } else {
        copy[column] = value;
      }
    }
    return copy;
  });
}
