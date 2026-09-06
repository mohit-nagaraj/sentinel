# SNT-002 — Core domain contracts and stable identity

| Field | Value |
|---|---|
| Milestone | M1 — Foundation and durable execution |
| Status | `review` |
| Depends on | SNT-001 |
| Blocks | Most source, graph, agent, and run issues |
| PRD references | §11, §12, §14, §15, NFR-001/NFR-002/NFR-004/NFR-007/NFR-009 |

## Background

All modules must exchange typed facts rather than free-form data. Stable identifiers are essential for idempotent extraction, Neo4j merges, repeated-run evaluation, and PR-to-baseline comparison. This issue defines contracts, not implementations of crawlers or agents.

## Scope

Define versioned Zod schemas and inferred TypeScript types for:

- applications, sources, commits, runs, missions, budgets, and terminal statuses;
- `DiscoveryMission` and `MissionResult`;
- evidence references and agent claim proposals;
- document source/page/section facts;
- code file/symbol/reference/call/route/API/domain facts;
- browser screen/element/action/transition/request facts;
- coverage assessments, evidence links/tiers, PR changes, findings, and verification results;
- structured run events safe for persistence/UI;
- stable-key and content-hash utilities.

## Identity rules

- IDs are derived only from canonical, non-secret fields.
- IDs are application-namespaced where cross-application collision is possible.
- Source-derived identities include repository+commit or document-source content identity as appropriate.
- Runtime observation identity distinguishes stable semantic identity from one-run evidence identity.
- Hash input serialization is canonical and explicitly versioned.
- Schema versions permit detection/migration; consumers reject unknown incompatible versions.

## Implementation tasks

- [x] Define branded ID types and enums for run/mission/claim/evidence statuses.
- [x] Define canonical serialization and SHA-256 hashing utilities.
- [x] Specify stable keys for every Neo4j entity in PRD §12.
- [x] Specify ephemeral/evidence IDs for crawl states, transitions, artifacts, and events.
- [x] Add mission scope, success criteria, budgets, and allowed tool/mode contracts.
- [x] Add result contracts that force unresolved questions and stop reasons to be explicit.
- [x] Add claim schemas that require evidence references and never accept an agent-authored final tier.
- [x] Add parser/adapter fact envelopes with extractor version and provenance.
- [x] Add backward-compatible parsing helpers and useful validation errors.
- [x] Publish contract fixtures used by later issues.

## Acceptance criteria

- Every stage described in PRD §14 has a Zod-validated input/output envelope.
- Identical canonical inputs produce identical IDs/hashes across process runs and object-key ordering.
- Secrets, raw cookies, and credential values cannot fit any persisted run/event/mission schema.
- Agent claim schemas require evidence but contain no authoritative `accepted` flag or self-declared probability.
- Unsupported schema versions fail clearly rather than being silently coerced.
- Contracts can be imported by web and worker packages without environment side effects.

## Required tests

- Table-driven unit tests for stable IDs across document, code, endpoint, and browser fixtures.
- Property tests for canonical object ordering and hash stability.
- Schema positive/negative tests, including extra-property rejection at trust boundaries.
- Redaction/secret-field negative fixtures.
- Snapshot tests for representative versioned wire payloads.

## Out of scope

Database tables, graph writes, model calls, extraction logic, and business risk scoring.

## Implementation notes

Do not encode Hi.Events-specific expected entities in generic contracts. Hi.Events fixtures may exercise the schemas, but names/paths belong in fixtures rather than production defaults.

- Wire schema version: `1`; parsers reject other versions and extra properties.
- Identity hash: SHA-256 over recursively key-sorted canonical JSON with an explicit kind/version domain separator.
- Stable key inputs are defined for all 17 PRD §12 graph entity categories.
- Provider-independent hashing uses `@noble/hashes`; no Node environment or secret loading occurs on import.
- Sanitized wire fixtures cover every stage artifact in PRD §14 plus redacted run events.
- Focused verification on 2026-09-07: 3 files and 49 contract/identity tests passed; the cumulative default suite passed 52 tests.
