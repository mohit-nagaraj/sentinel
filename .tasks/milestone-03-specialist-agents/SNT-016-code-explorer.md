# SNT-016 — Code Explorer agent

| Field | Value |
|---|---|
| Milestone | M3 — Specialist discovery agents |
| Status | `not-started` |
| Depends on | SNT-009, SNT-010, SNT-011, SNT-014 |
| Blocks | Evidence linking, PR investigation, Curator, evaluation |
| PRD references | §13.7–13.11, §15, FR-006–FR-008 |

## Background

ASTs and endpoint maps describe structure but do not decide which multi-file/multi-language path implements a mission. The Code Explorer must navigate bounded facts and source slices, corroborate hypotheses, and report unresolved dynamic boundaries.

## Mission modes

- `baseline_architecture_discovery`
- `implementation_trace`
- `pr_change_investigation`
- `unmapped_endpoint_resolution`

## Scope

Implement shared-kernel tools:

- `list_repository_modules`
- `search_symbols`
- `search_code_text`
- `inspect_symbol`
- `find_definition`
- `find_references`
- `trace_callers`
- `trace_callees`
- `find_endpoint_handler`
- `find_frontend_callers`
- `inspect_tests`
- `submit_code_claim`
- `finish_code_mission`

## Implementation tasks

- [ ] Add tool adapters over normalized TS/PHP/OpenAPI indexes.
- [ ] Enforce repository path/language/source-line/hop/result budgets.
- [ ] Construct context from bounded source slices and structural edges, not whole files.
- [ ] Define code claim/path schemas requiring source-range evidence.
- [ ] Support endpoint-first, frontend-first, backend-first, capability-first, and changed-symbol missions.
- [ ] Track visited symbol/edge/query combinations and detect no-progress loops.
- [ ] Prefer definitions/references/calls/routes over name similarity.
- [ ] Use focused tests as corroboration, never as proof of runtime behavior by themselves.
- [ ] Represent reflection, magic methods, computed URLs, DI ambiguity, and unresolved references explicitly.
- [ ] Return candidate frontend/backend/domain paths and suggested Documentation/Application follow-ups.

## Acceptance criteria

- Golden missions trace a React route/control through API client/endpoint into Laravel Action/Handler/service/domain facts when evidence exists.
- Changed-symbol missions explore callers/callees/endpoints/tests beyond the edited file without exceeding scope.
- Every proposed edge cites structural/source evidence.
- The model cannot invoke arbitrary shell/Git/filesystem/Neo4j operations or read out-of-scope files.
- Name similarity alone cannot produce a high-strength claim.
- Dynamic gaps remain unresolved with reason and suggested evidence source.
- Output is a typed `MissionResult` with deterministic ordering of claims/paths.

## Required tests

- Cross-stack implementation-trace golden fixture.
- Endpoint-first and changed-symbol trajectories.
- Distractor same-name symbols and comment/string false-positive cases.
- Tool/path/hop/source-line budget and privilege denial tests.
- Dynamic unresolved and partial-result tests.
- Repeated scripted trajectory/evidence stability tests.
- Opt-in Hi.Events slice mission eval.

## Out of scope

AST extraction itself, arbitrary code execution, semantic requirement acceptance, final risk scoring, and Neo4j writes.

## Implementation notes

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
