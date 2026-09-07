# SNT-006 — LangGraph runtime, checkpointing, events, and interrupts

| Field | Value |
|---|---|
| Milestone | M1 — Foundation and durable execution |
| Status | `review` |
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

- [x] Initialize `PostgresSaver` in a non-user-controlled schema.
- [x] Ensure checkpoint schema is not exposed through browser Data API configuration.
- [x] Build graph invocation/resume service keyed by run ID.
- [x] Define state fields that contain IDs/raw state, never live clients or large artifacts.
- [x] Add node lifecycle event envelope and durable event writer.
- [x] Add cancellation and lease ownership checks between nodes/tool calls.
- [x] Add per-node retry policies for transient faults only.
- [x] Add interrupt creation, persisted review payload, authorized resume, and idempotent repeat handling.
- [x] Add recursion/budget guard that ends with typed terminal status.
- [x] Build a synthetic graph with deterministic branch, parallel branch, model-tool loop stub, interrupt, and finalizer.
- [x] Document graph migration constraints for in-flight interrupted runs.

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

- Runtime package: `@sentinel/orchestration` using `@langchain/langgraph` 1.4.14, `@langchain/core` 1.2.9, and PostgresSaver 1.0.5.
- Official guidance used: [persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence), [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts), and [PostgresSaver reference](https://reference.langchain.com/javascript/langchain-langgraph-checkpoint-postgres).
- PostgresSaver always uses the fixed `langgraph_checkpoint` schema; migration and live privilege checks prove `PUBLIC`, `anon`, and `authenticated` have no schema access.
- Synthetic coverage includes deterministic and parallel branches, transient-only retry, pending-write recovery on a new graph instance, bounded model/tool work, interrupt/authorized resume, duplicate resume, rejection, cancellation, recursion exhaustion, and finalization.
- In-flight graph migrations must drain old threads or use a versioned graph/checkpoint namespace with an explicit validated state migration; node/state changes are never reinterpreted implicitly.
- Default verification on 2026-09-07: formatting, zero-warning lint, TypeScript build, 26 files and 161 tests passed; 4 orchestration files and 27 tests passed.
- Opt-in disposable Postgres verification: 1 integration test passed checkpoint setup/privacy, close/recreate restart, interrupt persistence, authorized/idempotent resume, durable event ordering, and exact thread cleanup.
