# Plan review: every change starts with an evaluated plan

Before the `auto-developer` agent writes any code for a story, it writes a plan, and a different agent, `plan-reviewer`, evaluates that plan against the ticket and the real code. The evaluation returns a verdict and findings ranked P0 (blocking) to P4 (optional). Code is not committed and no pull request is opened until the current plan is recorded as ready.

The reason is cost. A null case, a second caller or an unsafe migration found in a plan is a paragraph to rewrite. The same thing found in review is a rework, and found in production it is an incident.

**Status:** the rules and the gate are tested and part of the end-to-end run. The `plan-reviewer` agent has not yet been run in a Copilot session, so how good its findings are on your code base is for you to judge on the first few stories.

## The flow

```
auto-developer   reads the ticket and the code, writes the plan        plan submit
plan-reviewer    evaluates it; records verdict and findings P0 to P4   plan review
   not ready  ->  author resolves every P0 and P1, resubmits, re-evaluated (up to 3 rounds, then you decide)
   ready      ->  you see the plan, the P2 findings and what could not be verified, and confirm
auto-developer   implements, tests, reviews, commits                   repo commit is refused unless the plan is ready
```

If implementation has to depart from the plan, the plan is updated and evaluated again. The code reviewer checks the finished change against the evaluated plan.

## The plan

Markdown, with these headings. A missing heading is refused; "None", with the reason, is acceptable.

| Heading | Content |
|---|---|
| Goal | What will be true when this is done, in the ticket's terms |
| Acceptance criteria | Each criterion, with the change that satisfies it and the test that proves it |
| Changes | Per repository: files, classes and functions; any API, message, configuration or schema that changes shape; order of work |
| Edge cases | The situations that are not the happy path, and what the code does in each |
| Tests | New and changed tests, their stage, and why each new test would fail without the change |
| Risks and rollback | What could go wrong in production, who else is affected, how it is undone |
| Assumptions and open questions | What was taken as true without checking; what you must answer |

## The evaluation prompt

This is the instruction the reviewer works to. It lives in `.github/skills/plan-review/SKILL.md`; change it there.

> Evaluate this plan for a code change **before it is implemented**. Your job is to find what would make it fail, in review, in testing or in production, while that is still cheap to fix. Either sign it off as ready to implement or return it with findings. You are not here to agree, and you are not here to rewrite it.
>
> **Work from evidence, not from the plan's own description of the code.** Read the ticket and its acceptance criteria. Open the files the plan names and the code that calls them. Check that the classes, methods, tables, columns, endpoints and configuration the plan relies on exist and behave as it says. Where you could not check something, say so; do not assume it holds.
>
> **Evaluate each of these, and report what you looked at for each:**
>
> 1. **Requirements.** Does every acceptance criterion map to a specific change and a test? Does the plan do anything the ticket did not ask for?
> 2. **Feasibility.** Can each step be done as described in this code base, with its build tool, versions, frameworks and layering rules? Does anything named in the plan not exist, or work differently from how the plan assumes?
> 3. **Missing edge cases.** Go beyond the cases the plan lists. Consider at least: null, empty and missing values; boundaries (zero, one, maximum, negative, very large); duplicates and repeated or retried requests; concurrent requests and partial failure half-way through; a dependency that is slow, down or returns an error; ordering and time (time zones, daylight saving, clock skew, month and year ends); character encoding and length; permissions and other tenants or roles; existing data that predates the change; and the state left behind when the operation fails. Report only the ones that can actually occur here.
> 4. **Blast radius.** What else calls or depends on what changes: other modules, other repositories of this project, consumers of an API or message, scheduled jobs, reports? Is anything public changing shape, and are its consumers accounted for?
> 5. **Data.** Schema changes, migrations, backfills, destructive statements, transactions and locking, data written without validation. Is the change safe on existing production data, and safe to deploy while the old version is still running?
> 6. **Security.** Input validation, authorization on every new path, injection, secrets, and what gets logged.
> 7. **Tests.** Would each planned test fail without the change? Are the failure paths and the edge cases above tested, or only the happy path? Is any required stage unable to run?
> 8. **Operations.** Performance on realistic volumes (queries in loops, missing limits or indexes), logging and metrics needed to see it working, configuration and feature flags, deployment order, and whether rollback actually restores the previous behaviour.
> 9. **Assumptions.** Is each stated assumption true? What is the plan assuming without saying so?
>
> **Give every finding a priority:**
>
> | Priority | Meaning | Effect |
> |---|---|---|
> | **P0** | Blocking. Implementing the plan as written would break production, lose or corrupt data, open a security hole, or cannot work at all. | Not ready. |
> | **P1** | Must fix before implementation. An acceptance criterion is not met, a case that will occur is not handled, or the plan rests on something that is not true. | Not ready. |
> | **P2** | Should fix. A real weakness with a workable way around it: a gap in tests, a risk without a mitigation, unclear sequencing. | Ready, but the user is told. |
> | **P3** | Worth considering. An improvement to the approach, not a defect. | Optional. |
> | **P4** | Strictly optional. Style, naming, preference. | Optional. |
>
> Priority follows consequence, not effort and not how sure you want to sound. If you cannot say what breaks and when, it is not P0 or P1.
>
> **Each finding states:** the priority; what is wrong or missing, in one line; the concrete situation in which it goes wrong and what happens then; the evidence (file and line, acceptance criterion, or fact you checked); and the specific change to the plan that resolves it. A finding without a consequence is an opinion; leave it out or make it P4.
>
> **Verdict.** `not-ready` if any P0 or P1 stands. Otherwise `ready`. A sign-off is a claim that you checked: state what you verified and what you could not. If you found nothing, say what you examined so that "no findings" means something.
>
> **Do not:** pad the list to look thorough; restate the plan; raise problems the plan already handles; propose a different design because you would have chosen it; soften a real problem into a suggestion; or sign off because the plan reads well.

## What changed from the original prompt, and why

The starting point was: *"Evaluate the following plan for a code change… Identify any issues with its feasibility or sign off on it as ready to start implementation. If you have recommended changes, give each a priority level P0-P4… account for important edge cases missing from the plan, not just concerns with the existing plan as stated."* Its three strengths are kept: a forced verdict, a priority scale, and looking for what is missing. These were added:

| Change | Why |
|---|---|
| The reviewer reads the ticket and the code, not only the plan | A plan can be internally consistent and still wrong about the code. Most serious findings come from checking the plan's claims. |
| Nine named areas to evaluate | "Feasibility" alone tends to produce comments on what is written. Naming blast radius, data, security, tests and operations makes the reviewer look where the plan is silent. |
| A concrete list of edge-case families | "Missing edge cases" is where an unprompted reviewer is weakest. The list is a prompt to think, with an instruction to report only what can occur. |
| Each priority defined by its consequence, with its effect on the verdict | Without definitions P0 to P4 drift: everything becomes P1 or P2. Tying P0 and P1 to "not ready" makes the scale decide something. |
| Every finding needs the failing situation, evidence and a fix | It separates defects from opinions and makes each finding checkable by the author and by you. |
| A sign-off must say what was checked and what was not | It stops "looks good" from counting as an evaluation. |
| An explicit list of what not to do | Padding, restating and redesigning are the common ways a review wastes the author's time. |
| A separate agent with no edit tool evaluates | An author evaluating its own plan confirms it. The reviewer cannot quietly fix the plan either; it has to say what is wrong. |

## What is enforced in code

| Rule | Where |
|---|---|
| A plan has every required section and no secret or personal data | `plan submit` |
| The verdict applies to the plan that was read: it must quote that plan's hash | `plan review --plan-hash` |
| Changing the plan makes its evaluation stale | The verdict is stored against the plan's SHA-256 |
| `ready` is refused while any P0 or P1 finding stands | `plan review` |
| A P0 or P1 finding must carry evidence and a recommendation | `plan review` |
| `ready` must state what was verified | `plan review --checked` |
| The author cannot record the evaluation | `plan review` refuses the reviewer name `auto-developer` |
| No commit and no pull request while the current plan is missing, unevaluated, stale or not ready | `repo commit`, `pr create` (gate `plan-review`) |
| Every submission and evaluation is in the audit log | `autodev audit show --action plan` |

## Seeing it

```powershell
node scripts\autodev.mjs plan show --story S-01234 --project orders     # the plan, its evaluation, whether work may proceed
node scripts\autodev.mjs run show  --story S-01234 --project orders     # plan and code gates together
```

## Turning it down

`policies.planReview` in `project.yaml` is `required` by default. Set it to `advisory` to keep recording plans and evaluations without blocking commits and pull requests:

```yaml
policies:
  planReview: advisory
```

The agents are still instructed to plan and have the plan evaluated; only the hard stop is removed.

## Limits

- **The reviewer is another agent, not a person.** It will miss things and will sometimes be wrong. You confirm the plan after the evaluation, and that is the real control.
- **Identity is self-declared.** The framework cannot prove which agent recorded an evaluation, or how carefully. See [security.md](security.md).
- **A good plan is not a good change.** The plan gate does not replace tests or code review; those run afterwards on the code itself.
- **The plan gate applies at commit time.** Nothing technically prevents an agent from editing files before the plan is ready; the instructions forbid it, and the commit is refused until a ready plan exists.
