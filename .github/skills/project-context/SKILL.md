---
name: project-context
description: "Resolves which project a board or story belongs to and loads only that project's repositories, DB2 schemas, services, guidelines and approved learnings. Use at the start of any ticket or incident work, and whenever you need to know what a project owns."
---

# Project context

One CLI session works on exactly one project. This skill finds that project and loads its context, and nothing from any other project.

Commands are written `autodev <command>`. Run them as `node "$env:AUTODEV_HOME\scripts\autodev.mjs" <command>` (from the automation folder: `node scripts/autodev.mjs <command>`). Each prints one JSON envelope: check `ok`, then read `data` or branch on `error.code`. `--dry-run` shows what a command would do without writing anywhere.

## Contract

| Need | Command | Notes |
|---|---|---|
| `resolveProject(boardId, storyId)` | `autodev project resolve --board <id> [--story <S-…>] [--team <name>]` | Exactly one match or an error |
| Bind the session | `autodev session select --project <id>` | Once per session; cannot be changed |
| Which project am I on | `autodev session status` | |
| Project summary | `autodev project show` | boards, repositories, schemas, services, policies, `missing` |
| `getRepositories(projectId)` | `autodev project repos` | with local path and the services each one backs |
| `getSchemas(projectId)` | `autodev project schemas` | with the repositories and services using each |
| `loadGuidelines(projectId, taskType)` | `autodev project guidelines --task <type>` | types: `plan`, `implement`, `test`, `review`, `investigate`, `database` |
| What onboarding still owes | `autodev project validate` | lists `missing` fields and what each is needed for |
| Allowed hosts | `autodev service hosts` | |

## How to use it

1. Resolve, then bind. Do both before reading tickets, code or telemetry.
2. Load guidelines for the task you are about to do, not all of them. Each task type returns the relevant guideline files plus approved learnings for the skills that task uses.
3. Read three lists in the guidelines result:
   - `files`: use these as the project's rules.
   - `missing`: a standard the project has not written down. Tell the user; do not fill the gap with general practice presented as project policy.
   - `rejected`: a knowledge file that does not match what was approved. It was not loaded. Tell the user to run `autodev learn verify`.

## Errors

- `PROJECT_AMBIGUOUS`: more than one project maps to the board. Show `details.candidates` and ask the user to pick. Never pick for them.
- `PROJECT_NOT_FOUND`: nothing maps to it. The project needs onboarding (`autodev onboard-project`, run by a person).
- `PROJECT_SCOPE_VIOLATION`: the session is bound to another project. Stop. Work on a different project needs a new session.
- `CONFIG_INVALID`: `project.yaml` is malformed or contains a secret. Report `details.problems`; do not edit the manifest.

## Rules

- Skills are generic; everything project-specific lives under `projects/<id>/`. Never copy one project's mapping, standard or learning into work on another.
- A mapping that is not in `project.yaml` does not exist. Do not infer repository names, schema names or service owners from naming patterns.
