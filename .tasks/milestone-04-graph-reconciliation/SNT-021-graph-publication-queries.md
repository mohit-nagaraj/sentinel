# SNT-021 — Atomic current-graph publication and evidence queries

| Field          | Value                                                 |
| -------------- | ----------------------------------------------------- |
| Milestone      | M4 — Knowledge graph construction and reconciliation  |
| Status         | `done`                                                |
| Depends on     | SNT-004, SNT-018, SNT-019, SNT-020                    |
| Blocks         | Knowledge UI, PR investigation, blast radius, refresh |
| PRD references | §11.4, §12, §13.12, FR-010                            |

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

- [x] Map validated fact contracts to internal label/type allowlists.
- [x] Implement bounded batch writes and transaction metadata.
- [x] Stage pending revision without affecting active queries.
- [x] Implement validation queries and publish/rollback transaction.
- [x] Implement affected-scope replacement and orphan cleanup rules.
- [x] Ensure immutable assessment-referenced evidence remains addressable according to retention contract.
- [x] Add typed query repository returning evidence/provenance.
- [x] Add traversal depth/type/tier/application/revision constraints.
- [x] Produce publication summary and update Postgres active commit/revision only after success.

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

- `packages/contracts/src/graph-publication.ts` defines the strict 17-node publication union over existing validated fact contracts, accepted evidence-link input, full/affected replacement scopes, deterministic ordering, revision CAS fields, bounded traversal inputs, evidence-path projections, and exhaustive compact publication summaries.
- `packages/storage/src/neo4j/schema.ts` replaces the legacy mutable stable-key constraints with revision-scoped node/relationship identities and adds application/revision lookup indexes. The existing direct fact repository now writes and reads revision-scoped copies while retaining stale-write rejection.
- `packages/storage/src/neo4j/publication-repository.ts` stages nodes and links in bounded, idempotent batches tagged by a canonical publication hash. Affected refreshes copy unchanged nodes and links into the pending revision before replacements are applied.
- Publication validation runs before the activation callback and requires one application root, accepted non-Tier-D evidence on every link, same-application/same-revision endpoints, and a complete document -> requirement -> workflow -> UI -> endpoint -> code path with a coverage assessment. Validation/write/activation rejection removes only the pending revision and leaves the prior Postgres-selected revision reachable.
- Postgres remains the authoritative atomic current-revision pointer. `RunRepository.activateKnowledgePublication` advances it only after graph validation and explicitly distinguishes `activated`, `already_active`, and `rejected`; indeterminate activation errors preserve validated staging for safe confirmation/retry rather than risking deletion after an ambiguous commit.
- Successful finalization marks the selected revision current, carries unrelated facts forward for affected refreshes, removes superseded prior facts, and retains old relationships plus endpoint nodes when their relationship ID or evidence references are protected by an immutable assessment retention set.
- `packages/storage/src/neo4j/query-repository.ts` exposes fixed typed requirement, workflow, UI, code, coverage, selected-evidence-path, and PR-seed queries. All tenant, revision, endpoint, relationship, tier, depth, and limit values are validated/bound; traversal is hard-capped at 12 hops and Tier D/pending/rejected links cannot enter returned paths.
- `supabase/migrations/20260909000100_graph_publication_summaries.sql` and `KnowledgePublicationRepository` store and owner-scope one compact UI summary per activated application revision. Conflicting replays fail closed; identical activated summaries are idempotent.
- Focused verification: 80 relevant Vitest unit tests passed across graph and knowledge-UI contracts, publication, queries, revision-aware facts/schema, run activation, Postgres summaries, and migrations; `@sentinel/contracts` and `@sentinel/storage` package typechecks passed; scoped ESLint, Prettier, and `git diff --check` passed.
- The ystack `/review` found one compile-blocking branded-ID comparison in the evidence-binding guard. Endpoint comparison now uses normalized string identities, the package typechecks pass, and a regression test rejects evidence that is not bound to the published relationship.
- The opt-in `tests/graph/publication.integration.test.ts` covers real Neo4j publication/query, replay, invalid-refresh rollback, affected-scope carry-forward, and assessment evidence retention. It compiled and was discovered successfully but remained skipped locally because Neo4j credentials and `SENTINEL_NEO4J_TEST_PREFIX` were not configured. Full CI remains pending GitHub Actions.
- Rebase integration with merged SNT-025 populates the denormalized coverage/evidence properties consumed by `KnowledgeGraphQueryRepository`, accepts the evidence linker's corroborated extraction-method format, and exercises both the typed SNT-021 queries and SNT-025 knowledge UI queries in the opt-in Neo4j scenario.
