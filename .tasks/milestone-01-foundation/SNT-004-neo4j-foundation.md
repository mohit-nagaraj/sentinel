# SNT-004 — Neo4j constraints, repositories, and test isolation

| Field | Value |
|---|---|
| Milestone | M1 — Foundation and durable execution |
| Status | `not-started` |
| Depends on | SNT-001, SNT-002 |
| Blocks | Evidence linking, publication, blast-radius queries |
| PRD references | §9, §11.1, §12, §13.12 |

## Background

Neo4j Aura stores the active product-knowledge graph, not run orchestration. This issue creates safe connection management, schema constraints, parameterized repositories, and isolated test cleanup before feature-specific writes are added.

## Scope

- Server-only Neo4j driver lifecycle and health checks.
- Database selection and connection timeout/retry configuration.
- Constraints/indexes for application namespace and stable entity keys.
- Generic parameterized node/relationship fact repositories sufficient for later publication.
- Graph revision/pending namespace support needed for atomic activation.
- Transaction metadata containing run/application identifiers.
- Test namespace strategy and cleanup that cannot erase unrelated Aura data.
- Query result mapping that handles Neo4j integers and optional properties safely.

## Implementation tasks

- [ ] Define environment schema without logging credentials.
- [ ] Implement singleton/pool lifecycle and graceful shutdown.
- [ ] Add idempotent schema bootstrap for required labels/stable-key constraints.
- [ ] Implement parameter-bound read/write transaction helpers.
- [ ] Reject dynamic labels/relationship types unless selected from internal allowlists.
- [ ] Add application/test namespace factories.
- [ ] Add health diagnostics safe for UI/operator output.
- [ ] Add cleanup by explicit test application ID only.
- [ ] Add representative node/relationship round-trip fixture.

## Acceptance criteria

- Driver connects to configured Aura and reports a redacted health result.
- Bootstrap is idempotent.
- Duplicate stable facts merge instead of multiplying.
- Untrusted strings never become raw Cypher labels/types/query fragments.
- A failed multi-write transaction leaves no partial fixture.
- Test cleanup cannot match nodes outside the generated test application namespace.
- Neo4j credentials never enter client bundles, logs, snapshots, or thrown public errors.

## Required tests

- Unit tests for allowed label/type mapping and integer/result conversion.
- Integration tests for constraints, idempotent merge, rollback, and parameter injection resistance.
- Isolation test with two application namespaces proving cleanup affects one only.
- Health failure test with sanitized errors.

## Out of scope

Full schema publication, Curator output, blast-radius traversal, production data loading, and graph visualization.

## Implementation notes

The configured Aura instance is shared infrastructure. Integration tests must require an explicit opt-in and generated test application prefix; never use unrestricted `MATCH (n) DETACH DELETE n`.