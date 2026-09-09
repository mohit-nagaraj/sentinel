# SNT-032 — Incremental post-deployment knowledge refresh

| Field          | Value                                                         |
| -------------- | ------------------------------------------------------------- |
| Milestone      | M7 — Dynamic verification and knowledge refresh               |
| Status         | `done`                                                        |
| Depends on     | SNT-008, SNT-013, SNT-017, SNT-019, SNT-021, SNT-027, SNT-030 |
| Blocks         | Security hardening and final delivery                         |
| PRD references | §7.3–7.4, §11.4, FR-018                                       |

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

- [x] Define change-to-refresh-scope planner.
- [x] Reindex affected TS/PHP/OpenAPI/document sources.
- [x] Select affected/stale workflows for re-exploration or replay.
- [x] Dispatch specialist missions with prior evidence references and refresh budgets.
- [x] Invalidate reviewed/inferred links whose source identities changed.
- [x] Recompute coverage assessments for affected requirements.
- [x] Stage, validate, and atomically publish pending revision.
- [x] Remove/supersede affected stale current facts and safe orphans.
- [x] Preserve immutable assessment references/artifacts under retention contract.
- [x] Emit refresh summary, warnings, and freshness status.

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

- Added strict refresh boundary contracts in
  `packages/contracts/src/knowledge-refresh.ts`, including commit/change,
  inventory, scope, source-map, specialist, retention, reconciliation, and
  summary receipts.
- Added deterministic scope planning in
  `packages/orchestration/src/knowledge-refresh-planning.ts`. It classifies
  documentation, TypeScript/TSX, PHP, OpenAPI, configuration, rename, and
  removal changes; propagates affected dependencies; reassesses requirements
  covered by affected workflows; invalidates incompatible reviewed links; and
  emits bounded specialist missions with prior evidence.
- Compiled `refreshKnowledgeGraph` in
  `packages/orchestration/src/knowledge-refresh.ts` with checkpointed context
  validation, commit comparison, inventory loading, scoped source reindexing,
  parallel specialist dispatch, Curator reconciliation, immutable artifact
  retention, and terminal atomic publication. Rich payloads remain in a
  content-addressed durable store while checkpoints contain receipt IDs only.
- Reused the affected-revision Neo4j publication path for pending validation,
  compare-and-set activation, unchanged-fact copying, stale/orphan cleanup,
  historical evidence retention, and rollback. Indexed commit and freshness
  advance only with the matching successful publication.
- Added `post_deployment_refresh` validation using the baseline deployment role
  and a default validator that requires an exact trusted target deployment, the
  current graph revision/commit, and descendant commit ancestry.
- Focused verification: 50 refresh/deployment/runtime/publication tests passed;
  package type checks passed for contracts, adapters, orchestration, and
  storage; changed-file ESLint, Prettier, and `git diff --check` passed.
- `/review` identified two HIGH issues. Both were fixed: requirements covered by
  code-affected workflows are now reassessed, and the compiled adapter no longer
  checks an already-terminalized lease after successful atomic activation.
- No acceptance items were deferred. Full CI remains owned by GitHub Actions.
