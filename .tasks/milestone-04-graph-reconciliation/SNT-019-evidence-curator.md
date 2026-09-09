# SNT-019 — Evidence Curator and bounded reconciliation

| Field          | Value                                                         |
| -------------- | ------------------------------------------------------------- |
| Milestone      | M4 — Knowledge graph construction and reconciliation          |
| Status         | `done`                                                        |
| Depends on     | SNT-014, SNT-018                                              |
| Blocks         | Publication, onboarding workflow, PR investigation, review UI |
| PRD references | §7.1, §13.17, §15.5, FR-009                                   |

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

- [x] Define coverage matrix and gap/conflict schemas.
- [x] Build matrix deterministically from evidence state.
- [x] Define Curator model prompt/output with candidate specialist modes and remaining budgets.
- [x] Validate every proposed mission against gap, allowed scope, and global limits.
- [x] Dispatch missions using LangGraph dynamic worker/subgraph mechanism and merge results safely.
- [x] Revalidate/link results, rebuild matrix, and detect material evidence gain.
- [x] Enforce maximum rounds and no-progress termination.
- [x] Route unresolved human decisions through interrupt/review records.
- [x] Emit reconciliation events explaining gap, mission, result, and stop condition.

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

- `packages/contracts/src/evidence-curator.ts` defines strict coverage, Curator request/output, mission receipt/rejection, review, event, and terminal result contracts.
- `packages/orchestration/src/coverage-matrix.ts` deterministically classifies requirement, workflow/UI, endpoint/code, intent, changed-symbol, conflict, review, and stale-evidence gaps from validated evidence state.
- `packages/orchestration/src/evidence-curator.ts` implements parent-authorized mission validation, dynamic parallel dispatch and deterministic fan-in, global and per-mission budgets, material-gain detection, bounded stop policy, checkpointed human review, and publication readiness.
- Curator model output is advisory only. The parent graph derives stable mission identities and rejects unknown, human-only, cross-run, out-of-scope, unapproved-tool, over-budget, duplicate, redundant, and round-overflow proposals.
- Curator execution uses a graph-specific checkpoint namespace and an explicit `ResumeCoordinator`; duplicate starts are serialized and conflicting persisted start configuration fails closed.
- Reconciliation activity uses stable event IDs and post-commit reporting nodes so event retries resume without recomputing committed matrix, mission, review, or terminal state.
- Focused verification: `pnpm exec vitest run --project unit packages/contracts/src/evidence-curator.test.ts packages/orchestration/src/evidence-curator.test.ts` (24 passed); `pnpm --filter @sentinel/contracts typecheck`; `pnpm --filter @sentinel/orchestration typecheck`; scoped ESLint and Prettier checks.
- Review found and fixed event-before-checkpoint replay risk, uncoordinated duplicate execution, ambiguous committed-review reporting, evidence-strength gain detection, rejected-review terminal semantics, and checkpoint namespace collision risk. No acceptance item is deferred.
