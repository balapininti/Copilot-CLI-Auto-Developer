# Staged roadmap

Each phase has two parts: what is **built** (code exists and is tested against mocks) and what must happen to call it **verified** (a real, authorized call succeeded in your environment). Everything below is built. Nothing is verified against live corporate systems yet; that is the work each phase's exit check describes.

Per the priority update in the specification, the mocked monitoring → RCA → proposed ticket → approved handoff pipeline was built early, alongside the Bitbucket and DB2 foundations, and runs in `autodev demo e2e`.

## Phase 1: Browser and Agility read

| Built | Exit check on a corporate machine |
|---|---|
| Repository skeleton, result/error contract, redaction, logging | `.\scripts\Bootstrap.ps1` passes |
| Agent and skill files, discovery verification and user-level install | `autodev discovery verify` reports `confirmedWithCli: true`; `/skills list` and `/agent` show them in a session |
| preToolUse hook | Ask the agent to run `git push`; it is refused |
| Project manifest schema, onboarding, example project | `autodev onboard-project` then `autodev project validate` |
| Browser skill (Edge default, optional Chromium, persistent profile, allowlist) | `autodev auth login --service agility` completes with your SSO |
| Agility read-only adapter, API and browser-session paths | `autodev agility verify` and `autodev agility story <real story>` return real data, with a token and then without one |

## Phase 2: Project context and Bitbucket

| Built | Exit check |
|---|---|
| Board → project resolution, one-project sessions, scoped guidelines and learnings | `autodev project resolve --board <id>` for each of your boards; a second project's session cannot read the first's data |
| Clone/reuse from approved URLs, dirty-tree preservation, release-branch verification, feature branches | `autodev repo prepare --story <S-…> --repo <name>` on a real repository, including one with local changes and one story with a missing branch |

## Phase 3: DB2 and Java/Spring

| Built | Exit check |
|---|---|
| SQL guard, row and time limits, redaction, introspection commands | Install `ibm_db`; `autodev db2 tables --schema <S>` and `db2 describe` with the read-only account; confirm a write is refused by both the guard and the account |
| Build detection (Maven, Gradle, npm), versions, modules, layout | `autodev java detect --repo <name>` matches the repository |

## Phase 4: Tests, review and pull request

| Built | Exit check |
|---|---|
| Stage runner with evidence, tests gate | `autodev test run` on a real repository; a required stage with no command blocks |
| Automated review checks, independent review gate | `autodev review run`; the `code-reviewer` agent records a verdict |
| Gated commit, approval-gated push and PR, Agility updates | `autodev pr create --dry-run`, then one real PR on a scratch repository, approved through `approvals review` |

## Phase 5: Splunk and Dynatrace incident analysis

| Built | Exit check |
|---|---|
| Scoped Splunk search, Dynatrace problems and metrics | `autodev splunk search --minutes 5`, `autodev dynatrace problems --minutes 30` with least-privilege tokens |
| Incident model, correlation, deduplication, thresholds, worker with checkpoints, backoff and recovery | `autodev monitor run --dry-run`, then enabled against non-production for a week with ticket creation left at `approval-required` |
| Scheduled task registration | `Register-MonitoringTask.ps1`; `monitor status` shows successive passes |
| Defect drafting, approval, idempotent creation | One real defect approved and created; a repeat of the same error creates no second one |

## Phase 6: Controlled ticket-to-PR handoff

| Built | Exit check |
|---|---|
| Durable handoff queue, start authorization, atomic claim | An approved defect is queued, authorized by a person, claimed by `auto-developer`, and taken to an approved PR |
| Post-deployment resolution check | `monitor verify-resolution` after a real deployment returns verified, or says why validation is pending |

## Beyond phase 6: candidates, not commitments

- Verify and, where feasible, add browser-session access for Splunk and Dynatrace.
- Agility attachment download with content-type allowlist and size limits.
- Contract-test helpers for cross-repository changes.
- An approved webhook trigger for the worker, if the organization sanctions an inbound endpoint.
- A read-only status page generated from state, for teams that want visibility without the CLI.
- Signed approvals using a key the agent's process cannot read (for example a hardware-backed key), to turn the approval store from a guard rail into a boundary.
