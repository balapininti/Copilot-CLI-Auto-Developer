---
name: root-cause-analysis
description: "Investigates an incident to its cause using project context, the mapped repositories, recent commits and deployments, and read-only database metadata, and records the conclusion as a verified root cause, an evidence-backed hypothesis, or insufficient evidence. Use after an incident is correlated and before a defect is approved."
---

# Root cause analysis

Run `autodev <command>` as `node "$env:AUTODEV_HOME\scripts\autodev.mjs" <command>`; each prints one JSON envelope (`ok`, then `data` or `error.code`).

## Contract

| Need | Command |
|---|---|
| The incident and its evidence | `autodev incident show <INC-…>` |
| Service → repository and schemas | `autodev project repos`, `autodev project schemas` |
| Architecture context | `autodev project guidelines --task investigate` |
| More log evidence | `autodev splunk search …` |
| More telemetry | `autodev dynatrace problems …`, `autodev dynatrace metrics …` |
| Table shape, if data matters | `autodev db2 describe …`, `autodev db2 query …` |
| Record the conclusion | `autodev incident classify --incident <INC-…> --classification <…> --statement "…" --evidence "…" [--evidence "…"]` |

## Method

1. **Restate the symptom** from the evidence only: what failed, where, since when, how often.
2. **Locate the code.** Use `candidateRepos` and the stack frame or endpoint in the evidence. Read the failing path and what it depends on. Work in the existing clone under the project's `repos/` folder; read-only.
3. **Look at what changed.** `recentCommits` on the incident, `git log` on the release branch around `firstSeen`, and `deploymentVersions`. A change shortly before first occurrence is a lead. Many incidents start with no code change at all (data, load, a dependency, configuration).
4. **Form hypotheses, then try to break them.** For each: what would have to be true, and what evidence would contradict it? Go and look for the contradicting evidence.
5. **Classify honestly:**

| Classification | Use when | Evidence required |
|---|---|---|
| `verified-root-cause` | The failing path is identified and independently confirmed, for example by a reproduction, or by two independent sources agreeing | at least two `--evidence` references |
| `evidence-backed-hypothesis` | Evidence points to a cause, but it is not confirmed | at least one |
| `insufficient-evidence` | You cannot responsibly name a cause | none; say what is missing |

6. **Record it** with `incident classify`. Each `--evidence` is a short reference someone can follow: a file and line, a commit, a trace id, a search link. The statement and evidence appear in the defect.

## Rules

- **Never label a hypothesis as proven.** "Likely", "consistent with" and "suggests" are hypotheses. The command refuses a verified root cause without two pieces of evidence; do not pad the evidence to get past it.
- A trace id, a time coincidence, or Dynatrace's own "root cause entity" is a lead. None is proof.
- If the service has no repository mapping, stop and report the missing mapping. Do not go looking through other projects' repositories.
- Read-only throughout. No code changes, no configuration changes, no restarts, no data fixes. Production remediation is prohibited.
- Suggest the tests that would have caught it: they go into the defect as validation tests.
- State what you did not check. An investigation that names its own gaps is more useful than one that sounds complete.
