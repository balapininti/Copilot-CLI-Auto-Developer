# Onboarding a project

Onboarding creates `projects/<id>/` with a `project.yaml`, guideline templates and the knowledge folder. It asks only for company-specific facts, accepts partial answers, and never guesses a repository name, schema or URL. It contacts no external system.

## Run it

Interactively, at a terminal:

```powershell
node scripts\autodev.mjs onboard-project
```

Or from a file of answers (useful for review and repeatability):

```powershell
node scripts\autodev.mjs onboard-project --answers .\my-project.answers.json --dry-run   # preview
node scripts\autodev.mjs onboard-project --answers .\my-project.answers.json
```

Press Enter to skip any question. A skipped answer is written as `null` and reported under `missing`.

## Let Copilot build it from what you already have

You may already have most of the answers on the machine: clones of the project's repositories, an older skill or prompt file, a runbook, a wiki export. The `project-onboarder` agent reads what you point it at, fills in the answers, drafts the guideline files, and proposes the project. Nothing is created until you approve the exact files.

```powershell
cd C:\DevWorkspace\automation
.\scripts\Start-AutoDev.ps1 -Agent project-onboarder      # no -Project: there is no project yet
```

Tell it what to read:

> Onboard the orders project. Repositories are cloned under C:\src\orders. My old skill is in C:\Users\me\.copilot\skills\orders. The team runbook is C:\docs\orders-runbook.md.

What happens:

1. **Scan** (`autodev onboard scan`). Read-only. For each git clone it finds the remote URL, build tool, Java and Spring Boot versions and the test commands the build tool implies. From documents it collects the hosts that URLs point at, with a guess at which system each is.
2. **Read.** The agent reads the documents that look relevant and extracts boards, team names, schemas, services, release-branch conventions and process rules.
3. **Facts and gaps.** It shows you a table of every value with the file it came from, and a list of what it could not find. Correct it and answer what you can. Gaps are fine; they are recorded as missing.
4. **Proposal** (`autodev onboard propose`). It builds `project.yaml` and the guideline drafts and requests approval.
5. **Your review**, in your own terminal:

   ```powershell
   node scripts\autodev.mjs approvals review apr-… --project orders
   ```

   You see every file in full, the URLs it wants you to set, what is still missing, and the list of sources it read.
6. **Creation** (`autodev onboard apply`), exactly as approved.
7. **Handover.** The agent gives you the commands to set the environment variables with the URLs it found, the names of the secrets to store, and what is still missing. You run those yourself, then start a normal session: `.\scripts\Start-AutoDev.ps1 -Project orders`.

What to check when you review:

- **Test commands** under `repositories[].tests`. These are programs the framework will run in your clones. They should be your build tool and nothing else.
- **Hosts** in `bitbucket.allowedHosts` and `browser.allowedHosts`. These decide where code may be cloned from and where the browser may click.
- **Guideline text.** It becomes what every later agent treats as your team's rules. Each drafted line should name its source; delete what you do not recognise.
- **Boards and team names.** A wrong board maps other teams' stories to this project.

Limits, by design:

- **It reads only what you name.** It does not search the machine.
- **Your existing files are treated as information, not instructions.** If an old skill says "push straight to main", that is reported to you as a conflict, not adopted.
- **No secrets.** Credentials embedded in clone URLs are removed by the scan, `.env` files are never read, and an answer or guideline that looks like it contains a secret is refused. Tokens are stored by you, with `Set-AutoDevCredential.ps1`.
- **It cannot set policy.** Every policy starts at its restrictive default, monitoring starts off, and thresholds start empty, whatever the answers contain. Loosening one is a person's edit to `project.yaml`.
- **It cannot set environment variables or change an existing project.** It gives you the commands and the list of edits.
- **New projects only.** Onboarding an id that already exists is refused.

`autodev onboard scan --path <folder>` is also useful on its own: run it yourself to see what would be discovered before involving the agent.

**Status:** the scanner, the answers handling and the approval gate are tested. The agent itself has not yet been run in a Copilot session, so read its first proposal closely.

## What it asks

| Answer key | Meaning |
|---|---|
| `id`, `name` | Project id (folder name) and display name |
| `agilityBaseUrlEnv` | **Name** of the environment variable holding the Agility URL |
| `boardIds`, `teamNames` | Agility team room id(s) and team name(s) that map to this project. With team names set, a session refuses tickets that belong to another team. |
| `defectScope` | Agility scope OID where defects are created, e.g. `Scope:1234` |
| `acceptanceCriteriaField`, `releaseBranchField` | Your instance's attribute names for these |
| `releaseBranchPattern` | Regex with one capture group, used when there is no release-branch field |
| `bitbucketFlavor`, `bitbucketBaseUrlEnv`, `bitbucketProjectKey`, `bitbucketAllowedHosts` | Bitbucket details and the hosts repositories may be cloned from |
| `repositories` | `name=URL_ENV_VAR` pairs |
| `featureBranchPattern` | Default `feature/{storyId}-{slug}` |
| `db2ConnectionProfile`, `db2Schemas` | DB2 profile name and owned schemas |
| `services` | `service=repository` pairs (service ownership) |
| `splunkBaseUrlEnv`, `splunkProfile`, `splunkIndexes`, `splunkSourcetypes` | Splunk scope |
| `dynatraceBaseUrlEnv`, `dynatraceProfile`, `dynatraceEntitySelectors` | Dynatrace scope (separate selectors with `;`) |
| `monitoringEnvironment` | The one environment the worker watches |
| `javaVersion`, `springBootVersion`, `uiFramework` | Tech versions |
| `securityRestrictions` | Restrictions the agents must respect |
| `requiredTests` | Stages required before a PR (default `compile, unit`) |
| `chromiumApproved` | Whether Chromium is approved in addition to Edge |
| `browserAllowedHosts` | Hosts the browser may open: the application under test and your identity provider |
| `repositoryDetails` | Answers file only. Per repository: `type`, `schemas` and `tests` (commands as argument arrays). See the `onboarding` skill for the shape |
| `environmentValues` | `onboard propose` only. The URLs for the variables named above; shown for approval and returned as commands for you to run, never written into the project |

Give the **names** of environment variables and credential entries. An answer that looks like a secret or a URL with embedded credentials is refused.

Example answers file:

```json
{
  "id": "orders",
  "name": "Orders platform",
  "agilityBaseUrlEnv": "AGILITY_BASE_URL",
  "boardIds": "501",
  "releaseBranchPattern": "Release branch:\\s*(\\S+)",
  "bitbucketFlavor": "server",
  "bitbucketBaseUrlEnv": "BITBUCKET_BASE_URL",
  "bitbucketProjectKey": "ORD",
  "bitbucketAllowedHosts": "bitbucket.corp.example",
  "repositories": "service-api=SERVICE_API_REPO_URL, web-ui=WEB_UI_REPO_URL",
  "db2ConnectionProfile": "db2-dev-readonly",
  "db2Schemas": "APP, COMMON",
  "services": "orders-service=service-api"
}
```

## What it writes

```
projects\<id>\
  project.yaml
  guidelines\architecture.md  coding-standards.md  development-workflow.md  testing-standards.md
  knowledge\README.md
  repos\
```

It refuses to replace an existing `project.yaml`. To change a project later, edit its `project.yaml` and validate.

## After onboarding

1. **Fill in the guideline templates.** The agents read them before planning, implementing, testing and reviewing. An empty section is reported as a gap; it is not filled with generic advice.
2. **Set the environment variables** the manifest names (base URLs and repository URLs), for example in your PowerShell profile.
3. **Store the secrets** (`docs/secrets.md`): `.\scripts\Set-AutoDevCredential.ps1 -Name AGILITY_TOKEN`, and so on.
4. **Configure test commands** under `repositories[].tests`, as argument arrays. Any stage listed in `tests.required` must have a command (or be detectable for Maven/Gradle), otherwise the tests gate cannot pass.
5. **Validate**: `node scripts\autodev.mjs project validate --project <id>` lists everything still missing and what each item is needed for.
6. **Check access**: `node scripts\autodev.mjs auth status --project <id>` and `node scripts\autodev.mjs agility verify --project <id>`.
7. **Monitoring** stays off until you set `monitoring.enabled: true`, list the Splunk indexes and Dynatrace entity selectors, take real thresholds from the owning team, and register the scheduled task (`docs/monitoring.md`).

## Mapping rules

- A board may map to exactly one project. If two projects list the same board, `project resolve` returns `PROJECT_AMBIGUOUS` and the agent must ask.
- A project may have many repositories and many schemas. `services[]` says which service is backed by which repository and schemas; incidents for a service with no mapping stop at `needs-onboarding`.
- `repositories[].branchPolicy` is `story-release-branch-required` by default. `default-release-branch-allowed` (with `defaultReleaseBranch`) is an explicit opt-in per repository.
- Policies default to the restrictive choice. `productionChanges` and `monitoring.incidentPolicy.productionRemediation` can only be `prohibited`.

The full schema is `schemas/project.schema.json`; a commented example is `examples/projects/sample-project/project.yaml`.
