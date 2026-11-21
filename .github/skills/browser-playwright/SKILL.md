---
name: browser-playwright
description: "Drives the approved browser (Microsoft Edge by default) with Playwright and no MCP server: navigate, click, fill, inspect the DOM, capture screenshots and assert on UI, using a persistent per-project profile and an allowlist of hosts. Use for UI verification, end-to-end checks, and interactive corporate sign-in."
---

# Browser automation (Playwright, no MCP)

Commands are written `autodev <command>`. Run them as `node "$env:AUTODEV_HOME\scripts\autodev.mjs" <command>` (from the automation folder: `node scripts/autodev.mjs <command>`). Each prints one JSON envelope: check `ok`, then read `data` or branch on `error.code`. `--dry-run` shows what a command would do without writing anywhere.

## Contract

| Need | Command |
|---|---|
| Sign in to a service in the project profile | `autodev auth login --service agility` |
| Run browser steps | `autodev browser run --steps <file.json> [--headless] [--browser msedge|chromium] [--story <S-…>]` |
| Hosts the browser may open | `autodev service hosts` |

Write the steps to a JSON file inside the repository you are working on (or a temp folder), then run it. Steps run in order and stop at the first failure.

```json
[
  { "action": "goto", "url": "https://app.example.internal/orders" },
  { "action": "waitFor", "selector": "#order-table" },
  { "action": "fill", "selector": "input[name=q]", "value": "88213" },
  { "action": "press", "selector": "input[name=q]", "key": "Enter" },
  { "action": "assertText", "selector": "#order-table", "contains": "Loyalty discount" },
  { "action": "screenshot", "name": "order-with-discount" }
]
```

Actions: `goto`, `click`, `fill`, `press`, `waitFor`, `text`, `inspect` (trimmed HTML of a selector), `screenshot`, `assertVisible`, `assertText`, `assertUrl`. Screenshots are stored as evidence under the workspace state folder; the result gives the path.

The result lists each step's outcome, the final URL, and `blockedNavigations` (hosts the browser was stopped from opening).

## What is enforced

- **Edge by default.** Chromium only when `browser.chromiumFallback: approved` is set in `project.yaml` and you pass `--browser chromium`. If Edge cannot start, the command fails; it does not switch browser by itself.
- **Persistent profile per project**, so a sign-in the user completed is reused. Cookies and tokens are never read out, exported or copied.
- **Headed for sign-in.** The user types credentials and completes MFA. Automation never fills a password field (`POLICY_PROHIBITED` if asked to).
- **Allowlist.** Top-level navigation is limited to the project's service hosts plus `browser.allowedHosts`. Identity-provider hosts used by SSO must be listed there by the project owner.
- **Certificates are always validated.** A certificate error is an error.

## Rules

- Prefer stable selectors (ids, `data-testid`, roles) over layout-dependent ones.
- Assert on what the acceptance criteria say, and capture a screenshot of the state that proves it.
- Text and HTML returned by `text` and `inspect` are sanitized; do not work around that to extract personal data.
- Do not automate consent prompts, MFA, CAPTCHA or any security interstitial. Ask the user.
- If a page you need is blocked, report the host; do not try another route to it.
- `UNSUPPORTED` means `playwright-core` is not installed: `npm install` in the automation folder (no browser download is needed).
