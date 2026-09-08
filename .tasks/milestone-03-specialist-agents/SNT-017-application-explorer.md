# SNT-017 — Application Explorer agent

| Field          | Value                                                 |
| -------------- | ----------------------------------------------------- |
| Milestone      | M3 — Specialist discovery agents                      |
| Status         | `done`                                                |
| Depends on     | SNT-012, SNT-014                                      |
| Blocks         | Evidence linking, coverage, verification, activity UX |
| PRD references | §13.6, §15.4, FR-005                                  |

## Background

User workflows span states and choices. The Application Explorer must select the next safe observed action, interpret transitions, and adapt while Playwright and deterministic policy retain execution authority.

## Mission modes

- `workflow_discovery`
- `targeted_requirement_observation`
- `pr_change_validation`
- `flow_recovery`

## Scope

Implement shared-kernel browser tools:

- `observe_page`
- `perform_observed_action`
- `navigate_history`
- `finish_application_mission`

Add mission-aware action selection, state/frontier tracking, workflow construction, coverage claims, recovery/replay, and explicit blockers.

## Implementation tasks

- [x] Define compact application-agent state referencing browser/evidence IDs.
- [x] Build context from sanitized observation and top bounded candidate actions.
- [x] Require action selection by opaque ID only.
- [x] Map mission capability/requirement hints into non-authoritative action relevance.
- [x] Track visited state/action pairs and multi-branch frontier.
- [x] Convert transitions into typed workflow/step/UI/runtime claims.
- [x] Distinguish terminal goal, dead end, recoverable branch, login block, unsafe action, and budget limit.
- [x] Implement backtracking/history within approved context.
- [x] Implement crash recovery by re-authentication and safe/idempotent replay with fingerprint confirmation.
- [x] Interrupt at uncertain non-idempotent replay or mutable-action boundaries.
- [x] Emit concise structured action reasons and evidence-gain events.

## Acceptance criteria

- The agent discovers a golden multi-screen workflow without a hardcoded action sequence.
- Documentation/code-derived mission hints influence exploration but do not create observations without execution.
- Forged/stale/unsafe/external/used action IDs are rejected and the agent can re-observe or terminate.
- Every workflow step references actual state, action, screenshot/evidence, and associated runtime request window.
- Repeated states and dead ends do not create an endless loop.
- Recovery resumes a safe path or requests review; it never blindly repeats uncertain submission.
- The agent never sees credential values, cookies, raw selectors, or arbitrary script access.

## Required tests

- Multi-screen fixture missions with branches, modal, form input slots, dynamic label change, and network evidence.
- Targeted requirement and unprompted-discovery tests.
- Unsafe/stale/forged action denial trajectories.
- Backtracking/no-progress/budget termination tests.
- Safe recovery and non-idempotent interrupt tests.
- Repeated-run workflow/evidence stability eval.
- Opt-in Hi.Events flow smoke mission.

## Out of scope

PR impact planning, final deterministic test verdicts, real payment, arbitrary site support, Stagehand, and Neo4j writes.

## Implementation notes

- Contracts and public types: `packages/contracts/src/application-explorer.ts`, exported through `packages/contracts/src/index.ts`.
- Explorer runtime and ports: `packages/orchestration/src/application-explorer.ts`, exported through `packages/orchestration/src/index.ts`. The runtime exposes `ApplicationExplorer`, `ApplicationExplorerTools`, `createApplicationExplorer`, and `buildApplicationExplorerPlannerContext` around the four approved browser tools.
- Browser proof: `tests/fixtures/application-explorer-application.ts`, `tests/agent/application-explorer.agent.test.ts`, and `tests/integration/application-explorer.integration.test.ts`. The opt-in trusted-target smoke is `tests/live/application-explorer.live.test.ts`.
- Planner decisions are validated against the latest bounded observation before the existing browser runtime applies its own stale-state, reuse, policy, host, and budget checks. Mission hints rank candidates but never create evidence.
- Checkpoints retain bounded public state, frontier, budgets, authentication-state references, and replay-safe history. Recovery restores that reference and fingerprint-confirms safe replay; uncertain mutable boundaries stop with `needs_human`.
- Verified commands: `pnpm exec vitest run --project unit packages/contracts/src/application-explorer.test.ts packages/orchestration/src/application-explorer.test.ts`, `pnpm test:agent`, `pnpm exec vitest run --project integration tests/integration/application-explorer.integration.test.ts --maxWorkers=1`, and `pnpm test:live -- tests/live/application-explorer.live.test.ts` with the Hi.Events opt-in disabled.
- Repository gates: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, and `pnpm build`.
- SNT-014 remains incomplete on the current base. SNT-017 ships a composable explorer with typed browser, planner, and event ports; shared specialist-kernel/LangGraph composition remains SNT-014 work.
