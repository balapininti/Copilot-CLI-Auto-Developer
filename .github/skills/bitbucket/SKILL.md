---
name: bitbucket
description: "Works with the project's Bitbucket repositories: clone or reuse a clone from the approved URL, verify the story's release branch, create the story feature branch, inspect diffs, commit, and open pull requests after the gates pass. Use for any git or pull request step of a story."
---

# Bitbucket and git

Commands are written `autodev <command>`. Run them as `node "$env:AUTODEV_HOME\scripts\autodev.mjs" <command>` (from the automation folder: `node scripts/autodev.mjs <command>`). Each prints one JSON envelope: check `ok`, then read `data` or branch on `error.code`. `--dry-run` shows what a command would do without writing anywhere.

Use these commands for repository operations instead of raw `git` for anything that fetches, switches branch, commits or pushes. Reading with `git status`, `git log`, `git diff` and `git show` is fine.

## Contract

| Step | Command |
|---|---|
| State of a clone | `autodev repo status --repo <name>` |
| Clone/reuse, verify release branch, create feature branch | `autodev repo prepare --story <S-…> --repo <name>` |
| Full diff against the release branch | `autodev repo diff --story <S-…> --repo <name>` |
| Commit on the feature branch | `autodev repo commit --story <S-…> --repo <name> --message "<S-…>: …"` |
| Push and open the pull request | `autodev pr create --story <S-…> --repo <name> [--risks "…"] [--dependencies "…"] [--approval <id>]` |
| What is done and what is still gating | `autodev run show --story <S-…>` |

`repo prepare` needs the story to have been read first (`autodev agility story <S-…>`), because the release branch comes from the story.

## What the commands guarantee

- **Approved source only.** A repository is cloned only from the URL named by its `urlEnv`, and only if the host is in `bitbucket.allowedHosts`. An existing clone whose `origin` differs is refused.
- **Dirty clones are preserved.** Existing uncommitted changes are reported and left alone. No reset, no clean, no checkout over them.
- **The release branch rules.** The feature branch starts from the story's release branch, which must exist on the remote. If it does not, the result is `BRANCH_MISSING` and nothing falls back to `main`.
- **Unique feature branches.** Named from the project pattern (default `feature/{storyId}-{slug}`), with a numeric suffix if the name is taken.
- **Commits are gated.** `repo commit` is refused until tests, the automated review and the independent review have all passed for the current code.
- **Pull requests are gated twice.** First by those same checks against the committed code, then by the `createPR` policy (normally a person's approval of the exact title, description and branch). Only then is the branch pushed and the PR opened. Nothing is ever merged.

## Errors

| Code | Meaning | What to do |
|---|---|---|
| `DIRTY_WORKTREE` | Uncommitted changes in the clone | Show `details.changes` to the user; they decide |
| `BRANCH_MISSING` | Story names no release branch, or it is not on the remote | Blocker. Ask the user which release branch; rerun with `--release-branch <name>` only if they name one |
| `REPO_URL_NOT_APPROVED` | URL host not allow-listed, or the clone points elsewhere | Stop and report |
| `GATE_FAILED` | A check is missing, failed, or stale | `details.blockers` says which; rerun that check |
| `APPROVAL_REQUIRED` | The PR needs a person's approval | Give the user `details.approvalId`; rerun with `--approval <id>` after they approve |
| `APPROVAL_MISMATCH` | The PR content changed after approval | Request approval again |
| `POLICY_PROHIBITED` | Protected branch, or policy forbids it | Stop |

If no Bitbucket API token is available, `pr create` still pushes the approved branch and returns `manualUrl` plus the prepared title and description for the user to open the PR themselves.

## Rules

- One commit message format: start with the story number.
- Never `git push`, `git reset --hard`, `git clean`, `--force` or `--no-verify`. The hook refuses them and so should you.
- Multiple repositories for one story: prepare, test, review and open a PR for each, and name the dependency order in `--dependencies`.
