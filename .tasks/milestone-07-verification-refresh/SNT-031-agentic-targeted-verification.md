# SNT-031 — Agentic targeted verification and deterministic verdicts

| Field          | Value                                           |
| -------------- | ----------------------------------------------- |
| Milestone      | M7 — Dynamic verification and knowledge refresh |
| Status         | `done`                                          |
| Depends on     | SNT-017, SNT-024, SNT-029, SNT-030              |
| Blocks         | Security hardening and final delivery           |
| PRD references | §7.2, §13.15, §16, FR-015                       |

## Background

Dynamic verification enriches predicted blast radius. The Application Explorer may adapt to changed UI and request bounded follow-up missions, but deterministic checkpoints—not the model—produce pass/fail/change/blocked verdicts.

## Scope

- Compile `verifyPullRequestGraph`.
- Consume trusted deployment and verification plan.
- Prepare prerequisite data through trusted fixture/API when outside impact.
- Use UI setup when setup behavior is impacted.
- Execute affected Application Explorer missions and one control flow where feasible.
- Capture UI/state/network/console/screenshot evidence.
- Evaluate deterministic requirement checkpoints.
- Compare base/head observations when both exist.
- Curator gap analysis and limited additional mission round.
- Append/version report observations without erasing predicted risk.

## Implementation tasks

- [x] Define verification graph state/results and artifact retention.
- [x] Validate head identity immediately before browser execution.
- [x] Implement trusted setup adapter seam and cleanup.
- [x] Execute impacted missions with verification-specific tighter policy/budgets.
- [x] Implement checkpoint assertion catalog (reachability, visible/enabled, transition, request/status, value, error absence).
- [x] Distinguish `passed`, `failed`, `behavior_changed`, `blocked`, `not_run`, and `verification_unavailable`.
- [x] Execute/control interpret one unaffected flow when feasible.
- [x] Allow only named evidence-gap follow-up within total verification budget.
- [x] Persist observed evidence and enrich report/check idempotently.
- [x] Ensure passing evidence does not remove predicted impacted requirements.

## Acceptance criteria

- Verification runs only against expected trusted head.
- Agent adapts within opaque safe action space when labels/layout change.
- Deterministic assertions generate verdict and evidence; model explanation cannot override it.
- Outside-impact setup failures are categorized separately from product regression.
- Control failure can mark environment instability and prevent false PR blame.
- Prediction and observation remain separate report sections.
- One passed scenario does not claim global safety or remove blast-radius findings.
- Failures retain useful screenshot/trace/network evidence privately.

## Required tests

- Fixture baseline/head pairs: pass, real regression, label-only preserved behavior, API error, setup failure, control failure, blocked action.
- Agent adaptation and bounded follow-up tests.
- Deterministic verdict precedence tests.
- Head identity race/cancellation tests.
- Report/check enrichment idempotency tests.
- Browser cleanup and artifact retention tests.
- Opt-in real Hi.Events head verification demo.

## Out of scope

Auto-healing generated tests, changing expected outcomes, broad visual regression, real payments, and declaring PR safety.

## Implementation notes

- `packages/contracts/src/targeted-verification.ts` defines compact graph input,
  deterministic observations/assertions, mission and aggregate verdicts, artifact
  decisions, and private publication identities. Checkpoints retain only IDs,
  bounded counters, mission receipts, and terminal state.
- `packages/orchestration/src/targeted-verification.ts` compiles the durable graph.
  It checks current assessment ownership at every side-effect boundary, validates
  provider identity before setup and again immediately before each head browser
  run, applies one total budget, executes an optional control and one named gap
  follow-up, cleans setup in `finally`, and publishes idempotently.
- `verification-evaluator.ts`, `verification-executor.ts`, and
  `verification-publication.ts` keep model explanations non-authoritative,
  evaluate reachability/control/transition/request/value/error checkpoints,
  compare baseline and head evidence, retry browser cleanup, project observations
  into SNT-029 report results, and preserve predicted findings.
- `packages/storage/src/targeted-verification-store.ts`, private artifact retention,
  and `20260909000300_targeted_verification.sql` persist rich evidence outside
  LangGraph state and append contiguous report enrichment versions under an
  assessment/head/idempotency compare-and-set.
- The opt-in Hi.Events/Render live test requires both the repository-wide live
  gate and explicit trusted deployment credentials. It remained skipped locally
  because no trusted PR-head registration was supplied; no live result is claimed.
- The ystack review found a production SQL parameter mismatch, loss of the
  planner's `verification_unavailable` verdict, and a cached retry that skipped a
  failed browser close. The assessment UUID binding, planner precedence, and
  idempotent cleanup retry are corrected with focused regressions.
- Focused verification covers 13 contract/planning/evaluator/executor/graph/store/
  artifact/report files plus contracts, orchestration, storage, and docs
  typechecks, scoped lint/format/whitespace checks, and the gated live-test path.
  Complete CI remains pending GitHub Actions.
