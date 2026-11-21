# DB2 access

DB2 access is read-only: schema introspection and guarded, parameterised `SELECT` statements against the schemas mapped to the project. There is no write path in the adapter, and the default policy is `dbWrites: prohibited`.

**Status:** the SQL guard, limits and redaction are unit-tested. The live connection path has never been run against a database. Treat it as unverified until `autodev db2 tables` succeeds in your environment.

## 1. Use a read-only account

This is the real control. Create or request a DB2 account with `SELECT` on the project's schemas and on the catalog views, and nothing else. The SQL guard is a second line of defence, not a substitute.

## 2. Install the driver

The IBM driver is a native module and is not installed by default.

```powershell
cd C:\DevWorkspace\automation
npm install ibm_db
```

`ibm_db` downloads the IBM CLI driver during installation. Behind a corporate firewall, pre-stage the driver and point the installer at it (`IBM_DB_HOME` or `IBM_DB_INSTALLER_URL`, per the `ibm_db` documentation), or use your internal registry mirror. A C++ build toolchain may be needed if no prebuilt binary matches your Node version.

Without the driver every DB2 command returns `UNSUPPORTED` with this guidance. Nothing is simulated.

## 3. Store the connection

The connection string is a secret named `DB2_CONN_<PROFILE>`, where `<PROFILE>` is `database.connectionProfile` upper-cased with non-alphanumerics replaced by `_`. For `connectionProfile: db2-dev-readonly`:

```powershell
.\scripts\Set-AutoDevCredential.ps1 -Name DB2_CONN_DB2_DEV_READONLY
```

DB2 authenticates natively. Where your organization uses Kerberos or integrated security, the connection string carries no password, for example:

```
DATABASE=APPDB;HOSTNAME=db2.corp.example;PORT=50001;PROTOCOL=TCPIP;SECURITY=SSL;Authentication=KERBEROS;
```

Otherwise it includes the read-only account's credentials, which is why it lives in the credential store and never in `project.yaml`. Always use `SECURITY=SSL`. There is no browser fallback for DB2.

## 4. Configure the project

```yaml
database:
  engine: db2
  connectionProfile: db2-dev-readonly
  schemas: [APP, COMMON]
  writeAccess: false
  maxRows: 200
  timeoutSeconds: 30
  redactColumns: [CUSTOMER_REF]     # masked in addition to the built-in sensitive names
```

## 5. Use it

```powershell
node scripts\autodev.mjs db2 tables   --schema APP
node scripts\autodev.mjs db2 describe --schema APP --table DISCOUNT
node scripts\autodev.mjs db2 query    --sql "SELECT D.RATE FROM APP.DISCOUNT D WHERE D.CUSTOMER_ID = ?" --param 42 --max-rows 20
```

## What the guard accepts and rejects

Accepted: one `SELECT`, or `WITH … SELECT`, with explicit `JOIN`s, subqueries, and tables written as `SCHEMA.TABLE` where the schema is mapped to the project.

The catalog (`SYSCAT`, `SYSIBM`, `SYSSTAT`) is readable only through `db2 tables` and `db2 describe`, which run fixed queries filtered to the project's schemas. Free-form queries cannot read it, because catalog views expose other schemas' definitions and sampled column values.

Rejected with `SQL_REJECTED`:

- sequence expressions (`NEXT VALUE FOR`), which change state;
- a function called through a schema that is not mapped to the project;
- any data-change or DDL keyword (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE`, `CREATE`, `ALTER`, `DROP`, `GRANT`, `CALL`, `SET`, …), `SELECT INTO`, `FOR UPDATE`, `FINAL/NEW/OLD TABLE`, table functions;
- more than one statement;
- an unqualified table, a schema not mapped to the project, or a qualifier that is neither a mapped schema nor an alias defined in the query;
- comma-separated table lists and quoted identifiers;
- a parameter count that does not match the `?` markers.

String literals and comments are stripped before the checks, so a literal containing the word `DELETE` is fine, and a comment cannot hide a statement.

The guard is a conservative pattern filter, not a SQL parser. It rejects some valid SQL (a column named `SET` or `COMMENT`, for example). Rephrase the query; do not weaken the guard.

## Limits and redaction

- Rows are capped at `maxRows` (and `--max-rows` can only lower it). `truncated: true` means more rows existed.
- Each query is time-limited to `timeoutSeconds`.
- Columns whose names suggest sensitive data (password, token, SSN, card, IBAN, date of birth, email, phone, address, account number) and those in `redactColumns` are masked. Long values are shortened and binary values summarised.
- Each query is recorded in the audit log with the schemas read and the row count, never the SQL or the data.

## Schema changes

The agents do not change schema. If a story needs a migration, the user authorizes it explicitly (`autodev review run … --authorize-schema-change`, which requests approval for the specific files), and the migration travels in the pull request for your team's normal migration process. Without that authorization, any SQL, DDL or migration file in the change is a review blocker.
