# SNT-012 — Playwright observation, safe actions, and evidence capture

| Field | Value |
|---|---|
| Milestone | M2 — Deterministic source evidence |
| Status | `not-started` |
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

- [ ] Define browser adapter interface and injectable fake runtime.
- [ ] Launch isolated contexts and clean them on every terminal path.
- [ ] Build sanitized accessibility-focused observation serializer with size limits.
- [ ] Enumerate stable candidates and retain internal locators server-side only.
- [ ] Bind opaque IDs to run, state fingerprint, candidate, expiry, and single-use status.
- [ ] Implement policy classifier and deterministic deny-by-default categories.
- [ ] Implement typed action executor with stale-state revalidation.
- [ ] Capture pre/post fingerprint, screenshot, console errors, and time-correlated requests/responses.
- [ ] Normalize/redact runtime evidence and upload retained artifacts privately.
- [ ] Build safe action-history/replay contract used by recovery and verification.

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

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
