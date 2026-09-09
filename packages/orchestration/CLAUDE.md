## Key Files

- `src/specialist/kernel.ts` - shared checkpointed specialist graph and service.
- `src/specialist/state.ts` - compact state schemas, reducers, and safety checks.
- `src/specialist/tools.ts` - described least-privilege registry and call boundary.
- `src/code-explorer-specialist.ts` - Code Explorer shared-kernel composition.
- `src/application-explorer-specialist.ts` - Application Explorer composition.
- `src/runtime.ts` - lease, cancellation, deadline, and event wrapper.
- `src/event-projection.ts` - durable public run-event projection.
- `src/specialist/tools.ts` - safe compact tool output and activity projection boundary.

## Conventions

- Validate every checkpoint update before returning it to LangGraph.
- Keep rich source/browser output behind injected durable stores.
- Require explicit production checkpointers and execution coordinators.
- Commit state before emitting decision, tool, evidence, or terminal events.
- Give retried committed events deterministic idempotency keys.
- Recheck run ownership before work, event persistence, and recovery.
- Classify model decisions as provider-backed or deterministic for budgeting.
- Keep prompts, arguments, outputs, credentials, and reasoning out of state/events.
- Emit only bounded `activity` metadata from committed specialist decisions and sanitized tool observations.
- Colocate unit tests; keep agent, integration, and live suites separate.
