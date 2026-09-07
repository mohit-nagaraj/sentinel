# SNT-013 — PR diff to base/head symbol mapping

| Field          | Value                              |
| -------------- | ---------------------------------- |
| Milestone      | M2 — Deterministic source evidence |
| Status         | `done`                             |
| Depends on     | SNT-007, SNT-009, SNT-010          |
| Blocks         | Agentic PR investigation           |
| PRD references | §6.4, §13.13, FR-012               |

## Background

PR impact begins with exact change identity. Sentinel must map changed hunks to the smallest enclosing symbols in both base and head trees and preserve additions/deletions/renames without storing a permanent patch.

## Scope

- Resolve immutable PR base/head and verify ancestry/baseline compatibility inputs.
- Produce normalized diff hash and changed file/hunk ranges.
- Map base ranges to deleted/old symbols and head ranges to added/new symbols.
- Match modified/moved/renamed symbols conservatively using stable structure and Git rename metadata.
- Represent non-code/config/schema/generated/lockfile changes explicitly.
- Emit `ChangedFile`/`ChangedSymbol` facts with provenance and unresolved reasons.
- Persist only SHAs/hash/ranges/symbol summaries/results.

## Implementation tasks

- [x] Implement parser for GitHub/Git diff file/hunk/rename/binary states.
- [x] Canonicalize normalized diff for hashing.
- [x] Retrieve base/head AST facts only for affected TypeScript/PHP files.
- [x] Select smallest enclosing symbol and preserve nested parent context.
- [x] Classify added/modified/deleted/renamed/moved.
- [x] Handle file deletion using base index and addition using head index.
- [x] Mark changes outside supported adapters as unmapped, never discard them.
- [x] Add baseline compatibility classifier: exact, safe ancestor warning, stale-relevant, unrelated/unknown.
- [x] Add limits for very large/binary/generated diffs.

## Acceptance criteria

- Representative TS/PHP additions, edits, deletions, and renames map to correct symbols/source ranges.
- Deleted symbols remain available as base-side change facts.
- Unsupported/config changes appear in assessment inputs as unmapped/typed file changes.
- Same base/head yields the same normalized diff hash and ordered output.
- A graph baseline containing the PR change or with relevant intervening edits does not silently proceed.
- No patch file is required after processing.

## Required tests

- Local Git fixture matrix for line edits, nested symbols, new/deleted files, rename+edit, binary/generated file, and no-newline hunks.
- TypeScript and PHP smallest-enclosing-symbol tests.
- Baseline compatibility/ancestry tests.
- Diff hash/order stability tests.
- Large-diff limit tests.

## Out of scope

Semantic interpretation, caller/callee impact, GitHub webhook/check behavior, Neo4j traversal, and application verification.

## Implementation notes

### Paths

- Shared contracts and parsers: `packages/contracts/src/assessment.ts` and `packages/contracts/src/parsers.ts`.
- Diff parser, hashing, classification, limits, and errors: `packages/adapters/src/source/pr-diff/diff-parser.ts`, `limits.ts`, and `errors.ts`.
- Affected-only TypeScript/PHP indexing: `packages/adapters/src/source/pr-diff/affected-indexer.ts`.
- Smallest-enclosing selection and conservative pairing: `packages/adapters/src/source/pr-diff/symbol-mapper.ts`.
- Git/ancestry/baseline orchestration: `packages/adapters/src/source/pr-diff/analyzer.ts`, exported through the adapter barrels.
- Local repository matrix: `tests/fixtures/pr-diff-repository.ts` and `tests/integration/pr-diff-analyzer.integration.test.ts`.

### Decisions

- Git execution compares the two immutable trees with explicit `--no-ext-diff`, `--no-textconv`, fixed prefixes, histogram diffing, zero context, no indent heuristic, and 50% rename detection. Patch text exists only in process memory; the validated result contains SHAs, the normalized content-sensitive hash, ranges, symbol summaries, baseline status, and unresolved reasons.
- Affected indexing masks checkout enumeration to the selected source files and their nearest ancestor `tsconfig.json`; changed TypeScript tests are admitted through the indexer's focused-test policy for only those exact paths, and the PHP process receives the exact affected `.php` list. Generated, lockfile, binary, and unsupported files never enter an AST adapter.
- Changed lines are mapped individually before contiguous per-symbol ranges are rebuilt. This preserves the smallest nested declaration when a Git hunk spans several symbols. Rename metadata maps every structural symbol in a renamed file, including 100% metadata-only renames.
- Same-file structural identities classify as modified, Git-renamed-file structural identities as renamed, and cross-file symbols as moved only when the structural key and normalized source-content hash form a unique pair. Ambiguous matches remain added/deleted with `symbol_match_ambiguous` evidence.
- Baseline assessment proceeds only for an exact graph/base match or an ancestor whose intervening changes do not touch the supplied indexed paths. Relevant staleness, a baseline containing the PR, unrelated history, and unavailable ancestry are explicit blocking states.
- Parser/analyzer limits cover patch bytes, files, hunks per file, changed lines, indexed symbols, intervening paths, and Git time/output.

### Verification (2026-09-07)

- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed.
- `pnpm test` passed 539 tests across 59 files, including 13 new PR-diff unit tests and the extended contract suite.
- Focused local Git integration passed 3 tests covering TypeScript/PHP edits, nested symbols, added/deleted files, rename plus edit, a cross-file move, binary/generated/lockfile/config/schema changes, mode-only and no-newline diffs, deterministic reruns, all baseline classes, no patch retention, and large-diff/ancestry rejection.
- The full local `pnpm test:integration` run passed the SNT-013 suite and 21 other integration tests; two pre-existing PHP process-limit tests could not run to their intended assertions because this workstation has no PHP executable. Repository CI installs PHP 8.3 and Composer before running the same integration command and is required to pass before merge.
- No SNT-013 acceptance item is deferred. Semantic impact, graph persistence/traversal, GitHub delivery, and application verification remain the task's declared out-of-scope work.
