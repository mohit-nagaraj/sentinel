# SNT-021 — Atomic current-graph publication and evidence queries

| Field | Value |
|---|---|
| Milestone | M4 — Knowledge graph construction and reconciliation |
| Status | `not-started` |
| Depends on | SNT-004, SNT-018, SNT-019, SNT-020 |
| Blocks | Knowledge UI, PR investigation, blast radius, refresh |
| PRD references | §11.4, §12, §13.12, FR-010 |

## Background

Validated pending facts must become one coherent current graph. Failed/partial publication cannot replace current truth, and stale facts cannot remain reachable after refresh. Queries must return explainable evidence paths, not raw unconstrained Cypher.

## Scope

- Full node/relationship labels from PRD §12, including document provenance.
- Uniqueness/index bootstrap extensions.
- Pending graph revision staging scoped by application/run.
- Batched idempotent merge with provenance/evidence properties.
- Validation gates: counts, referential consistency, required evidence, complete cross-layer paths, no forbidden tiers.
- Atomic active revision switch and affected stale-fact removal/supersession.
- Parameterized query APIs for requirements, workflows, UI, code, coverage, selected evidence paths, and PR seeds.
- Compact denormalized summaries for Postgres/UI.

## Implementation tasks

- [ ] Map validated fact contracts to internal label/type allowlists.
- [ ] Implement bounded batch writes and transaction metadata.
- [ ] Stage pending revision without affecting active queries.
- [ ] Implement validation queries and publish/rollback transaction.
- [ ] Implement affected-scope replacement and orphan cleanup rules.
- [ ] Ensure immutable assessment-referenced evidence remains addressable according to retention contract.
- [ ] Add typed query repository returning evidence/provenance.
- [ ] Add traversal depth/type/tier/application/revision constraints.
- [ ] Produce publication summary and update Postgres active commit/revision only after success.

## Acceptance criteria

- At least one fixture publishes a complete document→requirement→workflow→UI→endpoint→code path plus coverage gap.
- Replaying the same fact batch creates no duplicates.
- Invalid/Tier-D/foreign-application facts cannot activate.
- A failed validation/write leaves previous active graph and Postgres active revision unchanged.
- Refresh replacement removes affected stale active paths while preserving unrelated current facts.
- Query APIs cannot cross application/revision boundaries or execute model-authored Cypher.
- Every returned path includes evidence tier and provenance references.

## Required tests

- End-to-end fixture publication and query tests.
- Idempotency and batch-boundary tests.
- Invalid publication rollback/failure-injection tests.
- Active revision switch/affected stale removal tests.
- Cross-tenant/revision leakage and traversal limit tests.
- Assessment evidence retention/reference test.

## Out of scope

Risk scoring, frontend visualization, automatic historical snapshot retention, and graph algorithms beyond bounded Cypher traversal.

## Implementation notes

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
