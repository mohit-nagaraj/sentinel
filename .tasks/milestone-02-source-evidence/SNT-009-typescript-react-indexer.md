# SNT-009 — TypeScript and React structural indexer

| Field | Value |
|---|---|
| Milestone | M2 — Deterministic source evidence |
| Status | `done` |
| Depends on | SNT-002, SNT-007 |
| Blocks | Endpoint normalization, Code Explorer, PR mapping |
| PRD references | §13.7, FR-006 |

## Background

Hi.Events' frontend uses TypeScript/React. The indexer must turn source into stable structural facts that a Code Explorer can navigate without receiving arbitrary filesystem access or full repository context.

## Scope

Use `ts-morph`/TypeScript Compiler API to extract:

- projects/source roots and module/file identities;
- exported/local symbols, components, functions, methods, and source ranges;
- imports/exports and resolved definitions/references where tractable;
- React Router routes and rendered component ancestry;
- JSX elements, static accessible names/labels/text/data-testid hints;
- event-handler bindings and handler definitions;
- React Query hooks and calls into API client modules;
- Axios/fetch client method/path templates;
- callers/callees for the selected source roots;
- unresolved dynamic expressions as explicit facts/warnings.

## Implementation tasks

- [x] Load project from detected `tsconfig` without executing build plugins.
- [x] Exclude generated, locale, vendor, build, and test files by declared policy while allowing focused test indexing.
- [x] Create stable file/symbol IDs with commit and qualified structural identity.
- [x] Extract source positions and bounded display slices.
- [x] Resolve import/export aliases and local call targets where supported.
- [x] Implement React route/component/JSX/handler patterns used by pinned Hi.Events fixtures.
- [x] Normalize API-client calls without prematurely matching backend endpoints.
- [x] Emit extraction method/version and unresolved reason codes.
- [x] Build query APIs consumed by Code Explorer.

## Acceptance criteria

- Pinned fixtures map route → component → JSX/handler → API client call with source provenance.
- Comments, string fixtures, and dead text are not misclassified as executable calls.
- Identical commit/indexer version yields stable fact IDs/order.
- Unsupported computed routes/labels/calls remain unresolved rather than guessed.
- Indexing has file/node/time limits and does not execute repository code.
- Query APIs return bounded facts/slices and cannot read excluded/out-of-root files.

## Required tests

- Unit fixtures for imports, aliases, JSX labels, handlers, hooks, templates, and dynamic negatives.
- Golden structural fact snapshots.
- Stable-ID/order tests.
- Source-range edge cases and deleted/renamed file fixtures.
- Performance budget test over a representative fixture tree.
- Opt-in scoped Hi.Events index smoke test.

## Out of scope

Whole-program soundness, runtime JavaScript evaluation, requirement matching, backend endpoint linking, and Code Explorer reasoning.

## Implementation notes

### Paths

- Module: `packages/adapters/src/source/typescript/`, barrelled through
  `packages/adapters/src/source/typescript/index.ts` and re-exported from `packages/adapters/src/index.ts`.
- `reader.ts` — `TypeScriptSourceReader` port plus `createFakeSourceReader` test double.
- `policy.ts` — versioned `defaultIndexPolicy` and `admitEntry`.
- `limits.ts` — `typeScriptIndexLimitsSchema`, `defaultTypeScriptIndexLimits`, `IndexBudget`.
- `errors.ts` — `TypeScriptIndexerError`, `unresolvedReasonSchema`, `skipReasonSchema`.
- `identity.ts` — stable-key wrappers, `TYPESCRIPT_INDEXER_VERSION`, deterministic comparators.
- `project.ts` — tsconfig discovery, in-memory compiler host, `resolveModuleSpecifier`.
- `slices.ts` / `symbols.ts` / `references.ts` / `routes.ts` / `jsx.ts` / `api-calls.ts` — extraction.
- `indexer.ts` — `indexTypeScriptSource`; `query.ts` — `createTypeScriptIndexQuery`.
- `testing.ts` — `reactAppFixtureFiles`, `indexFixture`, deterministic fixture scope.
- Fixture: `tests/fixtures/typescript-repository.ts`; integration:
  `tests/integration/typescript-source-index.integration.test.ts`; smoke:
  `tests/live/typescript-source-index.live.test.ts`.

### Decisions

- Added `ts-morph@28.0.0` (exact) to `@sentinel/adapters`. It vendors TypeScript 6.0.2, so extraction
  does not drift with the repo-root `typescript` devDependency.
- The indexer never touches `node:fs`. Source arrives through `TypeScriptSourceReader`, which a SNT-007
  `CheckoutSnapshot` satisfies structurally with no adapter shim (asserted by an `expectTypeOf` test), and
  admitted files are loaded into a `useInMemoryFileSystem` compiler host. Excluded and out-of-root files
  are therefore absent from the host rather than filtered afterwards.
- No repository code is executed. `tsconfig.json` is parsed with `ts.parseConfigFileTextToJson` and only
  `jsx`, `jsxImportSource`, `baseUrl`, `paths`, and `resolveJsonModule` are honoured; `plugins`, `extends`,
  `references`, `types`, and `typeRoots` are reported in `config.ignoredFields` and ignored. `lib` is
  Sentinel-fixed with `noLib`/`skipLoadingLibFiles`, so extraction cannot vary with the target's libs.
- **No `api_endpoint` or `domain_entity` fact envelopes are emitted.** Asserting a backend endpoint from
  frontend evidence is SNT-011's job, so API client calls are emitted as `ApiCallCandidate` records with a
  normalized frontend path template only.
- Contract envelopes cover `code_file`, `code_symbol`, `code_reference`, and `frontend_route`, each
  validated through `parseCodeFactEnvelope` before return. Because `frontendRouteFactSchema.componentSymbolIds`
  requires at least one entry, a route with no resolved component stays an indexer record and is never
  published as a fact.
- `codeReferenceFactSchema.id` is an `EvidenceId`, so the request carries `applicationId` and `runId`.
  Ordinals are assigned from a sort over a run-independent `referenceKey`, which keeps edge ordering and
  ordinals reproducible even though the evidence ID itself is run-scoped by contract.
- Every file gets a `module` symbol (qualified name is the bare file path, no `#`) so file-level imports
  have a source symbol for `code_reference` facts.
- Symbol qualified names are `<file path>#<declaration chain>`. Function-like declarations nested inside a
  component body are indexed to depth 4, because React handlers are body locals — without this every JSX
  handler binding in the target would be unresolved.
- Wall-clock duration lives in `index.elapsedMs`, outside `statistics`, so `statistics` is entirely
  deterministic.
- Only the `lazy` route property is a component source. React Router's `loader` is a data fetcher, and an
  earlier revision fell back to it — which produced a spurious `dynamic_component` reason on routes that
  had already resolved an `element`. The target uses `loader` on its public event routes, so this was a
  real false positive; covered by a regression test.

### Verification (2026-09-07)

- `pnpm format:check`, `pnpm lint` (0 problems), `pnpm typecheck`, `pnpm build` — all pass.
- `pnpm test` — 468 tests across 44 files pass; 268 of them are the 16 new indexer test files.
- `pnpm test:integration` — `typescript-source-index.integration.test.ts`, 5 tests pass against a local
  bare Git fixture through a real `EphemeralCheckoutManager`, covering deleted and renamed files.
- Opt-in smoke:
  `RUN_LIVE_TESTS=1 RUN_TYPESCRIPT_INDEX_SMOKE=1 pnpm vitest run --project live tests/live/typescript-source-index.live.test.ts`
  against `HiEventsDev/Hi.Events@2064f88f` `frontend/src`: 726 files, 2,632 symbols, 20,167 references,
  88 routes (87 with a resolved component), 260/263 API candidates with a path template, 251 React Query
  hooks, 228 warnings, 56s.
- Golden snapshots: `packages/adapters/src/source/typescript/__snapshots__/golden.test.ts.snap`.

### Deferred

- Backend endpoint matching and OpenAPI reconciliation — SNT-011.
- PR diff-to-symbol mapping — SNT-013; this issue guarantees the source ranges it consumes.
- Code Explorer tool wiring and agent reasoning — SNT-016; this issue delivers the query functions.
- Neo4j persistence of emitted facts — SNT-018/SNT-021.
- `.js`/`.jsx` indexing, whole-program type soundness, cross-package project references, and runtime
  evaluation of computed expressions remain out of scope as declared.
