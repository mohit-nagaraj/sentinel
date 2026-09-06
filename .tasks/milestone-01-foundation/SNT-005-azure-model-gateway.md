# SNT-005 — Azure OpenAI model gateway compatibility spike

| Field | Value |
|---|---|
| Milestone | M1 — Foundation and durable execution |
| Status | `not-started` |
| Depends on | SNT-001, SNT-002 |
| External prerequisite | Azure endpoint, API key, and deployment name are configured; capabilities remain unverified |
| Blocks | SNT-006, all specialist agents, grounded report wording |
| PRD references | §10.3–10.4, §15, §18.4, open question 4 |

## Background

Sentinel intentionally uses Azure OpenAI through the official `openai` TypeScript package inside custom LangGraph nodes. Before agent work, the actual Azure deployment must prove the precise capabilities the architecture requires; model names/API versions must not be guessed.

## Scope

- Internal `ModelGateway` interface independent of LangGraph state and provider secrets.
- Azure `/openai/v1/` client construction using deployment name as `model`.
- Structured output parsing with Zod-compatible JSON schema.
- Strict function-tool request/response loop.
- Streaming/event adaptation where supported.
- `store: false` behavior and application-managed continuation state.
- Bounded retries/timeouts, usage capture, refusal/content-filter handling, and redaction.
- Deterministic fake gateway for unit/graph tests.
- Explicit opt-in compatibility script against the configured deployment.

## Implementation tasks

- [ ] Define gateway request/result/usage/error contracts.
- [ ] Validate endpoint shape, deployment name, and server-only credentials.
- [ ] Implement one-shot structured generation.
- [ ] Implement strict tool-decision call and tool-result continuation without embedding orchestration policy in the gateway.
- [ ] Support streaming callbacks/events without exposing hidden reasoning.
- [ ] Set `store: false` where compatible and preserve only application-required response items.
- [ ] Normalize rate-limit, timeout, filter/refusal, malformed-output, and provider errors.
- [ ] Add fake/scripted gateway capable of deterministic multi-turn tool trajectories.
- [ ] Add live capability probe and write a redacted compatibility result.
- [ ] Define per-call input/output/tool limits consumed by higher-level mission budgets.

## Acceptance criteria

The selected Azure deployment passes all of:

1. ordinary response;
2. schema-valid structured response;
3. strict function call with rejected invalid arguments;
4. at least a two-step tool/result loop;
5. streaming callback/event flow;
6. usage metadata capture;
7. timeout/retry behavior;
8. content-filter/refusal surfaced as typed non-success.

Additionally:

- Gateway tests require no live credentials.
- Provider response IDs/state are not treated as Sentinel's durable workflow state.
- Secrets and full prompts are absent from default logs/events.
- Unsupported capabilities fail the spike with an actionable blocker rather than silent fallback to a different provider/model.

## Required tests

- Contract tests with recorded/synthetic provider payloads.
- Structured-output malformed/refusal/filter tests.
- Tool loop ordering and call-ID correlation tests.
- Retry classification tests.
- Redaction tests.
- Opt-in live compatibility test with a strict cost cap.

## Out of scope

Agent prompts, LangGraph topology, provider/model selection UI, Langfuse, model fallback routing, and production cost optimization.

## Implementation notes

Official references: Azure Responses API and Structured Outputs links in PRD §28. Record the tested Azure deployment/version and capability result here without recording endpoint keys or sensitive prompt content.

Configuration readiness was checked on 2026-09-07 without exposing values: endpoint, API key, and deployment variables are populated. This removes the external-input blocker but does not establish compatibility; the issue remains gated on SNT-001 and SNT-002, and its bounded live probe must verify every required capability.