---
name: learning-management
description: "Saves a reusable project learning only after a person approves the exact text: stage the proposed rule with its evidence and target file, request approval, then write precisely what was approved and keep an audit trail. Use when a correction, pitfall or project convention is worth remembering for next time."
---

# Learning management

Nothing is remembered automatically. A learning becomes part of a project's knowledge only when a person has approved the exact words.

Run `autodev <command>` as `node "$env:AUTODEV_HOME\scripts\autodev.mjs" <command>`; each prints one JSON envelope (`ok`, then `data` or `error.code`).

## Contract

| Step | Command |
|---|---|
| Propose | `autodev learn propose --skill <area> --rule "…" --evidence "…" --source "<S-… or INC-…>"` |
| See staged proposals | `autodev learn list` |
| Write an approved one | `autodev learn apply --approval <id>` |
| Check knowledge is untampered | `autodev learn verify` |

`--skill` is the knowledge area: `project-context`, `agility`, `bitbucket`, `db2`, `java-spring`, `browser-playwright`, `testing`, `code-review`, `splunk`, `dynatrace`, `authentication`, `incident-correlation`, `root-cause-analysis`, `workflow-handoff`. The target file is `projects/<id>/knowledge/<area>/approved.md`.

## Procedure

1. **Decide whether it is worth saving.** Good: a project convention that is not written down, a pitfall that cost time, a correction the user gave you that will apply again. Not worth saving: anything already in the guidelines or the code, one-off facts about a single story, anything you are not sure is true.
2. **Write one rule.** One sentence, specific and testable: "When <situation>, always/never <action>." Not a story, not a list.
3. **Propose** with the evidence (what showed this to be true) and the source (the story, incident or review it came from). The command returns the exact text, shown as a diff, the target path and an approval id. No knowledge file is touched.
4. **Show the user** the diff, the evidence, the target path, and ask for an explicit yes or no. They decide by running `autodev approvals review <id> --project <project>` in their own terminal.
5. **Apply** only after approval: `autodev learn apply --approval <id>`. It writes exactly the approved text and records it in the audit log. If they said no, leave it; do not rephrase and re-propose unless they ask.

## What is enforced, so you do not have to remember it

- The approval is bound to the hash of the target path, the file's prior content and the added text. Different text needs a new approval (`APPROVAL_MISMATCH`).
- If the knowledge file changed after the proposal, apply is refused (`CONFLICT`); propose again.
- Every approved file's hash is recorded. A knowledge file edited any other way no longer matches, is reported by `learn verify`, and is not loaded into any agent's context.
- Rules containing secrets or personal data are refused.

## Rules

- Never edit a file under `knowledge/` directly, and never write a learning into guidelines, code comments or instructions as a way around approval.
- A learning belongs to one project and one area. Do not carry it to another project.
- Propose at the end of the work, not in the middle, and at most a few. Quality over quantity.
- Offer; do not insist. If the user is not interested, drop it.
