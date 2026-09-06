# SNT-018 — Evidence validation, tiers, and candidate linking

| Field | Value |
|---|---|
| Milestone | M4 — Knowledge graph construction and reconciliation |
| Status | `not-started` |
| Depends on | SNT-004, SNT-015, SNT-016, SNT-017 |
| Blocks | Curator, coverage, publication |
| PRD references | §12.3–12.5, §13.11, FR-009 |

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

- [ ] Implement evidence resolver and source/version compatibility checks.
- [ ] Add allowlisted relationship schemas and required evidence by type.
- [ ] Implement exact normalization/matching in PRD trust order.
- [ ] Compute Tier A/B from deterministic/corroborated methods; never from model self-confidence.
- [ ] Generate bounded Tier-C/D semantic candidates from normalized capability terms.
- [ ] Use structured model adjudication to select/reject/abstain among supplied candidates only.
- [ ] Merge duplicate supporting paths while retaining provenance.
- [ ] Detect contradictory claims and prevent silent overwrite.
- [ ] Produce pending fact/review-candidate batch with deterministic IDs/order.

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
