# Undo and rollback guidance

The framework writes in few places, and each can be undone. Start with the audit log to see exactly what was done:

```powershell
node scripts\autodev.mjs audit show --project <id> --limit 100
node scripts\autodev.mjs audit verify --project <id>
```

## Things the framework did locally

| What | How to undo |
|---|---|
| Created a feature branch | `git switch <other-branch>` then `git branch -d <feature-branch>` in the clone. Nothing on the remote changed. |
| Committed on the feature branch | `git revert <sha>`, or delete the unpushed branch. The framework never rewrites history; that choice is yours. |
| Cloned a repository | Delete `projects\<id>\repos\<name>`. It is cloned again on next use. |
| Recorded gate results or run state | Delete `state\runs\<id>\<story>.json`. The story starts from "nothing checked". |
| Staged an approval request | Leave it to expire, or deny it with `approvals review`. Pending requests do nothing. |
| Recorded an incident | `autodev incident close --incident INC-… --reason "…"`. To discard all monitoring state for a project, stop the scheduled task and delete `state\incidents\<id>` and `state\monitor\<id>`. |
| Queued a handoff task | A task waiting for approval does nothing. To remove it, edit it out of `state\handoff\<id>\queue.json` while no session or worker is running. |
| Installed agents and skills at user level | `autodev discovery uninstall` removes exactly the files it copied. |
| Registered the monitoring task | `.\scripts\Register-MonitoringTask.ps1 -Project <id> -Unregister` |
| Stored a secret | `.\scripts\Set-AutoDevCredential.ps1 -Name <NAME> -Remove`, and revoke the token at its source. |
| Created a browser profile | Delete `%LOCALAPPDATA%\AutoDev\browser-profiles\<project>-msedge`. You sign in again next time. |

## Things the framework did remotely (always after approval)

| What | How to undo |
|---|---|
| Pushed a feature branch | Delete the branch in Bitbucket, or `git push origin --delete <branch>` yourself. |
| Opened a pull request | Decline it in Bitbucket. Nothing was merged. |
| Created an Agility defect | Close or delete it in Agility. Then close the incident, otherwise the worker treats the defect as still open and attaches recurrences to it. |
| Commented on or changed the status of a ticket | Edit or revert it in Agility. |

The audit entries `bitbucket.pr.created`, `agility.defect.created`, `agility.comment.added` and `agility.status.set` give the identifiers and the approval each one used.

## Learnings

A learning is plain text appended to `projects\<id>\knowledge\<skill>\approved.md`.

To remove one: delete the entry from the file. The file then no longer matches its integrity record, so the agents stop loading it. To restore an approved state, either propose a new learning for that file (which re-records the hash on apply) or, if you removed everything, delete the file and its line in `state\learning\<id>\integrity.json`.

`autodev learn verify --project <id>` shows the state of every knowledge file.

## A pass or session went wrong midway

- **Monitoring pass crashed:** run it again. Windows merge idempotently, an interrupted ticket write is looked up by its idempotency marker before anything is retried, and the handoff queue is keyed by defect.
- **Stale lock:** locks older than their timeout are taken over automatically (10 minutes for stores, 30 for the worker). To clear one by hand, delete the `.lock` file while nothing is running.
- **Session left a task claimed:** an abandoned claim is released after eight hours, or mark it with `autodev handoff complete --task-id … --outcome blocked --reason "…"`.
- **An approval was granted by mistake and not yet used:** there is no "unapprove". Change nothing and let it expire (24 hours; 7 days for monitoring tickets), or make the approved content impossible to send, for example by deleting the feature branch. If it was already used, undo the remote effect as above.

## Removing the framework

1. Unregister scheduled tasks.
2. `autodev discovery uninstall`.
3. Remove stored secrets and revoke the tokens.
4. Delete the workspace `state` folder, the browser profiles, and then the `automation` folder.

Project folders (`projects\<id>`) hold your manifests, guidelines and clones; keep or remove them as you see fit.

## Upgrading

The framework is a git repository: `git pull`, `npm ci`, `npm run check`, then `autodev discovery verify` (and `discovery install` again if you use user-level installation). State files are plain JSON and are read with defaults for missing fields. Before an upgrade that changes state shape, the release notes will say so; a copy of the `state` folder is a complete backup.
