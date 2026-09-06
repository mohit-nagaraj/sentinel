# Sentinel

Sentinel is a pnpm TypeScript workspace with strict, versioned contracts for its
application, evidence, agent, graph, and assessment boundaries. Provider
integrations and product behavior belong to later issues.

## Prerequisites

- Node.js 22.17.0 (pinned in `.nvmrc` and `.node-version`)
- pnpm 11.15.1 through Corepack

```sh
corepack enable
pnpm install --frozen-lockfile
```

No environment variables are required for default development, tests, or
builds. `.env.example` lists reserved names without credentials.

## Workspace

- `apps/web` - Next.js control application based on shadcn preset `b7Br7G7Ci`
- `apps/worker` - independently runnable Node.js worker process
- `docs` - existing Nextra documentation application
- `packages/contracts` - shared cross-process contracts
- `packages/orchestration` - orchestration boundary
- `packages/adapters` - source adapter boundary
- `packages/storage` - storage boundary
- `tests/fixtures` - deterministic shared test fixtures

Run applications independently:

```sh
pnpm dev:web
pnpm dev:worker
pnpm --filter @sentinel/worker health
```

## Quality Commands

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The default `test` command runs deterministic unit, web, and worker projects.
The remaining suites are separate by intent and directory:

- `pnpm test:integration` - disposable local service integration tests
- `pnpm test:graph` - deterministic whole-graph and path tests
- `pnpm test:agent` - recorded-fixture agent and evaluation tests
- `pnpm test:browser` - Playwright tests against an isolated local web server
- `pnpm test:live` - explicitly opted-in tests that may contact live providers

Place reusable deterministic inputs in `tests/fixtures`. Live tests must stay in
`tests/live` and must never be imported by a default test project.

## Shared Contracts

`@sentinel/contracts` exports Zod 4 schemas and inferred types for applications,
sources, runs, missions/results, document/code/browser facts, evidence links,
coverage, PR changes/findings, verification, and redacted run events. Persisted
and cross-process payloads carry `schemaVersion: 1` and reject unknown fields.

Stable graph identities are SHA-256 hashes of recursively canonicalized,
versioned inputs. Use `createStableKey` with one of the entity-specific input
variants; do not construct graph IDs from ad hoc strings. Evidence and workflow
identifier builders validate structured application/run scopes before hashing.
Public URL identities reject credential-bearing parameters, sort benign query
parameters, and discard fragments before persistence and hashing. Persisted
mission/event prose rejects ambiguous credential assignment/header syntax with
an actionable rephrase-or-redact error; raw values are never silently retained.

Sanitized wire fixtures live in `tests/fixtures/contracts`. Focused checks run
with:

```sh
pnpm --filter @sentinel/contracts typecheck
pnpm exec vitest run --project unit
```

## Operational Storage

The `@sentinel/storage` package owns server-only Supabase operational state,
Vault references, and private artifact access. Apply versioned SQL from
`supabase/migrations`; the initial migration creates the private `sentinel`
schema, reserves `langgraph_checkpoint`, enables RLS, revokes browser-role table
access, and installs lease-safe queue/event/assessment functions.

Long-lived workers should use the direct Postgres connection string. Serverless
web handlers may use Supabase's transaction pooler; Postgres.js prepared
statements are disabled so transaction-pooler connections remain compatible.
`SUPABASE_DB_URL` and all S3/Vault credentials stay server-side.

Artifact operations use the configured private Supabase S3 endpoint. Metadata
contains hashes, MIME/size, object keys, references, and retention only; signed
downloads are capped at 15 minutes. Target credentials are encrypted in Vault,
while application/source rows retain only opaque `secret-ref:v1:*` references.

Database, Storage, and Vault integration tests are skipped unless their explicit
`RUN_SUPABASE_*_TESTS=1` flags are set. Database tests additionally require
`SENTINEL_TEST_DATABASE_URL`, and the loader rejects it when it equals the normal
`SUPABASE_DB_URL`.
