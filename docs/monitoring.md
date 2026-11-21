# Monitoring and root-cause analysis

Monitoring is a first-class peer of the auto-developer workflow, and it runs without Copilot CLI. A scheduled, bounded worker reads scoped telemetry, records incidents, and proposes Agility defects for approval. The `incident-investigator` agent is the interactive half: it examines what the worker found and records conclusions.

Copilot CLI does not run continuously and is not asked to. The worker is a plain Node.js command started by Windows Task Scheduler.

## Enabling it for a project

In `projects/<id>/project.yaml`:

```yaml
monitoring:
  enabled: true
  environment: nonprod            # one explicit environment; required
  splunk:
    indexes: [app_nonprod]        # required for Splunk; never index=*
    sourcetypes: [app:json]
  dynatrace:
    entitySelectors: ["type(SERVICE),tag(app:orders)"]
    metricSelectors: ["builtin:service.response.time:percentile(95)"]
  thresholds:                     # from the owning team; null never fires
    errorCount: null
    errorRatePercent: null
    p95LatencyMs: 1500
  incidentPolicy:
    dedupeWindowMinutes: 60
    createTicket: approval-required
    autoStartDevelopment: false
```

Also set `services[]` (service to repository and schemas), the Splunk and Dynatrace base URL variables, and the tokens. Then try a pass that records nothing:

```powershell
node scripts\autodev.mjs monitor run --project <id> --dry-run
```

## Scheduling

```powershell
.\scripts\Register-MonitoringTask.ps1 -Project <id> -EveryMinutes 15
.\scripts\Register-MonitoringTask.ps1 -Project <id> -Unregister
```

The task runs as you (so it can read your Credential Manager entries), without elevation, ignores a new start while a pass is still running, and is limited to ten minutes. `monitoring.schedule` in the manifest is informational; the interval is whatever the task was registered with.

Do not schedule passes more often than your organization's Splunk and Dynatrace query limits allow. `monitoring.limits` caps the window length, the events per query and the spacing between queries.

## What one pass does

1. **Takes a lock** for the project. A second pass that starts while one is running exits with `already-running`. A lock left behind by a pass that was killed is reclaimed as soon as its process is gone.
2. **Honours backoff.** After a failed pass the next attempt is delayed, doubling up to an hour, and reported as `backing-off` until then.
3. **Finishes pending work**: creates tickets whose approval was granted, resolves writes that were interrupted, queues handoffs that were not queued, and re-checks incidents waiting on a mapping.
4. **Reads the next window(s)** after the checkpoint, each no longer than `maxWindowMinutes`, oldest first, a few per pass. After downtime it catches up gradually and reports `behind: true` until it has.
5. **Normalises** every event, problem and breached threshold into the common incident model, with timestamps in UTC and the source time zone kept alongside.
6. **Correlates** logs with telemetry by trace id where one exists, otherwise by service and overlapping time (labelled as the weaker method). Missing identifiers are recorded as missing.
7. **Deduplicates** on project, environment, service and error fingerprint within the dedupe window.
8. **Maps** the service to repositories and schemas. No mapping: the incident stops at `needs-onboarding`.
9. **Proposes a defect**: checks Agility for an existing defect with the same idempotency marker, builds a sanitized draft, and requests approval. No ticket is created yet.
10. **Saves the checkpoint** after each window.

A pass can crash at any point and simply be run again.

## Incident lifecycle

```
detected ──► defect-proposed ──► defect-created ──► handoff-queued ──► development-started
   │               │  └► defect-denied                                        │
   └► needs-onboarding                                                        ▼
                                             resolved-verified ◄── validation-pending ◄── pr-created
```

Any state can move to `closed` (`autodev incident close --reason "…"`).

## Classification

Every incident carries one of:

- `verified-root-cause`: recorded only by `autodev incident classify` with at least two pieces of evidence;
- `evidence-backed-hypothesis`: evidence points somewhere, not proven;
- `insufficient-evidence`: the starting point.

The worker never classifies anything as verified. Recent commits and deployment versions are attached as leads. A shared trace id is a lead. Dynatrace's own "root cause entity" is a lead.

## Approving a ticket

```powershell
node scripts\autodev.mjs incident list --project <id>
node scripts\autodev.mjs incident show INC-… --project <id>      # includes the proposed defect
node scripts\autodev.mjs approvals review apr-… --project <id>   # in your own terminal
```

The next pass creates the defect exactly once (the write is recorded before it is attempted and looked up by marker afterwards) and queues the handoff. If Agility is unreachable at that moment, the approval is not lost: later passes retry the same approved draft until it lands.

The marker is tied to the incident. If the same error comes back after an incident was resolved or closed, that is a new incident with its own proposal, not a silent link to the old ticket.

## Handoff to development

A queued defect is not authorized work. With `autoStartDevelopment: false` (the default) a person approves the start of each task:

```powershell
node scripts\autodev.mjs handoff list --project <id>
node scripts\autodev.mjs handoff authorize --task-id task-… --project <id>    # returns an approval id
node scripts\autodev.mjs approvals review apr-… --project <id>
node scripts\autodev.mjs handoff authorize --task-id task-… --project <id>    # now ready
```

The `auto-developer` agent then claims it (`handoff next`), **re-reads the defect from Agility and the project context**, validates the release branch, and runs the normal gated workflow. It never merges or deploys.

## After deployment

```powershell
node scripts\autodev.mjs monitor verify-resolution --incident INC-… --deployed-at 2025-01-17T14:00:00Z --project <id>
```

It marks the incident `resolved-verified` only when a full dedupe window after the deployment shows no recurrence of the incident's signature. Too early, no deployment time, or telemetry unavailable: it stays `validation-pending` and says why.

## Operating it

| Question | Command |
|---|---|
| Is it running, and when did it last succeed? | `autodev monitor status` |
| What would the next pass do? | `autodev monitor run --dry-run` |
| Why did the last pass fail? | `monitor status` → `checkpoint.lastError`. A failed pass also exits non-zero (5), so the scheduled task's last result shows it. |
| Retry now despite backoff | `autodev monitor run --ignore-backoff` |
| What did it write? | `autodev audit show --action monitoring` and `--action agility` |

State is under `state\monitor\<project>\` (checkpoint, lock) and `state\incidents\<project>\`.

## Trying it without corporate access

`node scripts\autodev.mjs demo e2e` runs the whole pipeline (Splunk exception plus matching Dynatrace trace, a latency regression with no exception, an unmapped service, deduplication, approval, ticket creation, crash recovery, handoff) against local mocks in a temporary workspace.

`node scripts\autodev.mjs mock serve` starts the same mock services on 127.0.0.1 so you can point a scratch project at them and run individual commands.

## Status

The worker's logic is covered by unit tests and the end-to-end run. The Splunk, Dynatrace and Agility adapters have **not** been run against live systems; see `docs/unsupported.md` before enabling monitoring for a real project.
