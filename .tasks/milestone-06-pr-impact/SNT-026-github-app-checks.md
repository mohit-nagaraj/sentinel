# SNT-026 — GitHub App webhook ingestion and check lifecycle

| Field          | Value                                       |
| -------------- | ------------------------------------------- |
| Milestone      | M6 — Pull-request blast-radius product loop |
| Status         | `done`                                      |
| Depends on     | SNT-003, SNT-007, SNT-023                   |
| Blocks         | PR investigation and report delivery        |
| PRD references | §7.2, §13.3, §16, FR-012                    |

## Background

The normal product trigger is a GitHub App `pull_request` webhook. Sentinel must authenticate raw deliveries, deduplicate them, create one check per head assessment, and link concise GitHub status to the detailed dashboard without repository-content writes.

## Scope

- Single-fork MVP GitHub App registration/configuration support.
- App JWT and installation token acquisition/refresh.
- Raw-body HMAC-SHA256 `X-Hub-Signature-256` validation with constant-time comparison.
- `X-GitHub-Delivery` idempotency.
- Pull-request events: opened, reopened, synchronize, ready_for_review; ignore unsupported/draft state by policy.
- Assessment enqueue/supersession and one check run per current head.
- Check states/conclusions and redacted dashboard link.
- Manual PR URL fallback through same assessment service.
- Rerequest/update behavior as time permits, without comments.

## Permissions

- Contents: read
- Pull requests: read
- Checks: write

No contents/branch/issue/pull-request/administration write permission.

## Implementation tasks

- [x] Add secure App config/private-key/webhook-secret loaders.
- [x] Add raw request body handling before JSON parsing.
- [x] Verify signature, event type/action, installation, repository, sender, and delivery ID.
- [x] Persist delivery and enqueue transactionally/idempotently.
- [x] Create/update check with head SHA and dashboard external URL.
- [x] Map queued/running/success/neutral/failure/action-required/infrastructure failure semantics.
- [x] Supersede prior head run on `synchronize` and prevent stale completion from overwriting latest check.
- [x] Implement manual URL path using identical service.
- [x] Add webhook/check diagnostics without leaking secrets/payload PII.

## Acceptance criteria

- Invalid/missing signatures are rejected before side effects.
- Duplicate delivery creates no duplicate run/check.
- Supported events enqueue one assessment for correct immutable head.
- New head supersedes old work and stale results cannot update the latest check.
- Check links to canonical Sentinel report and does not confuse predicted risk with test failure.
- App can read source/PR and write checks but cannot modify source or PR content.
- Webhook responds quickly; long analysis is worker-owned.
- Manual and webhook triggers yield the same assessment contract.

## Required tests

- Official/recorded payload fixtures for each supported/ignored action.
- Signature valid/invalid/body-mutation/constant-time helper tests.
- Delivery idempotency and concurrent duplicate tests.
- Synchronize/head supersession/race tests.
- Installation token/check API contract tests with mock server.
- Permission/documentation assertion test.
- Manual URL parity test.

## Out of scope

Marketplace/public multi-org install UX, PR comments, source writes, branch protection configuration, and preview deployment creation.

## Implementation notes

- Contracts: `packages/contracts/src/github-app.ts`.
- Raw HMAC, secure key/JWT loading, scoped installation-token cache, PR metadata, and Checks API: `packages/adapters/src/source/github/github-app.ts`.
- Transactional delivery/assessment/run/check state: `supabase/migrations/20260908000400_github_app_checks.sql` and `packages/storage/src/github-assessment-repository.ts`.
- Shared service and routes: `apps/web/lib/github-assessments.ts` and `apps/web/app/api/github/[[...path]]/route.ts`.
- Recorded action fixtures: `tests/fixtures/github/pull-request-events.json`.
- Default verification: format, lint, typecheck, 93 files/932 tests, and all production builds passed on 2026-09-09.
- Database verification: the focused race suite passed against the local disposable Supabase database and a separate clean Supabase-shaped database; database lint found no SNT-026 issue.
- Review hardening confirms the signed delivery head against current GitHub PR metadata, normalizes replay of superseded deliveries to a stale result, and recovers a missing initial check during lifecycle publication.
- `check_run.rerequested` remains deferred. The optional action requires a successful-run replay contract; normal check create/update lifecycle is complete without PR comments.
