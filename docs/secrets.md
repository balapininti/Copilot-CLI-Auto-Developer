# Secrets

This page says where the framework's secrets live, where they must never
live, and how to store, rotate and revoke them.

**Partly verified.** Reading a secret from Windows Credential Manager
(`scripts\ps\Get-AutoDevCredential.ps1`) is exercised by CI on a Windows
runner. `scripts\Set-AutoDevCredential.ps1` is parsed and linted there but has
not been executed. Verify it once with the steps under
[Store, list, remove](#store-list-remove) before relying on it.

## Where a secret is looked up

For a secret named `NAME` the framework looks in two places, in this order:

1. The environment variable `NAME`.
2. The operating system's credential store, entry `autodev/NAME`:
   - **Windows:** Credential Manager, a *generic* credential with the target
     name `autodev/NAME`. This is the supported store.
   - macOS: the login keychain, generic password with service `autodev/NAME`
     (`security find-generic-password -s autodev/NAME -w`).
   - Linux: libsecret through `secret-tool`
     (`secret-tool lookup service autodev name NAME`).

   The macOS and Linux lookups exist so that developers of the framework can
   work on their own machines. They are not a supported way to run it.

The first non-empty value wins. An environment variable therefore overrides
the credential store, which matters during rotation: a stale variable hides a
freshly stored credential.

The value is held in the memory of the one `autodev` process that needs it
and is registered with the redactor (see below). It is not cached on disk and
not passed to other processes.

### Which to use

- **Credential Manager** for anything that stays on your machine: interactive
  sessions and the scheduled monitoring task. Windows encrypts the entry with
  your logon credentials. Other Windows users of the same machine cannot read
  it; any program running as you can.
- **Environment variables** only where a secret is injected at run time, for
  example by a CI system. Do not put secrets in your PowerShell profile, in
  user or machine environment variables, or in a `.env` file. Environment
  variables are inherited by every child process, including the agent's
  shell.

### Turning the credential store off

Set `AUTODEV_DISABLE_CREDENTIAL_STORE=1` to make the framework use environment
variables only. No PowerShell, `security` or `secret-tool` process is started.
Use it in CI and in tests, and on machines where PowerShell policy blocks the
lookup (see [Limits](#limits-of-the-windows-lookup)).

## Secret names

| Default name | Used for | Renamed in `project.yaml` by |
| --- | --- | --- |
| `AGILITY_TOKEN` | Digital.ai Agility access token, sent as `Authorization: Bearer` | `agility.tokenSecret` |
| `BITBUCKET_TOKEN` | Bitbucket HTTP access token, sent as `Authorization: Bearer` | `bitbucket.tokenSecret` |
| `SPLUNK_TOKEN` | Splunk authentication token, sent as `Authorization: Bearer` | `observability.splunkTokenSecret` |
| `DYNATRACE_TOKEN` | Dynatrace API token, sent as `Authorization: Api-Token` | `observability.dynatraceTokenSecret` |
| `DB2_CONN_<PROFILE>` | DB2 connection string for the profile in `database.connectionProfile` | Not renamed; derived from the profile |

- Renaming lets two projects on one machine use different tokens, for example
  `agility.tokenSecret: BILLING_AGILITY_TOKEN`. The manifest holds the *name*;
  the value is still looked up as described above.
- `<PROFILE>` is the connection profile in upper case with every run of other
  characters replaced by `_`. Profile `billing-ro` becomes
  `DB2_CONN_BILLING_RO`.
- Names must match `^[A-Za-z_][A-Za-z0-9_.-]{0,99}$`.
- Service base URLs are not secrets. The manifest names the environment
  variable that holds each one (`agility.baseUrlEnv` and so on).

See which secrets a project expects, and whether each is available, without
printing any value:

```powershell
.\scripts\autodev.ps1 auth status --project <id>
```

## Store, list, remove

Run these yourself in a normal PowerShell window. The agent must not be asked
to handle secret values.

```powershell
# Store (prompts; input is hidden)
.\scripts\Set-AutoDevCredential.ps1 -Name AGILITY_TOKEN

# List names and last-written dates, never values
.\scripts\Set-AutoDevCredential.ps1 -List

# Remove
.\scripts\Set-AutoDevCredential.ps1 -Name AGILITY_TOKEN -Remove
```

What the script does:

- The value is read with `Read-Host -AsSecureString`. There is no parameter
  that takes the value, so it cannot end up in the command history or in a
  process command line.
- It is written as generic credential `autodev/<Name>` with persistence
  "local machine": the entry stays on this computer for your Windows account
  and does not roam with your profile.
- The unmanaged copy used for the write is zeroed and freed straight
  afterwards.
- The maximum length is 1280 characters (a Windows limit of 2560 bytes).

You can also see and delete the entries in Control Panel, Credential Manager,
Windows Credentials, under "Generic Credentials"; `cmdkey /list` shows them
too. Do not create them with `cmdkey /generic:... /pass:...`: that
puts the secret on a command line.

### Limits of the Windows lookup

The framework reads the credential by running

```
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\ps\Get-AutoDevCredential.ps1 -Target autodev/NAME
```

which prints the secret to its standard output, read only by the `autodev`
process that started it. Consequences:

- The helper only accepts targets that start with `autodev/`. It cannot be
  used to print other programs' credentials.
- It compiles a small piece of C# with `Add-Type`. Where PowerShell is locked
  to Constrained Language Mode (AppLocker or WDAC policies), `Add-Type` is
  blocked and the lookup fails. The framework then behaves as if the secret
  were absent (`AUTH_REQUIRED`). This case has not been tested. If it applies
  to you, ask whether the script can be allowed, or inject environment
  variables at run time and set `AUTODEV_DISABLE_CREDENTIAL_STORE=1`.
- A lookup failure of any kind is reported as "no secret", never with the
  secret in the message.
- Credential Manager entries belong to one Windows user. The scheduled
  monitoring task must run as the user who stored them, which is how
  `Register-MonitoringTask.ps1` registers it.

## Least privilege, per token

Create each token for this purpose only, with the narrowest scope that works
and an expiry date. Use a personal token for interactive work; use a service
account for scheduled monitoring only if your organisation requires it.

| Secret | Give it | Do not give it | Notes |
| --- | --- | --- | --- |
| `AGILITY_TOKEN` | Read access to the project's boards and work items. Write access only if this project is meant to comment, change status or create defects | Administration; other teams' projects | A read-only token blocks ticket creation and updates at the server (`ACCESS_DENIED`) whatever the project policy says. That is intended: it is the strongest way to guarantee that monitoring never writes to Agility |
| `BITBUCKET_TOKEN` | Repository read and pull-request write on this project's repositories only | Project or repository administration; access to other projects | Used for the REST API (opening pull requests). `git` itself authenticates with your own git credential setup, not with this token |
| `SPLUNK_TOKEN` | A role that can search only this project's indexes | `admin`-like roles, all-index search, any edit capability | The framework only searches. It adds its own bounds (`monitoring.limits`), but the token's role is the real boundary |
| `DYNATRACE_TOKEN` | Scopes `problems.read`, `metrics.read`, `entities.read` | Any `*.write` scope, configuration or token-management scopes | Browser sign-in is not implemented for Dynatrace; the token is the only way in |
| `DB2_CONN_<PROFILE>` | An account with SELECT on this project's schemas only | INSERT/UPDATE/DELETE, DDL, other schemas | The connection string contains a password; treat the whole string as the secret. The framework accepts only guarded SELECT statements, but the read-only account is the real boundary |

The framework's approval gates and policies are a second line of defence. The
token's own permissions are the first: the framework cannot do what the token
is not allowed to do.

## Where secrets never go, and what enforces it

| Place | What the framework does |
| --- | --- |
| `project.yaml` and other manifests | A manifest holds names of environment variables and credential entries only. Every manifest is scanned when it is loaded; one that appears to contain a secret is rejected and the project does not load |
| Logs, command results, audit entries | Everything printed or stored passes through the redactor. It masks every secret value the process has read (exact match) and recognisable shapes: bearer and API tokens, JWTs, private keys, credentials in URLs, `password=`-style assignments. Output of programs the framework runs (git, build tools) is redacted the same way |
| Commits and pull requests | The automated review scans added lines. A line that looks like a secret is a blocking finding, and the commit is refused until the review gate passes for the current code |
| Prompts and agent context | Commands return data, not credentials. No command prints a secret; `auth status` reports only whether one is available. Do not paste a secret into the Copilot CLI conversation |
| Ticket and defect text | Defect drafts and approval previews are redacted, including personal data patterns (e-mail addresses, phone and card numbers), before a person reviews them and before anything is sent |
| Browser | Password fields are never filled by automation. Cookies and tokens are never read out of the browser profile |
| Repository URLs | URLs with embedded credentials (`https://user:pass@host/...`) are refused |

Redaction is pattern-based and exact-match-based. It reliably masks the
secrets the framework itself read. It cannot recognise every possible secret
that appears in application logs or source code, so the review gate and human
approval of outgoing text still matter.

If you ever see a secret in output, a log, a commit or a ticket: treat it as
compromised, revoke it (below), and report the leak as a defect in the
framework.

## Rotation

Rotate on the schedule your organisation sets, when someone leaves the team,
and immediately after any suspected exposure.

1. Create the new token in the service, with the same narrow scope.
2. Store it under the same name; this replaces the old value:

   ```powershell
   .\scripts\Set-AutoDevCredential.ps1 -Name AGILITY_TOKEN
   ```

3. Make sure no environment variable of the same name is set, or it will
   override what you stored. This prints names only:

   ```powershell
   Get-ChildItem Env: | Where-Object { $_.Name -eq 'AGILITY_TOKEN' } | Select-Object -Property Name
   ```

4. Verify with a read-only call:

   ```powershell
   .\scripts\autodev.ps1 auth status --project <id>
   .\scripts\autodev.ps1 agility verify --project <id>
   ```

5. Revoke the old token in the service.

Nothing has to be restarted. Each `autodev` command, and each scheduled
monitoring pass, reads the secret when it starts. `-List` shows when each
entry was last written, which helps to find tokens that are due.

## Revocation

When a token may have leaked, or a machine is lost or reassigned:

1. **Revoke the token in the service first** (Agility, Bitbucket, Splunk,
   Dynatrace; for DB2 change the account's password). Removing it from your
   machine does not invalidate a copy someone else may hold.
2. Remove the local copy:

   ```powershell
   .\scripts\Set-AutoDevCredential.ps1 -Name AGILITY_TOKEN -Remove
   ```

3. If Agility browser sign-in was used, delete the profile folder to end the
   stored session, and sign out of other sessions in your identity provider
   if it offers that:

   ```
   %LOCALAPPDATA%\AutoDev\browser-profiles\<project>-msedge
   ```

4. If the monitoring task should stop: `.\scripts\Register-MonitoringTask.ps1 -Project <id> -Unregister`.
5. Review what the token was used for. The audit log records the framework's
   own actions (`autodev audit show --project <id>`); the service's access
   log is the authority on everything else.

Until a new token is stored, commands for that service fail with
`AUTH_REQUIRED` (nothing stored) or `AUTH_FAILED` (a revoked token is still
stored). That is the expected, safe state.
