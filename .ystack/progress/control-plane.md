# Control Plane Progress

## SNT-022 Application Onboarding

- [x] Define strict onboarding, compatibility, scope, and public response contracts.
- [x] Implement bounded repository, documentation, application, and Playwright readiness inspection.
- [x] Persist owner-scoped configuration, compatibility, confirmation, stale state, and secret references.
- [ ] Add the authorized server-only onboarding controller and actions.
- [ ] Deliver the accessible application shell, onboarding workflow, and browser security coverage.

## Decisions

| Date | Decision | Reason |
|---|---|---|
| 2026-09-08 | Compatibility resolves an immutable bounded checkout and reports evidence for each installed Hi.Events adapter before initialization. | The control plane must fail before agentic work when the target is unreachable, unsupported, or misaligned. |
| 2026-09-08 | URL readiness reuses the DNS-pinned documentation policy and Playwright uses the same-origin browser policy. | User-supplied onboarding URLs are SSRF and browser-egress boundaries, not ordinary fetch targets. |
| 2026-09-08 | Persist only validated onboarding JSON whose authentication entries contain opaque Vault references, then protect inspection and confirmation with canonical compare-and-set fingerprints. | This keeps plaintext out of ordinary rows and prevents delayed probes or stale browser submissions from approving superseded configuration. |
