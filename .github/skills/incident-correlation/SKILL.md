---
name: incident-correlation
description: "Normalises, groups and correlates Splunk and Dynatrace signals into incidents: common incident model, fingerprints, deduplication by project, environment, service and time window, and joining logs to telemetry by trace id or by service and time. Use when reading or reasoning about what the monitoring worker detected."
---

# Incident correlation

Run `autodev <command>` as `node "$env:AUTODEV_HOME\scripts\autodev.mjs" <command>`; each prints one JSON envelope (`ok`, then `data` or `error.code`).

The monitoring worker does the correlation on every pass. Use this skill to read its output correctly and to extend it by hand during an investigation.

## Contract

| Need | Command |
|---|---|
| Worker state and counts | `autodev monitor status` |
| Preview a pass without recording anything | `autodev monitor run --dry-run` |
| Incidents | `autodev incident list [--status <status>]` |
| One incident in full | `autodev incident show <INC-…>` |
| Close a false positive | `autodev incident close --incident <INC-…> --reason "…"` |

## The incident model

`incidentId`, `projectId`, `environment`, `service`, `severity`, `firstSeen`, `lastSeen` (UTC; `sourceTimeZones` kept alongside), `errorFingerprint`, `traceId`, `spanId`, `requestId`, `evidenceLinks`, `metricBaseline`, `observedMetric`, `candidateRepos`, `hypotheses`, `classification`, `confidence`, `status`, plus `occurrences`, `triggers`, `correlation` and `history`.

## How signals become incidents

1. **Normalise.** Each Splunk event, Dynatrace problem and breached threshold becomes a signal with a service, a UTC time and a fingerprint. For errors the fingerprint is the service, exception class and top application frame; ids, numbers and timestamps are masked so the same error always matches.
2. **Group** signals by service and fingerprint.
3. **Correlate** logs with telemetry for the same service:
   - shared trace id → `correlation.method: trace-id` (strong);
   - no shared id but overlapping in time → `time-and-service` (weaker, labelled as such);
   - neither → `none`.
4. **Deduplicate** on project + environment + service + fingerprint within `incidentPolicy.dedupeWindowMinutes`. A repeat inside the window updates the incident; a repeat after it counts as a recurrence of the same incident while a defect is open. Either way no second ticket is raised.
5. **Thresholds.** `errorCount`, `errorRatePercent` and `p95LatencyMs` come from the owning team. A `null` threshold is not evaluated at all. With no error-count threshold, an observed exception is recorded with trigger `exception-observed`.

## Reading an incident

- `correlation.missing` lists identifiers the source data did not contain. Those are facts about the data. Never fill them in.
- `confidence` is how sure the framework is that the grouped signals are one real incident. It says nothing about the cause.
- `classification` starts as `insufficient-evidence`. Correlation never makes something a verified root cause.
- `status: needs-onboarding` means the service is not mapped to a repository. The fix is a mapping in `project.yaml`, by the project owner.
- `triggers` says why it qualified: `exception-observed`, `errorCount >= N`, `dynatrace-problem`, `threshold-breached`.

## Rules

- A trace id shared by a log line and a problem shows they concern the same request. It is a lead, not proof of root cause.
- Compare times in UTC. State the source time zone when you quote a source timestamp.
- Do not merge incidents by hand because they "look related". If two fingerprints share a cause, record that as a hypothesis on each (see `root-cause-analysis`).
- One project's telemetry never informs another project's incident.
