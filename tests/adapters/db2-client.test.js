import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import YAML from 'yaml';

import { connectionSecretName, describeTable, listTables, runSelect } from '../../src/adapters/db2/client.js';
import { stripLiteralsAndComments } from '../../src/adapters/db2/guard.js';
import { parseManifest } from '../../src/core/manifest.js';
import { clearRegisteredSecrets } from '../../src/core/redact.js';
import { expectCode, fullManifest } from '../helpers.js';

const CONNECTION = 'DATABASE=TESTDB;HOSTNAME=db.example.invalid;UID=reader;PWD=not-a-real-pw-123;';
const ENV = { DB2_CONN_TEST: CONNECTION };

/** @param {Record<string, any>} [database] */
function manifestWith(database = {}) {
  const raw = fullManifest();
  raw.database = { ...raw.database, ...database };
  return parseManifest(YAML.stringify(raw)).manifest;
}

/**
 * @param {Array<Record<string, unknown>> | ((sql: string, params: unknown[]) => Promise<any> | any)} rowsOrFn
 */
function fakeDriver(rowsOrFn) {
  const log = { opened: /** @type {string[]} */ ([]), queries: /** @type {Array<{ sql: string, params: unknown[] }>} */ ([]), closed: 0 };
  return {
    log,
    open: async (/** @type {string} */ connectionString) => {
      log.opened.push(connectionString);
      return {
        query: async (/** @type {string} */ sql, /** @type {unknown[]} */ params) => {
          log.queries.push({ sql, params });
          return typeof rowsOrFn === 'function' ? rowsOrFn(sql, params) : rowsOrFn;
        },
        close: async () => {
          log.closed += 1;
        },
      };
    },
  };
}

const rows = (/** @type {number} */ count) => Array.from({ length: count }, (_, index) => ({ ID: index + 1 }));
const options = (/** @type {any} */ driver, env = ENV) => ({ env, driver, useCredentialStore: false });

after(() => clearRegisteredSecrets());

describe('db2 client with an injected driver', () => {
  test('connectionSecretName derives DB2_CONN_<PROFILE>', () => {
    assert.equal(connectionSecretName('test'), 'DB2_CONN_TEST');
    assert.equal(connectionSecretName('my-profile.1'), 'DB2_CONN_MY_PROFILE_1');
  });

  test('runs a guarded SELECT, passes parameters, and closes the connection', async () => {
    const driver = fakeDriver([{ ID: 1, RATE: 0.1 }]);
    const result = await runSelect(manifestWith(), { sql: 'SELECT D.ID, D.RATE FROM APP.DISCOUNT D WHERE D.ID = ?', params: [1] }, options(driver));
    assert.deepEqual(result, { schemas: ['APP'], rowCount: 1, truncated: false, maxRows: 200, rows: [{ ID: 1, RATE: 0.1 }] });
    assert.deepEqual(driver.log.opened, [CONNECTION]);
    assert.deepEqual(driver.log.queries[0].params, [1]);
    assert.match(driver.log.queries[0].sql, /FETCH FIRST 201 ROWS ONLY$/);
    assert.equal(driver.log.closed, 1);
  });

  test('row cap: one extra row is requested and truncation is flagged', async () => {
    const driver = fakeDriver(rows(4));
    const result = await runSelect(manifestWith(), { sql: 'SELECT ID FROM APP.T', maxRows: 3 }, options(driver));
    assert.match(driver.log.queries[0].sql, /FETCH FIRST 4 ROWS ONLY$/);
    assert.equal(result.rowCount, 3);
    assert.equal(result.rows.length, 3);
    assert.equal(result.truncated, true);
    assert.equal(result.maxRows, 3);
  });

  test('exactly maxRows rows is not reported as truncated', async () => {
    const result = await runSelect(manifestWith(), { sql: 'SELECT ID FROM APP.T', maxRows: 3 }, options(fakeDriver(rows(3))));
    assert.equal(result.rowCount, 3);
    assert.equal(result.truncated, false);
  });

  test('a caller cannot raise the cap above database.maxRows', async () => {
    const driver = fakeDriver(rows(50));
    const result = await runSelect(manifestWith({ maxRows: 5 }), { sql: 'SELECT ID FROM APP.T', maxRows: 10_000 }, options(driver));
    assert.match(driver.log.queries[0].sql, /FETCH FIRST 6 ROWS ONLY$/);
    assert.equal(result.maxRows, 5);
    assert.equal(result.rows.length, 5);
    assert.equal(result.truncated, true);
  });

  test('the cap holds even if the driver ignores FETCH FIRST', async () => {
    const result = await runSelect(manifestWith(), { sql: 'SELECT ID FROM APP.T' }, options(fakeDriver(rows(1000))));
    assert.equal(result.rows.length, 200);
    assert.equal(result.truncated, true);
  });

  test(
    'a non-positive maxRows is refused or clamped, never turned into a negative row count',
    async () => {
      const driver = fakeDriver(rows(3));
      let result;
      try {
        result = await runSelect(manifestWith(), { sql: 'SELECT ID FROM APP.T', maxRows: -1 }, options(driver));
      } catch (error) {
        assert.equal(/** @type {any} */ (error).code, 'INVALID_ARGUMENT');
        return;
      }
      assert.ok(result.rowCount >= 0, `rowCount ${result.rowCount}`);
      assert.ok(result.maxRows >= 1, `maxRows ${result.maxRows}`);
    },
  );

  test(
    'a statement ending in a line comment still gets its row cap',
    async () => {
      const driver = fakeDriver(rows(1));
      await runSelect(manifestWith(), { sql: 'SELECT ID FROM APP.T -- newest first' }, options(driver));
      assert.match(stripLiteralsAndComments(driver.log.queries[0].sql), /FETCH FIRST 201 ROWS ONLY/);
    },
  );

  test('sensitive columns and project redactColumns are masked in results', async () => {
    const driver = fakeDriver([{ ID: 1, EMAIL: 'jane.doe@example.com', LOYALTY_TIER: 'gold', NAME: 'Jane' }]);
    const result = await runSelect(manifestWith({ redactColumns: ['LOYALTY_TIER'] }), { sql: 'SELECT * FROM APP.CUSTOMER' }, options(driver));
    assert.deepEqual(result.rows, [{ ID: 1, EMAIL: '[REDACTED:column]', LOYALTY_TIER: '[REDACTED:column]', NAME: 'Jane' }]);
  });

  test('a rejected statement never opens a connection', async () => {
    const driver = fakeDriver([]);
    await expectCode(() => runSelect(manifestWith(), { sql: 'DELETE FROM APP.T' }, options(driver)), 'SQL_REJECTED');
    await expectCode(() => runSelect(manifestWith(), { sql: 'SELECT * FROM BILLING.INVOICE' }, options(driver)), 'SQL_REJECTED');
    await expectCode(() => runSelect(manifestWith(), { sql: 'SELECT * FROM APP.T WHERE A = ?' }, options(driver)), 'SQL_REJECTED');
    assert.equal(driver.log.opened.length, 0);
  });

  test('missing connection secret -> AUTH_REQUIRED naming the secret', async () => {
    const driver = fakeDriver([]);
    const error = await expectCode(() => runSelect(manifestWith(), { sql: 'SELECT ID FROM APP.T' }, options(driver, {})), 'AUTH_REQUIRED');
    assert.equal(error.details.secretName, 'DB2_CONN_TEST');
    assert.match(error.details.howToFix, /DB2_CONN_TEST/);
    assert.equal(driver.log.opened.length, 0);
  });

  test('driver absent -> UNSUPPORTED with install guidance (ibm_db is not required)', async (t) => {
    let installed = true;
    try {
      // @ts-ignore optional native dependency
      await import('ibm_db');
    } catch {
      installed = false;
    }
    if (installed) return t.skip('ibm_db is installed on this machine');
    const error = await expectCode(
      () => runSelect(manifestWith(), { sql: 'SELECT ID FROM APP.T' }, { env: ENV, useCredentialStore: false }),
      'UNSUPPORTED',
    );
    assert.match(error.message, /npm install ibm_db/);
  });

  test('a failed connection -> AUTH_FAILED without leaking the connection string', async () => {
    const driver = {
      open: async () => {
        throw Object.assign(new Error(`SQL30082N security failure for ${CONNECTION}`), { sqlstate: '08001' });
      },
    };
    const error = await expectCode(() => runSelect(manifestWith(), { sql: 'SELECT ID FROM APP.T' }, options(driver)), 'AUTH_FAILED');
    assert.equal(error.details.sqlState, '08001');
    assert.equal(error.details.profile, 'test');
    assert.ok(!error.message.includes('not-a-real-pw-123'));
    assert.ok(!JSON.stringify(error.details).includes('not-a-real-pw-123'));
  });

  test('not configured: no engine, no profile, no schemas', async () => {
    const driver = fakeDriver([]);
    const noEngine = manifestWith();
    noEngine.database.engine = null;
    await expectCode(() => runSelect(noEngine, { sql: 'SELECT ID FROM APP.T' }, options(driver)), 'NOT_CONFIGURED');
    const noProfile = manifestWith();
    noProfile.database.connectionProfile = null;
    const error = await expectCode(() => runSelect(noProfile, { sql: 'SELECT ID FROM APP.T' }, options(driver)), 'NOT_CONFIGURED');
    assert.equal(error.details.field, 'database.connectionProfile');
    const noSchemas = manifestWith();
    noSchemas.database.schemas = [];
    await expectCode(() => runSelect(noSchemas, { sql: 'SELECT TABNAME FROM SYSCAT.TABLES' }, options(driver)), 'NOT_CONFIGURED');
    assert.equal(driver.log.opened.length, 0);
  });

  test('a query that outlives database.timeoutSeconds -> TIMEOUT and the connection is closed', async () => {
    const manifest = manifestWith();
    manifest.database.timeoutSeconds = 0.05;
    /** @type {NodeJS.Timeout | undefined} */
    let pending;
    const driver = fakeDriver(() => new Promise((resolve) => {
      pending = setTimeout(() => resolve([]), 5_000);
    }));
    try {
      await expectCode(() => runSelect(manifest, { sql: 'SELECT ID FROM APP.T' }, options(driver)), 'TIMEOUT');
      assert.equal(driver.log.closed, 1);
    } finally {
      clearTimeout(pending);
    }
  });

  test('the connection is closed when the query itself fails', async () => {
    const driver = fakeDriver(() => {
      throw new Error('SQL0204N "APP.T" is an undefined name.');
    });
    await assert.rejects(() => runSelect(manifestWith(), { sql: 'SELECT ID FROM APP.T' }, options(driver)), /SQL0204N/);
    assert.equal(driver.log.closed, 1);
  });

  test('listTables queries SYSCAT for an upper-cased project schema', async () => {
    const driver = fakeDriver([{ TABNAME: 'ORDERS', TYPE: 'T', CARD: 10, REMARKS: null }]);
    const result = await listTables(manifestWith(), 'app', options(driver));
    assert.deepEqual(result.schemas, ['SYSCAT']);
    assert.deepEqual(driver.log.queries[0].params, ['APP']);
    assert.equal(result.rows[0].TABNAME, 'ORDERS');
  });

  test('schema outside the project -> PROJECT_SCOPE_VIOLATION before any connection', async () => {
    const driver = fakeDriver([]);
    const error = await expectCode(() => listTables(manifestWith(), 'BILLING', options(driver)), 'PROJECT_SCOPE_VIOLATION');
    assert.deepEqual(error.details.allowedSchemas, ['APP', 'COMMON']);
    await expectCode(() => describeTable(manifestWith(), 'billing', 'INVOICE', options(driver)), 'PROJECT_SCOPE_VIOLATION');
    await expectCode(() => listTables(manifestWith(), 'SYSCAT', options(driver)), 'PROJECT_SCOPE_VIOLATION');
    assert.equal(driver.log.opened.length, 0);
  });

  test('hostile schema and table names are rejected as INVALID_ARGUMENT', async () => {
    const driver = fakeDriver([]);
    await expectCode(() => listTables(manifestWith(), "APP' OR '1'='1", options(driver)), 'INVALID_ARGUMENT');
    await expectCode(() => describeTable(manifestWith(), 'APP', 'ORDERS; DROP TABLE APP.ORDERS', options(driver)), 'INVALID_ARGUMENT');
    await expectCode(() => describeTable(manifestWith(), 'APP', /** @type {any} */ (undefined), options(driver)), 'INVALID_ARGUMENT');
    assert.equal(driver.log.opened.length, 0);
  });

  test('describeTable returns columns, and NOT_FOUND when the table is not visible', async () => {
    const driver = fakeDriver((_sql, params) => (params[1] === 'ORDERS' ? [{ COLNAME: 'ID', TYPENAME: 'INTEGER' }] : []));
    const found = await describeTable(manifestWith(), 'APP', 'orders', options(driver));
    assert.equal(found.rowCount, 1);
    assert.deepEqual(driver.log.queries[0].params, ['APP', 'ORDERS']);
    await expectCode(() => describeTable(manifestWith(), 'APP', 'GHOST', options(driver)), 'NOT_FOUND', /APP\.GHOST/);
  });
});
