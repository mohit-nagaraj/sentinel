# SNT-032 — Incremental post-deployment knowledge refresh

| Field | Value |
|---|---|
| Milestone | M7 — Dynamic verification and knowledge refresh |
| Status | `not-started` |
| Depends on | SNT-008, SNT-013, SNT-017, SNT-019, SNT-021, SNT-027, SNT-030 |
| Blocks | Security hardening and final delivery |
| PRD references | §7.3–7.4, §11.4, FR-018 |

## Background

After merge/deployment, active knowledge must advance to the new commit without rebuilding everything by default or leaving stale facts in current traversal. Failed refreshes cannot partially replace current truth.

## Scope

- Compile `refreshKnowledgeGraph`.
- Validate deployed commit identity and relationship to active baseline.
- Determine affected code/document/workflow graph scope from merged changes and current paths.
- Update deterministic source maps for changed content.
- Dispatch scoped Documentation/Code/Application missions only where relevant or stale.
- Curator reconciliation and coverage reassessment.
- Pending revision validation and atomic active switch.
- Stale-fact/orphan cleanup and artifact retention rules.
- Update indexed commit/freshness only after success.

## Implementation tasks

- [ ] Define change-to-refresh-scope planner.
- [ ] Reindex affected TS/PHP/OpenAPI/document sources.
- [ ] Select affected/stale workflows for re-exploration or replay.
- [ ] Dispatch specialist missions with prior evidence references and refresh budgets.
- [ ] Invalidate reviewed/inferred links whose source identities changed.
- [ ] Recompute coverage assessments for affected requirements.
- [ ] Stage, validate, and atomically publish pending revision.
- [ ] Remove/supersede affected stale current facts and safe orphans.
- [ ] Preserve immutable assessment references/artifacts under retention contract.
- [ ] Emit refresh summary, warnings, and freshness status.

## Acceptance criteria

- Unchanged facts retain stable identities and are not unnecessarily reprocessed.
- Changed/removal facts and dependent links are refreshed or explicitly unresolved.
- Relevant stale facts cannot remain in active query paths after successful switch.
- Failed/cancelled refresh leaves old active graph and indexed commit untouched.
- Reviewed semantic links are reused only when source compatibility remains valid.
- Immutable historical assessment evidence remains addressable where retained.
- Product shows current commit/update time, not user-facing snapshot directory versions.

## Required tests

- Incremental add/modify/delete fixture across docs, TS/PHP, endpoint, and workflow facts.
- Unchanged-scope reuse/no-unnecessary-agent-call tests.
- Reviewed-link invalidation tests.
- Failed publication/cancellation rollback tests.
- Stale active path removal and unrelated fact preservation tests.
- Assessment reference/artifact retention tests.
- Deployment mismatch denial test.

## Out of scope

Scheduled continuous crawling, multi-commit history browser, duplicate full graph snapshots, and second-language target.

## Implementation notes

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
