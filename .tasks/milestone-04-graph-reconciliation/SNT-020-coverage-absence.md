# SNT-020 — Coverage assessments and absence semantics

| Field          | Value                                                |
| -------------- | ---------------------------------------------------- |
| Milestone      | M4 — Knowledge graph construction and reconciliation |
| Status         | `done`                                               |
| Depends on     | SNT-015, SNT-017, SNT-018                            |
| Blocks         | Publication, report, knowledge UI                    |
| PRD references | §12.6, §17, FR-011                                   |

## Background

A missing graph edge cannot distinguish feature absence from incomplete crawl, blocked authentication, unconfigured data, or work never attempted. Coverage must be an explicit scoped observation with provenance and careful language.

## Scope

- Statuses: observed, partially observed, not observed, blocked, not evaluated, ambiguous.
- Assessment scope: requirement, explored workflows/screens, crawl/mission/run, configuration/auth/test-data context, evidence and attempted-search summary.
- Deterministic status rules where possible; model may summarize reasons but not declare feature absence.
- Possible causes and human actions.
- Invalidation/reassessment on source/config/crawl revision changes.
- Report-safe wording templates.

## Implementation tasks

- [x] Define coverage assessment schema and stable/evidence identity.
- [x] Implement status transition/rule engine from mission/evidence outcomes.
- [x] Require scope and attempt evidence for negative statuses.
- [x] Distinguish `not_evaluated` from `not_observed`.
- [x] Represent auth/policy/unsafe/test-data blockers distinctly.
- [x] Generate permitted user-facing wording from status/scope.
- [x] Add stale/invalidation rules when requirement source or relevant crawl config changes.
- [x] Produce Neo4j-ready assessment facts and Postgres UI summaries.

## Acceptance criteria

- Every extracted requirement receives a coverage status or explicit pending state.
- `not_observed` requires evidence of a bounded attempt and names its scope.
- The system never converts no edge/no search into “feature does not exist.”
- Blocked authentication and unsafe actions are not misreported as product gaps.
- New supporting evidence can advance partial/not-observed status; stale evidence triggers reassessment.
- Report text uses approved uncertainty language.

## Required tests

- Status-rule matrix across observed/partial/not observed/blocked/not evaluated/ambiguous.
- No-attempt negative assertion denial test.
- Auth/policy/test-data blocker tests.
- Source/config invalidation tests.
- Wording snapshots that reject absolute absence claims.
- Idempotent assessment update tests.

## Out of scope

Full Curator routing, browser exploration, final report layout, and graph activation.

## Implementation notes

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._

- `packages/contracts/src/coverage.ts` defines strict evaluation inputs, scoped assessments, typed blockers/ambiguities, revision context, report-safe wording, graph facts, compact UI summaries, and freshness results.
- `packages/orchestration/src/coverage-assessment.ts` is the deterministic authority for all six statuses. Callers submit attempts, observed checkpoints, blockers, and ambiguity evidence; they cannot submit a status or infer absence from a missing edge.
- Assessment identity excludes outcome evidence so additional evidence can advance the same scoped assessment. Evaluator evidence is content-addressed so changed outcomes retain immutable provenance, while identical replay remains byte-for-byte idempotent.
- `not_observed` requires both bounded explored scope and attempt evidence. Missing attempt evidence produces `not_evaluated`; auth, policy, unsafe-action, and test-data blockers remain distinct and generate human actions without being reported as product gaps.
- Requirement-source, crawl-configuration, authentication-revision, and test-data-revision changes mark an assessment stale and explicitly require reassessment.
- Coverage output includes a Neo4j-ready flattened fact plus validated `coverage_evaluator` evidence and a `HAS_ASSESSMENT` candidate accepted by the existing authoritative evidence linker. `packages/storage/src/public-projections.ts` emits the compact Postgres/UI summary.
- Focused verification: 86 relevant Vitest tests passed across contracts, coverage, evidence linking, and storage projection; contract, orchestration, and storage package type checks passed; scoped ESLint, Prettier, and `git diff --check` passed.
- The requested simple `/review` found a blocker-wording crash and a possible absolute-absence leak through the public reason. Both were fixed with deterministic safe reasons, non-interpolated blocker wording, and persisted attempt-summary validation; regression tests cover both findings. No acceptance item is deferred.
