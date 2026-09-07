# SNT-011 — OpenAPI and cross-stack endpoint normalization

| Field | Value |
|---|---|
| Milestone | M2 — Deterministic source evidence |
| Status | `done` |
| Depends on | SNT-009, SNT-010 |
| Blocks | Code Explorer, evidence linking |
| PRD references | §13.10–13.11, FR-008 |

## Background

Normalized HTTP method/path identity is the strongest bridge between Playwright network observations, frontend API calls, Scramble OpenAPI operations, and Laravel handlers. Every source expresses dynamic parameters differently and must converge without fuzzy guessing.

## Scope

- Import supplied/exported OpenAPI 3 documents safely.
- Normalize method, origin/base path, slash/query behavior, parameter placeholders, version prefixes, and optional route groups.
- Preserve operation ID, tags, request/response schema references, and source hash.
- Normalize frontend literal/template URL calls.
- Normalize Laravel route/group/action facts.
- Normalize browser runtime URLs while excluding sensitive query/body values.
- Produce exact/candidate/conflict match outcomes with evidence.
- Optional trusted-baseline `route:list --json` adapter as corroborating input only.

## Implementation tasks

- [x] Define canonical endpoint-key algorithm and version it.
- [x] Parse/validate OpenAPI with byte/ref-depth/remote-ref restrictions.
- [x] Resolve local refs needed for operation metadata without fetching arbitrary remote refs.
- [x] Normalize parameter names by position rather than requiring identical names.
- [x] Add matching APIs for runtime URL and source templates.
- [x] Distinguish exact method/path matches from ambiguous candidates.
- [x] Emit conflicts when OpenAPI, route source, and runtime disagree.
- [x] Redact query/body/header credentials and personal values.
- [x] Add source/version provenance for every imported/matched fact.

## Acceptance criteria

- Semantically identical routes from TypeScript, Laravel, OpenAPI, and browser evidence produce one canonical endpoint identity.
- HTTP method differences never match as exact.
- Static path collisions and ambiguous dynamic segments are surfaced.
- Remote `$ref` cannot cause arbitrary network access.
- Sensitive URL/query/header/body values never enter endpoint identity or logs.
- Conflicting evidence remains inspectable and lowers link strength rather than being silently overwritten.

## Required tests

- Table-driven method/path/template normalization tests.
- OpenAPI fixture tests including local refs, malformed specs, and remote-ref denial.
- Frontend/Laravel/browser cross-source exact and ambiguous match tests.
- Query/header/body redaction tests.
- Stable endpoint-key tests.

## Out of scope

Generating the Hi.Events OpenAPI spec, semantic requirement matching, live API invocation, and graph publication.

## Implementation notes

### Paths and contracts

- `packages/adapters/src/source/endpoint/normalize.ts` owns
  `ENDPOINT_NORMALIZATION_VERSION`, method/path normalization, explicit prefix
  handling, and stable endpoint construction through `createStableKey`.
- `packages/adapters/src/source/endpoint/openapi.ts` imports supplied OpenAPI
  3.0/3.1 JSON/YAML/objects, enforces caller-tightenable limits, denies every
  non-fragment `$ref`, resolves bounded local JSON Pointers, and emits
  contract-validated `api_endpoint` envelopes.
- `packages/adapters/src/source/endpoint/sources.ts` adapts existing TypeScript
  `ApiCallCandidateRecord` and PHP `PhpRoute` values without modifying either
  structural indexer.
- `packages/adapters/src/source/endpoint/matching.ts` compares source templates
  and matches concrete runtime URLs with static-segment precedence, explicit
  ambiguity, method/path conflicts, and value-free runtime summaries.
- `packages/contracts/src/facts.ts` additively permits the OpenAPI version,
  tags, and request/response schema-reference arrays on endpoint facts.
- Unit tests live beside the endpoint modules; the cross-stack fixture is
  `tests/integration/endpoint-normalization.integration.test.ts`.

### Decisions and safety

- Identity is application + uppercase HTTP method + normalized path shape.
  Parameter names normalize to positional `{param}` segments. Origins, query
  strings, fragments, duplicate/trailing slashes, and percent-encoding case do
  not create new identities; encoded separators remain encoded.
- Version/base prefix removal is never inferred. Callers provide source base
  paths and optional prefixes explicitly.
- OpenAPI parsing is in-memory only. No URL or file resolver exists, so external
  refs fail before local resolution can perform I/O. Object imports reject
  accessors, custom array prototypes, and Proxies; all structural and metadata
  traversals have caller-tightenable limits and fixed redacted errors.
- Runtime paths, query values, headers, and bodies are transient. Match results
  expose canonical catalog paths or an unmatched reason plus source hash and
  value-free counts; errors use fixed messages.
- Conflicts retain both endpoint evidence records. Static/dynamic overlaps and
  equally specific runtime matches remain candidates rather than being guessed.
  Embedded placeholders use a bounded linear matcher rather than generated
  regular expressions or backtracking.
- The optional trusted-baseline `route:list --json` adapter remains deferred as
  allowed by scope; no acceptance item depends on it.

### Verification (2026-09-07)

- Focused endpoint unit tests: 62 tests pass across normalization, OpenAPI
  import, matching, and redaction.
- Cross-stack integration: TypeScript, Laravel, OpenAPI, and browser evidence
  converge on one stable endpoint while runtime secret values remain absent.
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm build` pass.
- `pnpm test` passes 601 tests across 63 files.
- `pnpm test:integration` passes 33 tests across five files with 13
  environment-gated Supabase/LangGraph/Playwright tests skipped. The PHP suite
  was run with checksum-verified PHP 8.4.25 and the locked Composer dependencies.
- The ystack review completed all five roles. Every confirmed P0/P1 was fixed;
  the final adversarial pass found no remaining P0/P1 issues.
