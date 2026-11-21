---
name: db2
description: "Read-only DB2 access scoped to the project's schemas: list tables, describe columns and run a guarded parameterised SELECT with row and time limits. Use before relying on any table or column, and when data shape matters to an investigation."
---

# DB2 (read-only)

Commands are written `autodev <command>`. Run them as `node "$env:AUTODEV_HOME\scripts\autodev.mjs" <command>` (from the automation folder: `node scripts/autodev.mjs <command>`). Each prints one JSON envelope: check `ok`, then read `data` or branch on `error.code`. `--dry-run` shows what a command would do without writing anywhere.

DB2 uses its own approved native authentication through a stored connection profile. There is no browser fallback, and no write path.

## Contract

| Need | Command |
|---|---|
| Schemas this project owns | `autodev project schemas` |
| Tables in a schema | `autodev db2 tables --schema <SCHEMA>` |
| Columns of a table | `autodev db2 describe --schema <SCHEMA> --table <TABLE>` |
| One SELECT | `autodev db2 query --sql "SELECT … WHERE ID = ?" --param <value> [--param <value>] [--max-rows 50]` |

## What the guard enforces

- One statement, `SELECT` or `WITH … SELECT` only. `INSERT`, `UPDATE`, `DELETE`, `MERGE`, DDL, `CALL`, `SET`, `SELECT INTO`, `FOR UPDATE` and data-change table references are rejected (`SQL_REJECTED`).
- Every table is written `SCHEMA.TABLE`, and the schema must be one mapped to this project. The catalog (`SYSCAT`, `SYSIBM`) cannot be queried directly; use `db2 tables` and `db2 describe` for metadata.
- Use explicit `JOIN`; comma-separated table lists and quoted identifiers are rejected.
- Values go in `?` markers with `--param`, in order. Never build SQL by putting a value into the string.
- Results are capped at the project's `maxRows`, time-limited, and columns that look sensitive are masked. `truncated: true` means there were more rows.

## Rules

- **Never invent schema.** Before code or a query uses a table or column, confirm it with `db2 describe`. If it is not there, it does not exist; report that.
- Query for shape and small samples, not bulk data. Add a `WHERE` and keep `--max-rows` low.
- Do not paste row data into tickets, commits or the chat beyond what is needed to make the point, and never personal data.
- Schema changes and migrations are not done here. If a story needs one, it requires the user's explicit authorization (`autodev review run … --authorize-schema-change`) and the change travels in the pull request for the team's own migration process.
- Writes are prohibited by default policy. Do not look for another client.

## Errors

- `UNSUPPORTED`: the IBM driver is not installed on this machine (`docs/db2.md`). Tell the user; do not guess at the schema instead.
- `AUTH_REQUIRED`: no connection is stored for the profile; `details.secretName` names it.
- `AUTH_FAILED`: the stored connection was refused.
- `PROJECT_SCOPE_VIOLATION`: that schema belongs to no mapping of this project.
- `NOT_FOUND` from `describe`: no such table visible to the account.
