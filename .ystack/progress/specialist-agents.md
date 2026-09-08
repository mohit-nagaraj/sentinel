# Specialist Agents Progress

## SNT-014 Shared Specialist Agent Kernel

- [x] Define compact specialist state and decisions.
- [x] Build the deterministic tool registry and budget gate.
- [x] Implement the reusable specialist LangGraph kernel.
- [x] Add scripted trajectories and durable boundary tests.

SNT-014 implementation, QA, P0/P1 review, PR CI, and merge are complete.

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

## SNT-016 Code Explorer

- [x] Preserve the thirteen bounded source/claim tools and domain result contracts.
- [x] Compose all tools through the shared specialist registry and kernel.
- [x] Keep rich source, path, and boundary state behind an injected durable store.
- [x] Verify budget, evidence, follow-up, interrupt, checkpoint, and restart paths.

SNT-016 is complete and its shared-kernel composition passes independent P0/P1 review.

## SNT-017 Application Explorer

- [x] Define strict Application Explorer decisions, checkpoint, frontier, claim, blocker, and result contracts.
- [x] Implement the guarded browser tools and adaptive mission runtime.
- [x] Verify deterministic and real-browser mission, denial, recovery, and stability trajectories.
- [x] Record verified SNT-017 documentation and milestone status.

SNT-017 is complete and its shared-kernel composition passes independent P0/P1 review.

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

## SNT-015 Documentation Explorer

- [x] Define strict Documentation Explorer contracts and parsers.
- [x] Build the bounded prepared-map tool port.
- [x] Compose all six tools through the shared specialist kernel.
- [ ] Prove golden, conflict, replay, denial, and failure trajectories.

### SNT-015 Decisions

| Date       | Decision                                                                                          | Reason                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-08 | Separate exact excerpt citations from compact tree, search, and link summaries.                   | The model can choose evidence without moving full document bodies into checkpoint state.                                              |
| 2026-09-08 | Keep rich requirement, duplicate, conflict, capability, and exclusion records non-authoritative.  | SNT-015 discovers cited intent while downstream validation, evidence-tier assignment, and publication remain separate.                |
| 2026-09-08 | Preserve document-relative section offsets and validate prepared-map integrity at construction.   | Exact citations remain compatible with SNT-008 provenance, and forged membership/hash/link records fail before tools are exposed.     |
| 2026-09-08 | Commit rich finish results before provider-free kernel finalization.                              | Restart, replay, human interrupt, and exhausted-provider paths retain one coordinated terminal result without duplicate side effects. |
| 2026-09-08 | Revalidate exact reads, source scope, tool identity, and atomic lexical support in orchestration. | The deterministic composition remains authoritative even when a structurally compatible tool port is faulty or stale.                 |
