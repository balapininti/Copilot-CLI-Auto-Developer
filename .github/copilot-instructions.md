# Auto Developer framework: ground rules

These apply to every agent and skill in this workspace.

## How to act

All access to project systems goes through the `autodev` command line. Run it as:

```powershell
node "$env:AUTODEV_HOME\scripts\autodev.mjs" <command> [options]
```

(`AUTODEV_HOME` is set by `scripts/Start-AutoDev.ps1`. From the automation folder, `node scripts/autodev.mjs <command>` is the same thing.) Skills write this as `autodev <command>`.

Every command prints one JSON object:

- success: `{ "ok": true, "data": ... }`
- failure: `{ "ok": false, "error": { "code": "...", "message": "...", "retryable": true|false, "details": { ... } } }`

Branch on `error.code`, never on the wording of a message. Add `--dry-run` to any command to see what it would do without writing anywhere.

## Rules that are never broken

1. **One project per session.** Work only on the project this session is bound to. If a command returns `PROJECT_SCOPE_VIOLATION`, stop; do not try another route.
2. **Never fabricate.** If a story, field, branch, table, column, API, trace id or test result is not in a command's output, it does not exist for you. Say what is missing and why.
3. **Approvals belong to a person.** When a command returns `APPROVAL_REQUIRED`, show the user the summary and the approval id, tell them to run `autodev approvals review <id> --project <project>` in their own terminal, and wait. Never run that command yourself and never look for another way to get the same effect.
4. **Never overwrite work.** No `git reset`, `git clean`, forced checkout, force push, or `--no-verify`. A dirty working tree is reported to the user, not cleaned.
5. **No release branch, no work.** The story's release branch decides where a feature branch starts. If it is missing, that is a blocker to report, never a reason to use the default branch.
6. **No secrets, anywhere.** Do not print, log, commit, or paste tokens, passwords, connection strings or personal data. Do not ask the user to paste a secret into the chat.
7. **No TLS shortcuts.** Never disable certificate validation in any tool.
8. **No direct calls.** Do not use `curl`, `Invoke-WebRequest`, a native `db2` client or `git push` to reach project systems. Use the `autodev` commands so scoping, redaction, limits and approvals apply.
9. **Never merge, deploy, or touch production.**
10. **No code before an evaluated plan.** A change starts with a written plan that someone other than its author has evaluated as ready (`plan-review` skill). The author never records that evaluation, and a plan that changes is evaluated again.
11. **No silent learning.** Nothing is saved to a project's knowledge unless the user approves the exact text through `autodev learn propose`.

## When you are unsure what to do

Run `autodev next --story <S-…>`. It gives the one next step, who does it and the command. Use `autodev context --story <S-…> --task <task>` to get what that step needs in one call.

## When something blocks you

Stop and report it with: what you were doing, the command and its `error.code`, what is needed to unblock, and who can provide it. A clear blocker is a good outcome; guessing past one is not.

## Honesty in reports

State what was verified and how. "Tests pass" means you ran them through `autodev test run` and it reported `passed: true` for the current code. A stage reported as `not-configured` did not pass. A hypothesis is labelled as a hypothesis.
