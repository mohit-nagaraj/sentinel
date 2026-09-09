# SNT-030 — Trusted deployment identity and verification planning

| Field | Value |
|---|---|
| Milestone | M7 — Dynamic verification and knowledge refresh |
| Status | `done` |
| Depends on | SNT-022, SNT-027, SNT-028 |
| Deployment approach | Manual Render Blueprint preview environments |
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

- [x] Select and document the public baseline/head deployment mechanism after the open decision is resolved.
- [x] Define deployment identity/proof contract and validation service.
- [x] Define trusted/untrusted/stale/unreachable states.
- [x] Add health/readiness and commit-match checks before credentials/browser access.
- [x] Transform impact findings into scoped verification missions/checkpoints.
- [x] Select a control flow and classify setup dependencies.
- [x] Enforce application/auth/data/policy compatibility.
- [x] Return explicit `verification_unavailable` when no trusted head exists.
- [x] Add cleanup/expiry and compromise-response expectations for disposable environments.

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

- `docs/src/content/deployment-verification.mdx` selects manual, expiring
  Render Blueprint preview environments on the public Hi.Events fork. The fork
  adds deployment-only Blueprint/Docker configuration that builds its checkout
  from source; the mutable upstream one-click `latest` image is explicitly not
  an identity-bearing target. The document records setup, trust ordering,
  secret isolation, network/resource constraints, cleanup, and compromise
  response using current Render and GitHub guidance.
- `packages/contracts/src/deployment-verification.ts` defines strict versioned
  registration, authenticated provider proof, exact/mismatch/stale/unreachable/
  unknown states, compatibility fingerprints, readiness/access decisions,
  deterministic checkpoints, setup classifications, affected/control missions,
  bounded budgets, exclusions, and actionable `verification_unavailable` plans.
- `packages/adapters/src/deployment/verification.ts` implements authenticated
  Render service/deploy attestation and an ordered fail-closed validator. It
  checks expiry and role, then service/deploy identity, repository, full SHA,
  public origin, compatibility, and readiness before authorizing any referenced
  credential. Baseline registrations cannot be relabeled as PR-head targets;
  provider self-report from application code is not trusted.
- `packages/orchestration/src/verification-planning.ts` deterministically maps
  only grounded blast-radius scenarios with named checkpoints into at most ten
  `pr_change_validation` Application Explorer missions. It recomputes whether
  setup is inside the blast radius, uses trusted fixture/API setup only outside,
  selects at most one unaffected control, and retains every omission/cap as an
  exclusion. Missing trust or checkpoints preserves the static assessment and
  returns `verification_unavailable` without executable missions.
- Focused verification on 2026-09-09: contracts, adapters, orchestration, and
  docs package typechecks passed; 19 focused unit tests passed across contract
  invariants, exact/mismatch/stale/unreachable/unknown identity, secret-release
  ordering, baseline denial, readiness failure, expiry/cleanup, concurrent-head
  isolation, Render response validation, mission/checkpoint/control/setup
  planning, unavailable behavior, and deterministic output. Scoped ESLint,
  Prettier, and `git diff --check` passed.
- The requested ystack `/review` found that a trusted deployment result could be
  paired with another concurrent PR/head assessment and that setup dependencies
  omitted changed/evidence-path entities. Both findings were fixed: validation
  results now carry pull-request and assessment identity, the planner rejects
  any mismatch, impacted setup classification covers changed symbols and every
  referenced evidence-path node, and bounded exclusions cannot overflow their
  wire contract. Focused regression tests cover each fix.
- `tests/live/render-deployment-verification.live.test.ts` is the opt-in real
  Render/Hi.Events compatibility smoke. Its registration was verified locally
  as skipped because `RUN_RENDER_DEPLOYMENT_SMOKE` and provider credentials were
  not supplied; it asserts live provider status, full head SHA, service ID, and
  public origin when configured. This credential-gated execution is the only
  environment-dependent test; no implementation acceptance item is deferred.
  Full non-live CI remains pending GitHub Actions.
