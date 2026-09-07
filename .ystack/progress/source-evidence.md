# Source Evidence Progress

## SNT-011 OpenAPI Endpoint Normalization

- [x] Define the canonical endpoint model and identity.
- [x] Build the constrained OpenAPI importer.
- [x] Add cross-source matching, conflict reporting, and redaction.
- [x] Expose and verify the completed endpoint evidence boundary.

## SNT-012 Playwright Evidence Runtime

- [x] Define strict browser observation, action, transition, failure, and replay contracts.
- [x] Implement deterministic policy, redaction, Playwright, and scripted-fake adapters.
- [x] Enforce isolated lifecycle, opaque state-bound actions, private artifacts, and fail-closed egress.
- [x] Verify the runtime with adversarial unit tests and a deterministic Chromium fixture.

## Decisions

| Date | Decision | Reason |
|---|---|---|
| 2026-09-07 | Endpoint identity is the shared stable key over application, uppercase HTTP method, and normalized path shape. | This uses the existing contract identity boundary and makes parameter names irrelevant while preserving method differences. |
| 2026-09-07 | Prefix removal is explicit configuration. | Version and deployment prefixes cannot be guessed without creating false matches. |
| 2026-09-07 | OpenAPI is parsed from caller-supplied bytes or objects, with external references rejected before bounded local resolution. | Keeping the importer free of filesystem and network resolvers removes the SSRF/local-file-read class by construction. |
| 2026-09-07 | Runtime matching returns a canonical catalog identity only after a unique best match. | Concrete request paths and query/header/body values stay transient; ambiguity and disagreement remain explicit outcomes. |
| 2026-09-08 | Browser actions expose semantic candidates while locators and behavior fingerprints remain private. | Revalidating both stable public state and current private behavior prevents stale or position-shifted controls from executing. |
| 2026-09-08 | Browser egress is limited to allowlisted HTTP and WebSocket origins, with service workers and WebRTC disabled. | All supported browser networking must pass an observable deterministic policy boundary. |
| 2026-09-08 | Failure traces are minimized JSON, not native Playwright archives. | Native archives can retain request, DOM, and locator material that the public evidence contract forbids. |
