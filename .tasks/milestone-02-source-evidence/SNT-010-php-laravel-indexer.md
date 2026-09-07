# SNT-010 — PHP and Laravel structural indexer

| Field | Value |
|---|---|
| Milestone | M2 — Deterministic source evidence |
| Status | `review` |
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

- [x] Create isolated Composer package/lockfile and CLI entry point.
- [x] Define safe CLI arguments and prevent arbitrary output/file writes.
- [x] Parse configured files without autoloading or executing target code.
- [x] Run NameResolver and emit fully qualified plus original names.
- [x] Extract facts/relationships/source ranges into versioned contract.
- [x] Implement Laravel route expression/group normalization for target fixture patterns.
- [x] Extract constructor dependencies and method/static calls.
- [x] Map repository/model usage conservatively and emit unresolved dynamics.
- [x] Validate all output in TypeScript and reject malformed/oversized streams.
- [x] Add bounded source-slice/query preparation for Code Explorer.

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

- Composer package: `tools/php-indexer/composer.json` and `composer.lock` pin `nikic/php-parser` v5.8.0 (`044a6a392ff8ad0d61f14370a5fbbd0a0107152f`). The package declares no Composer scripts or plugins and exposes only `bin/index.php`.
- Runtime boundary: `PhpLaravelIndexer` in `packages/adapters/src/php-laravel/process.ts` spawns a configured PHP executable without a shell, passes exactly one bounded JSON request on stdin, accepts output only on stdout, disables ambient PHP configuration, explicitly loads tokenizer where Unix packages require it, clears unrelated environment values, and applies cancellation/timeout/stdout/stderr limits. Child stderr and raw source are never reflected in errors. CI pins the PHP setup action to a full commit SHA.
- Source safety: the TypeScript host and PHP CLI both validate unique portable relative `.php` paths, path depth, root/file containment, and symlink components. `indexCheckout` hashes canonical SNT-007 blob text and rejects output unless PHP parsed identical bytes. The CLI requires its own fixed Composer autoloader and never includes target files, boots Laravel, invokes Artisan, runs migrations, or writes into the target repository.
- Versioned contract: `schema.ts` strictly validates application/repository/commit identity, parser identity, normalized content hashes, symbols, roles, routes, relationships, unresolved dynamics, six-position source ranges, unique IDs, every container/relationship/route link, and summary counts. Validated responses are recursively frozen before exposure.
- Structural extraction: PHP-Parser's v5 `NameResolver` runs with original-name preservation. The visitor emits namespaces, imports, classes, interfaces, traits, enums, functions, methods, properties, attributes, inheritance, trait use, constructor dependencies, parameter/return/property types, instance/static/function calls, instantiation, selected domain/model references, and explicit unresolved dynamic calls.
- Laravel extraction: grouped prefixes/middleware and GET/POST/PUT/PATCH/DELETE/OPTIONS/ANY/match routes are normalized for the exact Laravel `Route` facade and Hi.Events' structurally bootstrapped or typed `Illuminate\\Routing\\Router $router` chains. Class-constant and `[Controller::class, method]` actions resolve only when `::class` and the exact method are present; computed prefixes/method lists/paths, closures, strings, containers, reflection, magic, unrelated `Route` classes, and other dynamic calls remain unresolved rather than guessed.
- FormRequest/JsonResource labels are emitted only when inheritance reaches the exact Laravel base type; suffix matching alone does not create those associations.
- PHP symbols use the shared `code-symbol:v1` stable-key algorithm over application, repository, immutable commit, path, qualified name, and symbol kind. Parser-local relationship/route IDs include the same source scope. Repeated namespace/import blocks coalesce under namespace-scoped semantic identities while retaining every exact declaration range for changed-line lookup. Files and facts are byte-order/range sorted; repeat extraction with reversed request order is identical, while a different commit produces distinct identities.
- Code Explorer preparation: `PhpCodeIndex` provides bounded symbol search, smallest-enclosing-symbol lookup, relationship neighborhoods capped by depth/symbol/relationship counts, and source slices capped by context lines, total lines, and characters.
- Default limits: 2,000 files, 2 MiB per file, 64 MiB total source, path depth 40, 100,000 facts, 1,024-character strings, 1 MiB request, 32 MiB stdout, 64 KiB stderr, and 120 seconds.
- Fixture coverage: `tests/fixtures/php-laravel` traces grouped route → Action → Handler → Service → Repository → model and covers aliases, attributes, traits, interfaces, promoted constructor properties, repeated namespace/import blocks, closure/arrow shadowing, FormRequest, JsonResource, UTF-8 BOM normalization, malformed source, inert top-level code, unrelated Route classes, mixed/computed route components, and dynamic negatives. Golden expectations are consumed through the TypeScript schema.
- Verification on 2026-09-07 against the merged SNT-009 baseline: Composer strict validation and PHP syntax checks passed; `pnpm test` passed 510 tests; `pnpm test:integration` passed 29 tests with 11 environment-gated Supabase/LangGraph tests skipped; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm build` passed.
- Live verification on 2026-09-07: the opt-in test checked out Hi.Events commit `2064f88ff7590e93c738efb8becaa7d732063619`, parsed five selected backend files, and resolved `/public/events/{event_id}/order` to `CreateOrderActionPublic` without booting Laravel. A first Git pack transfer was reset by the network; the clean retry passed in about 12 seconds.
- Run the live smoke with `RUN_LIVE_TESTS=1 RUN_PHP_INDEXER_SMOKE=1 pnpm vitest run --project live tests/live/php-laravel-indexer.live.test.ts` after Composer install (PowerShell environment syntax differs).
- A trusted baseline may later provide `route:list --json` as SNT-011 corroboration, but no SNT-010 acceptance item is deferred and this extractor remains source-only for untrusted PR trees.
