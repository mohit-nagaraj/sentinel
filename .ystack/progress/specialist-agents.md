# Specialist Agents Progress

## SNT-014 Shared Specialist Agent Kernel

- [x] Define compact specialist state and decisions.
- [x] Build the deterministic tool registry and budget gate.
- [x] Implement the reusable specialist LangGraph kernel.
- [x] Add scripted trajectories and durable boundary tests.

SNT-014 is implemented on this integration branch and is awaiting final review, CI, and merge.

### SNT-014 Decisions

| Date       | Decision                                                                               | Reason                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-08 | Reuse the existing mission/result contracts and durable orchestration runtime.         | The kernel should specialize proven wire, checkpoint, lease, cancellation, and interrupt boundaries rather than create parallel ones.  |
| 2026-09-08 | Compile specialist subgraphs for per-invocation persistence inherited from the parent. | Missions remain isolated while parent workflows retain durable checkpoints and human interrupts.                                       |
| 2026-09-08 | Track budget consumption in an identity-keyed model/tool ledger.                       | Replay deduplication and conflict checks keep checkpoint usage atomic and prevent duplicate charges.                                   |
| 2026-09-08 | Coordinate tool execution by mission, call ID, and request hash.                       | Concurrent identical calls share one result, conflicts fail closed, and uncertain failures become durable charged observations.        |
| 2026-09-08 | Fingerprint the complete declared kernel configuration in checkpoint identity.         | Mission threads reject changed models, toolsets, validators, modes, prompts, and runtime limits instead of mixing trajectories.        |
| 2026-09-08 | Gate durable start claims and recovery with short coordination plus the run lease.     | Starts do not hold database locks during graph work, unauthorized workers cannot claim threads, and abandoned checkpoints can recover. |
| 2026-09-08 | Export strict scripted model, tool, and in-memory checkpoint helpers.                  | Agent trajectories stay deterministic and credential-free while exercising the same validation, budget, interrupt, and replay paths.   |

## SNT-017 Application Explorer

- [x] Define strict Application Explorer decisions, checkpoint, frontier, claim, blocker, and result contracts.
- [x] Implement the guarded browser tools and adaptive mission runtime.
- [x] Verify deterministic and real-browser mission, denial, recovery, and stability trajectories.
- [x] Record verified SNT-017 documentation and milestone status.

SNT-017 is complete as a composable Application Explorer and is being checked against the SNT-014 shared-kernel contract on this branch.

### SNT-017 Decisions

| Date       | Decision                                                                            | Reason                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-08 | State/action visitation is keyed by state fingerprint plus public action signature. | Opaque action IDs are observation-bound and may change after re-observation, while the signature preserves deterministic loop detection without exposing selectors. |
| 2026-09-08 | The Application Explorer uses structural browser and structured-planner ports.      | SNT-017 remains composable with the existing Playwright and Azure gateway adapters without duplicating shared-kernel responsibilities.                              |
| 2026-09-08 | Backtracked alternatives emit separate contiguous workflow claims.                  | Browser back/reload transitions remain replay evidence but do not become misleading product workflow steps.                                                         |
| 2026-09-08 | Planner context includes bounded progress and recent semantic actions.              | Model decisions need frontier, coverage, runtime-evidence, and recent-action context to adapt without a hardcoded workflow sequence.                                |
| 2026-09-08 | Evidence projection bounds expanded UI and request claims.                          | Selected UI action and representative request claims keep output bounded while each step retains the authoritative transition evidence reference.                   |
| 2026-09-08 | Recovery is bound to the checkpoint authentication reference and mission host set.  | A structurally similar screen is insufficient proof when a caller changes account state or broadens browser-policy origins.                                         |
| 2026-09-08 | Workflow identity hashes the observed state/action path, not planner wording.       | Product identities remain stable across summary paraphrases and branch discovery order while distinct same-kind paths cannot collide.                               |
| 2026-09-08 | Planner deadlines and tool events are enforced around cleanup-safe lifecycle paths. | Elapsed budgets terminate stalled calls, events pair, and event persistence failures cannot retain browser sessions.                                                |
