# SNT-011 — OpenAPI and cross-stack endpoint normalization

| Field | Value |
|---|---|
| Milestone | M2 — Deterministic source evidence |
| Status | `not-started` |
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

- [ ] Define canonical endpoint-key algorithm and version it.
- [ ] Parse/validate OpenAPI with byte/ref-depth/remote-ref restrictions.
- [ ] Resolve local refs needed for operation metadata without fetching arbitrary remote refs.
- [ ] Normalize parameter names by position rather than requiring identical names.
- [ ] Add matching APIs for runtime URL and source templates.
- [ ] Distinguish exact method/path matches from ambiguous candidates.
- [ ] Emit conflicts when OpenAPI, route source, and runtime disagree.
- [ ] Redact query/body/header credentials and personal values.
- [ ] Add source/version provenance for every imported/matched fact.

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

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
