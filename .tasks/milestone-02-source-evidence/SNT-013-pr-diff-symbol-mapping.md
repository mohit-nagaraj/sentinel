# SNT-013 — PR diff to base/head symbol mapping

| Field | Value |
|---|---|
| Milestone | M2 — Deterministic source evidence |
| Status | `not-started` |
| Depends on | SNT-007, SNT-009, SNT-010 |
| Blocks | Agentic PR investigation |
| PRD references | §6.4, §13.13, FR-012 |

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

- [ ] Implement parser for GitHub/Git diff file/hunk/rename/binary states.
- [ ] Canonicalize normalized diff for hashing.
- [ ] Retrieve base/head AST facts only for affected TypeScript/PHP files.
- [ ] Select smallest enclosing symbol and preserve nested parent context.
- [ ] Classify added/modified/deleted/renamed/moved.
- [ ] Handle file deletion using base index and addition using head index.
- [ ] Mark changes outside supported adapters as unmapped, never discard them.
- [ ] Add baseline compatibility classifier: exact, safe ancestor warning, stale-relevant, unrelated/unknown.
- [ ] Add limits for very large/binary/generated diffs.

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

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
