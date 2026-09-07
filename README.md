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

## Knowledge Graph Storage

Neo4j Aura stores the active product-knowledge graph. The storage package owns a
shared server-only driver, managed transactions, idempotent schema constraints,
and parameterized fact repositories. Node labels and relationship types come
only from contract-backed allowlists; application IDs, stable keys, revisions,
and properties are always bound parameters.

Graph integration tests are skipped unless `RUN_NEO4J_INTEGRATION_TESTS=1` and
`SENTINEL_NEO4J_TEST_PREFIX=sentinel-test-<8-32 lowercase hex characters>` are
set. Cleanup requires both the generated application ID and matching test marker,
so it cannot delete another application namespace in the shared Aura database.

## Model Gateway

`@sentinel/adapters` exposes a provider-neutral model gateway backed by the
official OpenAI TypeScript client and Azure's `/openai/v1/` Responses endpoint.
Calls use the configured deployment name as `model`, set `store: false`, enforce
strict schemas/tools and per-call limits, and return redacted typed failures.
The scripted gateway supplies deterministic multi-turn trajectories for normal
tests without provider credentials.

The paid compatibility probe is skipped unless
`RUN_AZURE_OPENAI_COMPATIBILITY=1` is set. Its output-token cap is controlled by
`AZURE_OPENAI_COMPATIBILITY_MAX_TOKENS` and validation never permits more than
1,024 tokens per call.

## Durable Orchestration

`@sentinel/orchestration` owns custom LangGraph.js workflows. Every invocation
uses the contract run ID as `thread_id`; PostgresSaver is initialized only in the
fixed `langgraph_checkpoint` schema reserved by the Supabase migration. That
schema remains outside browser-facing access. Operational ownership, leases,
cancellation, and ordered UI events stay in the `sentinel` schema.

Checkpoint state is limited to validated IDs, counters, budgets, bounded
summaries, references, and pending decisions. Live clients, browser/page objects,
documents, source/DOM, prompts, credentials, and oversized payloads are rejected.
Node wrappers recheck run ownership before side effects, retry only explicit
transient failures, sanitize checkpointed errors, and project redacted lifecycle
events into durable run events only after node state commits. Concurrent resume
attempts are serialized by a bounded, error-handled PostgreSQL pool and a
transaction-scoped advisory lock; contradictory repeats return a conflict.

Do not deploy incompatible node names, routing, or checkpoint-state schemas while
threads are interrupted or failed. Drain/resume those threads on the prior graph,
or publish a versioned graph/checkpoint namespace and run an explicit validated
state migration. Never reinterpret an in-flight checkpoint implicitly.

## Documentation Evidence Maps

`@sentinel/adapters` prepares deterministic documentation maps from approved web
roots or Markdown in an immutable GitHub checkout snapshot. Web crawls use a
disposable Crawlee request queue, robots and sitemap discovery, bounded retries,
and page/byte/time caps. Production roots require HTTPS; links, canonical hints,
redirects, and configured Playwright rendering remain inside the approved
origin/path set. Literal and DNS-resolved private or reserved addresses are
rejected at the transport boundary. The HTTP/private-network options exist only
for isolated fixtures.

HTML extraction prefers explicit `main`/`article` content, uses Readability as a
fallback, and sanitizes the retained markup with DOMPurify. Markdown is parsed to
mdast from repository files tied to the checkout commit. Both paths yield the
same contract-backed document source/page/section facts, exact excerpts with
offsets into sanitized canonical text, stable hashes, and `LINKS_TO` edges. Raw
responses, DOMs, ASTs, and checkouts are disposable.

`DocumentationMapIndex` provides bounded tree, list, lexical search,
read-section, and linked-page operations over prepared IDs only. The second
Supabase migration adds private map/page/section/link tables;
`DocumentMapRepository.replace` transactionally stores sanitized facts and
coverage metadata. Raw pages are not uploaded as artifacts by default; callers
must make a separate evidence-retention decision before using private Storage.
