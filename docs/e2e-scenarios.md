# End-to-end scenarios from a recorded HAR

A way to give a project a baseline of end-to-end checks without writing them by hand: you run a normal journey in your browser once, the framework and the agent turn it into a repeatable scenario, and that scenario is re-run and kept current as the code changes.

**Status:** the importer, the approval gate and the checks are unit-tested, and a scenario has been replayed in a real browser against a small local page. It has not been run with a HAR from a real application or by an agent in a Copilot session. How well an agent maps your recording to selectors in your code base is the untested part; review the first few scenarios it proposes closely.

## How the pieces divide the work

| Piece | What it contributes |
|---|---|
| **You** | Run one journey in the browser and export the HAR. Approve the finished scenario. |
| **The HAR** | *What* the journey did: the pages opened and the API calls made, in order. It does not record what you clicked or typed. |
| **The framework** | Strips the HAR down to a safe outline. Replays scenarios in Edge. Makes sure a scenario cannot change without your approval. |
| **The agent** | Works out *how*: searches the code base for the screen that makes each call, the control that triggers it and stable selectors, then tries the scenario until it passes. |

The flow is drawn in [diagrams.md](diagrams.md#13-end-to-end-scenarios-from-a-har).

## Before you start

List the application under test in `project.yaml`. Calls to any host not listed here are dropped from the recording, and scenarios can only be run against these hosts.

```yaml
browser:
  allowedHosts: [orders-dev.corp.example, login.corp.example]   # the application, and your identity provider
```

Use a development or test environment. A scenario that submits a form creates real data there every time it runs.

## 1. Record the journey

1. Open the application in Edge or Chrome and sign in.
2. Open the developer tools (F12), go to **Network**, tick **Preserve log**, and clear the list.
3. Do one journey from start to finish, for example: open the order screen, look up a customer, place an order, see the confirmation. One journey per recording.
4. Use made-up test data. Whatever you type may be visible to the agent as field names, and as masked values if you opt in below.
5. Export: the download arrow in the Network toolbar, **Export HAR**. Recent browsers offer a sanitized export by default; either kind works.

A HAR contains your session cookies and tokens. Keep it out of repositories, tickets and chat, and delete it after the import.

## 2. Import it

Give the agent the path ("build an end-to-end scenario called place-order from C:\Temp\orders.har"), or run the import yourself:

```powershell
node scripts\autodev.mjs scenario import --har C:\Temp\orders.har --name place-order --project orders
```

What is kept, per call: the method, the path with ids replaced by `{id}`, the status, the names of query parameters, and the *shape* of JSON and form bodies (field names and types).

What is dropped, always: every header and cookie, every token, every query value, every response value, every call to another host, and static files. The HAR itself is not copied; only its SHA-256 is recorded.

```json
{ "seq": 4, "kind": "api", "method": "POST", "path": "/api/orders", "status": 201,
  "requestShape": { "customerId": "number", "lines": [{ "sku": "string", "qty": "number" }] },
  "responseShape": { "orderId": "number", "total": "number" } }
```

`--keep-request-values` also keeps the values you submitted, after masking secrets and personal data and shortening long text. Use it only with made-up test data; it lets the agent reuse the exact inputs. `--host` picks one application when the recording touched several.

The outline is stored under `state\scenarios\<project>\drafts\`. Now delete the HAR.

## 3. The agent completes it

Using the `e2e-scenarios` skill, the agent:

1. searches the repositories for each API path in the outline, to find the endpoint that serves it and the UI code that calls it;
2. finds the screen and the control that triggers each call;
3. reads the markup for stable selectors (`data-testid`, then `id`, then `name`);
4. takes input values from your testing standards, or asks you;
5. decides what on the page proves the journey worked, and asserts on it;
6. runs the scenario as a trial (`autodev scenario run --file …`) and repeats until it passes.

The result is one JSON document:

```json
{
  "name": "place-order",
  "title": "A customer with a loyalty discount places an order",
  "baseUrl": "https://orders-dev.corp.example",
  "steps": [
    { "action": "goto", "url": "/orders" },
    { "action": "fill", "selector": "[data-testid=customer-id]", "value": "88213" },
    { "action": "fill", "selector": "[data-testid=reference]", "value": "e2e-{{unique}}" },
    { "action": "click", "selector": "[data-testid=submit-order]" },
    { "action": "assertText", "selector": "[data-testid=result]", "contains": "Order placed" },
    { "action": "screenshot", "name": "order-placed" }
  ],
  "expect": [
    { "method": "GET", "path": "/api/customers/{id}", "status": 200 },
    { "method": "POST", "path": "/api/orders", "status": 201 }
  ],
  "code": [
    { "repo": "web-ui", "path": "src/orders" },
    { "repo": "service-api", "path": "src/main/java/com/example/orders/OrderController.java" }
  ]
}
```

- `steps` are browser actions. `{{unique}}` becomes a new token on every run, for fields that reject duplicates.
- `expect` are the API calls that must be seen while the steps run. This is what the HAR adds over a plain UI script: a page can look right while the call behind it went to the wrong place.
- `code` is where the journey lives in the code base. It is how a later change is matched to this scenario.

If your application has no stable selectors, the agent will say so. Adding `data-testid` attributes is a code change for you to agree to.

## 4. You approve it

The agent requests approval and gives you an id. In your own terminal:

```powershell
node scripts\autodev.mjs approvals review apr-… --project orders
node scripts\autodev.mjs scenario apply --approval apr-… --project orders
```

You see the whole document before deciding. Only then is `projects\orders\scenarios\place-order.json` written. Check that the steps are the journey you recorded, the assertion is something a user would recognise as success, and the expected calls are the ones that matter.

## 5. Running scenarios

```powershell
node scripts\autodev.mjs scenario list --project orders
node scripts\autodev.mjs scenario run --name place-order --project orders
node scripts\autodev.mjs scenario run --all --headless --project orders
node scripts\autodev.mjs scenario run --all --base-url https://orders-test.corp.example --project orders
```

A scenario passes when every step succeeds, every expected call was seen with an accepted status, and the application returned no 5xx response during the run. The result says which step failed, which call was never made (`seen: 0`) or what it answered instead (`otherStatuses`). Screenshots and the result are stored under `state\evidence\<project>\`.

`--strict` makes a failing run exit non-zero (code 4), for use in your own scripts.

If the application needs a sign-in, sign in once in the project's Edge profile by running a scenario without `--headless`; the session is reused. Scenarios never type passwords or one-time codes.

## 6. How scenarios stay current

During a story, after implementing and before review, the agent runs:

```powershell
node scripts\autodev.mjs scenario affected --story S-01234 --repo web-ui --project orders
```

This lists the approved scenarios whose `code` references include a file the story changed. The agent runs those, and for each failure decides which of three things happened:

| What happened | What the agent does |
|---|---|
| The change broke the journey | Fixes the code. The scenario did its job. |
| The story changed the journey on purpose (a renamed endpoint, a new required field) | Updates the scenario, tries it, and proposes the update for your approval with the story as the reason |
| The scenario was fragile (a selector moved) | Proposes a sturdier scenario and says behaviour did not change |

When a story adds a journey nothing covers, the agent proposes a new scenario.

**Scenarios do not update themselves.** Every change goes through the same approval, and the approval request spells out what the update removes:

```
Summary:   Change end-to-end scenario "place-order" (5 steps, 2 expected calls, REMOVES 1 expectation(s))
change:
    "expectRemoved": ["POST /api/orders -> 201"],
    "expectAdded":   ["POST /api/v2/orders -> 201"]
```

This is deliberate. A scenario that an agent could quietly rewrite to match new behaviour would stop catching regressions the moment it mattered. A scenario file edited directly, by an agent or by hand, no longer matches its integrity record and is refused as a baseline (`autodev scenario list` shows it as `modified-outside-approval`).

The independent reviewer checks that affected scenarios were run and that every removed expectation is justified by the story.

## Limits

- **Evidence, not the gate.** A scenario runs against a host. The framework cannot tell which build that host is running, so a scenario result is never recorded as "tests passed for this code". To make end-to-end testing gate pull requests, configure a `tests.e2e` command that starts the application from the working tree ([setup.md](setup.md#end-to-end-testing-of-your-application)).
- **Only what was recorded.** A scenario checks the path you took. It does not explore error cases unless you record them.
- **One application per scenario.** Calls to other hosts are not followed or checked.
- **Test data is yours to manage.** The framework does not reset data. Journeys that can only be done once (cancel order 88213) need `{{unique}}` or a reset step outside the framework.
- **No file uploads, downloads, drag and drop, or multiple tabs.** The browser steps are navigate, click, fill, press, wait, read, screenshot and assert.
- **Scenarios are per machine until shared.** The file can be kept in your team's project repository, but its approval is recorded on the machine where it was given; on another machine it is `never-approved` until someone there proposes and approves it.
- **Never production.** Scenarios write data.
