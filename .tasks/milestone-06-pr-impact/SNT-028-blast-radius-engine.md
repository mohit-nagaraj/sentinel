# SNT-028 — Blast-radius traversal, scoring, and unknown handling

| Field | Value |
|---|---|
| Milestone | M6 — Pull-request blast-radius product loop |
| Status | `not-started` |
| Depends on | SNT-021, SNT-027 |
| Blocks | Report delivery and verification planning |
| PRD references | §13.14, §17, FR-013 |

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

- [ ] Define permitted path patterns and maximum depth/result limits.
- [ ] Implement parameterized Cypher queries through SNT-021 repository.
- [ ] Normalize/collapse equivalent paths while preserving corroboration.
- [ ] Define versioned deterministic risk policy and factor trace.
- [ ] Compute evidence strength separately from consequence/risk.
- [ ] Aggregate affected entities and rank findings.
- [ ] Create Unknown findings for unmapped relevant changes.
- [ ] Reject Tier-D/conflicted/stale paths from confident impact while preserving them as caveats.
- [ ] Derive structured recommended checkpoints/scenarios.
- [ ] Add score-policy version to assessment output.

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

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
