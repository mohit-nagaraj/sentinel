# SNT-020 — Coverage assessments and absence semantics

| Field | Value |
|---|---|
| Milestone | M4 — Knowledge graph construction and reconciliation |
| Status | `not-started` |
| Depends on | SNT-015, SNT-017, SNT-018 |
| Blocks | Publication, report, knowledge UI |
| PRD references | §12.6, §17, FR-011 |

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

- [ ] Define coverage assessment schema and stable/evidence identity.
- [ ] Implement status transition/rule engine from mission/evidence outcomes.
- [ ] Require scope and attempt evidence for negative statuses.
- [ ] Distinguish `not_evaluated` from `not_observed`.
- [ ] Represent auth/policy/unsafe/test-data blockers distinctly.
- [ ] Generate permitted user-facing wording from status/scope.
- [ ] Add stale/invalidation rules when requirement source or relevant crawl config changes.
- [ ] Produce Neo4j-ready assessment facts and Postgres UI summaries.

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
