# Sentinel Task System

This directory contains implementation-ready issues derived from [`../PRD.md`](../PRD.md) and organized by [`../milestones.md`](../milestones.md).

## Sources of truth

Use each document at one level only:

1. **`PRD.md`** — product behavior, architecture, constraints, and final decisions.
2. **`decisions.md`** — why the user selected key approaches.
3. **`milestones.md`** — sequencing, outcome-level scope, dependencies, and progress.
4. **Issue file** — implementation contract for one independently reviewable change.
5. **Code/tests** — actual current implementation; documentation is updated if implementation legitimately changes a contract.

Issue files intentionally reference rather than restate the complete PRD or milestone narrative.

## Workflow

1. Check an issue's `Depends on` field and [`milestones.md`](../milestones.md).
2. Change `Status` to `in-progress` and add an owner before implementation.
3. Read the linked PRD sections and dependency issue outputs.
4. Implement only the issue scope, including its tests.
5. Record material implementation decisions in the issue's `Implementation notes` section and architecture changes in `decisions.md`.
6. Run focused tests plus the issue's regression gate.
7. Change status to `review` only after all acceptance criteria are satisfied.
8. Review the diff and test evidence; mark `done` only after review and cumulative checks pass.
9. Update totals/status in [`milestones.md`](../milestones.md).

## Parallel-agent rules

Multiple implementation agents may work concurrently only when:

- every issue is `ready`;
- dependencies are complete;
- file/write scopes do not overlap materially;
- each issue has one accountable owner;
- shared schema/API changes land before consumers;
- integration is reviewed one issue at a time in dependency order.

Do not assign two agents to the same issue or let independent agents silently define competing shared contracts.

## Issue status

Use only:

- `not-started`
- `ready`
- `in-progress`
- `blocked`
- `review`
- `done`

## Test policy

Every implementation issue must add or update focused automated tests. Tests should be layered:

- pure unit tests for deterministic transformations and policy;
- contract tests for JSON/Zod boundaries;
- integration tests against isolated external-service namespaces;
- LangGraph node/partial/whole-graph tests for orchestration;
- Playwright tests for browser behavior;
- golden/eval cases for model trajectories and semantic quality.

Networked, paid-model, live-browser, and destructive tests must be opt-in and clearly separated from the default deterministic suite. Mocks must preserve provider contracts and be complemented by at least one explicit compatibility test where the provider integration is critical.

## Definition of done for every issue

Unless an issue explicitly strengthens it, done means:

- scoped acceptance criteria pass;
- required tests are committed and passing;
- typecheck, lint, and affected regression suites pass;
- failures are explicit and secrets are redacted;
- no out-of-scope feature was smuggled into the change;
- user-visible behavior is documented only after it exists and is verified;
- status/progress is updated.