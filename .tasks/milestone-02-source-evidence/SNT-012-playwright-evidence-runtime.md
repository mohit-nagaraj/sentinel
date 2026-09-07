# SNT-012 — Playwright observation, safe actions, and evidence capture

| Field | Value |
|---|---|
| Milestone | M2 — Deterministic source evidence |
| Status | `done` |
| Depends on | SNT-002, SNT-003 |
| Blocks | Application Explorer, onboarding safety, verification |
| PRD references | §13.6, §15.4, §18.2–18.3, FR-005 |

## Background

The Application Explorer must never manipulate a raw Playwright page through model-authored selectors/scripts. This runtime turns page state into sanitized observations and state-bound opaque actions, executes only validated actions, and captures durable evidence.

## Scope

- Browser/context/page lifecycle and per-run registry.
- Authentication/storage-state reference injection without model-visible secrets.
- URL/title/heading/ARIA/visible-control/modal/selected-DOM observations.
- Candidate action enumeration for click/fill/select/check/navigation/history with opaque IDs.
- Named safe input slots resolved at deterministic execution.
- State fingerprinting and action/state pair tracking.
- Allowlisted host/protocol, action/time/screen/download/tab, destructive/payment/message policy.
- Screenshot, console/page error, and network request/response observation windows.
- Artifact upload seam and redaction.
- Recovery recipe representation without implementing agent decisions.

## Implementation tasks

- [x] Define browser adapter interface and injectable fake runtime.
- [x] Launch isolated contexts and clean them on every terminal path.
- [x] Build sanitized accessibility-focused observation serializer with size limits.
- [x] Enumerate stable candidates and retain internal locators server-side only.
- [x] Bind opaque IDs to run, state fingerprint, candidate, expiry, and single-use status.
- [x] Implement policy classifier and deterministic deny-by-default categories.
- [x] Implement typed action executor with stale-state revalidation.
- [x] Capture pre/post fingerprint, screenshot, console errors, and time-correlated requests/responses.
- [x] Normalize/redact runtime evidence and upload retained artifacts privately.
- [x] Build safe action-history/replay contract used by recovery and verification.

## Acceptance criteria

- Public observation contains no selector, cookie/token, password, hidden DOM, or unsafe raw value.
- Stale, reused, forged, cross-run, expired, external-host, or policy-denied action IDs fail closed.
- A valid action produces one auditable transition with before/after state and network evidence.
- Destructive/real-payment/external-message/account-privilege actions are denied by default.
- Screenshots and traces use private artifact references; default retention favors failures/report evidence.
- Context/page cleanup occurs after completion, cancellation, and exception.
- Repeated semantic states yield stable-enough fingerprints while material modal/control changes differ.

## Required tests

- Playwright fixture app with multi-screen form, modal, network calls, duplicate states, auth fields, and unsafe buttons.
- Candidate/action lifecycle and stale/replay/forgery tests.
- Host/redirect/download/popup/destructive policy tests.
- Secret and PII redaction tests.
- Network observation-window correlation tests.
- Artifact-on-failure tests.
- Browser cleanup/cancellation tests.

## Out of scope

Agent action selection, live Hi.Events flow, real credentials, real payment, pixel-only visual regression, and full video streaming.

## Implementation notes

- Public schemas and identity inputs: `packages/contracts/src/browser-runtime.ts` and `packages/contracts/src/identity.ts`.
- Runtime boundary: `packages/adapters/src/browser/runtime.ts`; deterministic policy and redaction: `policy.ts` and `redaction.ts`; injectable scripted runtime: `fake.ts`.
- Real-browser proof: `tests/fixtures/browser-application.ts` and `tests/integration/playwright-evidence-runtime.integration.test.ts`.
- Every run reserves its ID before asynchronous setup, owns a non-persistent context, has a wall-clock deadline, and removes contexts, browsers, action ownership, pending network state, and secrets on completion, cancellation, timeout, setup failure, replay mismatch, or callback failure.
- Public action signatures use stable sanitized semantics. A separate private behavior fingerprint includes raw accessible-name identity and policy-relevant attributes; execution re-enumerates candidates and uses the refreshed locator only after both layers match.
- HTTP and WebSocket connections require an exact allowlisted origin. Service workers, WebRTC, background networking, off-origin redirects, excess tabs/downloads, and delayed denied side effects fail closed.
- Screenshots are persisted only through the private artifact sink and mask editable controls plus known secrets/PII across all frames. Opt-in failure traces are minimized JSON over already-redacted evidence. Native Playwright archives are deliberately excluded because they retain unsafe request, DOM, and locator material.
- Focused verification: 67 contract/policy/redaction/runtime tests pass; the deterministic Chromium fixture passes all 9 scenarios, including startup/provider deadlines, state and locator races, action forgery/replay, egress, artifacts, network windows, and cleanup.
- Repository verification: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `pnpm test:browser`, and all locally runnable non-PHP integration tests pass. PHP/Composer checks remain CI-authoritative on this machine because those executables are unavailable; SNT-012 does not modify the PHP indexer.
- Deferred exactly as scoped: live Hi.Events credentials/flows, Application Explorer action selection, Supabase-specific artifact-sink wiring, human policy overrides, video streaming, and pixel-only visual regression.
