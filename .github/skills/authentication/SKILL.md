---
name: authentication
description: "Explains and checks how each service is authenticated: API token first, then the user's signed-in Edge session where supported, with secrets held only in the OS credential store or injected environment. Use when a command reports AUTH_REQUIRED, AUTH_FAILED or ACCESS_DENIED, or before starting work to confirm access."
---

# Authentication

Run `autodev <command>` as `node "$env:AUTODEV_HOME\scripts\autodev.mjs" <command>`; each prints one JSON envelope (`ok`, then `data` or `error.code`).

## Contract

| Need | Command |
|---|---|
| What is available per service | `autodev auth status` |
| Interactive sign-in in the project's browser profile | `autodev auth login --service agility` |
| Prove Agility access | `autodev agility verify` |

`auth status` shows, per service: whether its base URL is configured, the name of the secret it looks for, whether that secret is available (never its value), and what happens without it.

## Order of preference, per service

1. **API token**, read from the environment variable or the OS credential store entry `autodev/<NAME>` (Windows Credential Manager).
2. **Signed-in browser session**, where the service supports it and the project allows it: requests are made through the project's Edge profile. If the profile is not signed in, a headed Edge window opens and the **user** completes SSO and MFA.
3. **Otherwise** the command fails with `AUTH_REQUIRED` and says exactly what is missing.

| Service | Token | Browser session |
|---|---|---|
| Agility | yes | yes (default on; `agility.browserFallback`) |
| Bitbucket (PR API) | yes | no; without a token the branch is pushed and a pre-filled PR link is returned |
| Splunk | yes | no |
| Dynatrace | yes | no |
| DB2 | native authentication via a stored connection profile | never |

Git itself authenticates through the user's own git setup (Git Credential Manager or SSH).

## Rules

- **Never handle a secret.** Do not ask the user to paste a token, password or connection string into the chat, do not read one from a file, and do not print one. To store a secret the user runs `scripts\Set-AutoDevCredential.ps1 -Name <NAME>` themselves and types it at the hidden prompt.
- **Never bypass.** Do not extract or reuse cookies, automate credentials or MFA, disable TLS validation, or switch to a browser that is not approved for the project.
- **Be exact about the failure:**
  - `AUTH_REQUIRED`: nothing usable to authenticate with. Name the secret (`details.secretName`) and the storing command, or say sign-in was not completed.
  - `AUTH_FAILED`: the credential was rejected. It may be expired or revoked.
  - `ACCESS_DENIED`: authenticated, but the account lacks permission for that resource. The user's access needs changing, not the framework.
  - `NOT_CONFIGURED`: the base URL variable or manifest field is unset.
- A read-only token cannot create tickets or pull requests. That is a deliberate control, not a fault to work around.
- Do not claim an integration works until a real call through it has succeeded in this environment.
