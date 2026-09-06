# SNT-024 — Realtime specialist activity and screenshot storyboard

| Field | Value |
|---|---|
| Milestone | M5 — Onboarding and observable control plane |
| Status | `not-started` |
| Depends on | SNT-006, SNT-017, SNT-023 |
| Blocks | Verification UX, final demo |
| PRD references | §8.4, §15, FR-016, NFR-006/NFR-010 |

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

- [ ] Define event-to-view-model projector and redact at write boundary.
- [ ] Add database broadcast trigger/channel authorization policies.
- [ ] Implement server/client subscription with catch-up cursor and reconnect.
- [ ] Build lane/timeline cards for all agents and Curator.
- [ ] Build browser screenshot/transition/network evidence card using signed URLs.
- [ ] Display budget progress and typed terminal/blocker state.
- [ ] Add pause/stop/respond navigation/actions.
- [ ] Prevent rendering raw untrusted HTML/source/DOM as executable markup.
- [ ] Add empty, slow, disconnected, failed, and completed states.

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

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
