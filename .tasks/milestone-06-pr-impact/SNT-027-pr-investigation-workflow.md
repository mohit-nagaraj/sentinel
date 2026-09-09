# SNT-027 — Agentic PR investigation workflow

| Field | Value |
|---|---|
| Milestone | M6 — Pull-request blast-radius product loop |
| Status | `ready` |
| Depends on | SNT-013, SNT-016, SNT-019, SNT-021, SNT-026 |
| Blocks | Blast-radius engine, verification planning |
| PRD references | §7.2, §13.13, §16, FR-012 |

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

- [ ] Define PR graph state and reducers for parallel symbol-group results.
- [ ] Implement baseline compatibility gate and action-required outcome.
- [ ] Group changes by structural/endpoints/domain relationships with limits.
- [ ] Dispatch `pr_change_investigation` Code missions using dynamic workers.
- [ ] Retrieve bounded current graph paths seeded by changed symbols/files/endpoints.
- [ ] Validate/merge assessment-specific evidence and unresolved boundaries.
- [ ] Invoke Curator in PR-impact mode for missing paths/conflicts.
- [ ] Create typed impact hypotheses and verification mission candidates.
- [ ] Check cancellation/current-head identity before expensive calls and finalization.
- [ ] Emit GitHub/UI-safe progress events.

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

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
