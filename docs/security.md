# Security model

This document says what the framework enforces, how, and where the limits are.

## What is enforced in code

| Rule | Where it is enforced |
|---|---|
| One project per session; no cross-project access | `core/project-context.js` (`resolveProjectScope`), per-project state folders |
| Repositories cloned only from approved hosts; an existing clone must fetch from **and push to** the approved URL | `adapters/bitbucket/git.js` (`validateRepoUrl`, `ensureClone`, `pushUrlMatches`) |
| Dirty working trees are never overwritten | `git.js`: no reset, clean, forced checkout or force push exists in the code |
| The story's release branch controls the base; missing branch is a blocker | `git.js` (`resolveBaseBranch`, `verifyReleaseBranch`) |
| PR only after tests and two reviews pass for the exact code | `workflow/run-store.js` (`checkGates`), `workflow/pull-request.js` |
| External writes follow the configured approval policy | `core/approvals.js` (`enforcePolicy`), called by every write path |
| Production changes cannot be enabled | `schemas/project.schema.json` (`productionChanges` and `productionRemediation` accept only `prohibited`) |
| DB2 is read-only, scoped, limited and redacted | `adapters/db2/guard.js`, `adapters/db2/client.js` |
| Splunk and Dynatrace queries are scoped and bounded | `adapters/splunk/client.js`, `adapters/dynatrace/client.js` |
| HTTPS only, host allowlist, no disabled certificate validation, no silent redirects | `core/http.js` |
| Edge by default; Chromium only if approved; allowlisted navigation; no password filling | `adapters/browser/playwright.js` |
| The browser may only read Agility, Bitbucket, Splunk and Dynatrace; clicking and typing are limited to the application under test | `cli/commands/integrations.js` (`browser run`) |
| A ticket read or written in a session must belong to one of the project's teams (when `agility.teamNames` is set) | `cli/commands/integrations.js` (`assertStoryInProject`) |
| A change too large to read in full cannot pass the automated review | `adapters/review/checks.js` (`diff-not-fully-reviewed`) |
| Secrets never in manifests, logs, results, tickets or evidence | `core/manifest.js` (refuses), `core/redact.js` (masks), `adapters/review/checks.js` (blocks commits) |
| No learning without approval of the exact text | `workflow/learning.js`, `core/knowledge-integrity.js` |
| No baseline end-to-end scenario added or changed without approval; nothing sensitive kept from a HAR | `workflow/scenarios.js` |
| Tamper-evident audit trail | `core/audit.js` (hash chain; `autodev audit verify`) |

## Approvals

1. A gated command without an approval stages a request and returns `APPROVAL_REQUIRED` with an approval id. The request stores the SHA-256 of the exact payload.
2. A person runs `autodev approvals review <id> --project <project>` **in their own terminal**. The command shows the content and asks them to type a short confirmation code to approve, or `deny`. The code is generated at random for that one review and is never stored, so it cannot be read from the approval record or worked out from the payload.
3. The gated command is rerun with `--approval <id>`. It re-hashes what it is about to send and consumes the approval. A different payload is `APPROVAL_MISMATCH`; a second use, an expired or a denied approval is refused.

`approvals review` refuses to run without an interactive terminal, and refuses to run inside an agent session (where `AUTODEV_SESSION_ID` or `AUTODEV_PROJECT` is set).

Inside a session the workspace is fixed too: a command given a `--workspace` that differs from the session's is refused (`PROJECT_SCOPE_VIOLATION`), because another workspace would bring its own manifests, policies and approval store.

Actions that are gated: creating a pull request (which includes the push), creating a defect, commenting on or changing the status of a ticket, authorizing a schema change, starting development on a queued defect, saving a learning, adding or changing an end-to-end scenario, and creating a project from inside a session. Policies are `approval-required`, `allowed` or `prohibited` per project; saving a learning, writing a scenario and creating a project are always approval-required.

## Learning: enforced at the file boundary

Prompt instructions are not relied on.

- `learn apply` is the only code path that writes `knowledge/<skill>/approved.md`, and it consumes an approval bound to the target path, the file's previous content hash and the added text.
- Each approved file's hash is stored in an integrity record. `loadGuidelines` checks that record before loading any knowledge file. A file created or edited any other way does not match and is **not loaded into any agent's context**; `autodev learn verify` reports it.
- The hook denies direct edits to knowledge files.

So a learning written around the gate, by an agent or by anyone else, is inert.

End-to-end scenarios (`projects/<id>/scenarios/`) follow the same model, for a different reason: a scenario is what a change is judged against, so an agent that could rewrite one could hide a regression it had just caused. `scenario apply` is the only writer, the approval is bound to the exact document and to a summary that names every expectation an update removes, and `scenario run` refuses a file that does not match its integrity record. A HAR handed to `scenario import` is reduced to methods, templated paths, status codes and the field names of bodies; headers, cookies, tokens, query values and response values are never written anywhere, and the HAR is not copied. See [e2e-scenarios.md](e2e-scenarios.md).

## The preToolUse hook

`.github/hooks/autodev.json` runs `scripts/hooks/pre-tool-use.mjs` before each tool call (policy in `src/core/hook-policy.js`). It denies:

- file edits anywhere except `projects/<id>/repos/` (the framework itself, `project.yaml`, guidelines, knowledge, `state/` and any `.git` folder are off limits);
- shell commands (including input sent to a running shell) that decide approvals, change or bypass the session's project and workspace binding, read the credential store, push or rewrite git history, change git remotes or configuration, skip hooks, disable TLS validation, call project systems directly (`curl`, `Invoke-WebRequest`, native `db2`), or deploy and publish.

`autodev discovery install` installs the hook at user level alongside the agents and skills.

The hook policy is unit-tested. **It has not been exercised inside a live, signed-in Copilot CLI session**, so confirm it fires on your installed version: start a session and ask the agent to run `git push`; it should be refused.

## Threat model and honest limits

The agent runs as you, on your machine. Any control that lives on the same machine, under the same account, is a strong guard rail and not a hard boundary.

- An agent that was determined to bypass the approval store could, in principle, write an approval record directly with a shell command the hook does not recognise. The hook, the terminal check and the session check make that hard and visible (the audit log would not contain a matching human decision), not impossible.
- Pattern-based checks (the SQL guard, the review rules, the hook rules, redaction) are conservative filters. They are not parsers and they are not complete.
- **The independent review is recorded by whoever runs `review record`.** The command refuses the name `auto-developer` and refuses a pass while automated blockers remain, but it cannot prove who the reviewer was. An agent could record a review under another name. Treat the recorded review as one input: the person approving the pull request sees the reviewer's name and notes in the PR content they approve, and Bitbucket's own required reviewers remain the real control.

**Therefore the controls that actually bound the damage are outside the framework, and you should set them:**

1. **Least-privilege tokens.** A read-only Agility token cannot create tickets. A Bitbucket token limited to the project's repositories, with branch permissions that forbid pushing to release branches and require reviewers, cannot merge anything. Splunk and Dynatrace tokens limited to the project's indexes and read scopes cannot see other tenants.
2. **A read-only DB2 account** with grants only on the project's schemas. The SQL guard is the second line; the account is the first.
3. **Branch protection and required reviews in Bitbucket.** The framework never merges; make it impossible anyway.
4. **Do not start Copilot CLI with `--allow-all-tools`.** The launcher does not. Keep tool approval on for anything you would not want run unattended.
5. **No production credentials on the workstation.** Monitoring is configured per environment; point it at non-production unless your organization has explicitly approved otherwise.

## Redaction

`core/redact.js` masks, in everything that leaves the process: exact values of secrets the process loaded; bearer tokens, JWTs, authorization headers, key=value secrets, URL credentials, private keys and common vendor token shapes; and values under sensitive key names. In ticket bodies, evidence and browser text it also masks email addresses, phone numbers, US social security numbers and card numbers that pass a Luhn check.

Redaction is pattern-based. It will miss secrets in unusual shapes and personal data it has no pattern for (names, addresses, account identifiers). Treat ticket drafts as needing a human read before approval; the approval step exists for exactly that.

## What is logged

- `state/audit/<project>/audit.jsonl`: every approval request, decision and use; every gate result; branch creation, commits and pull requests; ticket writes; monitoring passes; learnings. Each entry carries the hash of the previous one.
- Payload contents are not written to the audit log, only hashes and identifiers.
- Stderr logs are structured JSON, redacted, and off by default above `info` (`AUTODEV_LOG_LEVEL`).

## Reporting a vulnerability

Open a private security advisory on the GitHub repository rather than a public issue.
