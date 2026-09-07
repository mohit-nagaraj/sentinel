# SNT-007 — Read-only GitHub source connector and ephemeral checkout

| Field | Value |
|---|---|
| Milestone | M2 — Deterministic source evidence |
| Status | `review` |
| Depends on | SNT-002, SNT-003 |
| Blocks | Documentation repository sources, code indexers, PR mapping, GitHub App |
| PRD references | §6.4, §11.2–11.3, §13.3, §18.1 |

## Background

Source and PR analysis require exact immutable commits without writing to customer repositories. The connector must support public access first, isolate checkouts, constrain repository size/path behavior, and preserve only reproducible identities and derived facts.

## Scope

- Parse/normalize GitHub repository and PR identifiers.
- Retrieve repository/default-branch/commit/PR metadata via Octokit.
- Resolve immutable base/head SHAs and ancestry.
- Clone/fetch minimum required history into a random worker-owned temporary path.
- Prevent path traversal and symlink escape when exposing file reads to adapters.
- Enforce byte/file/depth/time/submodule limits.
- Compute tree/config fingerprints.
- Cleanup on success, failure, cancellation, and stale lease recovery.
- Public anonymous/token read mode; GitHub App installation auth is added by SNT-026.

## Implementation tasks

- [x] Define connector interface and normalized repository identity.
- [x] Add URL/owner/repo/ref allowlist validation.
- [x] Implement metadata and commit/ancestry lookup.
- [x] Implement shallow/targeted fetch that can materialize base and head when needed.
- [x] Create secure per-run temp directory outside target/source repositories.
- [x] Add safe relative file enumeration/read APIs for adapters.
- [x] Reject unsafe symlinks, submodule escapes, oversized/binary inputs, and unsupported archive shapes.
- [x] Add abort/cancellation handling around Git processes.
- [x] Implement cleanup registry and startup reclamation for abandoned paths.
- [x] Persist only identities, fingerprints, limits, and redacted failures.

## Acceptance criteria

- Pinned Hi.Events commits can be checked out reproducibly.
- Base/head commits are simultaneously addressable for PR comparison.
- No command writes to the remote, branch, or original working repository.
- `../`, absolute-path, symlink, and submodule escape attempts fail closed.
- Limits stop oversized repositories with an actionable compatibility result.
- Cancellation/exception removes temporary content.
- Logs/events contain no token, remote-with-credential URL, or source body.

## Required tests

- Unit tests for URL/ref/path normalization.
- Integration test against a small local bare Git fixture with branches/rename/deletion.
- Security tests for path and symlink escape.
- Cancellation and cleanup tests.
- Opt-in public Hi.Events checkout smoke test pinned to a known SHA.

## Out of scope

Webhook verification, check runs, source AST parsing, executing repository scripts, private enterprise Git hosts, and persisting clones.

## Implementation notes

- Public API: `packages/adapters/src/source/github/index.ts`, exported by `@sentinel/adapters`.
- Metadata: `GitHubMetadataClient` uses `@octokit/rest` for repository, commit, recursive tree, PR, and comparison requests. It accepts anonymous access or an in-memory token and returns normalized identities plus full immutable SHAs. Frozen, process-verified tree summaries prove file/byte/depth/submodule limits before a GitHub fetch; fork head repositories receive the same repository and tree preflight as the base.
- Checkout: `EphemeralCheckoutManager` creates a random lease under the OS temporary directory, initializes a bare object store from an explicitly empty template, runs a shallow targeted fetch with `--no-tags`, `--no-recurse-submodules`, and a preflight-bounded `blob:limit` filter, validates the fetched tree identity, and creates detached worktrees for the requested source/base/head snapshots.
- Git runs without a shell, inherited `GIT_*` configuration, templates/hooks, prompts, credential helpers, system/global Git configuration, submodule recursion, or line-ending conversion. Token authentication uses a process-local, host-scoped extra header and never embeds credentials in a remote URL or error object. GitHub 403 rate-limit responses remain retryable and are distinct from authentication failures.
- Default limits: 100,000 entries, 512 MiB of source, 8 MiB per file, depth 40, two simultaneous targets, 120 seconds per Git process, and 64 MiB of Git output. Limit failures are structured compatibility errors.
- Tree validation rejects gitlinks, unsupported modes, unsafe/reserved paths, invalid UTF-8 metadata, and symlinks that resolve outside the tree. Safe symlinks may exist in a checkout but are never exposed through `readText`.
- Source reads require a validated relative path and reject symbolic-link components, but return content from the validated Git blob rather than the mutable worktree. The reader recomputes the Git object identity and rejects NUL-containing or invalid UTF-8 content, so same-size mutations, filesystem races, and `.gitattributes` working-tree transformations cannot alter evidence.
- `startGitHubSourceConnector` reclaims expired or incomplete Sentinel lease directories at startup. Active leases refresh a heartbeat, so PID reuse cannot preserve an abandoned checkout and long-running healthy work remains fresh. Registry roots are per-user and owner/private-mode checked where the platform exposes POSIX ownership. Cleanup is retryable, preserves the primary Git/adapter error, and runs after success, failure, timeout, or cancellation.
- Fingerprints are SHA-256 canonical hashes over immutable repository/commit/tree identities and selected configuration blob identities. Source bodies, clones, patches, credentials, and raw provider errors are not persisted by this module.
- Local integration fixture: `tests/fixtures/git-repository.ts` creates a bare repository with base/head branches, rename/deletion, forced checkout EOL attributes, binary content, an escaping symlink object, and a gitlink without executing repository code. Tests also cover hostile inherited Git templates/configuration, equal-length worktree and enumeration mutation, forged/truncated preflight data, oversized forks, cleanup retry/error priority, active lease heartbeats, and incomplete lease recovery.
- Verification on 2026-09-07: `pnpm test` passed 200 tests; `pnpm test:integration` passed 11 Git tests with 10 credential-gated Supabase tests skipped; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm build` passed.
- Live verification on 2026-09-07: the opt-in test checked out Hi.Events commit `2064f88ff7590e93c738efb8becaa7d732063619` anonymously and read `README.md` through the guarded API. Run with `RUN_LIVE_TESTS=1 RUN_GITHUB_CHECKOUT_SMOKE=1 pnpm vitest run --project live tests/live/github-source-connector.live.test.ts` (PowerShell environment syntax may differ).
- No acceptance item is deferred. GitHub App installation authentication remains SNT-026 scope; this connector accepts the resulting token through the same read-only boundary.
