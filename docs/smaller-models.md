# Working well with a smaller model

Copilot CLI runs whichever model you select. A smaller, faster model follows clear instructions well. It is weaker at three things this workflow depends on: holding a long procedure in mind across a session, exploring a large code base thoroughly, and noticing what is missing. The framework moves those three out of the model's judgement and into code.

**Status:** each command below is tested for what it returns. Whether they improve results with a particular model has not been measured, because no model has run them in a Copilot session yet. Judge it on your first few stories.

## What the framework does

| Weakness | What takes it over | Command |
|---|---|---|
| Losing the order of a ten-step workflow; skipping or repeating a step | The order is computed from what is recorded. The agent asks for the one next step, does it, and asks again. | `autodev next --story S-…` |
| Context filling with long outputs, so later decisions get worse | One trimmed bundle per task, inside a size budget, that says what it left out. Empty guideline sections and template text are removed. | `autodev context --story S-… --task plan\|plan-review\|implement\|test\|review` |
| Not finding everything that uses the code being changed | A whole-word search across every repository of the project. | `autodev code refs --symbol Name` |
| Evaluating a plan from the plan's own description of the code | Looked-up facts: which named files and identifiers exist, which uses of them the plan does not mention, which acceptance criteria the plan may have skipped. | `autodev plan check --story S-…` |
| A review that is silent about a whole class of problem | A sign-off needs a nine-area checklist with what was looked at for each. A missing or unchecked area is refused. | `plan review`, `review record --checklist` |
| Long instructions diluting the important ones | The developer agent's file is a short loop around `autodev next` with one worked example; detail lives in skills, which load only when needed. | |

### The loop

```powershell
node scripts\autodev.mjs next --story S-01234 --project orders
```

```json
{
  "next": {
    "step": "evaluate-plan",
    "title": "Hand the plan to the plan-reviewer agent",
    "actor": "plan-reviewer",
    "command": "autodev plan check --story S-01234",
    "skill": "plan-review",
    "why": "The plan has not been evaluated. The author cannot evaluate its own plan."
  },
  "progress": { "story": "read", "plan": "not evaluated", "repositories": [ { "name": "service-api", "changedFiles": 0, "uncommitted": false, "gatesOutstanding": ["tests", "automated-review", "independent-review"], "pullRequest": null } ] }
}
```

`actor` says who acts: the developer agent, one of the reviewer agents, or you. The steps, in order: read the story, prepare repositories, write the plan, have it evaluated, revise it, implement, test, automated review, independent review, commit, open the pull request, report. If code changes after a gate ran, the next step is that gate again.

It is also the quickest way for you to see where a story stands.

### What was trimmed

The agent file is in the model's context for the whole session; skills are loaded when a step needs them.

| File | Before | After |
|---|---|---|
| `auto-developer.agent.md` | 8,395 characters | 5,371 |
| `plan-reviewer.agent.md` | 3,167 | 2,613 |
| Each of the 18 skills | a repeated 390-character preamble | one line |

## Choosing the model

**For the session.** Copilot CLI's documented controls are `/model` inside a session and `--model` when starting. The launcher passes it through:

```powershell
.\scripts\Start-AutoDev.ps1 -Project orders -Model <name shown under /model>
```

**For the reviewers.** The two reviewer agents are where judgement matters most: a missed problem in a plan or a review is the expensive kind. If your plan includes a stronger model than the one you use day to day, the reviewers are where to spend it.

GitHub's reference for custom agents lists a `model` property in an agent file ("Model to use when this custom agent executes. If unset, inherits the default model"). Its documentation only confirms that property for VS Code and the JetBrains, Eclipse and Xcode IDEs; it does not say whether Copilot CLI honours it, and this has not been tested here. To try it, add one line to the frontmatter of `.github/agents/plan-reviewer.agent.md` and `.github/agents/code-reviewer.agent.md`:

```yaml
model: <name shown under /model>
```

Then check whether it took effect: start the reviewer and ask which model it is running on, or look at `/model`. If Copilot CLI ignores the property, the sure way is to run the reviewer in its own session:

```powershell
.\scripts\Start-AutoDev.ps1 -Project orders -Agent plan-reviewer -Model <stronger model>
```

and tell it "Evaluate the plan for S-01234". The verdict is recorded in the same place, and the developer session picks it up on its next `autodev next`.

## What this does not fix

- **The quality of the code a model writes.** These commands make sure the right steps happen in the right order with the right facts. The tests and the two reviews are what catch a bad change.
- **Understanding of a very large change.** Keep stories small. A plan with many files and many callers is harder for any model, and much harder for a small one.
- **A reviewer that fills in the checklist without looking.** The checklist forces coverage to be claimed, area by area, in a form you can read. It cannot verify the claim. Read the first few yourself.
