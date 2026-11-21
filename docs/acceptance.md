# Acceptance criteria and where each is demonstrated

"Demonstrated" here means by the unit tests and by `autodev demo e2e`, which runs the real adapters, gates, approval store, worker and queue against a local mock server and a local git remote. It does not mean demonstrated against live corporate systems; see `docs/unsupported.md`.

Run both yourself:

```powershell
npm test
node scripts\autodev.mjs demo e2e
```

The demo result lists every check by name, grouped by area; the names below are those checks.

## Core criteria

| Criterion | Demonstrated by |
|---|---|
| Given board and story, fetch a real story or report a specific auth/access limitation without fabricating data | Demo, *agility*: "story is read through the API with a token", "a story that does not exist is reported, not invented", "with no token and no browser fallback the limitation is stated". Live fetch: unverified. |
| Given multiple mapped repos and schemas, load only the correct project-scoped information | Demo, *project context*: "only the project's own schemas are loaded", "a board mapped to two projects is refused as ambiguous"; *project isolation* checks |
| Existing dirty clones are preserved; missing clones are cloned only from approved URLs | Demo, *repository*: "a repository URL on an unapproved host is refused", "missing clone is cloned from the approved URL", "a dirty worktree is never overwritten by branch creation", "uncommitted work is still in place afterwards", "an existing dirty clone is reused and reported, not reset" |
| Story release branch controls the feature-branch base; missing base is a blocker | Demo, *repository*: "feature branch is created from the story release branch", "a release branch that does not exist is a blocker", "a story without a release branch does not fall back to the default branch" |
| Edge and optional Chromium work without MCP; no silent auth bypass | No MCP exists in the codebase (`discovery verify` fails an agent that declares one). Channel rules and the Playwright smoke test are in the browser tests. Edge itself: verified only where Edge is installed. |
| Tests and code review gate PR creation; failures are clearly reported | Demo, *gates* and *pull request*: "a pull request is refused before the work is committed and checked", "changing the code after review invalidates the gates", "stages with no command are reported as not-configured, not as passed", "automated review blocks a hard-coded secret and disabled TLS checks" |
| No project learning is written without explicit approval of the exact diff | Demo, *learning*: "proposing a learning writes nothing to the knowledge folder", "a learning cannot be written before it is approved", "after approval exactly the approved text is written", "a knowledge file edited outside the approval gate is detected and not loaded" |
| No external ticket, PR, DB write, production action or secret disclosure outside configured authorization | Demo: "creating the PR requires approval", "nothing was pushed or created while approval is pending", "a spent approval cannot be reused", "no Agility ticket is created without approval", "a write statement is rejected", "no token appears in the audit log". Production actions cannot be enabled by the manifest schema. |
| All workflows have dry-run and repeatable tests | `--dry-run` on every command; demo: "dry run reports the PR it would create and writes nothing", "a dry-run pass reports candidates and stores nothing" |

## Monitoring criteria

| Criterion | Demonstrated by (demo, *monitoring* / *handoff* unless noted) |
|---|---|
| Synthetic Splunk exception + matching Dynatrace trace produces one incident with both evidence links | "a Splunk exception and the matching Dynatrace problem become one incident with both evidence links" |
| Repeated same error produces no duplicate Agility ticket | "a second pass creates no duplicate incident or approval", "after approval the defect is created exactly once", "later passes do not create the ticket again" |
| Performance regression without an exception can still create a proposed incident when a configured threshold is breached | "a latency regression with no exception is proposed because a configured threshold was breached" |
| Missing span ID still permits time/service-based investigation with lower confidence, not a made-up trace | "missing trace and span ids are reported as missing, not made up" |
| Unknown service-to-repo mapping blocks autonomous code changes and requests onboarding clarification | "an unknown service-to-repository mapping blocks the incident for onboarding" |
| No Agility ticket created without approval; no developer handoff starts coding unless policy permits it | "no Agility ticket is created without approval", "queued work cannot be claimed until development is authorized", "starting development needs approval when autoStartDevelopment is false" |
| Monitoring worker can restart without losing incidents or repeating writes | "the checkpoint survives between passes", "a pass interrupted mid-write recovers without a duplicate ticket" |
| Project A telemetry, schemas and learning never contaminate Project B | *project isolation*: "the other project has no incidents", "an incident cannot be read through another project", "monitoring stays off for a project that did not enable it" |
| Production credentials and sensitive log fields never appear in prompts, ticket bodies or logs | "the ticket body is sanitized"; *audit*: "no token appears in the audit log"; redaction unit tests |
| End-to-end dry-run with mocked Splunk, Dynatrace, Agility and Bitbucket is runnable without corporate access | `autodev demo e2e` itself |
| A null threshold must not trigger a fabricated alert | Threshold unit tests; the demo sets only `p95LatencyMs` and no error-rate incident appears |
| Never label a hypothesis as proven | "correlated incidents are not labelled as a verified root cause", "the ticket separates hypotheses from verified findings"; `incident classify` refuses a verified root cause with fewer than two pieces of evidence |

## Engineering deliverables

| Deliverable | Where |
|---|---|
| Agents, skills, source, CLI, schema, example YAML | `.github/agents`, `.github/skills`, `src`, `scripts/autodev.mjs`, `schemas/project.schema.json`, `examples/projects/sample-project` |
| Windows PowerShell bootstrap and prerequisite validation | `scripts/Bootstrap.ps1`, `scripts/Start-AutoDev.ps1`, `autodev doctor` |
| Typed adapters, JSON result/error contract, sanitized logging, dry-run | JSDoc types checked by `npm run typecheck`; `src/core/result.js`, `errors.js`, `logger.js`, `redact.js` |
| Unit tests with mocked APIs, local Playwright smoke test, Agility read-only proof of concept | `tests/`, `src/mocks/server.js`, `autodev agility verify` |
| Permission gates, allowlists, retries/timeouts, idempotency, deduplication, audit log, rollback guidance | `src/core/approvals.js`, `http.js`, `audit.js`; `src/monitoring`; `docs/rollback.md` |
| Documentation for network, SSO, proxies, certificates, secrets, unsupported features | `docs/corporate-network.md`, `docs/secrets.md`, `docs/unsupported.md`, `docs/security.md` |
| Staged roadmap | `docs/roadmap.md` |
