/**
 * DB2 access: read-only schema introspection and guarded SELECTs.
 *
 * DB2 uses its own approved native authentication. The connection string is
 * a secret named DB2_CONN_<PROFILE> (environment or OS credential store) and
 * may rely on Kerberos / integrated security instead of a password. There is
 * no browser fallback for DB2.
 *
 * The IBM driver (`ibm_db`) is a native module and is not installed by
 * default. When it is absent every call reports UNSUPPORTED with install
 * guidance; nothing is simulated.
 *
 * Status: the guard, limits and redaction are unit-tested. The live driver
 * path has not been verified against a database.
 */

import { AutoDevError, ErrorCodes } from '../../core/errors.js';
import { isMissing } from '../../core/manifest.js';
import { getSecret } from '../../core/secrets.js';
import { assertIdentifier, redactRows, validateSelect } from './guard.js';

/**
 * @param {string} profile
 */
export function connectionSecretName(profile) {
  return `DB2_CONN_${String(profile).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * @typedef {object} Db2Driver
 * @property {(connectionString: string) => Promise<{ query: (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>, close: () => Promise<void> }>} open
 */

/**
 * @returns {Promise<Db2Driver>}
 */
async function loadDriver() {
  let ibmdb;
  try {
    // @ts-ignore optional native dependency, installed separately
    ibmdb = (await import('ibm_db')).default;
  } catch (error) {
    throw new AutoDevError(
      ErrorCodes.UNSUPPORTED,
      'DB2 access needs the IBM driver, which is not installed. Install it with "npm install ibm_db" in the automation folder (requires the IBM CLI driver to be reachable or pre-staged; see docs/db2.md).',
      { cause: error },
    );
  }
  return {
    open: async (connectionString) => {
      const connection = await ibmdb.open(connectionString);
      return {
        query: (sql, params) => connection.query(sql, params),
        close: () => connection.close(),
      };
    },
  };
}

/**
 * @param {Record<string, any>} manifest
 * @param {{ env?: NodeJS.ProcessEnv, driver?: Db2Driver, useCredentialStore?: boolean }} [options]
 */
async function connect(manifest, options = {}) {
  const database = manifest.database;
  if (database.engine !== 'db2') {
    throw new AutoDevError(ErrorCodes.NOT_CONFIGURED, 'This project has no DB2 database configured (database.engine).');
  }
  if (isMissing(database.connectionProfile)) {
    throw new AutoDevError(ErrorCodes.NOT_CONFIGURED, 'database.connectionProfile is not set.', { details: { field: 'database.connectionProfile' } });
  }
  if (database.schemas.length === 0) {
    throw new AutoDevError(ErrorCodes.NOT_CONFIGURED, 'database.schemas is empty; no schema is mapped to this project.');
  }
  const secretName = connectionSecretName(database.connectionProfile);
  const connectionString = await getSecret(secretName, { env: options.env, useCredentialStore: options.useCredentialStore });
  if (!connectionString) {
    throw new AutoDevError(
      ErrorCodes.AUTH_REQUIRED,
      `No DB2 connection is stored for profile "${database.connectionProfile}".`,
      { details: { secretName, howToFix: `Store the connection string as ${secretName} (see docs/db2.md). Use a read-only account.` } },
    );
  }
  const driver = options.driver ?? (await loadDriver());
  try {
    return await driver.open(connectionString);
  } catch (error) {
    throw new AutoDevError(ErrorCodes.AUTH_FAILED, 'Could not connect to DB2 with the stored profile.', {
      details: { profile: database.connectionProfile, sqlState: /** @type {any} */ (error)?.sqlstate ?? null },
      cause: error,
    });
  }
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
  /** @type {NodeJS.Timeout} */
  let timer;
  const timeout = new Promise((_, rejectTimeout) => {
    timer = setTimeout(() => rejectTimeout(new AutoDevError(ErrorCodes.TIMEOUT, `DB2 query exceeded ${ms / 1000} s.`)), ms);
  });
  return /** @type {Promise<T>} */ (Promise.race([promise, timeout]).finally(() => clearTimeout(timer)));
}

/**
 * Run one guarded, parameterised SELECT.
 * @param {Record<string, any>} manifest
 * @param {{ sql: string, params?: unknown[], maxRows?: number }} query
 * @param {{ env?: NodeJS.ProcessEnv, driver?: Db2Driver, useCredentialStore?: boolean }} [options]
 */
export async function runSelect(manifest, query, options = {}) {
  const database = manifest.database;
  const params = query.params ?? [];
  const checked = validateSelect(query.sql, { allowedSchemas: database.schemas, params });
  const requested = query.maxRows ?? database.maxRows;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new AutoDevError(ErrorCodes.INVALID_ARGUMENT, 'maxRows must be a whole number of at least 1.');
  }
  const maxRows = Math.min(requested, database.maxRows);
  // Ask for one extra row so truncation can be reported honestly. The newlines
  // keep a trailing "-- comment" in the statement from swallowing the wrapper.
  const limited = `SELECT * FROM (\n${checked.sql}\n) AS AUTODEV_Q FETCH FIRST ${maxRows + 1} ROWS ONLY`;
  const connection = await connect(manifest, options);
  try {
    const rows = await withTimeout(connection.query(limited, params), database.timeoutSeconds * 1000);
    const truncated = rows.length > maxRows;
    return {
      schemas: checked.schemas,
      rowCount: Math.min(rows.length, maxRows),
      truncated,
      maxRows,
      rows: redactRows(rows.slice(0, maxRows), database.redactColumns),
    };
  } finally {
    await connection.close().catch(() => {});
  }
}

/**
 * List tables in one of the project's schemas.
 * @param {Record<string, any>} manifest
 * @param {string} schema
 * @param {Parameters<typeof runSelect>[2]} [options]
 */
export async function listTables(manifest, schema, options = {}) {
  const name = assertProjectSchema(manifest, schema);
  return runSelect(
    manifest,
    {
      sql: 'SELECT TABNAME, TYPE, CARD, REMARKS FROM SYSCAT.TABLES WHERE TABSCHEMA = ? ORDER BY TABNAME',
      params: [name],
    },
    options,
  );
}

/**
 * Describe the columns of one table.
 * @param {Record<string, any>} manifest
 * @param {string} schema
 * @param {string} table
 * @param {Parameters<typeof runSelect>[2]} [options]
 */
export async function describeTable(manifest, schema, table, options = {}) {
  const name = assertProjectSchema(manifest, schema);
  const result = await runSelect(
    manifest,
    {
      sql: 'SELECT COLNAME, TYPENAME, LENGTH, SCALE, NULLS, KEYSEQ, REMARKS FROM SYSCAT.COLUMNS WHERE TABSCHEMA = ? AND TABNAME = ? ORDER BY COLNO',
      params: [name, assertIdentifier(table, 'table name')],
    },
    options,
  );
  if (result.rowCount === 0) {
    throw new AutoDevError(ErrorCodes.NOT_FOUND, `No table ${name}.${table.toUpperCase()} is visible to this account. Do not assume its columns.`);
  }
  return result;
}

/**
 * @param {Record<string, any>} manifest
 * @param {string} schema
 */
function assertProjectSchema(manifest, schema) {
  const name = assertIdentifier(schema, 'schema name');
  if (!manifest.database.schemas.map((/** @type {string} */ s) => s.toUpperCase()).includes(name)) {
    throw new AutoDevError(ErrorCodes.PROJECT_SCOPE_VIOLATION, `Schema "${name}" is not mapped to this project.`, {
      details: { allowedSchemas: manifest.database.schemas },
    });
  }
  return name;
}
