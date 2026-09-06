# SNT-025 — Knowledge, coverage, evidence-path, and review UI

| Field | Value |
|---|---|
| Milestone | M5 — Onboarding and observable control plane |
| Status | `not-started` |
| Depends on | SNT-019, SNT-020, SNT-021, SNT-023, SNT-024 |
| Blocks | Assessment report dashboard |
| PRD references | §8.5, §12, §17, FR-019 |

## Background

Users need to inspect current knowledge and ambiguity without rendering the entire Neo4j graph. The product should emphasize workflows, requirements, coverage, selected paths, provenance, freshness, and review actions.

## Scope

- Application knowledge summary and freshness/current commit.
- Requirements/capabilities and coverage filters.
- Workflows/screens/UI elements.
- Code/API/domain trace drill-down.
- Selected evidence path visualization/table, not unlimited graph canvas.
- Evidence tier, extraction method, source commit/run, artifact/source links.
- Review queue for Tier-C/D candidates/conflicts and LangGraph interrupts.
- Accept/reject with reason, compatibility/invalidation behavior.
- Empty/stale/partial/error states.

## Implementation tasks

- [ ] Add typed read APIs over SNT-021 queries and Postgres summaries.
- [ ] Build knowledge overview counts/freshness/source status.
- [ ] Build requirement and workflow coverage views.
- [ ] Build evidence-path component spanning docs→requirement→UI→endpoint→code.
- [ ] Add private artifact/source excerpt drill-down.
- [ ] Build review queue/detail with competing evidence.
- [ ] Wire accept/reject/reason to review and interrupt-resume services.
- [ ] Mark reviewed links stale when source identity changes.
- [ ] Add accessible filters, loading, pagination, and error handling.

## Acceptance criteria

- Reviewer can inspect one full cross-layer path and every provenance reference.
- Coverage statuses clearly distinguish not observed, blocked, not evaluated, and ambiguous.
- The UI never implies that a missing edge proves absence.
- Review decisions require reason, are auditable, and resume the intended run once.
- No cross-application/revision data leakage occurs.
- Large graphs are bounded/paginated; rendering does not require fetching all nodes.
- Current commit/freshness warnings are visible.

## Required tests

- API query authorization/pagination tests.
- Component tests for all coverage/evidence tiers and stale states.
- Review accept/reject/duplicate/invalidation integration tests.
- Browser test for evidence-path drill-down and interrupt resume.
- Cross-application isolation and private artifact access tests.

## Out of scope

Full force-directed graph editor, manual arbitrary Cypher, editing source requirements, and PR-specific report layout.

## Implementation notes

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
