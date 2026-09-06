# SNT-006 — LangGraph runtime, checkpointing, events, and interrupts

| Field | Value |
|---|---|
| Milestone | M1 — Foundation and durable execution |
| Status | `not-started` |
| Depends on | SNT-002, SNT-003, SNT-005 |
| Blocks | Specialist kernel, run API, all compiled workflows |
| PRD references | §7.4, §9.3, §10.4, §11.6, §13.2, §15 |

## Background

LangGraph.js is the execution graph; Neo4j is the knowledge graph. This issue proves durable orchestration mechanics with synthetic nodes before attaching real documentation, code, or browser agents.

## Scope

- `@langchain/langgraph`, `@langchain/core`, and PostgreSQL checkpointer setup.
- Trusted internal `langgraph_checkpoint` schema on Supabase Postgres.
- `thread_id = run.id` convention and graph/run metadata propagation.
- Typed graph state and compact reference-only checkpoint policy.
- Shared node wrapper for structured events, timing, retry/error classification, and cancellation checks.
- `updates`, `custom`, and tool-lifecycle event projection into `run_events`.
- Human `interrupt()`/resume bridge.
- Recursion/reconciliation/tool/model budget enforcement hooks.
- Synthetic fan-out/fan-in graph proving parallel pending-write recovery.

## Implementation tasks

- [ ] Initialize `PostgresSaver` in a non-user-controlled schema.
- [ ] Ensure checkpoint schema is not exposed through browser Data API configuration.
- [ ] Build graph invocation/resume service keyed by run ID.
- [ ] Define state fields that contain IDs/raw state, never live clients or large artifacts.
- [ ] Add node lifecycle event envelope and durable event writer.
- [ ] Add cancellation and lease ownership checks between nodes/tool calls.
- [ ] Add per-node retry policies for transient faults only.
- [ ] Add interrupt creation, persisted review payload, authorized resume, and idempotent repeat handling.
- [ ] Add recursion/budget guard that ends with typed terminal status.
- [ ] Build a synthetic graph with deterministic branch, parallel branch, model-tool loop stub, interrupt, and finalizer.
- [ ] Document graph migration constraints for in-flight interrupted runs.

## Acceptance criteria

- A run resumes from its checkpoint after simulated worker termination.
- Completed parallel work is not repeated when a sibling branch transiently fails.
- An interrupt survives process restart and resumes exactly once with an authorized decision.
- Event ordering is durable and contains graph/node/run identifiers without hidden reasoning.
- Cancellation prevents subsequent side effects.
- Compact checkpoint validation rejects browser objects, secrets, full documents/source/DOM, and oversized values.
- Budget/recursion exhaustion produces a typed terminal result rather than an uncaught framework error.

## Required tests

- Whole-graph success/failure tests using `MemorySaver` for fast unit coverage.
- Individual-node tests and seeded partial-path tests.
- PostgresSaver integration test for restart/resume.
- Parallel pending-write/retry test.
- Interrupt/resume/idempotency/authorization tests.
- Cancellation and budget boundary tests.
- Event projection/redaction tests.

## Out of scope

Real specialist agents, Neo4j publication, UI Realtime subscriptions, and production deployment scaling.

## Implementation notes

Follow LangGraph's documented guidance: state stores raw data/IDs, external calls occupy focused nodes, retries are node-specific, and interrupt-producing nodes must avoid unsafe side effects before the interrupt because the node may re-run on resume.