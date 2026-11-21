---
name: java-spring
description: "Guides Java and Spring Boot changes in a project repository: detect the build tool, Java and Spring Boot versions, modules and package layout, then implement minimal, idiomatic changes that follow the project's standards. Use when implementing or modifying Java service code."
---

# Java and Spring Boot

Commands are written `autodev <command>`. Run them as `node "$env:AUTODEV_HOME\scripts\autodev.mjs" <command>` (from the automation folder: `node scripts/autodev.mjs <command>`). Each prints one JSON envelope: check `ok`, then read `data` or branch on `error.code`. `--dry-run` shows what a command would do without writing anywhere.

## Detect before you write

`autodev java detect --repo <name>` returns the build tool (`maven`, `gradle` or `npm`), whether a wrapper is used, the declared Java and Spring Boot versions, modules, and for each module where main code, tests and resources live and the base package.

Then `autodev project guidelines --task implement` for the project's architecture and coding standards. Where the project's standards and the guidance below differ, the project's standards win.

## Implementing

- **Fit in.** Put new classes where equivalent ones already live. Match the existing layering (controller → service → repository), naming, exception types, logging style and test style. Read two or three neighbouring classes first.
- **Use what the versions support.** Check `javaVersion` and `springBootVersion` before using a language feature or API (records, `jakarta.*` vs `javax.*`, `RestClient`, virtual threads). When detection returns `null`, read the build file; do not assume the latest.
- **Smallest change that meets the acceptance criteria.** No drive-by refactoring, no reformatting of untouched lines, no new framework where the project has one.
- **Dependency injection** by constructor. No field injection in new code unless the project standard says otherwise.
- **Configuration** through the project's existing properties mechanism. No hard-coded URLs, credentials or environment names.
- **Persistence.** Bind parameters only; never concatenate values into SQL or JPQL. Confirm tables and columns with the `db2` skill first. Keep transaction boundaries where the project puts them.
- **Errors.** Use the project's exception hierarchy and handler. Do not swallow exceptions; do not log and rethrow the same error at every layer.
- **Logging.** Through the project logger, at the level its standards give. Never log tokens, passwords or personal data.
- **Validation and authorization** at the boundary the project already uses for them. A new endpoint without the project's authorization check is a defect.
- **Tests with the change.** A unit test for the new behaviour and for its failure cases; an integration or slice test when wiring changes. Follow the existing test naming and fixtures.

## Do not

- Do not add or upgrade a dependency without saying so in the plan and the PR; the review flags it either way.
- Do not create or change schema, migrations or stored procedures without the user's explicit authorization.
- Do not invent an API on another service. Read its contract in that service's repository; if it is not mapped to this project, ask.
- Do not edit generated sources, build outputs, or files outside the project's `repos/` folders.

## Build commands

Run builds and tests through `autodev test run` (see the `testing` skill), which uses the commands configured in `project.yaml` or the defaults for the detected build tool and wrapper. Running the build tool directly for a quick local check is fine; it does not count toward the gate.
