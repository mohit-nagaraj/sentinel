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

## SNT-023 Run Control API

- [x] Define strict command, public run, interrupt, pagination, and readiness contracts.
- [x] Enforce owner scope, idempotency fingerprints, active mutation exclusion, linked retry attempts, and application transitions in PostgreSQL.
- [x] Implement owner-scoped run/event reads, cancellation, interrupts, leases, and fixed public failure projections.
- [x] Dispatch all six run types through required start/continue/resume graph handlers.
- [x] Run a polling worker with heartbeats, checkpoint reclaim, cancellation/shutdown signals, and ordered cleanup.
- [x] Expose authenticated command/read/control/readiness routes plus worker liveness/readiness HTTP endpoints.

| Date       | Decision                                                                                                                                                     | Reason                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 2026-09-08 | Keep idempotency and one-active-non-eval-run exclusion inside PostgreSQL and compare canonical request fingerprints on replay.                               | Concurrent HTTP delivery must not depend on process-local locks, and the same key cannot silently identify new work. |
| 2026-09-08 | Reclaim expired leases with the same run and LangGraph thread; only an operator retry of a retryable terminal failure creates a linked run.                  | Crash recovery continues a durable checkpoint, while explicit retries remain separately auditable.                   |
| 2026-09-08 | Require a six-entry injected graph registry with start, continue, and resume operations instead of using the synthetic graph as a production implementation. | Domain root graphs arrive in later tickets; the worker must fail composition rather than execute a misleading stub.  |
| 2026-09-08 | Store bounded interrupt prompts/responses and accept one owner-authorized response, with identical repeats idempotent and contradictory repeats conflicting. | Human review must survive restart without permitting a response to be changed after checkpoint resume is scheduled.  |

## SNT-026 GitHub App Webhooks and Checks

- [x] Define strict webhook, assessment trigger, check lifecycle, response, and least-privilege App contracts.
- [x] Implement raw-body authentication, GitHub App token management, PR resolution, and Checks API operations.
- [x] Enqueue deliveries, immutable-head assessments, runs, supersession, and check binding transactionally.
- [x] Expose and verify shared signed-webhook and operator-authenticated manual assessment routes.

SNT-026 implementation, QA, clean-database migration verification, and production builds are complete.

| Date       | Decision                                                                                                          | Reason                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 2026-09-09 | Verify the exact bounded webhook bytes before parsing and use the GitHub delivery GUID as the durable replay key. | Authentication and idempotency must precede all assessment side effects.                                             |
| 2026-09-09 | Cache repository-scoped installation tokens generated from short-lived RS256 App JWTs.                            | App automation needs only Contents read, Pull requests read, and Checks write, without personal tokens.              |
| 2026-09-09 | Enqueue delivery, immutable head, supersession, cancellation, and worker run in one PostgreSQL function.          | Concurrent and out-of-order deliveries cannot rely on process locks or overwrite the current head.                   |
| 2026-09-09 | Bind checks to assessment ID plus head SHA and recover partial creation through a short lease and external ID.    | GitHub side effects are not transactional with PostgreSQL, so retry must discover prior success without duplication. |
| 2026-09-09 | Confirm signed webhook heads against current GitHub PR metadata before transactional enqueue.                     | Provider timestamps alone cannot totally order delayed deliveries that share timestamp resolution.                   |

## SNT-024 Realtime Specialist Activity

- [x] Define bounded, redacted activity metadata and persist owner-authorized private run broadcasts.
- [x] Add safe-boundary pause requests, short-lived realtime identity, and run-scoped screenshot signing.
- [ ] Build deterministic catch-up/reconnect state and the accessible specialist activity workspace.
- [ ] Add run routes, synthetic live fixture coverage, screenshot storyboard proof, and operational guidance.

| Date       | Decision                                                                                                                                            | Reason                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-09 | Send only run identity and sequence on private Realtime Broadcast topics, then fetch canonical events from PostgreSQL.                              | Broadcast wakes the client without making an ephemeral transport the source of truth or duplicating event content.           |
| 2026-09-09 | Mint four-minute owner JWTs with the configured asymmetric Supabase key, retaining legacy HS256 only for local development.                         | Private channel authorization needs `auth.uid()` while production signing should use rotatable asymmetric keys.              |
| 2026-09-09 | Sign only PNG/JPEG screenshot artifacts that match both the owned application and run, with a five-minute maximum URL lifetime.                    | A guessed artifact identifier must not cross run boundaries or expose non-visual evidence through the activity presentation. |
