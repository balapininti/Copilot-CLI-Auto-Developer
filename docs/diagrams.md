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
13. [End-to-end scenarios from a HAR](#13-end-to-end-scenarios-from-a-har)
14. [Onboarding from what already exists](#14-onboarding-from-what-already-exists)
15. [The next-step loop](#15-the-next-step-loop)
16. [Plan evaluation](#16-plan-evaluation)

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
        projects[("projects/#lt;id#gt;<br/>project.yaml, guidelines,<br/>knowledge, scenarios, repos")]
        state[("state<br/>approvals, audit, runs and plans,<br/>incidents, handoff queue")]
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
        agents["Agents<br/>auto-developer, incident-investigator,<br/>project-onboarder, plan-reviewer,<br/>code-reviewer, test-validator"]
        skills["18 skills<br/>one capability each, generic"]
        hook["preToolUse hook<br/>denies tool calls that go around the gates"]
    end

    subgraph code["Code: what enforces the rules (src)"]
        clilayer["cli<br/>argument parsing, JSON envelope, exit codes"]
        workflow["workflow<br/>next step, context bundle, plans and plan facts,<br/>run state and gates, review checklists, pull requests,<br/>learning and learning signals, scenarios, onboarding"]
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
| Agents | `.github/agents` | Who coordinates. Six files, no capability logic. |
| Skills | `.github/skills` | How to use one capability. Generic: no URL, project name or team rule appears in a skill. |
| Hook | `.github/hooks`, `scripts/hooks` | A net under the agents: blocks direct `git push`, direct writes to `state\` and `knowledge\`, and similar. |
| CLI | `src/cli` | One command in, one JSON envelope out. |
| Workflow, monitoring | `src/workflow`, `src/monitoring` | The two business flows. The order of the development workflow is computed here (`next.js`), not held in an agent's instructions. |
| Adapters | `src/adapters` | One per external system; each returns the same shapes whatever the transport. |
| Core | `src/core` | Everything every command depends on. Scope, approvals and audit live here, so no adapter can skip them. |

## 3. Where a skill gets its URLs, tokens and process

Skills never contain company facts. When a skill runs a command, `autodev` puts the facts together from six places. Setting these up is what [setup.md](setup.md) walks through.

```mermaid
flowchart LR
    skill["Skill runs, for example<br/>autodev agility story S-01234"]

    subgraph facts["What you set up, once per project"]
        direction TB
        manifest["projects/#lt;id#gt;/project.yaml<br/>mappings, policies and the NAMES<br/>of variables and secrets"]
        env["Environment variables<br/>the URLs: AGILITY_BASE_URL,<br/>BITBUCKET_BASE_URL, repo URLs ..."]
        store["Credential Manager<br/>the tokens: autodev/AGILITY_TOKEN ..."]
        guide["projects/#lt;id#gt;/guidelines/*.md<br/>your team's process and standards"]
        know["projects/#lt;id#gt;/knowledge/#lt;area#gt;/approved.md<br/>learnings a person approved<br/>(or saved unreviewed, if the project opted in)"]
        scen["projects/#lt;id#gt;/scenarios/#lt;name#gt;.json<br/>baseline end-to-end journeys<br/>a person approved"]
    end

    resolve["autodev resolves the project scope"]
    scoped["Scoped, authenticated call<br/>to the one allowed host"]
    context["autodev context: one trimmed bundle<br/>guidelines and learnings for the task,<br/>ticket, plan, next step"]
    e2e["autodev scenario run<br/>replayed in Edge"]

    skill --> resolve
    manifest -- "which variable, which secret,<br/>which board, repo, schema" --> resolve
    env -- "URL" --> resolve
    store -- "token" --> resolve
    resolve --> scoped
    guide --> context
    know -- "only if unchanged<br/>since approval" --> context
    resolve --> context
    scen -- "only if unchanged<br/>since approval" --> e2e
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

The agent does not hold this order in its instructions. Between steps it runs `autodev next`, which works out the one next step from what is recorded (diagram 15).

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant AD as auto-developer agent
    participant CLI as autodev CLI
    participant AG as Agility
    participant BB as Bitbucket
    participant PR as plan-reviewer agent
    participant RV as code-reviewer agent

    Dev->>AD: Implement story S-01234 from board 501
    AD->>CLI: project resolve, session select
    Note over CLI: The session is bound to one project<br/>and cannot change
    loop Before every step
        AD->>CLI: next --story S-01234
        CLI-->>AD: The one next step, who acts, the command, why
    end
    AD->>CLI: agility story S-01234
    CLI->>AG: read story
    AG-->>CLI: title, acceptance criteria, release branch, gaps
    Note over CLI: Criteria are kept with the story,<br/>so later steps do not read the ticket again
    AD->>CLI: repo prepare
    CLI->>BB: clone or reuse, verify release branch
    Note over CLI: Creates feature/S-01234-slug.<br/>No release branch on the ticket is a blocker,<br/>not a fallback to main
    AD->>CLI: context --task plan, code refs --symbol ...
    AD->>CLI: plan submit (criteria, changes, edge cases, tests, risks)
    AD->>PR: Evaluate this plan
    PR->>CLI: context --task plan-review
    CLI-->>PR: Plan, criteria, project rules and learnings,<br/>looked-up plan facts, nine checklist areas
    PR->>CLI: plan review: verdict, nine-area checklist, findings P0 to P4
    Note over CLI: Bound to the hash of the plan text.<br/>Ready is refused while a P0 or P1 stands<br/>or an area is unchecked
    PR-->>AD: Not ready: revise and resubmit. Ready: continue
    AD->>Dev: Plan, P2 findings, what could not be verified
    Dev-->>AD: Confirms the plan
    AD->>CLI: context --task implement
    AD->>AD: Edit code inside projects/id/repos only
    AD->>CLI: test run, scenario affected, scenario run
    Note over CLI: Gate "tests" recorded for tree T.<br/>Scenario results are evidence, not a gate
    AD->>CLI: review run
    Note over CLI: Gate "automated-review" recorded for tree T
    AD->>RV: Review this change
    RV->>CLI: context --task review, repo diff, code refs
    RV->>CLI: review record with a nine-area checklist
    Note over CLI: Gate "independent-review" recorded for tree T
    AD->>CLI: repo commit
    Note over CLI: Refused unless the plan is ready and<br/>all three gates match the working tree
    AD->>CLI: pr create
    CLI-->>AD: APPROVAL_REQUIRED, approval id
    AD->>Dev: Please review approval apr-...
    Dev->>CLI: approvals review apr-... (own terminal)
    AD->>CLI: pr create --approval apr-...
    CLI->>BB: push branch, open pull request
    CLI-->>AD: Pull request URL
    AD->>CLI: learn suggest --story S-01234
    CLI-->>AD: What went wrong on this story, what keeps recurring
    AD->>CLI: learn propose, or dismiss each signal
    AD->>Dev: PR link, summary, rules waiting for approval. Never merged.
```

If any step changes the code after a gate was recorded, that gate no longer matches and has to be run again. If the plan changes, its evaluation no longer matches either. See the next diagram.

## 6. Gates: why "tests passed" always means this code

Four things must hold before a commit: one about the plan, three about the code. Each is bound to a fingerprint, so none can refer to an earlier version.

```mermaid
flowchart LR
    plan["Plan text"] -- "SHA-256" --> ph["Plan hash H"]
    ph --> g0["plan-review = ready @ H<br/>no P0 or P1, nine areas covered"]
    wt["Working tree"] -- "git write-tree<br/>on a temporary index" --> tid["Tree id T<br/>fingerprint of every file"]
    tid --> g1["tests = pass @ T"]
    tid --> g2["automated-review = pass @ T"]
    tid --> g3["independent-review = pass @ T<br/>nine areas covered"]
    g0 --> commit{"repo commit:<br/>plan is still H and<br/>working tree is still T?"}
    g1 --> commit
    g2 --> commit
    g3 --> commit
    commit -- "no: something changed" --> rerun["GATE_FAILED<br/>autodev next names the gate to redo"]
    commit -- yes --> c["Commit on the story branch"]
    c --> pr{"pr create:<br/>plan is still H and<br/>committed tree is T?"}
    pr -- no --> rerun
    pr -- yes --> policy["createPR policy and approval"]
    policy --> push["Push and open the pull request"]
```

The plan gate can be made advisory per project (`policies.planReview: advisory`); the three code gates cannot.

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

Every story ends with a learning check. By default nothing is saved without a person's approval; a project can opt in to saving without review.

```mermaid
flowchart TB
    done(["Every prepared repository has a pull request"]) --> suggest["autodev learn suggest --story S<br/>searches the recorded history"]
    suggest --> signals["Signals, each with its evidence:<br/>a finding that sent this plan back,<br/>a gate that failed repeatedly,<br/>the same finding on several stories,<br/>an area where plans keep failing"]
    signals --> decide{"Would a general rule<br/>have prevented it?"}
    decide -- "no, or not sure" --> dismiss["learn suggest --dismiss<br/>with a reason. Not raised again"]
    decide -- yes --> propose["autodev learn propose<br/>one rule, its evidence and source"]
    propose --> checks{"No secret or personal data,<br/>a known area, file untampered?"}
    checks -- no --> refused["Refused"]
    checks -- yes --> mode{"learning.persistence<br/>in project.yaml"}
    mode -- "explicit-approval-only<br/>(default)" --> req["Approval request<br/>bound to the text's hash"]
    req --> person{"Person reviews<br/>in their own terminal"}
    person -- deny --> drop["Nothing is written"]
    person -- approve --> apply["autodev learn apply<br/>writes exactly the approved text"]
    mode -- "auto-save<br/>(set only by a person)" --> cap{"Fewer than 5<br/>saved today?"}
    cap -- no --> limit["POLICY_PROHIBITED<br/>reported to the user instead"]
    cap -- yes --> auto["Written at once, marked<br/>not reviewed by a person"]
    apply --> file["knowledge/#lt;area#gt;/approved.md<br/>plus an integrity record"]
    auto --> file
    file --> load{"On load: file matches<br/>the integrity record?"}
    load -- yes --> use["Given to the agent doing the matching task<br/>on every later story (autodev context)"]
    load -- "no: edited by hand<br/>or by the agent" --> reject["Ignored and reported as rejected"]
    file -. "a wrong rule" .-> remove["autodev learn remove<br/>a person only, outside a session"]
```

## 13. End-to-end scenarios from a HAR

A person records one journey in their browser. The framework keeps a sanitized outline, the agent uses the code base to work out the rest, and a person approves the result. Details are in [e2e-scenarios.md](e2e-scenarios.md).

```mermaid
flowchart TB
    rec(["Person runs one journey in the browser<br/>and exports a HAR"]) --> imp["autodev scenario import<br/>keeps pages, API calls and body shapes.<br/>Drops headers, cookies, tokens and all values"]
    imp --> outline["Outline: WHAT the journey did"]
    outline --> agent["Agent reads the code base:<br/>which screen makes each call,<br/>which control triggers it, stable selectors"]
    agent --> trial["autodev scenario run --file<br/>trial in Edge until it passes"]
    trial -- fails --> agent
    trial -- passes --> propose["autodev scenario propose<br/>approval bound to the exact document"]
    propose --> person{"Person reviews<br/>in their own terminal"}
    person -- deny --> nothing["Nothing is written"]
    person -- approve --> apply["autodev scenario apply"]
    apply --> base[("projects/#lt;id#gt;/scenarios/#lt;name#gt;.json<br/>plus an integrity record")]

    story(["Later: a story changes the code"]) --> affected["autodev scenario affected<br/>scenarios whose code references changed"]
    base --> affected
    affected --> run["autodev scenario run<br/>steps, expected API calls, no server errors"]
    run -- passes --> evidence["Evidence for the reviewer"]
    run -- fails --> why{"Why?"}
    why -- "the change broke the journey" --> fix["Fix the code"]
    why -- "the story changed the journey on purpose" --> propose
```

## 14. Onboarding from what already exists

The `project-onboarder` agent reads material you point it at and proposes a project. It cannot create one itself. See [onboarding.md](onboarding.md#let-copilot-build-it-from-what-you-already-have).

```mermaid
sequenceDiagram
    autonumber
    actor P as Person
    participant AG as project-onboarder agent
    participant CLI as autodev CLI
    participant FS as Files the person named

    P->>AG: Onboard my project. Read these folders and this old skill
    AG->>CLI: onboard scan --path ...
    CLI->>FS: Read-only: git remotes, build files, URLs in documents
    CLI-->>AG: Repositories, build and test commands, hosts. No credentials
    AG->>FS: Reads the relevant documents
    AG->>P: Facts with their sources, and what could not be found
    P-->>AG: Corrections and answers
    AG->>CLI: onboard propose --answers ... --guidelines ...
    Note over CLI: Builds project.yaml with restrictive policies.<br/>Stages every file. Creates nothing
    CLI-->>AG: Approval id, what is missing, URLs to set
    P->>CLI: approvals review apr-... (own terminal, sees every file)
    AG->>CLI: onboard apply --approval apr-...
    CLI->>CLI: Writes exactly the approved files to projects/id
    AG->>P: Commands to set the URLs, names of secrets to store, what is still missing
    P->>P: Sets variables, stores tokens, starts a session for the project
```

## 15. The next-step loop

`autodev next --story S` reads what is recorded for the story and returns one step: who acts, the command, and why. The agent does that step and asks again. This is what keeps a smaller model from skipping or reordering steps; details are in [smaller-models.md](smaller-models.md).

```mermaid
flowchart TB
    start(["autodev next --story S"]) --> q1{"Story read?"}
    q1 -- no --> s1["read-story"]
    q1 -- yes --> q2{"A repository prepared?"}
    q2 -- no --> s2["prepare-repositories"]
    q2 -- yes --> q3{"Plan submitted?"}
    q3 -- no --> s3["write-plan"]
    q3 -- yes --> q4{"Evaluated, and unchanged since?"}
    q4 -- no --> s4["evaluate-plan<br/>actor: plan-reviewer"]
    q4 -- yes --> q5{"Verdict ready?"}
    q5 -- "no, fewer than 3 rounds" --> s5["revise-plan"]
    q5 -- "no, 3 rounds" --> s5u["plan-disagreement<br/>actor: user"]
    q5 -- yes --> q6{"For the first repository<br/>without a pull request:<br/>on the story branch?"}
    q6 -- no --> s6u["wrong-branch<br/>actor: user"]
    q6 -- yes --> q7{"Any change yet?"}
    q7 -- no --> s7["implement<br/>after the user confirms the plan"]
    q7 -- yes --> q8{"tests valid for this code?"}
    q8 -- no --> s8["test"]
    q8 -- yes --> q9{"automated review valid?"}
    q9 -- no --> s9["automated-review"]
    q9 -- yes --> q10{"independent review valid?"}
    q10 -- no --> s10["independent-review<br/>actor: code-reviewer"]
    q10 -- yes --> q11{"Committed?"}
    q11 -- no --> s11["commit"]
    q11 -- yes --> s12["open-pull-request"]
    s12 --> q12{"Every prepared repository<br/>has a pull request?"}
    q12 -- no --> q6
    q12 -- yes --> q13{"Learning check run?"}
    q13 -- no --> s13["capture-learnings"]
    q13 -- yes --> s14["report<br/>with the approvals waiting for the user"]
```

"Valid for this code" means the gate passed for the current tree id (diagram 6). After an edit the answer becomes no again, so the next step is that gate.

## 16. Plan evaluation

The plan is evaluated before any code is written, by an agent that did not write it and cannot edit. Details and the evaluation prompt are in [plan-review.md](plan-review.md).

```mermaid
flowchart TB
    write["auto-developer writes the plan<br/>seven required sections"] --> submit["autodev plan submit<br/>hash H recorded"]
    submit --> facts["autodev plan check (looked up, not judged):<br/>do the named files and identifiers exist,<br/>who uses them that the plan does not mention,<br/>which acceptance criteria may be skipped"]
    facts --> bundle["autodev context --task plan-review<br/>plan, criteria, project rules, approved learnings,<br/>plan facts, nine checklist areas"]
    bundle --> review["plan-reviewer evaluates nine areas:<br/>requirements, feasibility, edge cases, blast radius,<br/>data, security, tests, operations, assumptions"]
    review --> findings["Findings, each with a priority,<br/>the failing situation, evidence and a fix"]
    findings --> block{"Any P0 or P1?"}
    block -- yes --> notready["plan review --verdict not-ready"]
    notready --> rounds{"Third round?"}
    rounds -- no --> revise["Author revises the plan<br/>new hash, evaluation is stale"]
    revise --> submit
    rounds -- yes --> user["The user decides"]
    block -- no --> complete{"All nine areas covered,<br/>none unchecked?"}
    complete -- no --> refused["Refused: not a sign-off"]
    complete -- yes --> ready["plan review --verdict ready @ H"]
    ready --> confirm["User sees the plan, P2 findings<br/>and what could not be verified, and confirms"]
    confirm --> implement["Implementation may start.<br/>repo commit and pr create check<br/>that the plan is still H"]
    notready -. "kept for the learning check" .-> history[("Every evaluation is kept<br/>with the story")]
    ready -. "kept" .-> history
```

| Priority | Meaning | Effect |
|---|---|---|
| P0 | Would break production, lose data, open a security hole, or cannot work | Not ready |
| P1 | A criterion is not met, a case that will occur is not handled, or an assumption is false | Not ready |
| P2 | A real weakness with a workable way around it | Ready; the user is told |
| P3 | An improvement, not a defect | Optional |
| P4 | Style and preference | Optional |
