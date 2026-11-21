import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertIdentifier, redactRows, stripLiteralsAndComments, validateSelect } from '../../src/adapters/db2/guard.js';
import { expectCode } from '../helpers.js';

const ALLOWED = ['APP', 'COMMON'];

/**
 * @param {string} sql
 * @param {unknown[]} [params]
 */
const accept = (sql, params) => validateSelect(sql, { allowedSchemas: ALLOWED, params });

/**
 * @param {string} sql
 * @param {RegExp} [reason]
 * @param {unknown[]} [params]
 */
const refuse = async (sql, reason, params) => {
  const error = await expectCode(() => validateSelect(sql, { allowedSchemas: ALLOWED, params }), 'SQL_REJECTED');
  if (reason) assert.match(error.details.reason, reason, `${sql} -> ${error.details.reason}`);
  return error;
};

describe('db2 guard: accepted statements', () => {
  test('accepts a simple SELECT on an allowed schema and reports the schema', () => {
    const result = accept('SELECT * FROM APP.ORDERS');
    assert.deepEqual(result.schemas, ['APP']);
    assert.equal(result.paramCount, 0);
    assert.equal(result.sql, 'SELECT * FROM APP.ORDERS');
  });

  test('accepts lower-case SQL, aliases and parameter markers', () => {
    const result = accept('select o.id, o.total from app.orders o where o.id = ? and o.status = ?', [1, 'NEW']);
    assert.deepEqual(result.schemas, ['APP']);
    assert.equal(result.paramCount, 2);
  });

  test('accepts a CTE', () => {
    const result = accept('WITH RECENT AS (SELECT ID FROM APP.ORDERS WHERE CREATED_AT > ?) SELECT R.ID FROM RECENT R', ['2026-01-01']);
    assert.deepEqual(result.schemas, ['APP']);
  });

  test('accepts two CTEs joined together', () => {
    accept('WITH A AS (SELECT ID FROM APP.T1), B AS (SELECT ID FROM COMMON.T2) SELECT A.ID FROM A JOIN B ON A.ID = B.ID');
  });

  test('accepts explicit joins across allowed schemas', () => {
    const result = accept(
      'SELECT O.ID, C.NAME FROM APP.ORDERS O INNER JOIN COMMON.CUSTOMER C ON C.ID = O.CUSTOMER_ID LEFT JOIN APP.DISCOUNT AS D ON D.CUSTOMER_ID = C.ID',
    );
    assert.deepEqual(result.schemas.sort(), ['APP', 'COMMON']);
  });

  test('accepts subqueries in WHERE, in the select list and as a derived table', () => {
    accept('SELECT O.ID FROM APP.ORDERS O WHERE O.CUSTOMER_ID IN (SELECT C.ID FROM COMMON.CUSTOMER C WHERE C.ACTIVE = 1)');
    accept('SELECT O.ID, (SELECT MAX(D.RATE) FROM APP.DISCOUNT D) FROM APP.ORDERS O');
    accept('SELECT Q.ID FROM (SELECT ID FROM APP.ORDERS) AS Q WHERE Q.ID > 5');
  });

  test('catalog schemas are readable only by the introspection helpers (allowCatalog), not by free-form queries', () => {
    const catalog = { allowedSchemas: ['APP'], allowCatalog: true };
    assert.deepEqual(validateSelect('SELECT TABNAME FROM SYSCAT.TABLES WHERE TABSCHEMA = ?', { ...catalog, params: ['APP'] }).schemas, ['SYSCAT']);
    validateSelect('SELECT 1 FROM SYSIBM.SYSDUMMY1', catalog);
    for (const sql of [
      "SELECT COLVALUE FROM SYSCAT.COLDIST WHERE TABSCHEMA = 'PAYROLL'",
      'SELECT TEXT FROM SYSCAT.VIEWS',
      'SELECT 1 FROM SYSIBM.SYSDUMMY1',
    ]) {
      assert.throws(() => validateSelect(sql, { allowedSchemas: ['APP'] }), /not mapped to this project/);
    }
  });

  test('FROM inside EXTRACT/TRIM/SUBSTRING is not mistaken for a table reference', () => {
    accept('SELECT EXTRACT(YEAR FROM T.CREATED) FROM APP.T T');
    accept("SELECT TRIM(BOTH ' ' FROM T.NAME) FROM APP.T T");
  });

  test('an alias cannot stand in for a schema in a function call', () => {
    assert.throws(() => validateSelect('SELECT OTHER.F(OTHER.X) FROM APP.T OTHER', { allowedSchemas: ['APP'] }), /function "OTHER\.F"/);
  });

  test('a string literal containing DELETE (or ; -- ? and quotes) is still accepted', () => {
    accept("SELECT * FROM APP.AUDIT_LOG WHERE ACTION = 'DELETE'");
    accept("SELECT * FROM APP.AUDIT_LOG WHERE NOTE = 'x; DROP TABLE APP.T -- it''s fine? /* */'");
    assert.equal(accept("SELECT * FROM APP.T WHERE A = '?' AND B = ?", [1]).paramCount, 1);
  });

  test('column names that merely contain a write keyword are accepted', () => {
    accept('SELECT UPDATED_AT, CREATED_BY, DELETED, SETTINGS, INSERT_TS FROM APP.ORDERS');
  });

  test('accepts one trailing semicolon, leading comments, FETCH FIRST and WITH UR', () => {
    assert.equal(accept('SELECT * FROM APP.ORDERS;  ').sql, 'SELECT * FROM APP.ORDERS');
    accept('/* why */ -- note\nSELECT * FROM APP.ORDERS FETCH FIRST 5 ROWS ONLY');
    accept('SELECT * FROM APP.ORDERS ORDER BY ID DESC FETCH FIRST 5 ROWS ONLY WITH UR');
    accept('SELECT * FROM APP.ORDERS FOR READ ONLY');
  });

  test('allowed schema names are matched case-insensitively', () => {
    assert.deepEqual(validateSelect('SELECT * FROM app.orders', { allowedSchemas: ['app'] }).schemas, ['APP']);
  });
});

describe('db2 guard: rejected statements', () => {
  for (const keyword of ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'CREATE', 'ALTER', 'DROP', 'GRANT', 'REVOKE', 'CALL', 'SET', 'LOCK', 'COMMIT']) {
    test(`rejects a ${keyword} statement outright`, async () => {
      await refuse(`${keyword} APP.ORDERS`, /only SELECT/);
    });
  }

  test('rejects write keywords in mixed case inside a SELECT', async () => {
    await refuse('SeLeCt * FrOm APP.T WHERE ID IN (dElEtE FROM APP.T)', /DELETE/);
    await refuse('select * from app.t where exists (uPdAtE app.t set a = 1)', /UPDATE|SET/);
    await refuse('WITH X AS (SELECT 1 FROM APP.T) insert into APP.T select * from X', /INSERT/);
  });

  test('rejects a write statement placed after a comment', async () => {
    await refuse('/* harmless */ DELETE FROM APP.ORDERS', /only SELECT/);
    await refuse('-- SELECT * FROM APP.ORDERS\nDROP TABLE APP.ORDERS', /only SELECT/);
    await refuse('SELECT * FROM APP.T /* x */ UNION ALL SELECT * FROM FINAL TABLE (INSERT INTO APP.T VALUES 1)');
  });

  test('rejects write keywords separated by tabs, newlines or comments', async () => {
    await refuse('SELECT * FROM APP.T WHERE X IN (\n\tDELETE\n\tFROM APP.T)', /DELETE/);
    await refuse('SELECT 1 FROM APP.T WHERE 1 = (/**/DROP/**/TABLE APP.T)', /DROP/);
  });

  test('rejects multiple statements', async () => {
    await refuse('SELECT * FROM APP.T; SELECT * FROM APP.T', /multiple statements/);
    await refuse('SELECT * FROM APP.T; DELETE FROM APP.T', /multiple statements/);
    await refuse('SELECT * FROM APP.T;;', /multiple statements/);
  });

  test('rejects comments that hide a second statement', async () => {
    await refuse('SELECT * FROM APP.T -- trailing\n; DELETE FROM APP.T', /multiple statements/);
    await refuse('SELECT * FROM APP.T /* ; */ ; DROP TABLE APP.T', /multiple statements/);
    await refuse("SELECT * FROM APP.T WHERE A = '--' ; DELETE FROM APP.T", /multiple statements/);
  });

  test('a quote inside a comment cannot swallow the rest of the statement', async () => {
    await refuse("SELECT * FROM APP.T -- it's\n; DELETE FROM APP.T WHERE A = 'x'", /multiple statements/);
    await refuse("SELECT * FROM APP.T /* ' */ UNION SELECT * FROM BILLING.INVOICE /* ' */", /BILLING/);
  });

  test('rejects unterminated comments and strings', async () => {
    await refuse('SELECT * FROM APP.T /* never closed', /unterminated comment/);
    await refuse("SELECT * FROM APP.T WHERE A = 'never closed", /unterminated quoted/);
  });

  test('rejects SELECT INTO', async () => {
    await refuse('SELECT ID INTO :HOSTVAR FROM APP.ORDERS', /INTO/);
    await refuse('SELECT ID into APP.COPY FROM APP.ORDERS', /INTO/);
  });

  test('rejects FOR UPDATE', async () => {
    await refuse('SELECT * FROM APP.ORDERS FOR UPDATE', /UPDATE/);
    await refuse('SELECT * FROM APP.ORDERS for\n  update OF TOTAL', /UPDATE/);
  });

  test('rejects FINAL TABLE / NEW TABLE / OLD TABLE data-change references', async () => {
    await refuse('SELECT * FROM FINAL TABLE (INSERT INTO APP.T (A) VALUES (1))');
    await refuse('SELECT * FROM NEW TABLE (APP.T)', /data-change/);
    await refuse('SELECT * FROM OLD  TABLE (APP.T)', /data-change/);
  });

  test('rejects unqualified tables', async () => {
    await refuse('SELECT * FROM ORDERS', /schema-qualified/);
    await refuse('SELECT * FROM APP.ORDERS O JOIN CUSTOMER C ON C.ID = O.ID', /schema-qualified/);
    await refuse('SELECT * FROM APP.ORDERS WHERE ID IN (SELECT ID FROM INVOICE)', /schema-qualified/);
  });

  test("rejects another project's schema wherever it appears", async () => {
    await refuse('SELECT * FROM BILLING.INVOICE', /BILLING/);
    await refuse('SELECT * FROM APP.ORDERS O JOIN BILLING.INVOICE I ON I.ORDER_ID = O.ID', /BILLING/);
    await refuse('SELECT * FROM APP.ORDERS WHERE ID IN (SELECT ORDER_ID FROM BILLING.INVOICE)', /BILLING/);
    await refuse('SELECT (SELECT MAX(TOTAL) FROM BILLING.INVOICE) FROM APP.ORDERS', /BILLING/);
    await refuse('WITH X AS (SELECT * FROM BILLING.INVOICE) SELECT * FROM X', /BILLING/);
    await refuse('SELECT * FROM APP.ORDERS UNION ALL SELECT * FROM BILLING.INVOICE', /BILLING/);
  });

  test('rejects a foreign schema written with whitespace, newlines or comments around the dot', async () => {
    await refuse('SELECT * FROM BILLING . INVOICE', /BILLING/);
    await refuse('SELECT * FROM\n\tBILLING\n.\nINVOICE', /BILLING/);
    await refuse('SELECT * FROM BILLING/**/./**/INVOICE', /BILLING/);
    await refuse('SELECT * FROM billing.invoice', /BILLING/);
  });

  test('rejects a foreign schema used only as a column or function qualifier', async () => {
    await refuse('SELECT BILLING.INVOICE.TOTAL FROM APP.ORDERS', /BILLING/);
    await refuse('SELECT SYSPROC.ADMIN_CMD(?) FROM APP.ORDERS', /SYSPROC/, ['x']);
  });

  test('a schema whose name merely starts with an allowed one is rejected', async () => {
    await refuse('SELECT * FROM APP2.ORDERS', /APP2/);
    await refuse('SELECT * FROM APPX.ORDERS', /APPX/);
  });

  test('rejects comma joins', async () => {
    await refuse('SELECT * FROM APP.ORDERS O, APP.CUSTOMER C WHERE O.ID = C.ID', /comma/);
    await refuse('SELECT * FROM APP.ORDERS, BILLING.INVOICE');
    await refuse('SELECT * FROM APP.ORDERS AS O , INVOICE', /comma/);
  });

  test('rejects quoted identifiers', async () => {
    await refuse('SELECT * FROM "BILLING"."INVOICE"', /quoted identifiers/);
    await refuse('SELECT "ID" FROM APP.ORDERS', /quoted identifiers/);
    await refuse('SELECT * FROM APP."ORDERS; DROP TABLE X"', /quoted identifiers/);
  });

  test('rejects table functions', async () => {
    await refuse('SELECT * FROM TABLE(SYSPROC.ENV_GET_INST_INFO()) AS T');
    await refuse('SELECT * FROM APP.T T JOIN TABLE (APP.F(T.ID)) X ON 1 = 1', /table functions/);
  });

  test('rejects a parameter count mismatch in either direction', async () => {
    await refuse('SELECT * FROM APP.T WHERE A = ? AND B = ?', /2 parameter marker\(s\) but 1/, [1]);
    await refuse('SELECT * FROM APP.T WHERE A = ?', /1 parameter marker\(s\) but 0/);
    await refuse('SELECT * FROM APP.T', /0 parameter marker\(s\) but 1/, [1]);
  });

  test('rejects empty, non-string and oversized input', async () => {
    await refuse('', /empty/);
    await refuse('   \n ', /empty/);
    await refuse(/** @type {any} */ (null), /empty/);
    await refuse(/** @type {any} */ ({ toString: () => 'SELECT * FROM APP.T' }), /empty/);
    await refuse(`SELECT * FROM APP.T WHERE A = '${'x'.repeat(20_001)}'`, /too long/);
  });

  test('rejects statements with no table at all and non-SELECT verbs', async () => {
    await refuse('SELECT 1', /no table reference/);
    await refuse('VALUES 1', /only SELECT/);
    await refuse('EXPLAIN PLAN FOR SELECT * FROM APP.T', /only SELECT/);
    await refuse('(SELECT * FROM APP.T)', /only SELECT/);
  });

  test('rejects stored procedure calls and session changes smuggled into a SELECT', async () => {
    await refuse('SELECT * FROM APP.T WHERE 1 = 1 CALL SYSPROC.ADMIN_CMD(1)', /CALL/);
    await refuse('SELECT * FROM APP.T; SET CURRENT SCHEMA = BILLING');
    await refuse('WITH X AS (SELECT 1 FROM APP.T) SELECT * FROM X; COMMIT');
  });

  test('errors carry code SQL_REJECTED, exit-code class 4 and are not retryable', async () => {
    const error = await refuse('DELETE FROM APP.T');
    assert.equal(error.name, 'AutoDevError');
    assert.equal(error.retryable, false);
    assert.match(error.message, /^SQL rejected:/);
  });
});

describe('db2 guard: suspected bypasses (adversarial)', () => {
  test(
    'an unqualified table after a JOIN, a derived table or inside a parenthesised join is rejected',
    async () => {
      await refuse('SELECT * FROM APP.ORDERS A JOIN APP.CUSTOMER B ON A.ID = B.ID, INVOICE');
      await refuse('SELECT * FROM (SELECT ID FROM APP.ORDERS) Q, INVOICE');
      await refuse('SELECT * FROM (INVOICE JOIN APP.ORDERS O ON 1 = 1)');
    },
  );

  test(
    'an unqualified table joined to an un-aliased table is rejected',
    async () => {
      await refuse('SELECT * FROM APP.ORDERS JOIN INVOICE ON 1 = 1', /schema-qualified/);
    },
  );

  test(
    'a second CTE written without a space after the comma is recognised',
    () => {
      accept('WITH A AS (SELECT ID FROM APP.T1),B AS (SELECT ID FROM APP.T2) SELECT A.ID FROM A INNER JOIN B ON A.ID = B.ID');
    },
  );

  test(
    "another project's schema cannot be read by giving an allowed table an alias with that schema's name",
    async () => {
      await refuse('SELECT * FROM APP.ORDERS BILLING JOIN APP.CUSTOMER C ON 1 = 1, BILLING.INVOICE');
      await refuse('SELECT * FROM (BILLING.INVOICE JOIN APP.ORDERS BILLING ON 1 = 1)');
      await refuse('SELECT MAX(O.ID) BILLING FROM APP.ORDERS O JOIN APP.CUSTOMER C ON 1 = 1, BILLING.INVOICE');
    },
  );

  test(
    'NEXT VALUE FOR (which advances a sequence) is not accepted as read-only',
    async () => {
      await refuse('SELECT NEXT VALUE FOR APP.ORDER_SEQ FROM SYSIBM.SYSDUMMY1');
    },
  );
});

describe('db2 guard: helpers', () => {
  test('stripLiteralsAndComments blanks literals and comments but keeps the code', () => {
    assert.equal(stripLiteralsAndComments("SELECT 'a;b' FROM T -- c\nWHERE 1 /* d */ = 1"), "SELECT '' FROM T  \nWHERE 1   = 1");
    assert.equal(stripLiteralsAndComments("'it''s'"), "''");
  });

  test('assertIdentifier upper-cases valid names and rejects hostile ones', async () => {
    assert.equal(assertIdentifier('orders_2'), 'ORDERS_2');
    for (const bad of ['', 'A B', 'A;DROP', "A'", 'A.B', '1ABC', 'A-B', 'x'.repeat(129), null, 42]) {
      await expectCode(() => assertIdentifier(/** @type {any} */ (bad)), 'INVALID_ARGUMENT');
    }
  });

  test('redactRows masks sensitive columns by name and by project list, keeps nulls', () => {
    const rows = redactRows(
      [{ ID: 1, EMAIL: 'jane@example.com', PASSWORD_HASH: 'abc', CARD_NO: '4111', LOYALTY_TIER: 'gold', NOTES: 'n', PHONE: null }],
      ['loyalty_tier'],
    );
    assert.deepEqual(rows, [
      { ID: 1, EMAIL: '[REDACTED:column]', PASSWORD_HASH: '[REDACTED:column]', CARD_NO: '[REDACTED:column]', LOYALTY_TIER: '[REDACTED:column]', NOTES: 'n', PHONE: null },
    ]);
  });

  test('redactRows caps long strings, summarises binary values and does not mutate its input', () => {
    const input = [{ BLOB_COL: Buffer.from([1, 2, 3]), TEXT_COL: 'y'.repeat(600), N: 0, F: false }];
    const [row] = redactRows(input);
    assert.equal(row.BLOB_COL, '[binary 3 bytes]');
    assert.match(String(row.TEXT_COL), /^y{500}… \(600 chars\)$/);
    assert.equal(row.N, 0);
    assert.equal(row.F, false);
    assert.equal(input[0].TEXT_COL.length, 600);
    assert.deepEqual(redactRows([]), []);
  });
});
