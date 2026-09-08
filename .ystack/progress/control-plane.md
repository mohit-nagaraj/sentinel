# Control Plane Progress

## SNT-022 Application Onboarding

- [x] Define strict onboarding, compatibility, scope, and public response contracts.
- [x] Implement bounded repository, documentation, application, and Playwright readiness inspection.
- [x] Persist owner-scoped configuration, compatibility, confirmation, stale state, and secret references.
- [x] Add the authorized server-only onboarding controller and actions.
- [x] Deliver the accessible application shell, onboarding workflow, and browser security coverage.

## Decisions

- Authenticate production control-plane requests with a high-entropy operator token at the Proxy and every Server Action; the server-derived operator UUID remains the storage owner, not proof of caller identity.
- Require explicit no-CAPTCHA automation confirmation for protected targets, and re-fingerprint current non-secret form values before scope confirmation.
- Reject unsupported repositories before checkout; pin the readiness browser to a validated public DNS result and guard both HTTP and WebSocket egress.

- Use an application rail with a compact four-step source, access, safety, and review workspace while preserving the existing Sentinel tokens; persistent application context is more efficient for returning operators than a centered one-off wizard.
- Exercise Server Action responses and client scripts with privileged canaries in Chromium; source-level import checks alone cannot prove database, graph, model, GitHub, or submitted target secrets are absent from the delivered browser surface.

| Date       | Decision                                                                                                                                                                                   | Reason                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-08 | Compatibility resolves an immutable bounded checkout and reports evidence for each installed Hi.Events adapter before initialization.                                                      | The control plane must fail before agentic work when the target is unreachable, unsupported, or misaligned.                                 |
| 2026-09-08 | URL readiness reuses the DNS-pinned documentation policy and Playwright uses the same-origin browser policy.                                                                               | User-supplied onboarding URLs are SSRF and browser-egress boundaries, not ordinary fetch targets.                                           |
| 2026-09-08 | Persist only validated onboarding JSON whose authentication entries contain opaque Vault references, then protect inspection and confirmation with canonical compare-and-set fingerprints. | This keeps plaintext out of ordinary rows and prevents delayed probes or stale browser submissions from approving superseded configuration. |
| 2026-09-08 | Treat every Server Action as a public mutation boundary and derive the operator UUID plus database/GitHub credentials only from server environment state.                                  | Rendering a form on an operator page is not authorization; data access must enforce ownership again next to storage.                        |
| 2026-09-08 | Reserve and automatically delete an uninitialized application draft when Vault-backed authentication setup fails.                                                                          | Vault mappings require an application foreign key, and failed secret setup must not leave a visible half-configured application.            |
