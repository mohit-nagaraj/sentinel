# SNT-019 — Evidence Curator and bounded reconciliation

| Field | Value |
|---|---|
| Milestone | M4 — Knowledge graph construction and reconciliation |
| Status | `not-started` |
| Depends on | SNT-014, SNT-018 |
| Blocks | Publication, onboarding workflow, PR investigation, review UI |
| PRD references | §7.1, §13.17, §15.5, FR-009 |

## Background

Initial specialist passes will leave gaps and conflicts. The Curator turns a compact deterministic coverage matrix into focused follow-up missions without becoming an unrestricted supervisor or bypassing evidence authority.

## Scope

- Coverage-matrix builder over validated claims/candidates/current graph references.
- Gap classes: requirement without workflow, workflow/runtime endpoint without code, code behavior without intent, changed symbol without product path, conflict, stale evidence.
- Structured Curator output containing proposed `DiscoveryMission`s only.
- Parent-graph validation of agent/mode/scope/questions/success criteria/budgets.
- Dynamic dispatch to specialist subgraphs; parallel where independent.
- Maximum reconciliation rounds, total budget, no-progress detection, human interrupt.
- Publication-readiness decision made deterministically from policy.

## Implementation tasks

- [ ] Define coverage matrix and gap/conflict schemas.
- [ ] Build matrix deterministically from evidence state.
- [ ] Define Curator model prompt/output with candidate specialist modes and remaining budgets.
- [ ] Validate every proposed mission against gap, allowed scope, and global limits.
- [ ] Dispatch missions using LangGraph dynamic worker/subgraph mechanism and merge results safely.
- [ ] Revalidate/link results, rebuild matrix, and detect material evidence gain.
- [ ] Enforce maximum rounds and no-progress termination.
- [ ] Route unresolved human decisions through interrupt/review records.
- [ ] Emit reconciliation events explaining gap, mission, result, and stop condition.

## Acceptance criteria

- A golden missing UI link generates an Application mission; missing endpoint handler generates a Code mission; missing documented intent generates a Documentation mission.
- Curator cannot invoke domain tools, write Neo4j, assign final evidence tiers, alter risk formulas, or exceed supplied budgets.
- Invalid/redundant/out-of-scope missions are rejected by parent graph.
- Independent missions can run in parallel and merge without lost updates.
- No-evidence-gain and max-round cases terminate with explicit unresolved coverage.
- Human-review gaps checkpoint and resume correctly.
- A complete matrix does not trigger unnecessary calls.

## Required tests

- Gap classification unit tests.
- Structured mission validation/privilege denial tests.
- Docs/Code/App dispatch golden scenarios.
- Parallel fan-out/reducer tests.
- No-progress/max-round/global-budget tests.
- Interrupt/resume test.
- Repeated-run mission relevance/stability eval.

## Out of scope

Specialist tool implementations, graph activation, final risk calculation, and UI rendering.

## Implementation notes

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
