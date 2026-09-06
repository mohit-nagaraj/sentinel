# SNT-001 — Workspace and testing foundation

| Field | Value |
|---|---|
| Milestone | M1 — Foundation and durable execution |
| Status | `ready` |
| Depends on | None |
| Blocks | SNT-002, SNT-003, SNT-004, SNT-005 |
| PRD references | §9.3, §10, §20 |

## Background

Sentinel has documentation but no application workspace. This issue creates the smallest production-shaped TypeScript foundation on which every later contract, worker, extractor, graph, and UI can be tested. It must not implement a product feature prematurely.

## Scope

- Establish the package manager and root workspace.
- Create a Next.js web/control application and a separately invokable Node worker package/process.
- Create package boundaries for shared contracts, orchestration, source adapters, storage, and test fixtures without filling them with speculative abstractions.
- Configure strict TypeScript, linting, formatting, environment validation entry points, and consistent module resolution.
- Configure Vitest for unit/contract tests and Playwright Test for browser tests.
- Define test categories/scripts: fast unit, integration, graph, agent/eval, browser, and opt-in live.
- Add CI that installs deterministically and runs format/lint, typecheck, unit tests, and build without requiring secrets.
- Provide `.env.example` with names only and safe descriptions; never copy `.env` values.

## Expected outputs

Representative paths (exact monorepo names may be normalized during implementation):

```text
apps/web/
apps/worker/
packages/contracts/
packages/orchestration/
packages/adapters/
packages/storage/
tests/fixtures/
package.json
pnpm-workspace.yaml
vitest.config.ts
playwright.config.ts
.env.example
.github/workflows/ci.yml
```

## Implementation tasks

- [ ] Select and pin Node/package-manager versions.
- [ ] Scaffold web and worker entry points with health/start commands.
- [ ] Add shared TypeScript base configuration and strict compiler flags.
- [ ] Configure lint/format rules and generated/vendor exclusions.
- [ ] Configure Vitest projects or tags so unit tests never touch live providers.
- [ ] Configure Playwright with an isolated test web server and artifact-on-failure policy.
- [ ] Add root scripts for `lint`, `typecheck`, `test`, `test:integration`, `test:browser`, and `build`.
- [ ] Add one unit smoke test, one web route/component smoke test, and one worker startup test.
- [ ] Add secret-safe environment schema/loading seam; actual typed keys arrive with owning issues.
- [ ] Add CI and dependency caching based on the lockfile.
- [ ] Document local prerequisites and test taxonomy in the root README stub.

## Acceptance criteria

- A clean clone can install from the lockfile and run lint, typecheck, unit tests, and build without external credentials.
- Web and worker can run independently; importing worker code does not require a browser or network connection.
- Test suites clearly separate deterministic defaults from integration/live tests.
- Strict TypeScript is enabled and no blanket `any`/skip-typecheck escape hatch is introduced.
- CI has no access to `.env` or local secrets and still passes.
- `.env`, private keys, browser state, traces, and generated output remain ignored.

## Required tests

- Unit: shared smoke test proves aliases/config work.
- Web: health/home route renders in a test environment.
- Worker: startup/health path can initialize with fake adapters.
- CI contract: execute all default root commands on an environment with provider variables unset.

## Out of scope

Database migrations, LangGraph workflows, real provider connections, finalized UI design, Docker deployment, and Hi.Events ingestion.

## Implementation notes

Record final workspace paths, package manager, Node version, and command names here after implementation. If scaffold-generated files differ from the representative paths, update dependent issues without changing their behavioral contracts.