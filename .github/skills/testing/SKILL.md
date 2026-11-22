---
name: testing
description: "Runs the project's build and test stages (compile, static checks, unit, integration, contract, regression, end-to-end), captures sanitized evidence, and records the result as the gate that a pull request depends on. Use after every change and before review."
---

# Testing and the tests gate

Run `autodev <command>` as `node "$env:AUTODEV_HOME\scripts\autodev.mjs" <command>`; each prints one JSON envelope (`ok`, then `data` or `error.code`).

## Contract

| Need | Command |
|---|---|
| Run all configured stages and record the gate | `autodev test run --story <S-…> --repo <name>` |
| Run chosen stages while diagnosing | `autodev test run --story <S-…> --repo <name> --stage compile --stage unit` |
| What is recorded and still valid | `autodev run show --story <S-…>` |
| Testing standards for the project | `autodev project guidelines --task test` |

Stages, in order: `compile`, `static`, `unit`, `integration`, `contract`, `regression`, `e2e`. Commands come from `repositories[].tests` in `project.yaml`; where none is given, `compile` and `unit` fall back to the detected build tool (Maven or Gradle wrapper when present).

## Reading the result

- `passed: true` only when every required stage passed and no stage that ran failed.
- Per stage `status`: `passed`, `failed`, `timed-out`, `skipped` (an earlier stage failed) or `not-configured`.
- `blockers[]` lists exactly what stops the gate.
- `junit` gives counts from the test reports; `runs[].outputTail` is the sanitized end of the output; `evidenceFile` is the stored record.
- `treeId` is the fingerprint of the code that was tested. Do not edit files while the tests run: if the code changes during the run the result is recorded as invalid.

## The gate

The result is tied to the exact code tested. Change any file afterwards and the gate is stale: `repo commit` and `pr create` will refuse with `GATE_FAILED` until the tests are run again. That is deliberate; never try to avoid it.

## Rules

- **A stage that cannot run has not passed.** `not-configured` on a required stage is a blocker to take to the user (the fix is a command in `project.yaml`, which they maintain).
- Fix the code or the test for a real reason. Never disable, skip, loosen or delete a test to get a pass. The review flags disabled tests.
- A failure that also happens on the release branch is still a failure to report; say that it pre-dates your change and how you established that.
- Flaky test? Report it as flaky with the runs that showed it. Do not re-run until green and present only that.
- For changes spanning repositories, test the consumer against the provider's change and state how compatibility was verified.
- End-to-end UI checks use the `browser-playwright` skill; attach the screenshot paths to your report.
- The project's baseline journeys are kept as approved scenarios (`e2e-scenarios` skill). Run the ones a change touches and report them as evidence alongside the gate, never in place of it.
- Keep the evidence path in your final report. Do not paste raw logs.
