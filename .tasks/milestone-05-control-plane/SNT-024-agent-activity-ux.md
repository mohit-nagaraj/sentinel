# SNT-024 — Realtime specialist activity and screenshot storyboard

| Field          | Value                                        |
| -------------- | -------------------------------------------- |
| Milestone      | M5 — Onboarding and observable control plane |
| Status         | `done`                                       |
| Depends on     | SNT-006, SNT-017, SNT-023                    |
| Blocks         | Verification UX, final demo                  |
| PRD references | §8.4, §15, FR-016, NFR-006/NFR-010           |

## Background

A strong demo should make agent work inspectable without showing chain-of-thought. The UI needs durable Documentation/Code/Application lanes, Curator reconciliation, structured reasons/evidence, budgets, and action-aligned screenshots.

## Scope

- Canonical redacted event taxonomy and UI projections.
- Persist LangGraph state/custom/tool events into ordered `run_events`.
- Private Supabase Realtime Broadcast by authorized run/application topic.
- Reload/reconnect/catch-up and duplicate event handling.
- Three specialist lanes plus Curator/reconciliation feed.
- Structured decision summary, reason code, tool/action status, evidence gain, budgets.
- Latest/private action-aligned screenshot and workflow storyboard.
- Pause/stop/human-action controls via SNT-023.
- Accessible live-region/status behavior and responsive layout.

## Implementation tasks

- [x] Define event-to-view-model projector and redact at write boundary.
- [x] Add database broadcast trigger/channel authorization policies.
- [x] Implement server/client subscription with catch-up cursor and reconnect.
- [x] Build lane/timeline cards for all agents and Curator.
- [x] Build browser screenshot/transition/network evidence card using signed URLs.
- [x] Display budget progress and typed terminal/blocker state.
- [x] Add pause/stop/respond navigation/actions.
- [x] Prevent rendering raw untrusted HTML/source/DOM as executable markup.
- [x] Add empty, slow, disconnected, failed, and completed states.

## Acceptance criteria

- Events appear live and reconstruct identically after reload from Postgres.
- Reconnect/catch-up creates no duplicate or reordered visible activity.
- Users can distinguish agent decision, policy result, tool execution, and evidence result.
- Screenshots are private and expire; unavailable images degrade gracefully.
- UI exposes no prompt, hidden reasoning, secret/cookie/token/raw credential, internal selector, or arbitrary full DOM.
- All activity views and status changes are keyboard/screen-reader accessible.
- A synthetic parallel run displays independent lanes and reconciliation correctly.

## Required tests

- Event projector/redaction unit tests.
- Realtime authorization and cross-application isolation tests.
- Reconnect/cursor/dedup/order tests.
- Component tests for event types and terminal states.
- Playwright browser test for live synthetic run, reload, and screenshot storyboard.
- XSS/untrusted-content rendering tests.

## Out of scope

Token-by-token hidden reasoning, full live screencast/video, Langfuse UI, and generic graph visualization.

## Implementation notes

- Redacted display metadata and ordered event projection live in `packages/contracts/src/events.ts` and `packages/orchestration/src/event-projection.ts`.
- `supabase/migrations/20260908000400_realtime_activity.sql` adds safe-boundary pause state, cursor-only private Broadcast, and owner authorization through `realtime.messages` RLS.
- `apps/web/lib/activity-feed.ts`, `activity-projector.ts`, and `realtime-client.ts` reconstruct Postgres pages deterministically and treat Broadcast only as a catch-up signal.
- `/runs` and `/runs/[runId]` render the responsive specialist workspace. Production uses short-lived owner JWTs and five-minute, run-scoped PNG/JPEG URLs; unavailable images remain accessible.
- Verification includes strict projection/XSS/component tests, token/key and reconnect tests, local Supabase RLS/cross-owner/Broadcast/pause integration, and Playwright live/reload/PNG/keyboard/mobile coverage.
- The browser fixture polls only when `SENTINEL_CONTROL_PLANE_FIXTURE=1` outside production. No acceptance item is deferred.
