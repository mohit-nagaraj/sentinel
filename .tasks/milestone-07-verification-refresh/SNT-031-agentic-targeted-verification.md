# SNT-031 — Agentic targeted verification and deterministic verdicts

| Field | Value |
|---|---|
| Milestone | M7 — Dynamic verification and knowledge refresh |
| Status | `not-started` |
| Depends on | SNT-017, SNT-024, SNT-029, SNT-030 |
| Blocks | Security hardening and final delivery |
| PRD references | §7.2, §13.15, §16, FR-015 |

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

- [ ] Define verification graph state/results and artifact retention.
- [ ] Validate head identity immediately before browser execution.
- [ ] Implement trusted setup adapter seam and cleanup.
- [ ] Execute impacted missions with verification-specific tighter policy/budgets.
- [ ] Implement checkpoint assertion catalog (reachability, visible/enabled, transition, request/status, value, error absence).
- [ ] Distinguish `passed`, `failed`, `behavior_changed`, `blocked`, `not_run`, and `verification_unavailable`.
- [ ] Execute/control interpret one unaffected flow when feasible.
- [ ] Allow only named evidence-gap follow-up within total verification budget.
- [ ] Persist observed evidence and enrich report/check idempotently.
- [ ] Ensure passing evidence does not remove predicted impacted requirements.

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

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
