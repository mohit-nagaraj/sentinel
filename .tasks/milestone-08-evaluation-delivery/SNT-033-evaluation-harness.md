# SNT-033 — Golden dataset and stage/trajectory evaluation harness

| Field | Value |
|---|---|
| Milestone | M8 — Evaluation, hardening, and assignment delivery |
| Status | `not-started` |
| Depends on | SNT-015, SNT-016, SNT-017, SNT-019, SNT-028 |
| Blocks | Security/resilience hardening and final delivery |
| PRD references | §21, assignment Design Document item 8 |

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

- [ ] Select and document the real PR fixture and expected scope.
- [ ] Build sanitized source/browser/graph fixtures and human labels.
- [ ] Add expected retrieval/tool trajectories with acceptable-order flexibility.
- [ ] Implement stage metric calculators: precision/recall, false acceptance, citation correctness, path completeness, unknown visibility, budget adherence.
- [ ] Implement whole-graph/node/partial/checkpoint eval execution.
- [ ] Implement repeated model mission runner with seed/config/model/template tracking.
- [ ] Compare evidence facts independently from prose variance.
- [ ] Add unsafe-tool/prompt-injection/abstention cases.
- [ ] Add report human rubric and scoring worksheet.
- [ ] Generate concise eval report with distributions and known sample limitations.

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

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
