---
name: workflow-handoff
description: "Passes approved Agility defects from the monitoring pipeline to the auto-developer through a durable queue: list queued defects, request or use authorization to start development, claim the next ready task, and complete it with pull request links or a blocking reason. Use when asking what is queued, or when picking up defect-driven work."
---

# Workflow handoff

Commands are written `autodev <command>`. Run them as `node "$env:AUTODEV_HOME\scripts\autodev.mjs" <command>` (from the automation folder: `node scripts/autodev.mjs <command>`). Each prints one JSON envelope: check `ok`, then read `data` or branch on `error.code`. `--dry-run` shows what a command would do without writing anywhere.

Handoff is not permission to change code. A queued defect becomes workable only when the project's policy says development may start: either `monitoring.incidentPolicy.autoStartDevelopment: true`, or a person approved that specific task.

## Contract

| Need | Command |
|---|---|
| What is queued | `autodev handoff list` |
| Ask for, or use, permission to start | `autodev handoff authorize --task-id <task-…> [--approval <id>]` |
| Claim the next ready task | `autodev handoff next` |
| Finish it | `autodev handoff complete --task-id <task-…> --outcome done --pr <url> [--pr <url>]` |
| Or report it blocked | `autodev handoff complete --task-id <task-…> --outcome blocked --reason "…"` |
| Link PRs to the incident | `autodev incident link-pr --incident <INC-…> --pr <url>` |
| Check the fix after deployment | `autodev monitor verify-resolution --incident <INC-…> --deployed-at <ISO time>` |

## Task states

| State | Meaning |
|---|---|
| `awaiting-start-approval` | Queued; a person must approve the start |
| `ready` | Cleared; can be claimed |
| `claimed` | A session is working on it |
| `done` | Finished, with PR links |
| `blocked` | Cannot proceed; `blockedReason` says why (for example no repository is mapped to the service) |

## For the auto-developer

1. `autodev handoff next`. `task: null` means nothing is ready; the note says whether something is waiting for approval. Do not start anything in that case.
2. With a task: **re-read the defect from Agility** (`autodev agility story <D-…>`) and the project context. The incident summary is a pointer, not the specification, and it may be out of date.
3. Run the normal ticket-to-PR workflow: release branch, feature branch, implementation, tests, review, approved pull requests. Every gate applies exactly as for a story. Nothing is merged or deployed.
4. Complete the task with the PR links, or mark it blocked with the reason.

## For the investigator

- `autodev handoff authorize` on a task that needs approval returns `APPROVAL_REQUIRED` with an approval id. Give it to the user; they decide in their own terminal. Do not rerun in a loop.
- A `blocked` task with a mapping problem is an onboarding action for the project owner.

## After deployment

Resolution is declared only on evidence. `monitor verify-resolution` checks telemetry for the incident's signature after the deployment time, over at least one dedupe window. `verified: false` with a reason means "validation pending"; report it that way. If you have no deployment time, say validation is pending.

## Rules

- Never claim a task you will not work on now; an abandoned claim is released only after a long timeout.
- One task, one defect, one project. The claim is atomic, so two sessions cannot take the same defect.
- Never start development from an incident that has no approved defect, and never treat "queued" as "authorized".
