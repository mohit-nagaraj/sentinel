# SNT-014 — Shared specialist agent kernel

| Field | Value |
|---|---|
| Milestone | M3 — Specialist discovery agents |
| Status | `not-started` |
| Depends on | SNT-005, SNT-006 |
| Blocks | Documentation, Code, and Application Explorers |
| PRD references | §14.1–14.2, §15.2–15.3, §18.4 |

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

- [ ] Define generic specialist state and reducers.
- [ ] Build subgraph factory accepting agent identity, modes, tools, prompts, and completion validator.
- [ ] Enforce mission scope and tool allowlist before every call.
- [ ] Correlate strict model tool calls/results and reject malformed/unknown calls.
- [ ] Update budget atomically for model/tool/content consumption.
- [ ] Persist only compact references in graph state.
- [ ] Emit agent/mission/decision/tool/evidence/terminal events.
- [ ] Add human-interrupt route and authorized resume contract.
- [ ] Add loop/recursion/no-progress detection.
- [ ] Build scripted fake gateway and tool set for deterministic tests.

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

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
