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
