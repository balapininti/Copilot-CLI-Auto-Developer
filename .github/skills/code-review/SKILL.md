---
name: code-review
description: "Reviews a story's change against project standards: automated checks for secrets, disabled TLS, string-built SQL, schema and dependency changes, disabled tests and oversized diffs, plus the independent reviewer verdict that gates the pull request. Use after tests pass and before committing."
---

# Code review and the review gates

Commands are written `autodev <command>`. Run them as `node "$env:AUTODEV_HOME\scripts\autodev.mjs" <command>` (from the automation folder: `node scripts/autodev.mjs <command>`). Each prints one JSON envelope: check `ok`, then read `data` or branch on `error.code`. `--dry-run` shows what a command would do without writing anywhere.

Two gates, both required before a pull request:

1. **Automated review**: deterministic checks over the diff.
2. **Independent review**: a verdict from a reviewer who did not write the change (the `code-reviewer` agent, or a person).

## Contract

| Need | Command |
|---|---|
| Review standards | `autodev project guidelines --task review` |
| The full diff against the release branch | `autodev repo diff --story <S-…> --repo <name>` |
| Run automated checks and record that gate | `autodev review run --story <S-…> --repo <name>` |
| Authorize a schema or migration change | `autodev review run … --authorize-schema-change [--approval <id>]` |
| Record the independent verdict | `autodev review record --story <S-…> --repo <name> --verdict pass|fail --reviewer <who> --notes "…"` |

## Automated findings

| Rule | Severity | Meaning |
|---|---|---|
| `secret-in-diff`, `credential-file` | blocker | A credential or key is in the change |
| `tls-validation-disabled` | blocker | Certificate or hostname checks switched off |
| `schema-change` | blocker until authorized | SQL, DDL or migration files changed |
| `sql-string-concatenation` | major | SQL built from strings; use bind parameters |
| `sensitive-data-logged` | major | A log line references a password, token or similar |
| `test-disabled` | major | `@Disabled`, `@Ignore`, `.skip`, `.only` |
| `dependency-change` | major / info | Dependencies added or build config changed |
| `no-test-change` | major | Source changed with no test added or updated |
| `change-too-large` | major | More than 50 files or 2000 added lines: needs a human and probably splitting |
| `diff-not-fully-reviewed` | blocker | The change is too large to be read in full; split it |
| `debug-output`, `swallowed-exception`, `todo-added`, `hardcoded-url` | minor | Clean up |

Blockers fail the gate. Majors must be fixed or explicitly accepted by the independent reviewer with a reason. Patterns miss things and sometimes misfire: each finding is a prompt to look, and a clean run is not a review.

## What the independent review covers

Correctness against each acceptance criterion; security; the project's standards; regression risk, including other repositories that consume what changed; performance; data safety; and whether the tests really exercise the change.

## Rules

- The author cannot record their own review: `--reviewer auto-developer` is refused.
- A pass cannot be recorded while automated blockers remain.
- Both verdicts are tied to the exact code reviewed. Any edit afterwards means running both again.
- Schema changes need the user's explicit authorization, recorded as an approval for the specific files.
- Findings are stated with file, line and reason. "Looks fine" is not a review note.
