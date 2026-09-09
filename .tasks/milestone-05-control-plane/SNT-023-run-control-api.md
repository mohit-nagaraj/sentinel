# SNT-023 — Run APIs, worker control, cancellation, and recovery

| Field          | Value                                               |
| -------------- | --------------------------------------------------- |
| Milestone      | M5 — Onboarding and observable control plane        |
| Status         | `done`                                              |
| Depends on     | SNT-006, SNT-022                                    |
| Blocks         | Activity UI, knowledge UI, GitHub App               |
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

- [x] Define command endpoints/server actions and response contracts.
- [x] Enforce application status/prerequisite transition rules.
- [x] Implement worker poll/claim/heartbeat/shutdown/reclaim.
- [x] Map job types to compiled graph entry points.
- [x] Persist terminal outputs and update application/assessment state atomically.
- [x] Implement cancellation tokens and cleanup callbacks.
- [x] Implement safe retry/resume policies by failure category.
- [x] Add interrupt inbox/read/respond APIs.
- [x] Add run/event list/detail APIs with bounded pagination.
- [x] Add health/readiness endpoints for web, worker, providers.

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

- Public contracts: `packages/contracts/src/run-control.ts`.
- Durable state machine: `supabase/migrations/20260908000300_run_control.sql` and `packages/storage/src/run-repository.ts`.
- Graph dispatch and process lifecycle: `packages/orchestration/src/run-dispatch.ts`, `apps/worker/src/worker.ts`, and `apps/worker/src/health-server.ts`.
- HTTP boundary: `apps/web/lib/run-control.ts` and `apps/web/app/api/control/[[...path]]/route.ts`.
- Verification covers focused contract/storage/orchestration/worker/web tests, a real LangGraph start/interrupt/resume path, and a disposable PostgreSQL matrix for idempotency, mutation locking, lease reclaim, interrupts, retries, pagination, ownership, and application status transitions.
- The worker graph registry is intentionally injected: the production root graphs named by the PRD are delivered by SNT-027, SNT-031, SNT-032, and related workflow tickets. SNT-023 supplies and validates their durable execution contract; it does not substitute the synthetic fixture for those workflows.
- Review hardening added server/SQL budget ceilings, same-origin JSON mutations, provider health probes, real checkpoint detection, application-wide non-eval serialization, consistent advisory lock ordering, configuration-bound atomic terminal publication, and millisecond-stable cursors.
