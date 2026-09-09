# SNT-028 — Blast-radius traversal, scoring, and unknown handling

| Field          | Value                                       |
| -------------- | ------------------------------------------- |
| Milestone      | M6 — Pull-request blast-radius product loop |
| Status         | `done`                                      |
| Depends on     | SNT-021, SNT-027                            |
| Blocks         | Report delivery and verification planning   |
| PRD references | §13.14, §17, FR-013                         |

## Background

Blast radius must be explainable and reproducible. Neo4j traversal finds candidate paths; deterministic policy combines path evidence, change type, selected-scope criticality, and spread. Risk and evidence strength remain separate.

## Scope

- Allowlisted bounded traversals from changed code/file/endpoint/domain seeds toward frontend/UI/workflow/requirement.
- Direction/type/depth/current-revision/evidence-tier constraints.
- Candidate path normalization, cycle prevention, duplicate collapse, and provenance retention.
- Deterministic impact aggregation by UI element/screen/workflow/requirement.
- High/Medium/Low/Unknown risk policy with reason factors.
- Separate A–D evidence strength.
- Unknown/unmapped/stale/conflict handling.
- QA scenario recommendations derived from affected workflow steps/acceptance criteria as structured facts; prose comes later.

## Implementation tasks

- [x] Define permitted path patterns and maximum depth/result limits.
- [x] Implement parameterized Cypher queries through SNT-021 repository.
- [x] Normalize/collapse equivalent paths while preserving corroboration.
- [x] Define versioned deterministic risk policy and factor trace.
- [x] Compute evidence strength separately from consequence/risk.
- [x] Aggregate affected entities and rank findings.
- [x] Create Unknown findings for unmapped relevant changes.
- [x] Reject Tier-D/conflicted/stale paths from confident impact while preserving them as caveats.
- [x] Derive structured recommended checkpoints/scenarios.
- [x] Add score-policy version to assessment output.

## Acceptance criteria

- Every non-Unknown finding has at least one full inspectable evidence path.
- Same graph revision/change set/policy version produces identical ranking.
- High impact cannot be mistaken for high evidence strength.
- Tier-D, stale, foreign-app, and invalid-direction paths cannot support confident findings.
- Shared service/domain changes can fan out to multiple UI/workflow/requirement findings within limits.
- Unmapped changes remain prominently Unknown rather than disappearing.
- Risk factors and path provenance are sufficient to explain each rank to engineers.

## Required tests

- Golden graph fixtures for direct, indirect, shared fan-out, duplicate, cyclic, stale, conflicting, and unknown cases.
- Risk/evidence separation matrix.
- Deterministic ranking/tie/order tests.
- Traversal depth/type/application/revision isolation tests.
- Tier-D denial and corroboration tests.
- Structured QA recommendation tests.

## Out of scope

Agent mission execution, final natural-language report, UI display, statistical probability calibration, and Graph Data Science dependency.

## Implementation notes

- `packages/contracts/src/blast-radius.ts` defines policy version
  `blast-radius-policy-v1`, bounded candidate and normalized evidence paths,
  application/revision-aware nodes and relationships, provenance, caveats,
  separate risk/evidence labels, factor traces, structured QA scenarios,
  findings, criticality input, and cross-reference-validated results.
- `packages/contracts/src/graph-publication.ts` owns the shared fixed
  blast-radius relationship allowlist and the bounded typed Neo4j query contract
  for code/file/endpoint/domain seeds.
- `packages/storage/src/neo4j/query-repository.ts` uses parameterized,
  application/revision/tier/depth/result-constrained `allShortestPaths` queries,
  a fixed target-kind set, pre-bound endpoints, fixed relationship types, node
  cycle exclusion, and deterministic path ordering.
- `packages/orchestration/src/blast-radius.ts` validates relationship direction
  and product-layer steps, rejects Tier-D/stale/conflicted/foreign/review-pending
  candidates from confident impact, retains named caveats, collapses semantic
  duplicate paths with corroborating evidence and provenance, and aggregates
  deterministic UI/screen/workflow/requirement findings.
- Risk is a versioned deterministic sum of change severity, selected-scope
  criticality, path directness, affected spread, shared fan-out, and independent
  corroboration. Evidence strength remains a separate A-D dimension; high-risk
  Tier-C and low-risk Tier-A cases are both covered.
- Query and SNT-027 adapters aggregate all changed symbols and exact operations
  per path rather than multiplying candidate cardinality. Valid SNT-027 maximums
  remain inside SNT-028 bounds; normalized paths, findings, caveats, evidence,
  provenance, and QA scenarios have compatible aggregate caps.
- Focused verification on 2026-09-09: 27 tests passed across direct, indirect,
  shared fan-out, duplicate, cyclic, stale, conflicting, Tier-D, foreign-app,
  revision, unsupported/unknown, risk/evidence separation, deterministic order,
  aggregate stress, query constraints, adapter cardinality, provenance, and
  structured QA scenarios. Contracts, orchestration, and storage package
  typechecks passed; scoped ESLint, Prettier, and `git diff --check` passed.
- The ystack `/review` found unbounded path expansion, adapter candidate
  multiplication, normalized-path truncation, query/policy relationship drift,
  and caveat overflow. All were fixed and covered by focused regression tests.
  No acceptance item is deferred. Full CI remains pending GitHub Actions.
