# SNT-022 — Application onboarding, compatibility, auth, and safety configuration

| Field | Value |
|---|---|
| Milestone | M5 — Onboarding and observable control plane |
| Status | `not-started` |
| Depends on | SNT-003, SNT-007, SNT-012 |
| Blocks | Run API, knowledge UI, verification planning |
| PRD references | §6.3, §8.1–8.3, §18.2–18.3, FR-001–FR-002 |

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

- [ ] Build server-validated onboarding wizard and application list/detail shell.
- [ ] Add dynamic auth fields by method without Hi.Events-specific UI conditionals.
- [ ] Implement secret create/update/delete/reference service and redaction.
- [ ] Add repository/commit, documentation, and application reachability probes.
- [ ] Integrate repository inspector/adapters and Playwright readiness checks.
- [ ] Show detected technologies, warnings, blockers, missing human actions, and proposed scope.
- [ ] Persist normalized configuration and require explicit confirmation before initialization.
- [ ] Add edit/reinspect behavior that marks current knowledge stale when relevant inputs change.
- [ ] Enforce server-side authorization even though take-home tenancy may be simple.

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

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
