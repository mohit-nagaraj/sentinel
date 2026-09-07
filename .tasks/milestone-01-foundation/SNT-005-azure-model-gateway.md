# SNT-005 — Azure OpenAI model gateway compatibility spike

| Field | Value |
|---|---|
| Milestone | M1 — Foundation and durable execution |
| Status | `review` |
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

- [x] Define gateway request/result/usage/error contracts.
- [x] Validate endpoint shape, deployment name, and server-only credentials.
- [x] Implement one-shot structured generation.
- [x] Implement strict tool-decision call and tool-result continuation without embedding orchestration policy in the gateway.
- [x] Support streaming callbacks/events without exposing hidden reasoning.
- [x] Set `store: false` where compatible and preserve only application-required response items.
- [x] Normalize rate-limit, timeout, filter/refusal, malformed-output, and provider errors.
- [x] Add fake/scripted gateway capable of deterministic multi-turn tool trajectories.
- [x] Add live capability probe and write a redacted compatibility result.
- [x] Define per-call input/output/tool limits consumed by higher-level mission budgets.

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

- Runtime package: `@sentinel/adapters` using the official `openai` 7.10.0 client and Zod 4.3.6.
- Official OpenAI Responses references used: [create response](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create) and [data controls](https://developers.openai.com/api/docs/guides/your-data).
- Live probe on 2026-09-07 returned model `gpt-5-mini` for deployment fingerprint `sha256:a7e45eaed6603e3420be8ffd2dcb79d7b36bc33377bce5414a23b879fc7d315e`.
- The 512-token-per-call probe passed ordinary text, strict structured output, strict tool arguments, a correlated two-step tool/result loop, streaming deltas, usage capture, `store: false`, and live timeout normalization with retries disabled.
- Malformed output, invalid tool arguments/correlation, refusal, content filter, rate limit, provider failure, bounds, and redaction are covered with synthetic provider payloads; harmful content was not sent merely to trigger a live filter.
- Default verification: formatting, zero-warning lint, TypeScript build, 22 files and 123 tests passed; 4 focused model-gateway files and 14 tests passed; the paid live project skips without opt-in and passed 1 compatibility test with opt-in.
