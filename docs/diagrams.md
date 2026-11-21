# Architecture and flow diagrams

How the framework works, in pictures. GitHub renders these Mermaid diagrams in place; in VS Code use the Markdown preview with a Mermaid extension. The prose behind them is in [architecture.md](architecture.md), [security.md](security.md) and [monitoring.md](monitoring.md).

1. [The system on one page](#1-the-system-on-one-page)
2. [Layers inside the automation folder](#2-layers-inside-the-automation-folder)
3. [Where a skill gets its URLs, tokens and process](#3-where-a-skill-gets-its-urls-tokens-and-process)
4. [What happens on one command](#4-what-happens-on-one-command)
5. [Ticket to pull request](#5-ticket-to-pull-request)
6. [Gates: why "tests passed" always means this code](#6-gates-why-tests-passed-always-means-this-code)
7. [Approvals](#7-approvals)
8. [Authentication](#8-authentication)
9. [One monitoring pass](#9-one-monitoring-pass)
10. [Incident lifecycle](#10-incident-lifecycle)
11. [Defect to development handoff](#11-defect-to-development-handoff)
12. [Learning](#12-learning)

## 1. The system on one page

Two things start work: a developer in a Copilot CLI session, and Windows Task Scheduler. Both go through the same local command, `autodev`, and nothing else talks to the corporate systems.

```mermaid
flowchart LR
    dev(["Developer"])
    sched(["Windows Task Scheduler"])

    subgraph ws["Developer workstation"]
        direction TB
        copilot["GitHub Copilot CLI session<br/>agents + skills + hook"]
        cli["autodev CLI<br/>node scripts/autodev.mjs"]
        projects[("projects/#lt;id#gt;<br/>project.yaml, guidelines,<br/>knowledge, repos")]
        state[("state<br/>approvals, audit, runs,<br/>incidents, handoff queue")]
        creds[("Windows Credential Manager<br/>and environment variables")]
    end

    subgraph corp["Corporate systems"]
        direction TB
        agility["Digital.ai Agility"]
        bitbucket["Bitbucket"]
        db2["DB2 (read-only)"]
        splunk["Splunk"]
        dynatrace["Dynatrace"]
    end

    dev -- "Start-AutoDev.ps1 -Project id" --> copilot
    dev -- "approvals review<br/>(own terminal)" --> cli
    sched -- "monitor run<br/>every N minutes" --> cli
    copilot -- "every action is one<br/>autodev command" --> cli
    cli --> projects
    cli --> state
    cli --> creds
    cli -- "REST, token first" --> agility
    cli -- "git + REST" --> bitbucket
    cli -- "guarded SELECT" --> db2
    cli -- "scoped search" --> splunk
    cli -- "problems, metrics" --> dynatrace
```

There is no server, no hosted component and no MCP. Copilot supplies the reasoning; `autodev` decides what is allowed.

## 2. Layers inside the automation folder

```mermaid
flowchart TB
    subgraph md["Markdown: what Copilot reads (.github)"]
        agents["Agents<br/>auto-developer, incident-investigator,<br/>code-reviewer, test-validator"]
        skills["15 skills<br/>one capability each, generic"]
        hook["preToolUse hook<br/>denies tool calls that go around the gates"]
    end

    subgraph code["Code: what enforces the rules (src)"]
        clilayer["cli<br/>argument parsing, JSON envelope, exit codes"]
        workflow["workflow<br/>run state and gates, pull requests,<br/>learning, onboarding, discovery"]
        monitoring["monitoring<br/>incident model, correlation, worker,<br/>defect draft, handoff queue"]
        adapters["adapters<br/>agility, bitbucket, db2, java, testing,<br/>review, splunk, dynatrace, browser"]
        core["core<br/>project scope, manifest, approvals, audit,<br/>secrets, auth, HTTP, redaction, state store"]
    end

    agents -- "use" --> skills
    skills -- "run autodev commands" --> clilayer
    hook -. "checks every tool call" .-> agents
    clilayer --> workflow
    clilayer --> monitoring
    workflow --> adapters
    monitoring --> adapters
    workflow --> core
    monitoring --> core
    adapters --> core
```

| Layer | Folder | Rule of thumb |
|---|---|---|
| Agents | `.github/agents` | Who coordinates. Four files, no capability logic. |
| Skills | `.github/skills` | How to use one capability. Generic: no URL, project name or team rule appears in a skill. |
| Hook | `.github/hooks`, `scripts/hooks` | A net under the agents: blocks direct `git push`, direct writes to `state\` and `knowledge\`, and similar. |
| CLI | `src/cli` | One command in, one JSON envelope out. |
| Workflow, monitoring | `src/workflow`, `src/monitoring` | The two business flows. |
| Adapters | `src/adapters` | One per external system; each returns the same shapes whatever the transport. |
| Core | `src/core` | Everything every command depends on. Scope, approvals and audit live here, so no adapter can skip them. |

## 3. Where a skill gets its URLs, tokens and process

Skills never contain company facts. When a skill runs a command, `autodev` puts the facts together from five places. Setting these up is what [setup.md](setup.md) walks through.

```mermaid
flowchart LR
    skill["Skill runs, for example<br/>autodev agility story S-01234"]

    subgraph facts["What you set up, once per project"]
        direction TB
        manifest["projects/#lt;id#gt;/project.yaml<br/>mappings, policies and the NAMES<br/>of variables and secrets"]
        env["Environment variables<br/>the URLs: AGILITY_BASE_URL,<br/>BITBUCKET_BASE_URL, repo URLs ..."]
        store["Credential Manager<br/>the tokens: autodev/AGILITY_TOKEN ..."]
        guide["projects/#lt;id#gt;/guidelines/*.md<br/>your team's process and standards"]
        know["projects/#lt;id#gt;/knowledge/#lt;skill#gt;/approved.md<br/>learnings a person approved"]
    end

    resolve["autodev resolves the project scope"]
    scoped["Scoped, authenticated call<br/>to the one allowed host"]
    context["Guidelines and learnings<br/>handed to the agent for the task"]

    skill --> resolve
    manifest -- "which variable, which secret,<br/>which board, repo, schema" --> resolve
    env -- "URL" --> resolve
    store -- "token" --> resolve
    resolve --> scoped
    guide --> context
    know -- "only if unchanged<br/>since approval" --> context
    resolve --> context
```

## 4. What happens on one command

Every command, from every skill, goes through the same checks in the same order.

```mermaid
flowchart TB
    start(["autodev #lt;command#gt; --project id"]) --> scope{"Project matches<br/>the session's project?"}
    scope -- no --> e1["PROJECT_SCOPE_VIOLATION<br/>exit 4"]
    scope -- yes --> manifest{"project.yaml valid and<br/>has what this command needs?"}
    manifest -- no --> e2["CONFIG_INVALID / NOT_CONFIGURED<br/>exit 2"]
    manifest -- yes --> write{"Does it write outside<br/>the workstation?"}
    write -- no --> run["Run it"]
    write -- yes --> policy{"Policy for this action"}
    policy -- prohibited --> e3["POLICY_PROHIBITED<br/>exit 4"]
    policy -- "approval-required,<br/>none granted for this content" --> e4["APPROVAL_REQUIRED<br/>exit 3, returns an approval id"]
    policy -- "allowed, or approval<br/>matches the content hash" --> dry{"--dry-run?"}
    dry -- yes --> preview["Report what would be sent.<br/>Nothing written, approval not spent"]
    dry -- no --> run
    run --> audit["Append to the hash-chained audit log"]
    audit --> out(["One JSON envelope on stdout,<br/>redacted logs on stderr"])
```

Exit codes: `0` success, `1` unexpected, `2` usage or configuration, `3` waiting on a person, `4` refused by policy or a gate, `5` upstream or transient.

## 5. Ticket to pull request

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant AD as auto-developer agent
    participant CLI as autodev CLI
    participant AG as Agility
    participant BB as Bitbucket
    participant RV as code-reviewer agent

    Dev->>AD: Implement story S-01234 from board 501
    AD->>CLI: project resolve, session select
    Note over CLI: The session is bound to one project<br/>and cannot change
    AD->>CLI: agility story S-01234
    CLI->>AG: read story
    AG-->>CLI: title, acceptance criteria, release branch, gaps
    AD->>CLI: project guidelines --task plan
    AD->>Dev: Plan, plus a question for every gap
    Dev-->>AD: Confirms the plan
    AD->>CLI: repo prepare
    CLI->>BB: clone or reuse, verify release branch
    Note over CLI: Creates feature/S-01234-slug.<br/>No release branch on the ticket is a blocker,<br/>not a fallback to main
    AD->>AD: Edit code inside projects/id/repos only
    AD->>CLI: test run
    Note over CLI: Gate "tests" recorded for tree T
    AD->>CLI: review run
    Note over CLI: Gate "automated-review" recorded for tree T
    AD->>RV: Review this change
    RV->>CLI: repo diff, then review record
    Note over CLI: Gate "independent-review" recorded for tree T
    AD->>CLI: repo commit
    Note over CLI: Refused unless all three gates match<br/>the working tree
    AD->>CLI: pr create
    CLI-->>AD: APPROVAL_REQUIRED, approval id
    AD->>Dev: Please review approval apr-...
    Dev->>CLI: approvals review apr-... (own terminal)
    AD->>CLI: pr create --approval apr-...
    CLI->>BB: push branch, open pull request
    CLI-->>AD: Pull request URL
    AD->>Dev: PR link and summary. Never merged.
```

If any step changes the code after a gate was recorded, that gate no longer matches and has to be run again. See the next diagram.

## 6. Gates: why "tests passed" always means this code

```mermaid
flowchart LR
    wt["Working tree"] -- "git write-tree<br/>on a temporary index" --> tid["Tree id T<br/>fingerprint of every file"]
    tid --> g1["tests = pass @ T"]
    tid --> g2["automated-review = pass @ T"]
    tid --> g3["independent-review = pass @ T"]
    g1 --> commit{"repo commit:<br/>working tree is still T?"}
    g2 --> commit
    g3 --> commit
    commit -- "no: something changed" --> rerun["GATE_FAILED<br/>run the gates again"]
    commit -- yes --> c["Commit on the story branch"]
    c --> pr{"pr create:<br/>committed tree is T?"}
    pr -- no --> rerun
    pr -- yes --> policy["createPR policy and approval"]
    policy --> push["Push and open the pull request"]
```

## 7. Approvals

An approval is for exact content. It is decided by a person at a real terminal, outside the Copilot session, and can be used once.

```mermaid
sequenceDiagram
    autonumber
    participant AG as Agent
    participant CLI as autodev CLI
    participant ST as Approval store
    actor P as Person, own terminal

    AG->>CLI: Write action (pr create, agility comment, learn apply ...)
    CLI->>ST: Save request with SHA-256 of the exact payload
    CLI-->>AG: APPROVAL_REQUIRED, approval id (exit 3)
    AG->>P: Shows the summary and the id
    P->>CLI: approvals review apr-...
    Note over CLI,P: Needs an interactive terminal and no session variables.<br/>Shows the full content. The person types a one-time code<br/>that is never stored.
    CLI->>ST: approved or denied, by whom, when
    AG->>CLI: Same action with --approval apr-...
    CLI->>ST: Hash what is about to be sent, compare, consume
    alt Same content, approved, not expired, not used before
        CLI-->>AG: Done
    else Content changed
        CLI-->>AG: APPROVAL_MISMATCH
    else Denied
        CLI-->>AG: APPROVAL_DENIED
    else Expired or already used
        CLI-->>AG: APPROVAL_REQUIRED (a new request is needed)
    end
```

## 8. Authentication

```mermaid
flowchart TB
    need(["A command needs a service"]) --> url{"Base URL variable<br/>named in project.yaml is set?"}
    url -- no --> cfg["NOT_CONFIGURED<br/>names the variable to set"]
    url -- yes --> envtok{"Token in the environment<br/>variable of that name?"}
    envtok -- yes --> tok["Token mode<br/>HTTPS to that one host only"]
    envtok -- no --> cred{"Token in Credential Manager<br/>entry autodev/NAME?"}
    cred -- yes --> tok
    cred -- no --> svc{"Service is Agility and<br/>browserFallback is not false?"}
    svc -- no --> req["AUTH_REQUIRED<br/>names the secret to store"]
    svc -- yes --> signed{"Project's Edge profile<br/>already signed in?"}
    signed -- yes --> browser["Browser mode<br/>requests made from inside the signed-in Edge"]
    signed -- "no, interactive" --> login["Opens Edge. The person completes<br/>SSO and MFA themselves"]
    login --> browser
    signed -- "no, scheduled task" --> req2["AUTH_REQUIRED, exit 3<br/>run auth login once"]
```

Never done on any path: typing a password, exporting cookies, automating MFA, ignoring a certificate error, following a redirect to a host that was not approved. DB2 authenticates natively through its stored connection string; `git` uses your own git credential setup.

## 9. One monitoring pass

The scheduled task runs this, bounded and restartable. It can be killed at any arrow and run again.

```mermaid
flowchart TB
    start(["Task Scheduler: autodev monitor run --project id"]) --> lock{"Lock free?"}
    lock -- "no, another pass is alive" --> skip["already-running"]
    lock -- "yes, or the holder is dead" --> backoff{"In backoff after<br/>a failed pass?"}
    backoff -- yes --> wait["backing-off"]
    backoff -- no --> pending["Finish pending work:<br/>create approved tickets, resolve interrupted writes,<br/>queue handoffs, re-check unmapped incidents"]
    pending --> window["Read the next window after the checkpoint<br/>Splunk errors, Dynatrace problems and metrics<br/>scoped to the project's indexes and entities, capped"]
    window --> norm["Normalise into the common incident model"]
    norm --> corr["Correlate: by trace id, else by service and time"]
    corr --> dedupe{"Same project, environment, service<br/>and fingerprint within the window?"}
    dedupe -- yes --> occ["Add an occurrence to the open incident"]
    dedupe -- no --> map{"Service mapped to<br/>a repository?"}
    map -- no --> onboard["needs-onboarding<br/>nothing further"]
    map -- yes --> exists{"Defect with this incident's<br/>marker already in Agility?"}
    exists -- yes --> link["Link it, no new ticket"]
    exists -- no --> propose["Build a sanitized defect draft<br/>and request approval. No ticket yet"]
    occ --> ckpt["Save checkpoint"]
    onboard --> ckpt
    link --> ckpt
    propose --> ckpt
    ckpt --> more{"More windows to catch up,<br/>within this pass's limit?"}
    more -- yes --> window
    more -- no --> done(["Release lock, exit 0<br/>a failed pass exits 5 and sets backoff"])
```

## 10. Incident lifecycle

```mermaid
stateDiagram-v2
    [*] --> detected
    detected --> needs_onboarding: service has no repository mapping
    needs_onboarding --> detected: mapping added
    detected --> defect_proposed: draft and approval request
    detected --> defect_created: matching defect already exists, linked
    defect_proposed --> defect_denied: person denies
    defect_proposed --> detected: approval lapsed
    defect_proposed --> defect_created: person approves, next pass creates it once
    defect_denied --> detected: reopened
    defect_created --> handoff_queued
    handoff_queued --> development_started: start authorized, auto-developer claims it
    development_started --> pr_created: gated workflow opens a PR
    pr_created --> validation_pending: deployment recorded by verify-resolution
    validation_pending --> resolved_verified: no recurrence for a full window after deployment
    validation_pending --> validation_pending: still occurring
    resolved_verified --> [*]
```

Any state can also move to `closed` with a reason (`autodev incident close`). State names use hyphens in the CLI (`defect-proposed`); underscores here are a Mermaid limitation. The transition table is a pure function in `src/monitoring/incident-model.js`; an invalid move is an error, not a silent no-op.

## 11. Defect to development handoff

```mermaid
sequenceDiagram
    autonumber
    participant W as Monitoring worker
    actor P as Person, own terminal
    participant CLI as autodev CLI
    participant AG as Agility
    participant Q as Handoff queue
    participant AD as auto-developer agent

    W->>CLI: Propose defect for incident INC-...
    CLI-->>P: Approval request (incident list / show)
    P->>CLI: approvals review apr-...
    W->>CLI: Next pass
    Note over CLI: Records the intent first, then writes
    CLI->>AG: Create defect, with idempotency marker
    CLI->>Q: Queue task (id derived from project and defect)
    P->>CLI: handoff authorize --task-id task-...
    Note over CLI,P: With autoStartDevelopment false (the default)<br/>each task needs its own approval to start
    AD->>CLI: handoff next
    CLI-->>AD: Task: defect id and incident summary
    AD->>CLI: agility story (re-reads the defect from Agility)
    Note over AD: Runs the normal ticket-to-PR flow (diagram 5)
    AD->>CLI: handoff complete --task-id ... --outcome done --pr ...
    Note over CLI: The incident moves to pr-created
    P->>CLI: monitor verify-resolution --deployed-at ...
    Note over CLI: resolved-verified only on evidence
```

## 12. Learning

Nothing is remembered because an agent decided it should be.

```mermaid
flowchart LR
    notice["Agent notices something<br/>worth remembering"] --> propose["autodev learn propose<br/>stages the exact text"]
    propose --> req["Approval request<br/>bound to the text's hash"]
    req --> person{"Person reviews<br/>in their own terminal"}
    person -- deny --> drop["Nothing is written"]
    person -- approve --> apply["autodev learn apply<br/>writes exactly the approved text"]
    apply --> file["knowledge/#lt;skill#gt;/approved.md"]
    apply --> integ["Integrity record: SHA-256 of the file"]
    file --> load{"On load: file matches<br/>the integrity record?"}
    integ --> load
    load -- yes --> use["Given to the agent with the guidelines"]
    load -- "no: edited by hand<br/>or by the agent" --> reject["Ignored and reported as rejected"]
```
