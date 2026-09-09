# SNT-018 — Evidence validation, tiers, and candidate linking

| Field          | Value                                                |
| -------------- | ---------------------------------------------------- |
| Milestone      | M4 — Knowledge graph construction and reconciliation |
| Status         | `done`                                               |
| Depends on     | SNT-004, SNT-015, SNT-016, SNT-017                   |
| Blocks         | Curator, coverage, publication                       |
| PRD references | §12.3–12.5, §13.11, FR-009                           |

## Background

Specialists propose claims; they are not trusted to write graph truth or assign final evidence strength. This issue validates provenance, creates deterministic exact links first, generates bounded ambiguous candidates, and assigns evidence tiers by policy.

## Scope

- Claim/evidence reference validation.
- Deterministic links: diff→symbol, method/path endpoint matches, route→handler, source call/reference, runtime transition/action/request.
- Candidate links: route/component/UI and requirement/capability/workflow semantic relationships.
- Evidence tier policy A–D and review state.
- Conflict, duplicate, stale, incompatible-commit, and unsupported-source handling.
- Bounded model adjudication only for small ambiguous candidate sets.
- Pending validated graph-fact batch; no activation yet.

## Implementation tasks

- [x] Implement evidence resolver and source/version compatibility checks.
- [x] Add allowlisted relationship schemas and required evidence by type.
- [x] Implement exact normalization/matching in PRD trust order.
- [x] Compute Tier A/B from deterministic/corroborated methods; never from model self-confidence.
- [x] Generate bounded Tier-C/D semantic candidates from normalized capability terms.
- [x] Use structured model adjudication to select/reject/abstain among supplied candidates only.
- [x] Merge duplicate supporting paths while retaining provenance.
- [x] Detect contradictory claims and prevent silent overwrite.
- [x] Produce pending fact/review-candidate batch with deterministic IDs/order.

## Acceptance criteria

- Invalid/missing evidence IDs, incompatible commits/runs, and unsupported relation types are rejected.
- Exact endpoint and AST relationships receive deterministic tiers.
- A model cannot create arbitrary subjects/objects/relationships outside candidate IDs.
- Tier D never enters confident blast-radius paths.
- Multiple evidence sources strengthen a link without losing individual provenance.
- Conflicts remain explicit and route to review/reconciliation.
- Reprocessing the same claims is idempotent.

## Required tests

- Positive/negative evidence requirement matrix per relationship type.
- Exact route/API/source/runtime linking tests.
- Candidate adjudication choice/reject/abstain fixtures.
- Prompt/model attempt to introduce unknown IDs/edges test.
- Duplicate/corroboration/conflict/stale-version tests.
- Tier policy golden tests and deterministic ordering.

## Out of scope

Curator mission planning, absence assessment, graph activation, risk scoring, and UI review.

## Implementation notes

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._

- `packages/contracts/src/evidence-linking.ts` defines strict evidence records, endpoint bindings, exact observations, semantic candidates, adjudication, conflicts, rejections, and pending-batch contracts.
- `packages/orchestration/src/evidence-linker.ts` implements compatibility validation, relation-specific evidence policy, PRD-ordered exact matching, unique-specificity routing, deterministic tiering, duplicate merge, conflict withholding, bounded semantic candidate generation, and fail-closed model adjudication.
- `packages/contracts/src/evidence-linking.test.ts` and `packages/orchestration/src/evidence-linker.test.ts` cover strict boundaries, the positive/negative relationship matrix, exact diff/API/source/runtime/route links, choice/reject/abstain, arbitrary model IDs/fields, duplicate provenance, contradictions, stale run/commit/source rejection, Tier A-D policy, ordering, and repeat idempotency.
- Submitted authoritative claims require every cited evidence record to bind the exact relationship endpoints. Deterministic exact observations provide their own typed endpoint binding.
- Frontend route facts must use a compatible commit; route/component observations must use the same commit. Literal route matches outrank parameterized patterns, and equally specific matches remain unresolved.
- Tier C/D candidates always remain `reviewState: pending` and `confidentPathEligible: false`, including candidates selected by the model.
- Focused verification: `pnpm exec vitest run --project unit packages/contracts/src/evidence-linking.test.ts packages/orchestration/src/evidence-linker.test.ts` (40 passed); `pnpm --filter @sentinel/contracts typecheck`; `pnpm --filter @sentinel/orchestration typecheck`; scoped ESLint and Prettier checks.
- The requested simple `/review` found three functional defects (unbound submitted evidence, stale route commits, and ambiguous exact matches); all were fixed and covered by regression tests. No acceptance item is deferred.
