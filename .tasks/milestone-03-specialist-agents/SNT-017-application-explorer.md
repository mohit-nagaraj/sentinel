# SNT-017 — Application Explorer agent

| Field | Value |
|---|---|
| Milestone | M3 — Specialist discovery agents |
| Status | `not-started` |
| Depends on | SNT-012, SNT-014 |
| Blocks | Evidence linking, coverage, verification, activity UX |
| PRD references | §13.6, §15.4, FR-005 |

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

- [ ] Define compact application-agent state referencing browser/evidence IDs.
- [ ] Build context from sanitized observation and top bounded candidate actions.
- [ ] Require action selection by opaque ID only.
- [ ] Map mission capability/requirement hints into non-authoritative action relevance.
- [ ] Track visited state/action pairs and multi-branch frontier.
- [ ] Convert transitions into typed workflow/step/UI/runtime claims.
- [ ] Distinguish terminal goal, dead end, recoverable branch, login block, unsafe action, and budget limit.
- [ ] Implement backtracking/history within approved context.
- [ ] Implement crash recovery by re-authentication and safe/idempotent replay with fingerprint confirmation.
- [ ] Interrupt at uncertain non-idempotent replay or mutable-action boundaries.
- [ ] Emit concise structured action reasons and evidence-gain events.

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

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
