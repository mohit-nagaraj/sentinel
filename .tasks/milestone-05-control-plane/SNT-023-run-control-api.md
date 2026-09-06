# SNT-023 — Run APIs, worker control, cancellation, and recovery

| Field | Value |
|---|---|
| Milestone | M5 — Onboarding and observable control plane |
| Status | `not-started` |
| Depends on | SNT-006, SNT-022 |
| Blocks | Activity UI, knowledge UI, GitHub App |
| PRD references | §7.4–7.5, §8.4, §13.1–13.2, FR-016, NFR-005/NFR-008 |

## Background

The web process must enqueue long work and return immediately; the worker claims and executes compiled graphs. Users need durable status, cancellation, safe retry/resume, and human-interrupt responses.

## Scope

- Authorized API/service commands for inspect, initialize, assess, verify, refresh, cancel, retry, and interrupt resume.
- Run idempotency and per-application mutation locks.
- Worker claim/heartbeat/lease/reclaim loop.
- LangGraph invocation/resume integration.
- Run/event/status read APIs and pagination.
- Cancellation propagated between nodes/tool calls and browser/Git subprocesses.
- Retry semantics: new attempt versus checkpoint resume.
- Human-review resume authorization and duplicate-response protection.
- Redacted failure categories and operator actions.

## Implementation tasks

- [ ] Define command endpoints/server actions and response contracts.
- [ ] Enforce application status/prerequisite transition rules.
- [ ] Implement worker poll/claim/heartbeat/shutdown/reclaim.
- [ ] Map job types to compiled graph entry points.
- [ ] Persist terminal outputs and update application/assessment state atomically.
- [ ] Implement cancellation tokens and cleanup callbacks.
- [ ] Implement safe retry/resume policies by failure category.
- [ ] Add interrupt inbox/read/respond APIs.
- [ ] Add run/event list/detail APIs with bounded pagination.
- [ ] Add health/readiness endpoints for web, worker, providers.

## Acceptance criteria

- API returns run ID immediately and work occurs outside request lifecycle.
- Duplicate commands do not create conflicting active mutations.
- Worker crash/lease expiry resumes from safe checkpoint.
- Cancellation stops future tools and cleans browser/Git resources.
- Human interrupt can be answered once by authorized caller and resumes correct run.
- User-visible failures are actionable and redacted.
- Run progress/history remains available after process/page restart.

## Required tests

- API authorization/validation/idempotency tests.
- Worker claim/lease/reclaim graceful shutdown tests.
- Graph invocation/resume/cancel integration tests.
- Duplicate interrupt response and unauthorized response tests.
- Failure-category retry matrix.
- Pagination and cross-application access tests.

## Out of scope

Realtime UI, GitHub webhook ingress, actual deployment platform autoscaling, and multi-worker throughput optimization.

## Implementation notes

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
