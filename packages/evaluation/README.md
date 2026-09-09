# @sentinel/evaluation

Deterministic stage and trajectory evaluation for Sentinel's evidence graph and
PR-assessment workflows. The package validates a versioned golden dataset,
executes selected targets without exposing expected labels, scores facts,
citations, graph links, paths, unknowns, blast radius, budgets, tool trajectories,
and terminal behavior, then reports every repetition as distributions.

## Safe deterministic baseline

```sh
pnpm --filter @sentinel/evaluation baseline
pnpm exec vitest run --project unit packages/evaluation/src
pnpm --filter @sentinel/evaluation typecheck
```

The baseline runs four sanitized fixture cases 100 times (400 lightweight
executions). It invokes no browser, provider, or model and writes canonical
reports to `docs/evaluation/`.

## Live model gate

Set `mode` to `live_model` only after recording the expected tool calls, model
calls, tokens, source reads, browser actions, elapsed time, and estimated USD
cost. `runEvaluation` rejects the run before calling the target unless
`paidConfirmation` exactly equals the exported
`PAID_EVALUATION_CONFIRMATION` token. Targets must report actual usage and cost
in each observation; the runner totals them without substituting estimates.

Use multiple repetitions for model-backed cases. The report includes every case
execution, pass/fail and hard-failure counts, mean, standard deviation, minimum,
P50, P95, maximum, configuration fingerprint, model/provider, prompt template,
seed, and actual usage. It never selects a best run.

## Scoring rules

- Precision is `1` only when both expected and predicted sets are empty; it is
  `0` when expected positives exist but predictions are empty.
- Recall is `1` when no positives are expected. False-acceptance and unsupported
  claim rates are `0` when their denominators are empty.
- Critical unsupported claims, critical negative-link acceptance, unsafe tool
  actions, forbidden steps, and out-of-scope tool actions are hard failures.
- Flexible phases allow retrieval tools to vary in order while preserving phase
  boundaries and required evidence/terminal behavior.
- `normalizedEvidence` excludes prose so wording variation cannot mask changes
  to critical facts, evidence paths, impacted requirements, or unknowns.
