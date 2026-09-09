# Sentinel

Sentinel is a pnpm TypeScript workspace with strict, versioned contracts for its
application, evidence, agent, graph, assessment, and onboarding boundaries. Its
Next.js control plane connects an application, repository, documentation,
authentication method, and bounded browser-safety policy before initialization.

## Prerequisites

- Node.js 22.17.0 (pinned in `.nvmrc` and `.node-version`)
- pnpm 11.15.1 through Corepack

```sh
corepack enable
pnpm install --frozen-lockfile
```

No environment variables are required for default tests or builds. The durable
worker requires its database, graph module, and health settings from
`.env.example`; provider credentials remain optional until their workflows run.

## Fastest reproducible review

The repository has two review paths. The deterministic path is complete,
credential-free, and appropriate for a clean clone. The external-service path is
optional and proves individual provider adapters only when the reviewer supplies
their own isolated resources.

From a clean clone:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm delivery:check
pnpm security
pnpm demo:web
```

Open `http://localhost:3000`. `demo:web` sets only
`SENTINEL_CONTROL_PLANE_FIXTURE=1`; outside production that flag enables the
resettable, in-memory onboarding, run-activity, evidence-path, absence, and review
fixtures without authentication or provider credentials. Stop and restart the
command to reset fixture state.

Use these review surfaces in order:

1. `/` - inspect and confirm the bounded Hi.Events onboarding configuration.
2. `/runs` - open the fixture run and inspect Documentation, Code, Application,
   and Curator activity without hidden reasoning.
3. `/knowledge` - open Hi.Events checkout coverage, a complete evidence path,
   and the explicit promotion-code absence/ambiguity case.
4. `/assessments/00000000-0000-4000-8000-000000000029` - inspect the product
   report dashboard, evidence drill-down, unknowns, download, and print surface.
5. [`docs/delivery/sample-report-hi-events-pr-1338.md`](docs/delivery/sample-report-hi-events-pr-1338.md)
   - read product-rendered deterministic fallback Markdown for real PR #1338.
6. [`DESIGN.md`](DESIGN.md) - review architecture, graph semantics, evaluation,
   security, scope cuts, and next-week priorities.

Current capability is deliberately narrow:

| Surface                                                                                                                         | Status in this revision                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Deterministic source/browser adapters, specialist kernels, graph reconciliation, blast-radius scoring, eval, and security gates | Implemented and covered by CI                                                                      |
| Resettable control-plane demo                                                                                                   | Implemented with deterministic in-memory fixtures                                                  |
| Trusted Render deployment identity and verification planning                                                                    | Implemented; no assignment PR-head deployment is registered                                        |
| Product report delivery/dashboard (SNT-029)                                                                                     | Implemented with grounded wording, private persistence, API/UI, GitHub summary, and print behavior |
| Dynamic PR-head verification (SNT-031)                                                                                          | Not implemented; report status is `verification_unavailable`                                       |
| Incremental post-deployment refresh (SNT-032)                                                                                   | Implemented with scoped reuse/invalidation and atomic publication                                  |

The committed sample passes its structured data through the product report view
contract and canonical renderer. Do not describe that deterministic fixture as a
live model, persisted Neo4j assessment, or browser-verification result; the same
pipeline supports persisted reports while this reproducible artifact keeps
provider and private-service requirements out of the clean-clone path.

## Optional external-service setup

Copy `.env.example` to a local ignored environment file and fill only the
services you intend to exercise. Never commit the populated file. Each provider
adapter fails closed when its required configuration is absent.

### Supabase and migrations

Docker (or a compatible container runtime) is required for local Supabase. The
repository already contains `supabase/config.toml` and ordered migrations, so do
not run `supabase init` again.

```sh
pnpm dlx supabase@2.117.0 start
pnpm dlx supabase@2.117.0 db reset
pnpm dlx supabase@2.117.0 status
```

`db reset` destroys only the local Supabase database and reapplies every tracked
migration; never add `--linked` for this review. Map the printed local values to
`SUPABASE_DB_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and the S3 fields
named in `.env.example`. `sentinel-artifacts` is declared private in
`supabase/config.toml`.

### Neo4j Aura

Create a disposable Aura database and set `NEO4J_URI`, `NEO4J_USERNAME`,
`NEO4J_PASSWORD`, and `NEO4J_DATABASE`. Integration cleanup is disabled unless
both `RUN_NEO4J_INTEGRATION_TESTS=1` and a unique
`SENTINEL_NEO4J_TEST_PREFIX=sentinel-test-<8-32 lowercase hex>` are present.
Never point tests at a production graph.

### Azure OpenAI

Set `AZURE_OPENAI_ENDPOINT` to the Azure resource `/openai/v1/` base,
`AZURE_OPENAI_API_KEY` to a server-only key, and `AZURE_OPENAI_DEPLOYMENT` to the
deployment name. The default suites use scripted model gateways. The paid probe
runs only when `RUN_AZURE_OPENAI_COMPATIBILITY=1` and caps output with
`AZURE_OPENAI_COMPATIBILITY_MAX_TOKENS`.

### GitHub App

Install the App only on the selected repository with Contents read, Pull requests
read, and Checks write. Subscribe only to `pull_request`, point the webhook to
`https://<sentinel-origin>/api/github/webhooks`, and configure the six
names `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_INSTALLATION_ID`,
`GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_APP_WEBHOOK_SECRET`, and
`SENTINEL_PUBLIC_BASE_URL`. The private key path must reference an ignored regular
PEM file outside the repository.

### Worker and optional Render proof

The worker requires `SUPABASE_DB_URL`, `SENTINEL_WORKER_ID`, and an injected
`SENTINEL_WORKER_GRAPH_MODULE` exporting `createRunGraphs`. This repository does
not ship the final production graph assembly, so the deterministic UI demo does
not start the worker. Health endpoints can still be exercised package-locally.

Render identity proof is opt-in. Supply a disposable preview and the
`RENDER_*` values from `.env.example`; no Sentinel, GitHub App, Supabase,
production application, payment, or mail credential may be injected into the
untrusted PR service.

## Safe, integration, and live checks

Default-safe commands use no paid model, public target, or live credential:

```sh
pnpm delivery:check
pnpm security
pnpm exec vitest run --project unit --project web --project worker
pnpm test:agent
pnpm test:graph
pnpm test:integration
pnpm test:browser
```

Integration projects remain skipped unless their explicit disposable-service
flags are set. Live commands require deliberate flags and trusted isolated
resources:

```sh
RUN_LIVE_TESTS=1 pnpm test:live
RUN_LIVE_TESTS=1 RUN_CODE_EXPLORER_HI_EVENTS=1 pnpm test:live -- tests/live/code-explorer-hi-events.live.test.ts
RUN_LIVE_TESTS=1 RUN_RENDER_DEPLOYMENT_SMOKE=1 pnpm test:live -- tests/live/render-deployment-verification.live.test.ts
```

PowerShell users set environment variables with `$env:NAME = "value"` before
running the command. The live umbrella alone does not enable the paid Azure,
Hi.Events mission, or Render identity cases; their additional flags and required
configuration must also be present.

## Teardown and troubleshooting

```sh
pnpm dlx supabase@2.117.0 stop
```

Stop the web and worker with `Ctrl+C`. Delete disposable Aura/Render resources in
their provider consoles and revoke temporary provider/test credentials. Do not
use `supabase stop --no-backup`, delete a shared graph namespace, or close a
preview before retaining any sanitized evidence needed for the demo.

Common failures:

| Symptom                            | Resolution                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Control plane returns 503          | Use `pnpm demo:web`, or configure `SENTINEL_OPERATOR_TOKEN` and backend services for non-fixture mode.         |
| Readiness is degraded              | Inspect `/api/control/readiness`; missing services remain explicit and do not become fabricated success.       |
| Worker refuses to start            | Supply a real `SENTINEL_WORKER_GRAPH_MODULE`; it is intentionally absent from the deterministic demo.          |
| Supabase integration tests skip    | Set the matching `RUN_SUPABASE_*` flag and a disposable `SENTINEL_TEST_DATABASE_URL`.                          |
| Neo4j cleanup is denied            | Use a unique valid test prefix and matching generated application namespace.                                   |
| Render verification is unavailable | Register an exact live deploy/head SHA, or keep the honest `verification_unavailable` result.                  |
| Sample report changed              | Run `pnpm delivery:sample`, review the JSON source and regenerated Markdown, then rerun `pnpm delivery:check`. |

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

## Application Onboarding

The web control plane lists connected applications and provides a four-step
source, access, safety, and review workflow. Operators supply normal form fields;
the product does not require YAML. Authentication supports public flows, generic
credential fields, or encrypted Playwright storage state. Submitted secrets are
converted to opaque Supabase Vault references and never returned to the browser.
Protected targets require the operator to confirm that automated login succeeds
without CAPTCHA or mandatory human verification before compatibility can pass.

Compatibility inspection resolves the configured GitHub branch or commit to an
immutable SHA, reads only the bounded checkout, and reports cited evidence for
TypeScript/React, PHP/Laravel, Laravel routes, OpenAPI/Scramble, and Playwright.
Documentation and application URLs pass DNS/private-network, protocol, origin,
redirect, timeout, and byte limits before browser readiness is accepted. The
readiness browser pins the approved hostname resolution and applies the same
origin policy to HTTP and WebSocket traffic.

The proposed scope must be confirmed against the current submitted configuration
fingerprint. Blockers prevent confirmation, and editing any inspected field hides
confirmation until reinspection succeeds. Relevant source, authentication, or
safety edits invalidate confirmation and mark published knowledge stale; name-only
edits preserve readiness. Confirmation does not enqueue initialization.

Long-running commands use the authenticated `/api/control` boundary and return a
durable run immediately. The supported routes are:

- `POST /api/control/runs` - enqueue one of the six typed run commands.
- `GET /api/control/runs` - list owned runs with `limit`, `cursorCreatedAt`, and
  `cursorId`; add `applicationId` to filter.
- `GET /api/control/runs/:id` and `/events` - read an owned run and its ordered
  event page (`after`, `limit`).
- `GET /api/control/runs/:id/realtime` - obtain a four-minute owner JWT and its
  private `run:<uuid>` Broadcast topic.
- `GET /api/control/runs/:id/artifacts/:artifactId` - obtain a five-minute URL
  for a PNG/JPEG screenshot belonging to the same owned run.
- `POST /api/control/runs/:id/pause`, `/cancel`, and `/retry` - pause at the next
  safe boundary, request cooperative stop, or create a linked attempt for a
  retryable terminal failure.
- `GET /api/control/runs/:id/interrupt` and
  `POST /api/control/runs/:id/interrupts/:decisionId/respond` - read and answer a
  bounded human decision exactly once.
- `GET /api/control/readiness` - inspect redacted storage, worker, model,
  browser, and GitHub readiness.

Every route repeats operator authentication and storage ownership checks. API
responses are private/no-store DTOs and never include request payloads,
idempotency keys, leases, checkpoint state, or provider error details.

The `/runs` workspace projects canonical Postgres events into independent
Documentation, Code, and Application lanes plus Curator reconciliation. Private
Supabase Broadcast messages contain only the run ID and, for event wakes, its
sequence; lifecycle wakes contain no event content. They wake a serialized
catch-up loop and run snapshot refresh rather than acting as storage. Reload and
reconnect merge ordered pages by sequence, reject gaps or conflicting duplicates,
and refresh run/interrupt state. The workspace distinguishes decisions, policy,
tools, browser actions, requests, evidence, budgets, interrupts, failures, and
completion without rendering prompt text, hidden reasoning, selectors, full DOM,
or executable markup.

Production control-plane access requires the existing server-only
`SUPABASE_DB_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, private artifact
S3 settings, optional read-only `GITHUB_TOKEN`, and a server-derived
`SENTINEL_OPERATOR_ID` UUID. Configure `SUPABASE_REALTIME_SIGNING_JWK` with an
ES256/RS256 private JWK matching the project signing key. `SUPABASE_JWT_SECRET`
is a legacy HS256 fallback for local Supabase development only.
`SENTINEL_OPERATOR_TOKEN` must contain at least 32
characters; the Proxy challenges browsers with HTTP Basic and every Server Action
independently accepts only that Basic credential or an exact Bearer token.
`SENTINEL_CONTROL_PLANE_FIXTURE=1` exists only for the isolated Playwright suite
and must not be enabled in a production deployment.

The durable worker loads a server module named by
`SENTINEL_WORKER_GRAPH_MODULE`. That module must export
`createRunGraphs({ databaseUrl, workerId })` and return handlers for all six run
types, each with `hasCheckpoint`, `hasPendingInterrupt`, `start`, `continue`, and
`resume` methods. Lease reclaim checks checkpoint existence before choosing
`start` or `continue` with the same run identity. A stored response calls
`resume` only while its exact interrupt remains pending; otherwise execution
continues from the newer checkpoint. Successful handlers return a typed
terminal publication that storage commits atomically with run/application state.
SIGINT/SIGTERM and cancellation abort the execution signal and run registered
cleanup callbacks before ownership is released. The worker serves
`/health` and `/readiness` on `SENTINEL_WORKER_HEALTH_HOST` and
`SENTINEL_WORKER_HEALTH_PORT`; configure the web probe with the full
`SENTINEL_WORKER_HEALTH_URL`.

Control-plane readiness is healthy only when storage and every worker/model/
browser/GitHub health URL is configured, reachable, and returns a small JSON
payload with `status: "ok"` or `status: "ready"`.

## GitHub App PR Assessments

Register the single-repository GitHub App with only these repository
permissions:

- Contents: read
- Pull requests: read
- Checks: write

Subscribe only to `pull_request`. Sentinel handles `opened`, `reopened`,
`synchronize`, and `ready_for_review`; unsupported actions and draft PRs do not
enqueue analysis. The App does not request permission to write contents, pull
requests, issues, administration settings, or comments.

Configure these server-only values:

- `GITHUB_APP_ID` and `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_INSTALLATION_ID` for the default single-fork installation
- `GITHUB_APP_PRIVATE_KEY_PATH`, an absolute path to a regular RSA PEM file
- `GITHUB_APP_WEBHOOK_SECRET`, a high-entropy value of at least 32 characters
- `SENTINEL_PUBLIC_BASE_URL`, the canonical HTTPS Sentinel origin used by check
  details links; loopback HTTP remains valid for local development

`POST /api/github/webhooks` authenticates the exact bounded request bytes with
`X-Hub-Signature-256` before parsing. It validates `X-GitHub-Delivery`, event,
action, installation, repository, sender, PR, base SHA, head SHA, and provider
timestamp. Before enqueue, Sentinel resolves current PR metadata through the
installation and ignores a delivery whose head is no longer current. PostgreSQL
then records the delivery, creates or reuses the immutable-head assessment, and
enqueues the `assess_pr` run atomically. A newer head cancels the prior run; an
older delivery and any replay of its delivery ID remain non-current.

Sentinel creates one `Sentinel blast radius` check per assessment/head and uses
the assessment UUID as `external_id`. A durable short lease prevents concurrent
creation, while recovery searches the head for that external ID after a partial
failure. Later lifecycle publication also recovers a missing initial check before
updating it. Check updates require the same assessment and head to remain current.
Predicted risk, unknown scope, and unavailable verification use a neutral
conclusion; deterministic verification failure uses failure, and infrastructure
failure is explicitly labelled as analysis failure.

`POST /api/github/assessments` is the operator-authenticated manual fallback. It
accepts `schemaVersion`, `applicationId`, and a canonical public GitHub PR URL,
resolves current PR metadata through the configured installation, and invokes
the same assessment service and budget as the webhook path.

The deterministic GitHub suites need no provider credentials. The PostgreSQL
race test uses the existing disposable integration settings:

```sh
pnpm exec vitest run packages/contracts/src/github-app.test.ts packages/adapters/src/source/github/github-app.test.ts apps/web/lib/github-assessments.test.ts "apps/web/app/api/github/[[...path]]/route.test.ts" --project unit --project web
RUN_SUPABASE_INTEGRATION_TESTS=1 SENTINEL_TEST_DATABASE_URL=postgresql://... pnpm exec vitest run tests/integration/github-app-assessment.integration.test.ts --project integration --maxWorkers=1
```

## Assessment reports and incremental refresh

SNT-029 turns blast-radius results into a strict `AssessmentReportView` with
mandatory identity, product-area, UI, workflow, requirement, evidence, QA,
verification, unknown/exclusion, and generation sections. Model wording may only
select exact supplied choices and complete citation sets; invalid or unavailable
wording falls back to the deterministic renderer. Markdown is stored privately,
current-head finalization is compare-and-set/idempotent, and verification can be
appended only as a versioned enrichment.

The authenticated dashboard is `/assessments/:assessmentId`. Its API returns the
owner-scoped view, a five-minute signed Markdown download, and bounded private
artifact excerpts. The fixture report is available in `demo:web` at:

```text
http://localhost:3000/assessments/00000000-0000-4000-8000-000000000029
```

The committed PR #1338 sample uses the same view schema and canonical renderer:

```sh
pnpm delivery:sample
```

SNT-032 implements post-deployment refresh as a separate checkpointed graph. It
validates trusted deployed commit ancestry, plans changed document/TS/PHP/OpenAPI
and affected workflow scope, reuses unchanged stable facts, invalidates
incompatible reviewed links, reassesses coverage, retains immutable assessment
artifacts, and atomically activates a validated pending revision. Failed or
cancelled refresh leaves the prior active graph and indexed commit untouched.

## Evaluation harness

`@sentinel/evaluation` validates the sanitized Hi.Events PR #1338 golden set and
scores facts, citations, positive/negative graph links, evidence paths, visible
unknowns, blast-radius impact and controls, tool trajectories, terminal behavior,
and budgets. Targets can run at whole-graph, node, seeded-partial, or checkpoint
scope; expected labels are not passed across the target boundary.

Generate the no-network deterministic 100-run baseline and run focused checks:

```sh
pnpm --filter @sentinel/evaluation baseline
pnpm exec vitest run --project unit packages/evaluation/src
pnpm --filter @sentinel/evaluation typecheck
```

The committed reports in `docs/evaluation/` are harness-conformance evidence,
not live-model quality claims. Model-backed runs require an estimated usage/cost
record plus the exact `PAID_EVALUATION_CONFIRMATION` token before execution, and
their actual usage is reported separately. See `docs/evaluation/README.md` for
the split, repetition, and 100-run scaling protocol and
`docs/evaluation/qa-report-rubric.md` for the human worksheet.

## Quality Commands

The deterministic security gate scans secrets/ignored files, validates production
advisories and licenses against expiring exact policy entries, runs the malicious
boundary matrix, and regenerates the 100-run evaluation baseline without live
credentials:

```sh
pnpm security
```

See `docs/security/threat-model.md` for trust boundaries, fault recovery, and
explicit demo limitations, and `docs/security/security-policy.md` for the
dependency/license exception policy.

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

## Shared Specialist Kernel

`@sentinel/orchestration` provides one LangGraph kernel for Documentation, Code,
and Application specialists. A kernel configuration fixes the specialist
identity, permitted mission modes, prompt/model/toolset/completion-validator IDs,
described tool registry, no-progress limit, and recursion limit. The canonical
configuration fingerprint is stored with the mission checkpoint, so a resumed
thread cannot silently switch prompts, tools, models, validators, or limits.

Specialist state contains only the mission, compact decisions, call hashes,
evidence/reference IDs, correlated budget entries, progress fingerprints, bounded
human-interrupt data, committed-event cursors, and a terminal `MissionResult`.
Rich source slices, browser observations, DOM state, prompts, raw tool output, and
credentials remain behind injected durable ports. The aggregate checkpoint and
each tool argument payload have independent byte limits.

Every model decision is classified as provider-backed or deterministic. Provider
decisions consume exactly one model call; deterministic reconstruction consumes no
model tokens. Tool calls pass strict schemas, fixed agent/mode permissions,
mission allowlists, scope checks, state correlation, duplicate-call checks, and
preflight budget reservation before execution. Production registries require an
explicit durable execution coordinator. Completed calls, conservative uncertain
failures, and budget entries are checkpointed together and replay by call ID.

State-changing nodes are followed by committed-event nodes. Durable run events use
idempotency keys so event-sink or checkpoint retries cannot publish contradictory
decision, tool, evidence, budget, interrupt, or terminal history. Mission start,
continue, and resume are serialized per mission, guarded by the current run lease,
and recover abandoned nonterminal checkpoints. Human resume requires an authorized
matching decision on the same thread and exposes only decision, reason, and
approval state to the next model decision.

Run focused kernel checks with:

```sh
pnpm vitest run --project unit packages/orchestration/src/specialist packages/orchestration/src/runtime.test.ts
pnpm test:agent
```

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

## TypeScript and React Source Index

`@sentinel/adapters` turns a TypeScript/React source tree into deterministic
structural facts: files, symbols, imports, call and reference edges, React Router
routes with their rendered component ancestry, JSX accessible hints, event
handler bindings, React Query hooks, and normalized frontend API call templates.
`createTypeScriptIndexQuery` exposes the bounded read-only surface the Code
Explorer navigates, and `indexTypeScriptSource` returns
`parseCodeFactEnvelope`-valid envelopes for the fact kinds `@sentinel/contracts`
models today.

Source is read only through a narrow reader port that a read-only GitHub
checkout snapshot already satisfies, and admitted files are loaded into an
in-memory compiler host. Excluded, vendored, generated, locale, and out-of-root
files are therefore absent from the compiler host rather than filtered after the
fact, and no repository code, build plugin, or bundler config is ever evaluated.
Computed route paths, dynamic components, computed handlers, substituted labels,
and computed request paths record a reason code instead of a guess.

The public smoke test is skipped unless both `RUN_LIVE_TESTS=1` and
`RUN_TYPESCRIPT_INDEX_SMOKE=1` are set:

```bash
RUN_LIVE_TESTS=1 RUN_TYPESCRIPT_INDEX_SMOKE=1 \
  pnpm vitest run --project live tests/live/typescript-source-index.live.test.ts
```

## Endpoint Evidence Normalization

`@sentinel/adapters` provides a versioned endpoint identity and a constrained
OpenAPI 3.0/3.1 importer. HTTP method plus normalized path shape form the shared
identity; origins, query strings, fragments, redundant slashes, and parameter
names do not. Base paths and optional deployment/version prefixes are applied
only when explicitly supplied by the caller.

The importer accepts caller-supplied JSON, YAML, or plain objects under byte,
node, operation, string, YAML-alias, and local-reference limits. It rejects
every non-fragment `$ref` before resolving bounded local JSON Pointers and never
uses filesystem or network resolvers. Imported operations retain operation ID,
tags, request/response schema references, source hash, source URI, optional
commit, and extractor version in contract-validated endpoint facts.

Adapters turn existing TypeScript API candidates and Laravel route facts into
the same evidence model. Runtime matching prefers static segments, reports tied
patterns as candidates, and preserves method/path disagreement as conflicts.
Browser request query/header/body values and unmatched concrete paths are not
returned; results carry only canonical matched paths, hashes/provenance, and
value-free redaction counts.

Run focused endpoint checks with:

```sh
pnpm exec vitest run --project unit packages/adapters/src/source/endpoint
pnpm exec vitest run --project integration tests/integration/endpoint-normalization.integration.test.ts
```

## Playwright Evidence Runtime

`@sentinel/adapters` exposes an injectable browser evidence runtime with real
Playwright and scripted-fake implementations. Each run owns a fresh
non-persistent browser context. Models receive only bounded, schema-validated
observations and opaque action IDs; Playwright locators, storage state, input
values, raw URLs, and browser handles remain inside the adapter.

Actions are bound to the run, a random session nonce, the observed semantic
state, the candidate behavior, an expiry, and single-use state. The runtime
re-reads the page and executes the refreshed locator only after the public state
and private behavior fingerprints still match. Unknown submissions and
destructive, payment, privilege, message, popup, download, or external-origin
actions fail closed by default. Run, action, screen, redirect, tab, download,
input, navigation, and wall-clock limits apply through setup, execution,
observation, completion, cancellation, and replay.

Browser contexts block service workers and WebRTC, route HTTP and WebSocket
traffic through the exact-origin policy, and close on every terminal path.
Observations and transitions retain only query-free, token-redacted URLs,
normalized network metadata, redacted console/page errors, and private artifact
IDs. Screenshots mask editable controls and known PII/secrets in every frame.
Failure trace artifacts are minimized JSON assembled from already-redacted
runtime evidence; native Playwright archives are not retained because they can
contain request, DOM, and locator material outside the evidence contract.

Run focused browser-runtime checks with:

```sh
pnpm exec vitest run --project unit packages/adapters/src/browser packages/contracts/src/browser-runtime.test.ts packages/contracts/src/identity.test.ts
pnpm exec vitest run --project integration tests/integration/playwright-evidence-runtime.integration.test.ts --maxWorkers=1
```

## Code Explorer

`@sentinel/contracts` defines the Code Explorer mission, source evidence,
proposed claim, implementation path, unresolved boundary, tool observation,
and terminal result schemas. Results retain the shared `MissionResult` fields
and add deterministically ordered candidate paths. Claims remain proposals: the
schemas do not expose accepted status or authoritative evidence tiers.

`@sentinel/adapters` composes the prepared TypeScript, PHP/Laravel, and endpoint
indexes through `CodeExplorerRepository` and `CodeExplorerTools`. The model can
select only `list_repository_modules`, symbol/text search, bounded symbol and
relationship inspection, endpoint/frontend lookup, focused test inspection,
claim submission, and mission completion. It receives no shell, Git, arbitrary
filesystem, Neo4j, or graph-write operation. Repository paths, languages,
results, traversal hops, source lines, and source characters are validated at
the deterministic tool boundary. Text matches have lexical strength, and
focused tests are marked as corroboration only.

`@sentinel/orchestration` exposes the legacy `CodeExplorerService` plus
`createCodeExplorerSpecialist`, which composes all thirteen described Code tools
through the shared specialist kernel. Rich source, edge, path, boundary, and result
records live in an injected durable Code store; checkpoints retain only compact
hashes and evidence/reference IDs. Each provider turn selects one strict tool,
while committed finish reconstruction is deterministic and consumes no additional
model budget. Repeated semantic visits stop without rereading the source tool.
Only a recorded structural edge whose source, target, and relationship kind
match the proposal can support a claim; lexical matches, same-name symbols,
source slices, and tests do not establish a relationship by themselves. All
composed indexes must share one application, run, repository, and immutable
commit identity, and resolved targets outside mission scope are suppressed.
Dynamic calls, computed targets,
dependency-injection ambiguity, and unmapped endpoints remain typed unresolved
boundaries. Documentation and Application follow-ups remain proposed missions in
the same run/application boundary. Production composition injects the checkpointer,
execution coordinator, run-control dependencies, and durable rich-result store.

Run focused Code Explorer checks with:

```sh
pnpm exec vitest run --project unit packages/contracts/src/code-explorer.test.ts packages/adapters/src/code-explorer/tools.test.ts packages/orchestration/src/code-explorer.test.ts packages/orchestration/src/code-explorer-specialist.test.ts
pnpm test:agent
```

The pinned Hi.Events order-creation evaluation is network- and model-backed and
therefore requires both live-test flags plus the existing GitHub/Azure
configuration:

```sh
RUN_LIVE_TESTS=1 RUN_CODE_EXPLORER_HI_EVENTS=1 \
  pnpm vitest run --project live tests/live/code-explorer-hi-events.live.test.ts
```

## Application Explorer

`@sentinel/contracts` exports strict Application Explorer schemas and inferred
types for planner decisions, bounded context and checkpoint state, frontier and
replay metadata, terminal classifications, blockers, evidence claims, and
mission output. `@sentinel/orchestration` exports `ApplicationExplorer`,
`ApplicationExplorerTools`, `createApplicationExplorer`,
`buildApplicationExplorerPlannerContext`, and `createApplicationExplorerSpecialist`.
The specialist composition fixes all four mission modes and tool descriptions,
uses the shared checkpoint/lease/budget/event/interrupt lifecycle, and keeps rich
observations, transitions, frontier state, replay recipes, and outputs in an
injected durable Application store.

The planner can select only `observe_page`, `perform_observed_action`,
`navigate_history`, or `finish_application_mission`. Observed action IDs remain
bound to the latest sanitized observation, while the browser runtime retains
policy, stale-state, host, reuse, and budget authority. Mission hints affect
candidate relevance only. Executed transitions produce contract-validated
screen, workflow, flow-step, UI-element, and runtime-request claims. Recovery
replays only fingerprint-confirmed safe history and requests human review at an
uncertain mutable boundary. The authentication-state reference must still match
the checkpoint before replay. Complete results require actual transition evidence
that deterministically addresses every mission question and success criterion;
all non-interrupted terminal paths close an active browser session.

The deterministic unit, agent, and integration suites require no live target.
The Hi.Events smoke remains disabled unless explicitly enabled against a trusted
deployment:

```sh
RUN_HIEVENTS_APPLICATION_EXPLORER=1 \
HIEVENTS_APPLICATION_EXPLORER_URL=https://events.example.test \
pnpm test:live -- tests/live/application-explorer.live.test.ts
```

`HIEVENTS_APPLICATION_EXPLORER_ALLOWED_ORIGINS` optionally supplies additional
comma-separated exact origins; the entry URL origin is always included.
`pnpm test:live` sets the general `RUN_LIVE_TESTS=1` gate. The smoke selects at
most one replay-safe public action and does not enter form values.
