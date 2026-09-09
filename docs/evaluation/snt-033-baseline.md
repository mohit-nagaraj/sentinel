# Sentinel evaluation: hi-events-pr-1338-attribution

Run `snt-033-deterministic-baseline` evaluated dataset `2026-09-09.v1` with 100 repetition(s).

## Outcome

- Pass rate: 100.0% (400/400)
- Hard failures: 0
- Mode: `deterministic` using `sentinel/scripted-golden-fixture`
- Template: `eval-template-v1`
- Seed: `1338`

## Metric distributions

| Metric | Mean | P50 | P95 | Min-Max |
|---|---:|---:|---:|---:|
| fact_precision | 100.0% | 100.0% | 100.0% | 100.0%-100.0% |
| fact_recall | 100.0% | 100.0% | 100.0% | 100.0%-100.0% |
| fact_f1 | 100.0% | 100.0% | 100.0% | 100.0%-100.0% |
| evidence_fact_accuracy | 100.0% | 100.0% | 100.0% | 100.0%-100.0% |
| link_precision | 100.0% | 100.0% | 100.0% | 100.0%-100.0% |
| link_recall | 100.0% | 100.0% | 100.0% | 100.0%-100.0% |
| false_acceptance_rate (lower is better) | 0.0% | 0.0% | 0.0% | 0.0%-0.0% |
| citation_correctness | 100.0% | 100.0% | 100.0% | 100.0%-100.0% |
| unsupported_claim_rate (lower is better) | 0.0% | 0.0% | 0.0% | 0.0%-0.0% |
| path_completeness | 100.0% | 100.0% | 100.0% | 100.0%-100.0% |
| unknown_visibility | 100.0% | 100.0% | 100.0% | 100.0%-100.0% |
| impacted_recall | 100.0% | 100.0% | 100.0% | 100.0%-100.0% |
| impact_precision | 100.0% | 100.0% | 100.0% | 100.0%-100.0% |
| control_false_positive_rate (lower is better) | 0.0% | 0.0% | 0.0% | 0.0%-0.0% |
| trajectory_required_recall | 100.0% | 100.0% | 100.0% | 100.0%-100.0% |
| trajectory_scope_adherence | 100.0% | 100.0% | 100.0% | 100.0%-100.0% |
| trajectory_evidence_correctness | 100.0% | 100.0% | 100.0% | 100.0%-100.0% |
| trajectory_efficiency | 100.0% | 100.0% | 100.0% | 100.0%-100.0% |
| terminal_correctness | 100.0% | 100.0% | 100.0% | 100.0%-100.0% |
| budget_adherence | 100.0% | 100.0% | 100.0% | 100.0%-100.0% |
| case_score | 100.0% | 100.0% | 100.0% | 100.0%-100.0% |
| normalized_stability | 100.0% | 100.0% | 100.0% | 100.0%-100.0% |

## Usage

- Model calls: 0
- Tokens: 0 input / 0 output
- Tool calls: 0
- Browser actions: 0
- Actual cost: not reported

## Known limitations

- This compact dataset is a human-reviewed assignment fixture, not a statistically representative benchmark.
- Held-out labels are separated from development cases by the harness but remain visible to repository maintainers, so contamination remains possible.
- Browser observations are sanitized structural equivalents; private screenshots, credentials, and raw traces are excluded.
- No paid model run is represented in the committed baseline report.
