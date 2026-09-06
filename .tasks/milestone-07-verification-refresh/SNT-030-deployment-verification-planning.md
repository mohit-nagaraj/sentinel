# SNT-030 — Trusted deployment identity and verification planning

| Field | Value |
|---|---|
| Milestone | M7 — Dynamic verification and knowledge refresh |
| Status | `blocked` |
| Depends on | SNT-022, SNT-027, SNT-028 |
| External blocker | Public baseline/PR-head sandbox or preview approach |
| Blocks | Agentic verification and deployed refresh |
| PRD references | §6.4, §7.2–7.3, §13.15, open question 1 |

## Background

Sentinel cannot claim it verified a PR unless the tested application corresponds to the PR head. Arbitrary PR execution is dangerous, and local-only execution is not the final assignment story. This issue locks a trusted deployment identity contract and converts impact into bounded verification missions without implementing a universal preview platform.

## Scope

- Deployment registration/identity model for baseline and PR head.
- Proof/attestation strategy tying URL to repository+commit+environment.
- Trust classification and allowed verification modes.
- Readiness/health/test-data/auth/setup references.
- Curator/impact findings → bounded Application Explorer mission plan.
- Affected flows plus one control where feasible.
- Setup classification: outside versus inside blast radius.
- Verification unavailable/action-required outcomes.
- Threat model for untrusted code, network egress, secrets, resources, and cleanup.

## Implementation tasks

- [ ] Select and document the public baseline/head deployment mechanism after the open decision is resolved.
- [ ] Define deployment identity/proof contract and validation service.
- [ ] Define trusted/untrusted/stale/unreachable states.
- [ ] Add health/readiness and commit-match checks before credentials/browser access.
- [ ] Transform impact findings into scoped verification missions/checkpoints.
- [ ] Select a control flow and classify setup dependencies.
- [ ] Enforce application/auth/data/policy compatibility.
- [ ] Return explicit `verification_unavailable` when no trusted head exists.
- [ ] Add cleanup/expiry and compromise-response expectations for disposable environments.

## Acceptance criteria

- Verification refuses an environment not tied to the expected head SHA.
- Baseline deployment cannot be mislabeled as PR-head verification.
- No untrusted PR deployment receives secrets before trust/readiness policy passes.
- Plan lists impacted mission(s), deterministic checkpoints, setup method, control flow, budgets, and exclusions.
- Missing/failed deployment yields an actionable non-fabricated status and leaves static assessment valid.
- The selected assignment deployment approach is publicly demonstrable and minimally modifies Hi.Events.

## Required tests

- Exact/mismatch/stale/unreachable/unknown identity matrix.
- Secret-release ordering and untrusted-environment denial tests.
- Mission/checkpoint/control/setup planning fixtures.
- Verification-unavailable behavior test.
- Expiry/cleanup and concurrent-head isolation tests.
- Opt-in real selected sandbox/preview compatibility smoke test.

## Out of scope

A universal PaaS, automatic arbitrary PR deployment, actual browser verification, and graph refresh.

## Implementation notes

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
