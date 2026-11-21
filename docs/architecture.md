# Architecture

## The idea in one paragraph

GitHub Copilot CLI supplies the reasoning. This framework supplies everything around it that must not be left to reasoning: which project is in scope, how each system is reached and authenticated, what may be read, what needs a person's approval before it is written, and what has to be true before a pull request can exist. Agents and skills are Markdown; every action they take goes through one local Node.js command (`autodev`) that enforces the rules in code. There is no MCP server anywhere.

## Layers

```
Copilot CLI session
  agents      .github/agents/*.agent.md       who coordinates what
  skills      .github/skills/<name>/SKILL.md  how to use one capability
  hook        .github/hooks/autodev.json      denies tool calls that go around the gates
      |
      v   node scripts/autodev.mjs <command>     one JSON result envelope per call
autodev CLI   src/cli
  workflow    src/workflow     run state and gates, pull requests, learning, onboarding, discovery
  monitoring  src/monitoring   incident model, correlation, worker, handoff queue
  adapters    src/adapters     agility, bitbucket (git + REST), db2, java, testing, review, splunk, dynatrace, browser
  core        src/core         errors, results, redaction, logging, state, audit, approvals,
                               manifest, project scope, HTTP, secrets, authentication, hook policy
      |
      v
Agility · Bitbucket · DB2 · Splunk · Dynatrace · Microsoft Edge (Playwright)
```

A second entry point does not involve Copilot at all: Windows Task Scheduler runs `autodev monitor run` on a schedule. That is the monitoring worker.

## Agents

| Agent | Role | Tools |
|---|---|---|
| `auto-developer` | The only coordinator of development and pull requests: ticket to PR | read, search, edit, execute, agent, todo |
| `incident-investigator` | Monitoring and root-cause analysis; prepares defects; never changes code | read, search, execute, agent, todo |
| `code-reviewer` | Independent review; records the verdict that gates the PR | read, search, execute |
| `test-validator` | Runs and interprets test stages | read, search, execute |

Capabilities live in skills, not agents, so nothing is duplicated: `project-context`, `agility`, `bitbucket`, `db2`, `java-spring`, `browser-playwright`, `testing`, `code-review`, `splunk`, `dynatrace`, `authentication`, `learning-management`, `incident-correlation`, `root-cause-analysis`, `workflow-handoff`.

## Workspace

```
C:\DevWorkspace\
  automation\                  this repository
  projects\<project-id>\
    project.yaml               mappings and policies; names of secrets, never values
    guidelines\*.md            the team's standards
    knowledge\<skill>\approved.md   learnings, written only after approval
    repos\<repo-name>\         clones the agent works in
  state\                       written only by the autodev CLI
    approvals\ audit\ runs\ evidence\ incidents\ monitor\ handoff\ learning\ sessions\
```

Skills are generic. Everything specific to a project is under `projects/<id>/` and is loaded only for that project.

## Discovery

Copilot CLI finds custom agents in `.github/agents` of the folder it is started in and in `~/.copilot/agents`, and skills in `.github/skills` and `~/.copilot/skills`. Being somewhere under `C:\DevWorkspace` does not make them discoverable. Two supported setups:

1. `scripts\Start-AutoDev.ps1` starts Copilot CLI in the automation folder (repository-level discovery).
2. `autodev discovery install` copies agents and skills into the user-level folders, with a manifest so `discovery uninstall` removes exactly what it added.

`autodev discovery verify` validates every agent, skill and hook file against the documented format and, when the `copilot` command is installed, asks it which skills it can see.

## The principles the code is built on

**One owner per piece of state.** The project manifest owns mappings and policy. The run store owns a story's branches and gate results. The incident store owns incidents. The queue owns handoff tasks. The approval store owns decisions. Nothing is cached in two places and reconciled later.

**Scope is checked once, at the door.** A session is bound to one project (`AUTODEV_PROJECT`, or a write-once session record). Every command resolves its project through `resolveProjectScope`, and a mismatch is `PROJECT_SCOPE_VIOLATION`. State is stored per project, so project A's incidents, approvals, learnings and telemetry are not reachable from project B's session.

**Approvals are bound to content.** An approval records the SHA-256 of the exact payload. Executing the action re-hashes what is about to be sent and consumes the approval. Changed content, a reused approval and an expired one are all refused.

**Gates are bound to code.** Test and review results are recorded against a git tree id, a fingerprint of the entire working tree. A pull request can be created only when the committed tree has that id. "Tests passed" can never refer to an earlier version of the change.

**Write-ahead for external writes.** Before a ticket is created, the intent is saved. If the process dies mid-write, the next pass looks the ticket up by its idempotency marker before doing anything else.

**Idempotency keys come from the data.** A defect's marker is derived from project, environment, service and error fingerprint. A handoff task id is derived from project and defect. Re-running is always safe.

**The lifecycle is a table.** An incident moves between states through a pure transition function; side effects happen outside it. Invalid moves are errors.

**Explicit unsupported states.** An integration that is not available says so with a specific error code. Nothing is simulated and nothing is assumed to work.

## The result contract

Every command prints one JSON object on stdout and structured, redacted logs on stderr.

```json
{ "ok": true,  "data": { }, "meta": { "command": "...", "projectId": "...", "dryRun": false, "durationMs": 12 } }
{ "ok": false, "error": { "code": "APPROVAL_REQUIRED", "message": "...", "retryable": false, "details": { } }, "meta": { } }
```

Exit codes: `0` success, `1` unexpected, `2` usage or configuration, `3` waiting on a person (approval or sign-in), `4` refused by policy or a gate, `5` upstream or transient.

## Ticket to pull request

```
project resolve -> session select -> agility story -> project guidelines
   -> (plan confirmed by the user)
   -> repo prepare        clone/reuse, verify release branch, create feature branch
   -> edit code           the agent, inside projects/<id>/repos only
   -> test run            records gate "tests"              (tree id)
   -> review run          records gate "automated-review"   (tree id)
   -> code-reviewer       records gate "independent-review" (tree id)
   -> repo commit         refused unless all three gates match the working tree
   -> pr create           gates checked against the commit, then the createPR policy,
                          then push + open PR. Never merged.
```

## Monitoring to development

```
Task Scheduler -> monitor run (one bounded pass)
   1. finish pending work     approved tickets, interrupted writes, unqueued handoffs
   2. read the next window    Splunk errors, Dynatrace problems and metrics, scoped and capped
   3. normalise + correlate   common incident model; trace id, else service and time
   4. deduplicate             project + environment + service + fingerprint + window
   5. map to repositories     unknown mapping -> needs-onboarding, nothing further
   6. propose a defect        approval request; no ticket yet
   7. save checkpoint
person approves -> next pass creates the ticket once -> handoff queue
person approves the start (or policy allows it) -> auto-developer claims the task,
   re-reads the ticket and runs the normal ticket-to-PR workflow
after an approved deployment -> monitor verify-resolution -> resolved only on evidence
```

## Dependencies

Runtime: `yaml`, `ajv`. Optional: `playwright-core` (drives the installed Edge; downloads no browser) and `ibm_db` (installed separately when DB2 access is wanted). Tests use Node's built-in runner. This keeps installation workable behind a corporate registry mirror.
