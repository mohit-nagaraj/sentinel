# SNT-025 — Knowledge, coverage, evidence-path, and review UI

| Field          | Value                                        |
| -------------- | -------------------------------------------- |
| Milestone      | M5 — Onboarding and observable control plane |
| Status         | `done`                                       |
| Depends on     | SNT-019, SNT-020, SNT-021, SNT-023, SNT-024  |
| Blocks         | Assessment report dashboard                  |
| PRD references | §8.5, §12, §17, FR-019                       |

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

- [x] Add typed read APIs over SNT-021 queries and Postgres summaries.
- [x] Build knowledge overview counts/freshness/source status.
- [x] Build requirement and workflow coverage views.
- [x] Build evidence-path component spanning docs→requirement→UI→endpoint→code.
- [x] Add private artifact/source excerpt drill-down.
- [x] Build review queue/detail with competing evidence.
- [x] Wire accept/reject/reason to review and interrupt-resume services.
- [x] Mark reviewed links stale when source identity changes.
- [x] Add accessible filters, loading, pagination, and error handling.

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

- Typed contracts and bounded Neo4j/Postgres read models live in `packages/contracts/src/knowledge.ts`, `packages/storage/src/knowledge-graph-repository.ts`, and `packages/storage/src/knowledge-summary-repository.ts`.
- `apps/web/lib/knowledge-service.ts` enforces operator/application ownership, current graph revisions, source-identity invalidation, auditable link decisions, and one-time owned interrupt resume. Current Postgres decisions override graph-projected review state only for the matching source identity.
- The authenticated, private/no-store HTTP surface is implemented in `apps/web/app/api/knowledge/[[...path]]/route.ts`; request bodies, page sizes, graph paths, and artifact excerpts are bounded. Source URIs are allowlisted and private excerpts are MIME-limited, range-read, redacted, and rendered as text.
- `/knowledge` and `/knowledge/[applicationId]` provide responsive requirement/workflow coverage, selected cross-layer provenance paths, stale/partial/error states, cursor pagination, and review actions without fetching or rendering an unlimited graph.
- Focused verification passed for 22 contract/storage tests and 11 API/component tests, package type checks for `@sentinel/contracts`, `@sentinel/storage`, and `@sentinel/web`, and scoped ESLint/Prettier checks.
- `pnpm exec playwright test tests/browser/knowledge.spec.ts --project=chromium` passed the evidence-path, private excerpt, interrupt-resume/idempotency, keyboard, secret-canary, and desktop/mobile overflow flow. No acceptance item is deferred.
