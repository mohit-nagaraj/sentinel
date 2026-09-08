# SNT-014 — Shared specialist agent kernel

| Field          | Value                                          |
| -------------- | ---------------------------------------------- |
| Milestone      | M3 — Specialist discovery agents               |
| Status         | `review`                                       |
| Depends on     | SNT-005, SNT-006                               |
| Blocks         | Documentation, Code, and Application Explorers |
| PRD references | §14.1–14.2, §15.2–15.3, §18.4                  |

## Background

All three specialists share mission lifecycle, tool selection, validation, checkpoint state, budgets, events, and terminal semantics. Implementing three ad hoc loops would make behavior inconsistent and difficult to evaluate.

## Scope

- Reusable LangGraph specialist subgraph factory/kernel.
- Versioned `DiscoveryMission`, compact state, claim/result, unresolved, and terminal contracts.
- Tool registry with per-agent/mode allowlists and strict schemas.
- Model decision node, deterministic validation node, tool execution node, observation update, and continuation router.
- Per-mission tool/content/model/elapsed budgets and graph recursion limits.
- Common terminal statuses: complete, partial, blocked, budget exhausted, needs human, failed.
- Structured reason codes/events without chain-of-thought.
- Scripted fake model/tool trajectory support.

## Implementation tasks

- [x] Define generic specialist state and reducers.
- [x] Build subgraph factory accepting agent identity, modes, tools, prompts, and completion validator.
- [x] Enforce mission scope and tool allowlist before every call.
- [x] Correlate strict model tool calls/results and reject malformed/unknown calls.
- [x] Update budget atomically for model/tool/content consumption.
- [x] Persist only compact references in graph state.
- [x] Emit agent/mission/decision/tool/evidence/terminal events.
- [x] Add human-interrupt route and authorized resume contract.
- [x] Add loop/recursion/no-progress detection.
- [x] Build scripted fake gateway and tool set for deterministic tests.

## Acceptance criteria

- The same kernel can instantiate all three specialist identities without giving one agent another's tools.
- Every tool call is rejected unless allowed by agent, mission mode, scope, state, and budget.
- Agents cannot self-mark claims accepted or assign authoritative evidence tiers.
- No-progress and exhausted-budget loops terminate predictably.
- Terminal `MissionResult` always includes claims, unresolved questions, exclusions, follow-ups, and stop reason arrays as applicable.
- Events reveal concise choices/results but no prompts, hidden reasoning, or secrets.
- Checkpoint/resume preserves trajectory without duplicating completed tool side effects.

## Required tests

- State/reducer and graph-router unit tests.
- Tool allowlist/schema/scope/budget denial matrix.
- Complete/partial/blocked/budget/human/failure trajectories.
- No-progress and recursion-limit tests.
- Checkpoint/resume and duplicate tool-result tests.
- Cross-agent privilege isolation test.
- Event redaction/snapshot tests.

## Out of scope

Domain-specific prompts/tools, Curator, Neo4j mutation, and frontend rendering.

## Implementation notes

### Paths

- Shared state, tool registry, kernel, and scripted fixtures: `packages/orchestration/src/specialist/`.
- Runtime and event projection: `packages/orchestration/src/runtime.ts` and `packages/orchestration/src/event-projection.ts`.
- Durable event idempotency: `packages/storage/src/run-repository.ts` and `supabase/migrations/20260908000200_run_event_idempotency.sql`.
- Code/Application compositions: `packages/orchestration/src/code-explorer-specialist.ts` and `packages/orchestration/src/application-explorer-specialist.ts`.
- Cross-identity trajectories: `tests/agent/specialist-kernel.agent.test.ts`, `tests/agent/code-explorer-specialist.agent.test.ts`, and `tests/agent/application-explorer-specialist.agent.test.ts`.

### Decisions

- Checkpoint state stores compact decisions, call/result hashes, evidence/reference IDs, a replay-safe budget ledger, progress, human resolution, committed-event cursors, and terminal results. Rich domain observations remain in injected durable stores.
- Kernel configuration fingerprints the agent, modes, prompt, model, described tools, completion validator, and limits. Start/continue/resume reject incompatible checkpoint reuse.
- Provider decisions consume exactly one model call. Explicit deterministic reconstruction consumes zero model calls/tokens and cannot report other usage.
- Production tool registries require an injected durable execution coordinator. Completed or uncertain calls are correlated by mission/call/request hash and checkpointed with conservative usage.
- State commits precede decision/tool/interrupt/terminal events. Deterministic event keys and database conflict checks make retries idempotent.
- Cross-agent follow-ups are permitted only as schema-valid proposed missions with the same run/application and a distinct mission ID.

### Verification (2026-09-08)

- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm build` pass.
- `pnpm test` passes 824 tests across 83 files.
- `pnpm test:agent` passes 39 trajectories across the generic, Code, and Application specialist suites.
- Focused shared-kernel review regressions cover concurrent start/continue, lease denial/recovery, committed-event retries, terminal recovery, elapsed settlement, duplicate decisions, over-reported tool usage, zero-budget deterministic completion, human authorization, and restart replay.
- Application Explorer's six real-browser integration missions pass. The full integration command passes every runnable non-PHP case; one PHP parser limit case remains locally unavailable because this machine's PHP CLI lacks OpenSSL and cannot run Composer. GitHub CI provisions PHP 8.3 and Composer for that gate.
- Five-role `/review` and dedicated Code/Application composition reviews found and closed all confidence-80+ P0/P1 issues.

### Deployment boundary

- Production composition supplies the Postgres checkpointer, durable execution coordinator, durable rich-observation store, run-control/event dependencies, and concrete model/tool adapters. In-memory implementations are explicitly test-only.
- Paid Azure and live Hi.Events tests remain opt-in; no provider credentials are required by default verification.
