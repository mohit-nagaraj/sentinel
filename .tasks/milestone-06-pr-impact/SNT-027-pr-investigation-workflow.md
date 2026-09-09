# SNT-027 — Agentic PR investigation workflow

| Field          | Value                                       |
| -------------- | ------------------------------------------- |
| Milestone      | M6 — Pull-request blast-radius product loop |
| Status         | `done`                                      |
| Depends on     | SNT-013, SNT-016, SNT-019, SNT-021, SNT-026 |
| Blocks         | Blast-radius engine, verification planning  |
| PRD references | §7.2, §13.13, §16, FR-012                   |

## Background

Static diff mapping is the seed, not the conclusion. The PR workflow must run the Code Explorer in change-investigation mode, combine new claims with current Neo4j paths, and let the Curator identify unknown product mappings and targeted validation missions.

## Scope

- Compile `assessPullRequestGraph` root workflow.
- Validate repository, app, graph baseline, base/head ancestry, and current-head ownership.
- Map diff via SNT-013.
- Dispatch bounded Code Explorer missions per related changed-symbol group, not blindly per file.
- Query current Neo4j candidate paths and known workflows/requirements.
- Validate new claims as assessment overlay; do not mutate baseline truth.
- Build PR impact coverage matrix and Curator follow-ups.
- Generate candidate Application validation missions only when trusted head deployment is available later.
- Preserve unknown/unmapped changes.
- Publish typed investigation result for scoring/reporting.

## Implementation tasks

- [x] Define PR graph state and reducers for parallel symbol-group results.
- [x] Implement baseline compatibility gate and action-required outcome.
- [x] Group changes by structural/endpoints/domain relationships with limits.
- [x] Dispatch `pr_change_investigation` Code missions using dynamic workers.
- [x] Retrieve bounded current graph paths seeded by changed symbols/files/endpoints.
- [x] Validate/merge assessment-specific evidence and unresolved boundaries.
- [x] Invoke Curator in PR-impact mode for missing paths/conflicts.
- [x] Create typed impact hypotheses and verification mission candidates.
- [x] Check cancellation/current-head identity before expensive calls and finalization.
- [x] Emit GitHub/UI-safe progress events.

## Acceptance criteria

- A supported PR runs deterministic diff mapping and agent investigation beyond the edited file.
- Related changes are investigated coherently without unbounded agent fan-out.
- Assessment evidence cannot overwrite the active baseline graph.
- Changed symbols with no product path remain visible as `unknown`.
- Baseline mismatch stops or degrades according to documented rules.
- Curator follow-ups are bounded and tied to named evidence gaps.
- A superseded/cancelled head cannot publish final current results.
- Output is deterministic in identity/order given equivalent validated claims, even if nonessential exploration order differs.

## Required tests

- Whole graph golden PR fixture.
- Parallel changed-symbol grouping/reducer tests.
- Baseline exact/safe-ancestor/stale/unrelated matrix.
- Unknown unsupported/config change retention tests.
- Curator follow-up/no-progress/budget tests.
- Cancellation/superseded-head race test.
- Checkpoint/resume after Code Explorer result test.

## Out of scope

Final risk score, report prose, running browser verification, and updating baseline graph.

## Implementation notes

- `packages/contracts/src/pr-investigation.ts` defines bounded change groups,
  per-symbol unknowns, baseline action outcomes, assessment-only overlays,
  validated/rejected/conflicted claim references, worker receipts, impact
  hypotheses, trusted-head verification candidates, and immutable final results.
- `packages/orchestration/src/pr-investigation-grouping.ts` deterministically
  groups changed symbols through same-file, structural-parent, shared-endpoint,
  and shared-domain relationships. Group/symbol caps retain overflow and
  unsupported/configuration/schema changes as explicit unknowns.
- `packages/orchestration/src/pr-investigation.ts` compiles
  `assess_pull_request` with reducer-backed LangGraph `Send` workers, durable
  external result references, exact/safe-ancestor/stale/unrelated baseline
  policy, repeated current-head/current-graph ownership gates, active-revision
  graph queries, assessment-only validation, bounded PR-impact Curator work,
  trusted-head mission candidates, idempotent progress events, and atomic
  current-result publication. `createPrInvestigationCompiledRunGraph` adapts it
  to the worker `assess_pr` registry contract.
- `packages/orchestration/src/pr-investigation-support.ts` provides canonical
  content-addressed worker results, bounded aggregate claim selection,
  deterministic baseline/file/symbol/endpoint/domain seed construction,
  per-symbol missing-path retention, overlay construction, hypotheses, and
  candidate verification missions. Code missions receive explicit changed
  symbol IDs while using configured application roots so callers, callees,
  handlers, and tests outside edited files remain investigable.
- `packages/storage/src/neo4j/query-repository.ts` adds a typed, parameterized
  PR-impact query over at most 500 code-file, code-symbol, endpoint, and domain
  seeds. It remains application/revision/tier/depth/result constrained and uses
  deterministic ordering across all tied shortest paths.
- Focused verification on 2026-09-09: 30 tests passed across PR contracts,
  grouping/reducers, whole-graph golden execution, baseline matrix, unknown
  retention, Curator no-progress/budget/reconciled evidence, cancellation and
  graph-supersession races, checkpoint resume, run-dispatch adaptation, and
  Neo4j query constraints. Contracts, orchestration, and storage package
  typechecks passed; scoped ESLint, Prettier, and `git diff --check` passed.
- The ystack `/review` found worker-scope, mixed-group unknown, post-Curator
  output, graph-revision race, path-tie determinism, aggregate-bound,
  worker-result canonicalization, and committed-event retry issues. All were
  fixed and covered by focused regression tests. No acceptance item is deferred.
- Full CI remains pending GitHub Actions and is the complete non-live gate.
