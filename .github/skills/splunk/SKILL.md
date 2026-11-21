---
name: splunk
description: "Runs scoped, bounded, read-only Splunk searches for the project's error events using its configured indexes, sourcetypes and time limits, and returns sanitized events. Use when investigating errors or exceptions for a service."
---

# Splunk (scoped log search)

Commands are written `autodev <command>`. Run them as `node "$env:AUTODEV_HOME\scripts\autodev.mjs" <command>` (from the automation folder: `node scripts/autodev.mjs <command>`). Each prints one JSON envelope: check `ok`, then read `data` or branch on `error.code`. `--dry-run` shows what a command would do without writing anywhere.

## Contract

| Need | Command |
|---|---|
| Errors in the last N minutes | `autodev splunk search --minutes 30` |
| For one service | `autodev splunk search --minutes 30 --service orders-service` |
| A fixed window | `autodev splunk search --from 2025-01-17T10:00:00Z --to 2025-01-17T10:45:00Z` |
| Narrow with a text term | `autodev splunk search --minutes 30 --filter "PricingService"` |

The result gives the search that ran, the window (UTC), `count`, whether it hit the cap (`capped`), a `link` to open the same search in Splunk Web, and up to 100 sanitized events.

## How the search is built

You do not write SPL. The search is assembled from `monitoring.splunk` in `project.yaml`:

- only the project's listed **indexes** (never `index=*`; wildcards are refused),
- its **sourcetypes**, the service field names it configured, and its error filter,
- a **time window** no longer than `monitoring.limits.maxWindowMinutes`,
- a **result cap** of `monitoring.limits.maxEventsPerQuery`.

`--filter` adds plain search terms only. Pipes, subsearches, macros, and any attempt to change index, sourcetype, host, source or time range are rejected (`QUERY_REJECTED`).

## Reading events

- `_time` is the event time; convert to UTC when comparing with other sources and note the source time zone if the event carries one.
- Trace, span and request ids are read from the field names in `monitoring.correlation`. If an event has none, it has none: say so. Do not derive an id from other text.
- The first line of `_raw` is usually the message; a stack trace follows. The exception class and top application frame are what identify a recurring error.

## Rules

- Stay inside the project's environment and indexes. To look somewhere else, the project owner changes `project.yaml`; you do not.
- Start narrow (one service, 15 to 30 minutes) and widen only as far as the limit allows. To cover a longer period, run consecutive windows.
- `capped: true` means there may be more events than you saw; narrow the search before drawing conclusions about counts.
- Events are sanitized before you see them. Never try to recover masked values, and never paste raw payloads into tickets or chat.
- Authentication is by token only for Splunk. `AUTH_REQUIRED` names the missing secret; there is no browser fallback (`docs/unsupported.md`).
- `RATE_LIMITED`: wait and retry later; do not loop.
