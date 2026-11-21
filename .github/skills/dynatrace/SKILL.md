---
name: dynatrace
description: "Queries Dynatrace for the project's services, read-only and scoped to its configured entity selectors: open and recent problems, and the metric selectors the project has approved (response time, failure rate and similar). Use when investigating performance, availability or anomalies."
---

# Dynatrace (scoped telemetry)

Commands are written `autodev <command>`. Run them as `node "$env:AUTODEV_HOME\scripts\autodev.mjs" <command>` (from the automation folder: `node scripts/autodev.mjs <command>`). Each prints one JSON envelope: check `ok`, then read `data` or branch on `error.code`. `--dry-run` shows what a command would do without writing anywhere.

## Contract

| Need | Command |
|---|---|
| Problems in the last N minutes | `autodev dynatrace problems --minutes 30` |
| Problems in a fixed window | `autodev dynatrace problems --from <ISO> --to <ISO>` |
| All configured metrics | `autodev dynatrace metrics --minutes 30` |
| One configured metric | `autodev dynatrace metrics --minutes 30 --metric "builtin:service.response.time:percentile(95)"` |

**Problems** return: id, title, severity level, impact, status, start and end (UTC), affected entities, the root-cause entity Dynatrace named (if any), trace ids found in the evidence, and a link.

**Metrics** return one series per metric and entity: point count, `max`, `avg`, `last` and the unit.

## Scope

- Queries use only the entity selectors in `monitoring.dynatrace.entitySelectors`. With none configured, the query is refused.
- Only metric selectors listed in `monitoring.dynatrace.metricSelectors` can be queried. To add one, the project owner edits `project.yaml`.
- Windows are limited by `monitoring.limits.maxWindowMinutes`.

## Reading results

- Check the **unit**. Service response time is reported in microseconds; thresholds in `project.yaml` are in milliseconds.
- A metric alone is not an incident. It matters when it breaches a threshold the owning team configured (`monitoring.thresholds`). A threshold that is `null` has not been set, so nothing is "breached"; do not apply a threshold of your own.
- `avg` over the window is a rough baseline, not a statistical one. Say "average over the window", not "normal".
- Dynatrace's "root cause entity" is its own inference. Treat it as a lead and confirm it in logs and code before repeating it.
- A problem with no trace id has no trace id. Correlate by service and time and say that is what you did.

## Rules

- Stay within the project's entities and environment.
- Read-only. Never close, comment on or acknowledge a problem, and never change settings or deployments.
- Authentication is by API token only (scopes `problems.read`, `metrics.read`, `entities.read`). `AUTH_REQUIRED` names the missing secret; there is no browser fallback.
- Entity ids map to services through `services[].dynatraceEntityId` in `project.yaml`. If an entity does not map to a known service, report that mapping as missing.
