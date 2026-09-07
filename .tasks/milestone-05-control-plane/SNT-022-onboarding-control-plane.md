# SNT-022 — Application onboarding, compatibility, auth, and safety configuration

| Field          | Value                                        |
| -------------- | -------------------------------------------- |
| Milestone      | M5 — Onboarding and observable control plane |
| Status         | `done`                                       |
| Depends on     | SNT-003, SNT-007, SNT-012                    |
| Blocks         | Run API, knowledge UI, verification planning |
| PRD references | §6.3, §8.1–8.3, §18.2–18.3, FR-001–FR-002    |

## Background

Onboarding is a product workflow, not a YAML requirement. Users connect the three persistent sources—application, documentation, repository—plus auth and safe boundaries. Compatibility must be inspected before expensive/agentic work begins.

## Scope

- Applications list/create/configure UI.
- Source, immutable commit/branch, docs roots/paths, GitHub installation placeholder, application/head URL configuration.
- Authentication methods: none, email/password-equivalent fields, encrypted storage-state fallback.
- Restricted secret references via Supabase Vault or envelope-encrypted server store; never ordinary rows.
- Crawl policies: hosts/protocols/actions/screens/time, form submission, destructive/payment/message/privilege denials.
- Target test-data/setup reference fields without Sentinel owning target seed semantics.
- Deterministic repository/document/application readiness probes and adapter report.
- Scope proposal/confirmation and status transitions.

## Implementation tasks

- [x] Build server-validated onboarding wizard and application list/detail shell.
- [x] Add dynamic auth fields by method without Hi.Events-specific UI conditionals.
- [x] Implement secret create/update/delete/reference service and redaction.
- [x] Add repository/commit, documentation, and application reachability probes.
- [x] Integrate repository inspector/adapters and Playwright readiness checks.
- [x] Show detected technologies, warnings, blockers, missing human actions, and proposed scope.
- [x] Persist normalized configuration and require explicit confirmation before initialization.
- [x] Add edit/reinspect behavior that marks current knowledge stale when relevant inputs change.
- [x] Enforce server-side authorization even though take-home tenancy may be simple.

## Acceptance criteria

- User can onboard without authoring YAML.
- Credentials never appear in application/source/run records, client responses after submission, logs, or model context.
- Compatibility accurately reports Hi.Events TS/React, PHP/Laravel, OpenAPI, and Playwright indicators from evidence.
- Unreachable/unsupported/misaligned inputs block initialization with human action.
- Destructive/payment/message/privilege actions default to denied.
- Changing commit/docs/application/auth/safety inputs triggers correct stale/reinspection behavior.
- UI is accessible and preserves non-secret form state on validation errors.

## Required tests

- Form/server validation and URL/host/policy tests.
- Secret persistence/redaction/rotation/deletion tests.
- Compatibility fixtures for supported, partial, and blocked targets.
- Stale-state transition tests.
- Browser tests for complete onboarding and errors.
- Security test proving browser bundle/API cannot access privileged Supabase/Neo4j/model secrets.

## Out of scope

GitHub App registration flow, running initialization graph, target-owned seed implementation, production multi-tenancy/billing, and preview hosting.

## Implementation notes

- Public contracts and canonical configuration fingerprints live in `packages/contracts/src/operations.ts`.
- `packages/adapters/src/onboarding/compatibility.ts` rejects unapproved repository identities before checkout, resolves a bounded immutable GitHub commit, cites installed-stack evidence, probes documentation through the DNS-pinned URL policy, and verifies the application with a DNS-pinned Playwright page load whose HTTP and WebSocket traffic stays on the approved origin.
- `supabase/migrations/20260908000100_onboarding_control_plane.sql` and `packages/storage/src/onboarding-repository.ts` store owner-scoped reference-only configuration, compatibility, confirmation, and stale state. Existing `TargetSecretService` uses Supabase Vault for create/resolve/rotate/delete.
- `apps/web/proxy.ts` enforces a configured operator token before control-plane access, and `apps/web/app/actions.ts` repeats the request check. `apps/web/lib/control-plane.ts` owns server-side authorization and secret reconciliation; `apps/web/components/onboarding-control-plane.tsx` renders the application rail and source/access/safety/review workflow.
- Protected targets require explicit operator confirmation that login can be automated without CAPTCHA or human verification. Relevant source, deployment, documentation, authentication, preview, setup, and safety changes invalidate confirmation. The server reconstructs the submitted configuration before confirmation; name-only edits preserve current readiness.
- The fixed action denials cover destructive actions, real payments, external messages, and privilege changes. The browser never receives secret references or privileged environment values.
- Verified with focused contract/storage/adapter/web tests, the real off-origin WebSocket readiness integration, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`, and `pnpm test:browser` (4 Chromium tests).
- GitHub App registration/exchange, initialization execution, target-owned seed/reset behavior, production multi-tenancy, and preview hosting remain outside this issue.
