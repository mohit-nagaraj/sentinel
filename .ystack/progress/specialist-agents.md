# Specialist Agents Progress

## SNT-014 Shared Specialist Agent Kernel

- [x] Define compact specialist state and decisions.
- [x] Build the deterministic tool registry and budget gate.
- [x] Implement the reusable specialist LangGraph kernel.
- [x] Add scripted trajectories and durable boundary tests.

## Decisions

| Date       | Decision                                                                               | Reason                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-08 | Reuse the existing mission/result contracts and durable orchestration runtime.         | The kernel should specialize proven wire, checkpoint, lease, cancellation, and interrupt boundaries rather than create parallel ones.  |
| 2026-09-08 | Compile specialist subgraphs for per-invocation persistence inherited from the parent. | Missions remain isolated while parent workflows retain durable checkpoints and human interrupts.                                       |
| 2026-09-08 | Track budget consumption in an identity-keyed model/tool ledger.                       | Replay deduplication and conflict checks keep checkpoint usage atomic and prevent duplicate charges.                                   |
| 2026-09-08 | Coordinate tool execution by mission, call ID, and request hash.                       | Concurrent identical calls share one result, conflicts fail closed, and uncertain failures become durable charged observations.        |
| 2026-09-08 | Fingerprint the complete declared kernel configuration in checkpoint identity.         | Mission threads reject changed models, toolsets, validators, modes, prompts, and runtime limits instead of mixing trajectories.        |
| 2026-09-08 | Gate durable start claims and recovery with short coordination plus the run lease.     | Starts do not hold database locks during graph work, unauthorized workers cannot claim threads, and abandoned checkpoints can recover. |
| 2026-09-08 | Export strict scripted model, tool, and in-memory checkpoint helpers.                  | Agent trajectories stay deterministic and credential-free while exercising the same validation, budget, interrupt, and replay paths.   |
