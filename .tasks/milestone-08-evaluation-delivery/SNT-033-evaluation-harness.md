# SNT-033 — Golden dataset and stage/trajectory evaluation harness

| Field          | Value                                               |
| -------------- | --------------------------------------------------- |
| Milestone      | M8 — Evaluation, hardening, and assignment delivery |
| Status         | `done`                                              |
| Depends on     | SNT-015, SNT-016, SNT-017, SNT-019, SNT-028         |
| Blocks         | Security/resilience hardening and final delivery    |
| PRD references | §21, assignment Design Document item 8              |

## Background

The assignment asks how correctness would be judged across 100 runs. Sentinel must evaluate deterministic facts, specialist trajectories, cross-layer links, blast radius, abstention, and report usefulness—not merely final prose.

## Scope

- Sanitized golden fixture set for selected Hi.Events vertical slice/PR.
- Expected documentation sections/requirements/citations.
- Expected TS/PHP/routes/endpoints and changed symbols.
- Expected browser states/transitions/requests/workflows.
- Positive/negative cross-layer links, conflicts, coverage gaps, impacted/non-impacted controls.
- Deterministic stage metrics and agent trajectory/evidence metrics.
- Repeated-run runner with model-cost confirmation/opt-in.
- Train/development evaluation fixtures versus held-out final fixture where feasible.
- Human rubric for QA-lead report usefulness.
- Machine-readable and Markdown summary.

## Implementation tasks

- [x] Select and document the real PR fixture and expected scope.
- [x] Build sanitized source/browser/graph fixtures and human labels.
- [x] Add expected retrieval/tool trajectories with acceptable-order flexibility.
- [x] Implement stage metric calculators: precision/recall, false acceptance, citation correctness, path completeness, unknown visibility, budget adherence.
- [x] Implement whole-graph/node/partial/checkpoint eval execution.
- [x] Implement repeated model mission runner with seed/config/model/template tracking.
- [x] Compare evidence facts independently from prose variance.
- [x] Add unsafe-tool/prompt-injection/abstention cases.
- [x] Add report human rubric and scoring worksheet.
- [x] Generate concise eval report with distributions and known sample limitations.

## Acceptance criteria

- Deterministic fixtures produce stable results across repeated runs.
- Specialist evals score tool scope, evidence correctness, unnecessary actions/reads, and terminal behavior—not hidden reasoning.
- Critical unsupported claims and unsafe tool actions count as hard failures.
- Blast-radius eval reports impacted recall and false positives/Unknown visibility.
- Repeated model results are reported as distributions; no best-run cherry-picking.
- Paid/live repeated runs require explicit opt-in and estimated/actual usage capture.
- The harness can explain how it scales to 100 runs without requiring 100 expensive full-system runs for submission.

## Required tests

- Unit tests for every metric and zero-denominator behavior.
- Golden pass/fail mutation tests proving metrics detect known regressions.
- Deterministic repeated-run stability test.
- Scripted varied-trajectory equivalence tests.
- Dataset leakage/split and fixture schema tests.
- Eval report snapshot.

## Out of scope

Large statistically representative calibration, external benchmark claims, model fine-tuning, and Langfuse dependency.

## Implementation notes

- `packages/evaluation` is the standalone deterministic evaluation package. Its
  strict schemas keep target inputs separate from labels, validate development
  and held-out split identities/content fingerprints, and model node, partial,
  checkpoint, and whole-graph execution.
- `metrics.ts` scores facts, normalized evidence facts, links, false acceptance,
  citations, unsupported claims, evidence paths, unknown visibility, impacted
  recall/precision, non-impacted controls, trajectories, terminal state, and all
  budget dimensions. Empty-set behavior is explicit and covered by tests.
- Critical unsupported claims, critical negative-link acceptance, unsafe tools,
  forbidden steps, and unauthorized scope are hard failures. Citation support
  and the normalized stability fingerprint are computed by the harness from
  structured output rather than trusted target assertions.
- `runner.ts` withholds expected labels from the target, supports 1-100 seeded
  repetitions, records model/provider/config/template metadata, reports full
  distributions, and rejects live-model execution before target invocation
  without estimated usage plus the exact paid-evaluation confirmation token.
  Actual usage/cost is aggregated separately from estimates.
- `packages/evaluation/fixtures/hi-events-pr-1338.golden.json` contains the
  sanitized human-reviewed Hi.Events attribution slice for upstream PR #1338 at
  base `2064f88ff7590e93c738efb8becaa7d732063619` and head
  `f68df0dabd18d04df5e6c7e873aac2b5e5201584`. It covers requirements, TS/React
  and PHP/Laravel symbols, endpoint/runtime/browser facts, positive and negative
  links, conflicts/unknowns, impacted and control flows, prompt injection,
  unsafe actions, abstention, and flexible tool order.
- `docs/evaluation/README.md` documents current primary-source evaluation
  guidance, the split/contamination boundary, and the layered path to 100 runs.
  `docs/evaluation/qa-report-rubric.md` provides the five-dimension human rubric,
  hard-failure gate, and scoring worksheet.
- `pnpm --filter @sentinel/evaluation baseline` generated canonical Markdown and
  machine-readable summaries in `docs/evaluation/`. The committed baseline is
  explicitly deterministic harness conformance: 400/400 lightweight executions,
  100% normalized stability, zero hard failures, and zero provider/model usage.
  It is not presented as live-model performance.
- Focused verification on 2026-09-09: 18 tests passed across schemas/leakage,
  every metric and empty denominator, golden/mutated outcomes, hard failures,
  varied trajectories, all execution scopes, 100-run stability, distribution
  reporting, paid-run gating/usage, and Markdown/JSON rendering. The evaluation
  package typecheck passed. Scoped ESLint, Prettier, and diff checks are run as
  the issue review gate; full CI remains pending GitHub Actions.
- The ystack `/review` found a post-execution metadata validation mismatch,
  shared mutable golden arrays, order-sensitive stability for set-like output,
  and dropped non-cost usage estimates. All four were fixed: configuration now
  uses the report identifier schema before execution, observations deep-clone
  labels, stability sorts only semantically unordered collections, and reports
  retain complete estimates separately from actual totals. Focused regressions
  cover every fix.
- No acceptance item is deferred. Paid/live runs remain intentionally opt-in and
  were not executed for the deterministic baseline.
