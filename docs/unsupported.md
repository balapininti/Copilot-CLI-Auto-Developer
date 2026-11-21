# Verification status and known unsupported features

Nothing in this framework has been run against a real corporate Agility, Bitbucket, Splunk, Dynatrace or DB2 instance. It was built and tested on a developer machine with local mocks. This page says exactly what that does and does not establish, so nobody mistakes "tests pass" for "the integration works".

## What has been verified, and how

| Area | Verified by |
|---|---|
| Core rules: scoping, approvals, gates, redaction, audit chain, manifest validation, SQL guard, query scoping, hook policy | Unit tests (`npm test`) |
| Both workflows end to end, including crash recovery and deduplication | `autodev demo e2e` against the local mock server and a local git remote |
| Git behaviour (clone, dirty-tree preservation, release-branch checks, branching, commit, push) | Real `git` against local repositories |
| Browser automation | A Playwright smoke test against a page served on 127.0.0.1, run with the real Microsoft Edge on GitHub-hosted Windows and Linux runners (navigation, text, fill, password-field refusal, blocked navigation, screenshot) |
| Runs on Windows and Linux, Node 22 and 24, including the end-to-end run | The CI workflow on GitHub-hosted runners |
| PowerShell scripts parse on Windows PowerShell 5.1 and PowerShell 7; `Bootstrap.ps1 -CheckOnly` runs; a secret stored in Windows Credential Manager is read back through `Get-AutoDevCredential.ps1` and `src/core/secrets.js` | The CI workflow on a Windows runner. `Start-AutoDev.ps1`, `Set-AutoDevCredential.ps1` and `Register-MonitoringTask.ps1` are parsed and linted there but have **not** been executed. |

## What has NOT been verified

| Integration | Status | What to do first |
|---|---|---|
| **Copilot CLI agents and hooks** | Skill discovery is confirmed: Copilot CLI 1.0.114 (`copilot skill list`, run from this folder on macOS) listed the 15 skills that existed then; the `e2e-scenarios` skill was added later and is validated against the file format only. Agent selection (`--agent`) and the preToolUse hook need a signed-in session and have **not** been exercised; they are validated against the documented file formats only. Nothing was run on Windows outside CI. | In a session run `/agent` and `/skills list`; ask the agent to `git push` and confirm the hook refuses. |
| **Digital.ai Agility** | Written to the documented `rest-1.v1` JSON contract; exercised against the mock only. | `autodev agility verify`, then `autodev agility story <a real story>`. Confirm your custom field names in `agility.fields`. |
| **Agility through the browser session** | The code path exists (requests through the signed-in Edge profile). Never run against a real SSO. | `autodev auth login --service agility`, then `autodev agility verify` with no token set. |
| **Bitbucket pull request API** | Data Center REST 1.0 and Cloud REST 2.0 request shapes; mock only. | `autodev pr create --dry-run`, then a real PR on a scratch repository. |
| **Splunk** | `services/search/jobs/export`; mock only. | `autodev splunk search --minutes 5` with a token scoped to one index. |
| **Dynatrace** | Environment API v2 problems and metrics; mock only. | `autodev dynatrace problems --minutes 30`. |
| **DB2** | Guard, limits and redaction are unit-tested. The live driver path (`ibm_db`) has never connected to a database. | Install the driver (`docs/db2.md`), then `autodev db2 tables --schema <S>`. |
| **End-to-end scenarios** | HAR import, validation, the approval gate and expectation checks are unit-tested. A scenario was replayed in a real browser against a small page served on 127.0.0.1. Never run with a HAR from a real application, behind SSO, or by an agent in a Copilot session; how well an agent maps a recording to selectors in your code base is untested. | Record a short journey, `autodev scenario import`, and review the outline before asking the agent to complete it. |
| **Corporate proxy, CA and VPN behaviour** | Follows Node's and git's documented settings; not run on a corporate network. | `autodev doctor`, then `docs/corporate-network.md`. |

Treat each row as unverified until a real, authorized call through it has succeeded in your environment. When one does, record it for your team.

## Features that are deliberately not supported

| Feature | Why | What happens instead |
|---|---|---|
| MCP servers of any kind | Requirement | Local scripts, git, REST and Playwright only |
| Browser-session access to Splunk and Dynatrace | Their REST APIs are not reliably reachable with a web session, and the pattern was not testable | `AUTH_REQUIRED` naming the token to provide |
| Creating a pull request by driving the Bitbucket UI | Fragile, and it would act with the user's full UI session | The approved branch is pushed and a pre-filled "create pull request" link is returned |
| Browser fallback for DB2 | DB2 uses native authentication only | `AUTH_REQUIRED` when no connection profile is stored |
| DB2 writes, DDL and migrations | Default policy `dbWrites: prohibited`; no write path exists in the adapter | Schema changes travel in the pull request after explicit authorization |
| Merging pull requests, deploying, production remediation | Prohibited; the manifest schema cannot enable them | Not implemented |
| Automatic (unapproved) learning | Requirement | `learn propose` → person approves → `learn apply` |
| Typing credentials, automating MFA, exporting cookies | Would bypass corporate authentication | The user signs in themselves in a headed Edge window |
| Webhook or event-driven monitoring triggers | Needs an inbound endpoint and explicit organizational approval | Scheduled passes via Windows Task Scheduler |
| A long-running monitoring daemon | Short, restart-safe passes are simpler to operate and reason about | One bounded pass per scheduled run |
| Querying all Splunk indexes or all Dynatrace entities | Never by default | Queries are refused unless the project lists its indexes and entity selectors |
| Parsing a cron expression | `monitoring.schedule` is informational | The interval is set when the scheduled task is registered |
| Agility instances without `rest-1.v1` JSON | Only that contract is implemented | `UPSTREAM_ERROR` saying the response was not a rest-1.v1 asset list |
| Automatic chunked download of Agility attachments | Attachments are listed with their URLs; content is not fetched | Open the URL, or read it through the browser skill |
| Linux and macOS as production platforms | Windows-first | They work for development and CI; the credential store integration there is a convenience only |

## Known rough edges

- The SQL guard and review rules are conservative patterns. They reject some valid SQL (for example a column literally named `SET` or `COMMENT`, comma-separated table lists, quoted identifiers) and can flag harmless code. Rephrase the query; do not weaken the guard.
- Redaction can mask a 13 to 19 digit number that happens to pass a Luhn check, such as some numeric identifiers, in ticket text.
- The hook matches shell commands by pattern. A legitimate command inside a target repository that happens to mention a protected path name (for example a file called `project.yaml` in the repository being edited) together with a write verb will be refused; run it differently or ask the user to.
- `browser run` with clicking or typing steps can only target hosts listed in `browser.allowedHosts` that are not one of the project's service hosts. A UI test that must sign in through an identity provider needs that provider's host in the list.
- Free-form `db2 query` cannot read the catalog (`SYSCAT`, `SYSIBM`); use `db2 tables` and `db2 describe` for metadata.
- If the release branch named by a story moves between `repo prepare` and `pr create`, the pull request simply shows the new base; the framework does not rebase.
