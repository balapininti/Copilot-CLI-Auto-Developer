# Copilot CLI Enterprise Auto Developer Framework

A Windows-first, locally executed, MCP-free automation framework for [GitHub Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli). It gives Copilot two governed workflows:

- **Ticket to pull request.** An `auto-developer` agent takes a Digital.ai Agility story through project context, the right Bitbucket repositories and release branch, a written plan that is independently evaluated before any code, a minimal Java/Spring Boot or UI change, tests, independent review, and an approved pull request.
- **Monitoring to defect.** A scheduled worker reads scoped Splunk and Dynatrace telemetry, correlates and deduplicates it into incidents, and proposes Agility defects; an `incident-investigator` agent does the root-cause analysis; approved defects are handed to the auto-developer through a durable queue.

Copilot supplies the reasoning. The framework supplies the rules, and enforces them in code rather than in prompts: one project per session, approvals bound to the exact content, test and review results bound to the exact code, nothing remembered without approval, nothing merged or deployed.

> **Status: built and tested against local mocks; not yet verified against live corporate systems.**
> The Agility, Bitbucket, Splunk, Dynatrace and DB2 adapters follow the vendors' documented APIs and pass against a local mock server. None has been run against a real instance. Skill discovery was confirmed with Copilot CLI 1.0.114 (`copilot skill list` shows all 15 skills); agent selection and the hook have not been exercised in a signed-in session. [docs/unsupported.md](docs/unsupported.md) lists exactly what is and is not verified and the first command to run for each. Treat every integration as unverified until a real, authorized call succeeds in your environment.

## Try it in five minutes, with no corporate access

Requires Node.js 22.12 or later and git.

```powershell
git clone https://github.com/balapininti/Copilot-CLI-Auto-Developer.git automation
cd automation
npm ci
npm run check                        # lint, type-check, unit tests
node scripts\autodev.mjs demo e2e    # both workflows, end to end, against local mocks
```

`demo e2e` builds a throwaway workspace, a local git remote and a mock Agility/Bitbucket/Splunk/Dynatrace, then runs the real adapters, gates, approval store, monitoring worker and handoff queue through both workflows and reports each acceptance check by name.

## Set up on a Windows workstation

The short version is below; [docs/setup.md](docs/setup.md) is the full walkthrough and [docs/diagrams.md](docs/diagrams.md) shows how the pieces fit.

```powershell
# 1. Put this repository at <workspace>\automation, e.g. C:\DevWorkspace\automation
.\scripts\Bootstrap.ps1              # checks prerequisites, installs dependencies, creates projects\ and state\

# 2. Onboard a project (asks only for company-specific facts; skipped answers are reported, never guessed)
node scripts\autodev.mjs onboard-project
#    or let Copilot build it from what you already have (repository clones, an older skill, team documents);
#    it proposes, you approve:  .\scripts\Start-AutoDev.ps1 -Agent project-onboarder

# 3. Store secrets in Windows Credential Manager (typed at a hidden prompt, never on the command line)
.\scripts\Set-AutoDevCredential.ps1 -Name AGILITY_TOKEN

# 4. Check what is still missing, and that access works
node scripts\autodev.mjs project validate --project <id>
node scripts\autodev.mjs auth status      --project <id>
node scripts\autodev.mjs agility verify   --project <id>

# 5. Start Copilot CLI with the agents and skills discoverable, bound to one project
.\scripts\Start-AutoDev.ps1 -Project <id>
```

Then, in the session: *"Implement story S-01234 from board 501."*

When the agent reaches something that needs your approval (a pull request, a ticket, a learning), it gives you an approval id. Review and decide it **in a separate terminal**:

```powershell
node scripts\autodev.mjs approvals review apr-1a2b3c4d5e6f --project <id>
```

Prerequisites: Windows 10/11, PowerShell 6 or later (a Copilot CLI requirement), Node.js 22.12+, git, GitHub Copilot CLI (`npm install -g @github/copilot` or `winget install GitHub.Copilot`), and Microsoft Edge. `playwright-core` drives the installed Edge and downloads no browser. `autodev doctor` checks all of this.

## Workspace layout

```
C:\DevWorkspace\
  automation\                       this repository
    .github\agents\                 auto-developer, incident-investigator, project-onboarder, plan-reviewer, code-reviewer, test-validator
    .github\skills\<name>\SKILL.md  18 shared skills
    .github\hooks\autodev.json      preToolUse hook
    scripts\                        autodev.mjs, Bootstrap.ps1, Start-AutoDev.ps1, …
    src\core\  src\adapters\  src\monitoring\  src\workflow\  src\cli\
    schemas\project.schema.json
    tests\  docs\  examples\
  projects\<project-id>\
    project.yaml                    mappings and policies; names of secrets, never values
    guidelines\*.md                 your team's standards
    knowledge\<skill>\approved.md   learnings, written only after approval
    repos\<repo-name>\              clones the agent works in
  state\                            approvals, audit log, run state, incidents, queue (written only by autodev)
```

Copilot CLI discovers agents and skills from `.github\agents` and `.github\skills` of the folder it is started in, or from `~\.copilot`. Being under `C:\DevWorkspace` is not enough, so either start it with `Start-AutoDev.ps1` or run `autodev discovery install`. `autodev discovery verify` checks the result.

## What is enforced, not just requested

| Guarantee | How |
|---|---|
| One explicitly selected project per session; no cross-project data | Session binding checked by every command; state stored per project |
| Repositories cloned only from approved URLs; dirty clones preserved | Host allowlist; no reset, clean or force exists in the code |
| The story's release branch is the base; a missing one is a blocker | Verified on the remote; no fallback to the default branch |
| No commit or PR until the story's plan has been independently evaluated as ready | The verdict is bound to the hash of the plan; a P0 or P1 finding cannot be signed off; the author cannot record its own evaluation (`policies.planReview`) |
| A PR only after tests, automated review and independent review pass for the exact code | Gate results are bound to a git tree id |
| No PR, ticket, comment, schema change or start of defect work without the configured approval | Approvals bound to a SHA-256 of the exact payload, single-use, decided at a real terminal |
| A baseline end-to-end scenario cannot be changed without approval | Only `scenario apply` writes one; an edited scenario fails its integrity check and is not run as a baseline; an update names every expectation it removes |
| An agent cannot create a project or set its own policies | `onboard propose` stages every file for approval; `onboard apply` writes exactly what was approved; answers cannot set a policy |
| No learning without approval of the exact text | Only `learn apply` writes knowledge; unapproved files fail an integrity check and are never loaded |
| DB2 is read-only and scoped | SQL guard, row and time limits, column redaction; no write path |
| Telemetry queries are scoped and bounded | Explicit indexes and entity selectors, capped windows and results |
| Token first, then the signed-in Edge session; never a bypass | No cookie export, no password filling, no MFA automation, no disabled TLS |
| Secrets stay in the OS credential store or injected environment | Refused in manifests, masked in logs, results and tickets, blocked in commits |
| Never merges, deploys or touches production | Not implemented; the manifest schema cannot enable it |
| Everything is auditable | Hash-chained audit log per project (`autodev audit verify`) |

These are strong guard rails on a machine where the agent runs as you. They are not a substitute for least-privilege tokens, a read-only DB2 account and Bitbucket branch protection. [docs/security.md](docs/security.md) has the threat model and the honest limits.

## The command line

Agents and skills act only through `autodev`. Every command prints one JSON envelope (`ok` + `data`, or `ok: false` + `error.code`), takes `--dry-run`, and exits with a code that says whether it succeeded (0), needs a person (3), was refused by policy (4) or hit an upstream problem (5).

```powershell
node scripts\autodev.mjs help
```

| Group | Commands |
|---|---|
| Setup | `doctor`, `discovery verify/install/uninstall`, `onboard-project`, `onboard scan/propose/apply`, `demo e2e`, `mock serve` |
| Project | `project list/show/validate/resolve/repos/schemas/guidelines`, `session status/select`, `service hosts` |
| Access | `auth status/login`, `agility verify/boards/story/comment/status` |
| Code | `repo status/prepare/diff/commit`, `java detect`, `db2 tables/describe/query`, `browser run` |
| Quality | `plan submit/show/review`, `test run`, `review run/record`, `run show`, `pr create` |
| End-to-end scenarios | `scenario import/run/propose/apply/list/show/affected` |
| Monitoring | `splunk search`, `dynatrace problems/metrics`, `monitor run/status/verify-resolution`, `incident list/show/classify/link-pr/close`, `handoff list/authorize/next/complete` |
| Governance | `approvals list/show/review`, `learn propose/apply/list/verify`, `audit show/verify` |

## Documentation

| Document | Contents |
|---|---|
| [docs/setup.md](docs/setup.md) | Step-by-step setup: where URLs, tokens, mappings and your team's process go; verifying each integration; end-to-end testing |
| [docs/diagrams.md](docs/diagrams.md) | Architecture and flow diagrams: layers, configuration, ticket to PR, gates, approvals, authentication, monitoring, handoff, learning |
| [docs/architecture.md](docs/architecture.md) | Layers, agents and skills, discovery, design principles, both workflows |
| [docs/security.md](docs/security.md) | What is enforced and where, approvals, the hook, threat model and limits |
| [docs/unsupported.md](docs/unsupported.md) | Verification status of every integration; features deliberately not supported |
| [docs/onboarding.md](docs/onboarding.md) | Onboarding questions, the manifest, what to do afterwards |
| [docs/plan-review.md](docs/plan-review.md) | The plan every change starts from, the evaluation prompt, the P0 to P4 scale and how the gate is enforced |
| [docs/e2e-scenarios.md](docs/e2e-scenarios.md) | Building baseline end-to-end scenarios from a recorded HAR, running them, and keeping them current as the code changes |
| [docs/monitoring.md](docs/monitoring.md) | The monitoring worker, scheduling, incident lifecycle, handoff |
| [docs/corporate-network.md](docs/corporate-network.md) | VPN, proxies, certificate authorities, SSO, allowlists, troubleshooting |
| [docs/secrets.md](docs/secrets.md) | Where secrets live, how to store and rotate them, least-privilege guidance |
| [docs/db2.md](docs/db2.md) | Driver installation, connection profiles, what the SQL guard allows |
| [docs/rollback.md](docs/rollback.md) | How to undo anything the framework did |
| [docs/roadmap.md](docs/roadmap.md) | The six phases, what is built, and the exit check that verifies each |
| [docs/acceptance.md](docs/acceptance.md) | Each acceptance criterion and where it is demonstrated |

## Development

```powershell
npm run lint
npm run typecheck      # JSDoc types checked by the TypeScript compiler; there is no build step
npm test               # Node's built-in test runner
npm run check          # all three
```

Plain ESM JavaScript, no transpilation, two runtime dependencies (`yaml`, `ajv`) plus optional `playwright-core`. CI runs on Windows and Linux with Node 22 and 24, parses every PowerShell script under Windows PowerShell 5.1 and PowerShell 7, and runs the end-to-end demo.

## License

MIT. See [LICENSE](LICENSE).
