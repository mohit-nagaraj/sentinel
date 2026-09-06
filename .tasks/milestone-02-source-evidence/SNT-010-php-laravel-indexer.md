# SNT-010 — PHP and Laravel structural indexer

| Field | Value |
|---|---|
| Milestone | M2 — Deterministic source evidence |
| Status | `not-started` |
| Depends on | SNT-002, SNT-007 |
| Blocks | Endpoint normalization, Code Explorer, PR mapping |
| PRD references | §10.2, §13.8, FR-007 |

## Background

PHP is the majority of Hi.Events. Accurate namespaces and source positions justify a small first-class PHP parser process while Sentinel remains TypeScript. The extractor must parse source only—it must never boot arbitrary target code.

## Scope

- Isolated PHP CLI package using `nikic/PHP-Parser` v5-compatible APIs.
- Read-only source-root input and JSONL/JSON output schema.
- Namespace/name resolution with original and resolved identities.
- Accurate line/token/file ranges.
- Class/interface/trait/function/method/property/import facts.
- Laravel route-group/method/path/action parsing from source.
- Action/controller `__invoke` and handler methods.
- Constructor dependency injection and call relationships.
- Action → Handler → Service → Repository and selected model/domain references.
- FormRequest/JsonResource associations where structurally visible.
- Strict resource/time/file limits and TypeScript Zod validation.

## Implementation tasks

- [ ] Create isolated Composer package/lockfile and CLI entry point.
- [ ] Define safe CLI arguments and prevent arbitrary output/file writes.
- [ ] Parse configured files without autoloading or executing target code.
- [ ] Run NameResolver and emit fully qualified plus original names.
- [ ] Extract facts/relationships/source ranges into versioned contract.
- [ ] Implement Laravel route expression/group normalization for target fixture patterns.
- [ ] Extract constructor dependencies and method/static calls.
- [ ] Map repository/model usage conservatively and emit unresolved dynamics.
- [ ] Validate all output in TypeScript and reject malformed/oversized streams.
- [ ] Add bounded source-slice/query preparation for Code Explorer.

## Acceptance criteria

- Pinned fixtures trace Laravel route → Action → Handler → Service/Repository/domain reference.
- Namespaced aliases resolve correctly and retain original evidence.
- Changed line ranges can identify smallest enclosing PHP symbol.
- Dynamic container/reflection/magic calls remain unresolved, never fabricated.
- The extractor does not run target bootstrap, Composer scripts, migrations, or application code.
- A malformed source file yields a scoped parser error without losing unrelated valid facts.
- Output is deterministic for identical files/parser version.

## Required tests

- PHP fixture tests for namespaces, aliases, traits, attributes, constructor injection, calls, routes/groups, malformed input, and dynamic negatives.
- Golden JSON output tests consumed by TypeScript contract parser.
- Process timeout/output-size/path security tests.
- Stable source-range/ID tests.
- Opt-in scoped Hi.Events backend fixture smoke test.

## Out of scope

Executing `artisan`, runtime container resolution, whole-program data flow, Code Explorer decisions, and Neo4j writes.

## Implementation notes

A trusted baseline may later provide `route:list --json` as corroboration through SNT-011, but this extractor remains source-only and safe for untrusted PR trees.