---
name: agility
description: "Reads Digital.ai Agility boards, stories and defects (title, description, acceptance criteria, comments, attachments, dependencies, release branch) and, with approval, adds comments, sets status or creates defects. Use whenever work starts from or reports back to an Agility ticket."
---

# Digital.ai Agility

Commands are written `autodev <command>`. Run them as `node "$env:AUTODEV_HOME\scripts\autodev.mjs" <command>` (from the automation folder: `node scripts/autodev.mjs <command>`). Each prints one JSON envelope: check `ok`, then read `data` or branch on `error.code`. `--dry-run` shows what a command would do without writing anywhere.

Access is token-first. Without a token, and if the project allows it, the same calls go through the user's signed-in Edge profile; the user completes any SSO or MFA prompt themselves. Either way the result has the same shape (`fetchedVia` says which path was used).

## Read (no approval needed)

| Need | Command |
|---|---|
| Prove access works | `autodev agility verify` |
| List team rooms and teams | `autodev agility boards` |
| Read a story or defect | `autodev agility story <S-01234>` |

`agility story` returns: `id`, `title`, `description`, `acceptanceCriteria`, `status`, `priority`, `team`, `sprint`, `owners`, `releaseBranch` (+ `releaseBranchSource`), `dependencies.upstream/downstream`, `comments[]`, `attachments[]`, `url`, and `gaps[]`.

Always read `gaps`. It states what the ticket did not provide (typically the release branch or acceptance criteria) and why. Each gap is a question for the user before planning.

## Write (follows the project's approval policy)

| Need | Command |
|---|---|
| Comment on a ticket | `autodev agility comment <S-01234> --text "…" [--approval <id>]` |
| Set status | `autodev agility status <S-01234> --status "<name>" [--approval <id>]` |

Defects are created by the monitoring pipeline after approval (see `workflow-handoff`), not by hand from here.

On `APPROVAL_REQUIRED`: show the user `details.summary` and `details.approvalId`, ask them to run `autodev approvals review <id> --project <project>` in their own terminal, wait, then rerun the same command with `--approval <id>`. The approval covers that exact text; if you change the text, a new approval is needed.

## Errors, and what to tell the user

- `AUTH_REQUIRED`: no token and no usable browser session. Say which secret is missing (`details.secretName`) or that sign-in was not completed.
- `AUTH_FAILED` / `ACCESS_DENIED`: the token is invalid, or the account cannot see that project. Say so plainly.
- `NOT_FOUND`: no such story visible to this account.
- `PROJECT_SCOPE_VIOLATION`: the ticket belongs to a team that is not one of this project's. It is outside this session; do not work on it here.
- `NOT_CONFIGURED`: a manifest field or environment variable is unset; `details.field` names it.
- `UPSTREAM_ERROR` mentioning rest-1.v1: the instance may use a different API version; see `docs/unsupported.md`.

## Rules

- Never describe a story you could not read. Report the limitation.
- Acceptance criteria and the release branch come from fields that differ per Agility instance (`agility.fields.*` in `project.yaml`). If they are not configured, say so; do not guess them from the description.
- Comments you write must not contain secrets, personal data or raw log payloads.
- Never set a final status ("Done", "Accepted") on your own initiative. Status changes are the user's call.
