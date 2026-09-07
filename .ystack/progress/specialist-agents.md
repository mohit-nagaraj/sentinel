# Specialist Agents Progress

## SNT-014 Shared Specialist Agent Kernel

- [x] Define compact specialist state and decisions.
- [ ] Build the deterministic tool registry and budget gate.
- [ ] Implement the reusable specialist LangGraph kernel.
- [ ] Add scripted trajectories and durable boundary tests.

## Decisions

| Date       | Decision                                                                               | Reason                                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-08 | Reuse the existing mission/result contracts and durable orchestration runtime.         | The kernel should specialize proven wire, checkpoint, lease, cancellation, and interrupt boundaries rather than create parallel ones. |
| 2026-09-08 | Compile specialist subgraphs for per-invocation persistence inherited from the parent. | Missions remain isolated while parent workflows retain durable checkpoints and human interrupts.                                      |
| 2026-09-08 | Track budget consumption in an identity-keyed model/tool ledger.                       | Replay deduplication and conflict checks keep checkpoint usage atomic and prevent duplicate charges.                                  |
