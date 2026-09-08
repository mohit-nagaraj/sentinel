# SNT-016 — Code Explorer agent

| Field          | Value                                                   |
| -------------- | ------------------------------------------------------- |
| Milestone      | M3 — Specialist discovery agents                        |
| Status         | `done`                                                  |
| Depends on     | SNT-009, SNT-010, SNT-011, SNT-014                      |
| Blocks         | Evidence linking, PR investigation, Curator, evaluation |
| PRD references | §13.7–13.11, §15, FR-006–FR-008                         |

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

- [x] Add tool adapters over normalized TS/PHP/OpenAPI indexes.
- [x] Enforce repository path/language/source-line/hop/result budgets.
- [x] Construct context from bounded source slices and structural edges, not whole files.
- [x] Define code claim/path schemas requiring source-range evidence.
- [x] Support endpoint-first, frontend-first, backend-first, capability-first, and changed-symbol missions.
- [x] Track visited symbol/edge/query combinations and detect no-progress loops.
- [x] Prefer definitions/references/calls/routes over name similarity.
- [x] Use focused tests as corroboration, never as proof of runtime behavior by themselves.
- [x] Represent reflection, magic methods, computed URLs, DI ambiguity, and unresolved references explicitly.
- [x] Return candidate frontend/backend/domain paths and suggested Documentation/Application follow-ups.

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

### Paths

- Wire contracts and parsers: `packages/contracts/src/code-explorer.ts`, re-exported by `@sentinel/contracts`.
- Composite normalized repository and all thirteen tools: `packages/adapters/src/code-explorer/`, re-exported by `@sentinel/adapters`.
- Shared-kernel composition: `packages/orchestration/src/code-explorer-specialist.ts`, re-exported by `@sentinel/orchestration`; the prior bounded service remains available for compatibility.
- Cross-stack fixture and scripted missions: `tests/fixtures/code-explorer.ts` and `tests/agent/code-explorer.test.ts`.
- Opt-in pinned public evaluation: `tests/live/code-explorer-hi-events.live.test.ts`.

### Decisions

- `CodeExplorerRepository` composes prepared TypeScript query, PHP relationship/source-slice, Laravel route, frontend API-call, and OpenAPI evidence. It never parses syntax itself and never receives an unrestricted filesystem handle.
- Repository construction rejects application, run, repository, snapshot, endpoint-provenance, or commit identity disagreement. Resolved reference/handler targets are emitted only when the target symbol remains inside the mission's path and language scope.
- `CodeExplorerTools` exposes exactly the task's thirteen operations. Mission path/language/tool scope is checked before execution; per-tool result, hop, line, and character limits are applied again below the model gateway.
- Symbol and text searches return candidates without structural claim evidence. `submit_code_claim` accepts only evidence IDs previously observed in the mission, and at least one structural source-to-target edge must exactly support the proposed relationship.
- Focused test evidence is always `corroborating` with `corroboratesOnly: true`; it cannot satisfy the structural-edge rule alone.
- The specialist stores rich source/edge/path results in an injected durable store and retains only compact hashes/evidence references in LangGraph state. Sequenced observations hydrate bounded recent context; semantic repeats terminate as `no_progress` without duplicate reads.
- All thirteen described tools execute through the shared registry and durable coordinator. Tool/source/content/repository/model/token/elapsed budgets and total traversal/result limits terminate with typed status/reason codes; committed finish reconstruction is provider-free.
- Claims and connected paths are sorted deterministically. Dynamic calls and unresolved references are retained with reason codes and optional Documentation/Application follow-up targets.
- The Azure gateway's validated default tool ceiling is 16 so the complete thirteen-tool surface fits while remaining below the contract maximum of 32.
- SNT-014 is absent from the `origin/main` baseline used for this work. SNT-016 provides its feature-specific bounded execution loop and ports but does not mark the broader shared-kernel checkpoint/interrupt/cross-agent milestone complete.

### Verification (2026-09-08)

- `pnpm typecheck`, `pnpm lint`, and `pnpm build` pass.
- `pnpm test` passes 677 tests across 70 files, including 36 new contract/adapter/orchestration unit tests.
- `pnpm test:agent` passes 9 Code Explorer mission tests: the golden cross-stack trace, endpoint-first and changed-symbol paths, frontend/backend/capability entry modes, distractors, dynamic/unmapped partial results, and five equivalent repeated runs.
- `php-laravel-indexer.integration.test.ts` passes all 13 tests after installing the lockfile-pinned ignored Composer dependency. The other integration projects passed or remained gated by their documented external-service flags.
- With `RUN_LIVE_TESTS=1` alone, the Hi.Events Code Explorer evaluation is discovered and skipped; it runs only when `RUN_CODE_EXPLORER_HI_EVENTS=1` and the existing GitHub/Azure configuration are also present.
- `/review` identified and fixed four P1 boundaries before shipping: mixed immutable identities, cross-scope resolved targets, predicate/evidence-kind mismatch, and remaining budget/elapsed checks around model-selected tools.

### Deferred

- The paid Hi.Events mission was not executed during default verification; the runnable harness is intentionally opt-in.
- Shared checkpoint/resume, authorized human interrupts, cross-agent privilege isolation, lease enforcement, committed events, and restart replay are exercised through the SNT-014 composition tests.
- Neo4j mutation, semantic requirement acceptance, Curator reconciliation, and final risk scoring remain out of scope as declared.
