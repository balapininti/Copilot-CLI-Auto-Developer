# Running on a corporate network

This page is for people who run the framework from a managed Windows machine,
behind a VPN, a proxy and a corporate certificate authority (CA).

**What has and has not been verified.** Nothing on this page has been tested
on a real corporate network. The Node.js behaviour described below was checked
against Node 24.14.1 on a developer machine (details in
[Node.js versions](#nodejs-versions-what-was-confirmed)). Statements about
git, npm, Edge and Windows are the documented behaviour of those products and
were not exercised behind a real proxy, a TLS-inspecting gateway or a
conditional-access policy. Treat the first run on your network as a test and
use the [troubleshooting table](#troubleshooting-by-error-code).

## What the framework connects to

Everything runs on your machine. There is no hosted component of this
framework and no MCP server. Outbound connections are made by:

| Program | Connects to | Used for |
| --- | --- | --- |
| `node` (the `autodev` CLI) | The base URLs of Agility, Bitbucket, Splunk and Dynatrace configured for the project | REST calls |
| `git` | The Bitbucket hosts in `bitbucket.allowedHosts` | clone, fetch, push |
| Microsoft Edge | The Agility host, plus `browser.allowedHosts` | Sign-in fallback and browser test steps |
| DB2 driver | The database in the stored connection string | Read-only queries |
| `npm` | Your npm registry or mirror | Installing packages, at setup time only |
| GitHub Copilot CLI | GitHub's Copilot services | The agent itself. Not part of this framework; see GitHub's documentation for its network requirements |

The framework's own HTTP client accepts only `https://` URLs. Plain `http://`
is accepted for loopback addresses only, for the local mock server.

## VPN and firewall

- Be on the VPN (or the office network) before starting a session if your
  services are internal. The framework does not start or detect a VPN.
- If the VPN drops, calls fail with `NETWORK` or `TIMEOUT`. Both are marked
  retryable; nothing is lost. The scheduled monitoring task backs off after a
  failed pass (1 minute, doubling, up to 1 hour) and continues from its last
  checkpoint.
- The firewall must allow HTTPS from your machine to the hosts in the table
  above, either directly or through the proxy. `service hosts` lists them for
  a project:

  ```powershell
  .\scripts\autodev.ps1 service hosts --project <id>
  ```

## Proxies

Each program reads its proxy settings from a different place. Setting one does
not set the others.

### Node.js (the autodev CLI)

Node.js does **not** use the Windows system proxy and, by default, ignores the
proxy environment variables. It honours `HTTPS_PROXY`, `HTTP_PROXY` and
`NO_PROXY` only when `NODE_USE_ENV_PROXY=1` is set (or `node` is started with
`--use-env-proxy`).

```powershell
# User-level, so new terminals and the scheduled task see them.
[Environment]::SetEnvironmentVariable('NODE_USE_ENV_PROXY', '1', 'User')
[Environment]::SetEnvironmentVariable('HTTPS_PROXY', 'http://proxy.example.corp:8080', 'User')
[Environment]::SetEnvironmentVariable('NO_PROXY', 'localhost,127.0.0.1,.example.corp', 'User')
```

Open a new terminal afterwards. Notes:

- Do not put a user name and password in the proxy URL. An environment
  variable is readable by every process you start. If your proxy needs
  authentication that Node cannot do (NTLM, Kerberos), use the local
  authenticating proxy your IT department provides, if there is one.
- PAC files and WPAD auto-discovery are not supported by Node. You need the
  explicit proxy host and port.
- `Bootstrap.ps1` and `autodev doctor` report whether `HTTPS_PROXY` and
  `NODE_USE_ENV_PROXY` are set. They warn when the proxy is set but
  `NODE_USE_ENV_PROXY` is not, because Node would then silently connect
  directly.

### git

git uses, in this order, its own configuration and then the environment:

```powershell
git config --global http.proxy http://proxy.example.corp:8080
# bypass the proxy for one internal host:
git config --global http.https://bitbucket.example.corp/.proxy ""
```

git also honours `HTTPS_PROXY` / `NO_PROXY` when `http.proxy` is not set. The
framework runs your installed git with your configuration and adds no proxy
settings of its own.

### npm

npm reads its own configuration (and falls back to the `HTTPS_PROXY`
environment variable):

```powershell
npm config set https-proxy http://proxy.example.corp:8080
npm config set noproxy "localhost,127.0.0.1,.example.corp"
```

### Microsoft Edge (Playwright)

The browser is the Edge installed on your machine, started through
`playwright-core`. The framework passes no proxy option, so Edge uses the
Windows system proxy settings, including PAC files and group policy, as it
does when you open it yourself.

## Corporate certificate authorities

If your network inspects TLS, or your internal services use certificates
issued by an internal CA, each program must be told to trust that CA.

### Never disable certificate validation

- Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- Never use `git -c http.sslVerify=false`, `git config http.sslVerify false`
  or `GIT_SSL_NO_VERIFY`.
- Never set npm's `strict-ssl=false`.

What the framework enforces:

- Every `autodev` command exits with `TLS_POLICY_VIOLATION` (exit code 4) when
  `NODE_TLS_REJECT_UNAUTHORIZED=0` is in its environment. `Bootstrap.ps1` and
  `Start-AutoDev.ps1` refuse as well.
- The HTTP client has no option to skip validation, and the browser is always
  started with certificate errors treated as errors.
- The framework never passes `http.sslVerify=false` to git. It does **not**
  inspect your global git configuration, so do not set it there either.
- The automated code review flags TLS-disabling patterns in changes it
  reviews.

### Node.js

Option 1, a PEM bundle (works on every supported Node version):

```powershell
[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'C:\certs\corp-ca-bundle.pem', 'User')
```

The file holds one or more CA certificates in PEM format (the root, and any
intermediates your servers do not send). Node reads it once at start-up and
adds it to its built-in list. If the path is wrong Node prints a warning and
carries on, and you get certificate errors later; `Bootstrap.ps1` warns when
the file does not exist.

Option 2, the Windows certificate store (recent Node versions):

```powershell
[Environment]::SetEnvironmentVariable('NODE_USE_SYSTEM_CA', '1', 'User')
# or, for one command:  node --use-system-ca scripts\autodev.mjs doctor
```

Node then also trusts the CAs in the operating system store, which is where
group policy normally installs the corporate root. See the version notes
below before relying on this.

### git

Git for Windows can use the Windows certificate store directly:

```powershell
git config --global http.sslBackend schannel
```

or you can point it at a PEM bundle:

```powershell
git config --global http.sslCAInfo C:\certs\corp-ca-bundle.pem
```

### npm

```powershell
npm config set cafile C:\certs\corp-ca-bundle.pem
```

npm runs on Node, so `NODE_EXTRA_CA_CERTS` also applies to it.

### Edge

Edge uses the Windows certificate store. Nothing to configure.

## Node.js versions: what was confirmed

The framework requires Node 22.12 or later.

| Claim | Status |
| --- | --- |
| `--use-env-proxy` and `--use-system-ca` exist as command-line options | Confirmed on Node 24.14.1 (`node --help` lists both; both are accepted in `NODE_OPTIONS`) |
| `NODE_USE_ENV_PROXY=1` makes `fetch` (which the framework uses) go through `HTTPS_PROXY` | Confirmed on Node 24.14.1: with the variable, a request was sent to the configured proxy address; without it, the proxy variable was ignored |
| `NODE_EXTRA_CA_CERTS` | Confirmed listed in `node --help` on Node 24.14.1. Not tested with a real corporate CA |
| `NODE_USE_SYSTEM_CA=1` and `--use-system-ca` add the operating system's CAs | **Not confirmed.** Node 24.14.1 accepts both, but on the test machine (macOS, sandboxed) the system store returned no certificates, so the effect could not be observed. `node --help` on 24.14.1 does not list the `NODE_USE_SYSTEM_CA` variable. Not tested on Windows |
| Node 22.x behaviour | **Not confirmed**; no Node 22 was available. According to the Node.js documentation, `NODE_USE_ENV_PROXY` needs 22.21 or later on the 22 line, and `--use-system-ca` needs 22.15 or later. On Node 22.12 to 22.20, assume the proxy variables are ignored |

Check your own installation:

```powershell
node --version
node --help | Select-String -Pattern 'proxy|system-ca|EXTRA_CA'
```

If `--use-env-proxy` is not listed, your Node cannot use a proxy for the
framework's HTTP calls; upgrade Node. If `--use-system-ca` is not listed, use
`NODE_EXTRA_CA_CERTS`.

## Single sign-on

The framework prefers API tokens and falls back to a browser only where that
is implemented.

1. **Token first.** For each service the framework looks for an API token
   (see [secrets.md](secrets.md)). When one is found, no browser is involved.
2. **Browser fallback: Agility only.** When there is no Agility token and the
   project has not set `agility.browserFallback: false`, the framework opens
   Microsoft Edge with a profile kept for that project at

   ```
   %LOCALAPPDATA%\AutoDev\browser-profiles\<project>-msedge
   ```

   You complete SSO and MFA yourself in that window:

   ```powershell
   .\scripts\autodev.ps1 auth login --service agility --project <id>
   ```

   The framework waits (5 minutes by default) and then reuses the signed-in
   profile on later runs until your identity provider ends the session.
3. **Bitbucket, Splunk and Dynatrace need a token.** Browser sign-in is not
   implemented for them; without a token they fail with `AUTH_REQUIRED`.

What the automation does and does not do in the browser:

- It never types into password fields; a step that tries is refused.
- It never reads, exports or copies cookies or tokens out of the profile.
  Requests are made from inside the signed-in browser.
- It only navigates to allowed hosts and never ignores certificate errors.
- It is the real, installed Edge with a persistent profile, so conditional
  access, device compliance and MFA policies apply as they do when you browse
  yourself. If policy blocks the sign-in, the framework cannot work around it
  and does not try. Whether your tenant's policies accept an Edge profile
  outside your normal one has not been tested.
- Non-interactive runs (the scheduled monitoring task) never open a sign-in
  window. If the profile is not signed in they stop with `AUTH_REQUIRED`
  (exit code 3) and you sign in once with `auth login`.

The profile folder holds your signed-in session. It is in your user profile,
protected by Windows file permissions. Delete the folder to sign out.

## Host allowlists

The framework refuses to contact a host that the project has not named.

| Setting | Controls |
| --- | --- |
| The base URL of each service (`agility.baseUrlEnv`, `bitbucket.baseUrlEnv`, `observability.splunkBaseUrlEnv`, `observability.dynatraceBaseUrlEnv` name the environment variables that hold them) | REST calls for a service go only to the host of that service's base URL |
| `bitbucket.allowedHosts` | Hosts repositories may be cloned from or pushed to. A repository URL on another host is refused (`REPO_URL_NOT_APPROVED`) |
| `browser.allowedHosts` | Additional hosts the browser may navigate to, on top of the service hosts |

An entry `*.example.corp` matches subdomains. Redirects are not followed by
the HTTP client: a redirect (typically to a sign-in page) is reported as
`AUTH_REQUIRED` rather than followed to a host that was never approved. If a
service legitimately lives on a second host, add that host to the project
manifest; do not work around the check.

## Rate limits

- Monitoring queries are bounded by `monitoring.limits` in `project.yaml`:

  | Key | Default | Meaning |
  | --- | --- | --- |
  | `maxWindowMinutes` | 60 | Longest time window one query may cover |
  | `maxEventsPerQuery` | 500 | Most events one Splunk search returns |
  | `minSecondsBetweenQueries` | 1 | Minimum gap between monitoring queries |

- The HTTP client retries idempotent requests (GET, HEAD, OPTIONS) at most
  twice on HTTP 408, 429, 502, 503 and 504 and on network errors, with
  exponential back-off. It honours `Retry-After` up to 60 seconds. Writes are
  not retried unless the call carries its own idempotency key.
- If a service keeps answering 429 the command ends with `RATE_LIMITED`
  (exit code 5). Raise `minSecondsBetweenQueries`, lower the frequency of the
  scheduled task (`Register-MonitoringTask.ps1 -EveryMinutes`), or ask the
  service owner for the limits that apply to your token.

## Installing packages behind a registry mirror

`Bootstrap.ps1` runs `npm ci`, which installs exactly what `package-lock.json`
lists. Only npm packages are downloaded. `playwright-core` does not download
a browser, and the framework never runs `playwright install`.

To use an internal mirror (Artifactory, Nexus, Azure Artifacts):

```powershell
npm config set registry https://artifactory.example.corp/api/npm/npm-remote/
npm config set cafile C:\certs\corp-ca-bundle.pem      # if the mirror uses an internal CA
```

- `package-lock.json` records `resolved` URLs on registry.npmjs.org. npm
  replaces the default registry host with your configured registry when it
  installs, so the lockfile normally works unchanged. This has not been
  verified against a real mirror.
- If the mirror needs authentication, follow your organisation's instructions
  for `.npmrc`. Keep the token in your user-level `%USERPROFILE%\.npmrc`,
  never in the repository.
- `playwright-core` is an optional dependency. If the mirror blocks it,
  installation still succeeds; browser sign-in and browser test steps are
  then unavailable and `autodev doctor` reports `playwright-core` as missing.
- If the mirror lacks a package or version, `npm ci` fails with `E404` or
  `ETARGET`. Ask for the package to be allowed; do not edit the lockfile to
  point elsewhere.

## Troubleshooting by error code

Every failed command prints JSON with `error.code` and `error.message`. Start
with:

```powershell
.\scripts\Bootstrap.ps1 -CheckOnly
.\scripts\autodev.ps1 auth status --project <id>
```

| Code | Exit code | Likely causes | What to do |
| --- | --- | --- | --- |
| `NETWORK` | 5 | VPN is down. Proxy needed but `NODE_USE_ENV_PROXY` is not 1, so Node connects directly. Wrong `HTTPS_PROXY`. Internal host missing from `NO_PROXY`, so it is sent to a proxy that cannot reach it. DNS failure. Corporate CA not trusted (the message contains `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN` or `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`) | The message contains the underlying reason (`ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET`, a certificate code). Connect the VPN; fix the proxy variables; for certificate codes set `NODE_EXTRA_CA_CERTS`. Never disable validation |
| `TIMEOUT` | 5 | Service is slow or unreachable (default limit is 30 seconds per request). Firewall silently drops the connection. Proxy needed but not configured. A monitoring query covers too much data | Check the VPN and proxy as for `NETWORK`. For monitoring, reduce `maxWindowMinutes` or `maxEventsPerQuery`. Retry; the command is safe to repeat |
| `TLS_POLICY_VIOLATION` | 4 | `NODE_TLS_REJECT_UNAUTHORIZED=0` is set in the environment. Or a configured URL is `http://` for a host that is not loopback | Remove the variable, including from your user and machine environment variables, and trust the corporate CA properly. Use `https://` base URLs |
| `HOST_NOT_ALLOWED` | 4 | A URL points at a host other than the service's base-URL host. The browser was asked to open a host not in `browser.allowedHosts`. The base URL variable holds the wrong host | Compare `autodev service hosts --project <id>` with the host in the message. Correct the base URL variable, or add the host to the manifest if it is legitimate |
| `AUTH_REQUIRED` | 3 | No token stored and no browser fallback for that service. The service answered with a redirect or an HTML sign-in page (expired SSO session, or a gateway in front of the API). The browser profile is not signed in and the run is not interactive. No DB2 connection string stored | Store the token (see [secrets.md](secrets.md)). For Agility without a token run `autodev auth login --service agility`. If a gateway intercepts API calls, ask for the direct API host |
| `AUTH_FAILED` | 5 | HTTP 401: the token is wrong, expired or revoked, or was pasted with extra characters. A stale environment variable with the same name overrides the stored credential | Create a new token and store it again with `Set-AutoDevCredential.ps1`. Check that no old environment variable of that name exists (`Get-ChildItem Env:*TOKEN*` shows names; do not print values on a shared screen) |
| `ACCESS_DENIED` | 5 | HTTP 403: the account is authenticated but lacks permission for that project, repository, index or entity. A read-only token was used for a write (for Agility this is intended; see secrets.md). A web application firewall blocked the request | Ask the service owner for the specific permission. Do not widen the token beyond what [secrets.md](secrets.md) recommends |
| `RATE_LIMITED` | 5 | HTTP 429 after retries: too many queries, or a limit shared with other users of the same token | Wait and retry. Raise `monitoring.limits.minSecondsBetweenQueries`, run the scheduled task less often, narrow the queries |

Exit code 5 is shared by several codes; scripts should branch on
`error.code`, not on the exit code.

Related codes: `UPSTREAM_ERROR` (the service answered 5xx or something
unexpected), `NOT_CONFIGURED` (a base URL variable is not set),
`REPO_URL_NOT_APPROVED` (repository host not in `bitbucket.allowedHosts`).

git and npm failures do not always carry these codes because those programs
make their own connections. For git, test the same operation by hand
(`git ls-remote <url>`); for npm, run `npm ping`.
