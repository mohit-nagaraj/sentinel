# SNT-007 — Read-only GitHub source connector and ephemeral checkout

| Field | Value |
|---|---|
| Milestone | M2 — Deterministic source evidence |
| Status | `not-started` |
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

- [ ] Define connector interface and normalized repository identity.
- [ ] Add URL/owner/repo/ref allowlist validation.
- [ ] Implement metadata and commit/ancestry lookup.
- [ ] Implement shallow/targeted fetch that can materialize base and head when needed.
- [ ] Create secure per-run temp directory outside target/source repositories.
- [ ] Add safe relative file enumeration/read APIs for adapters.
- [ ] Reject unsafe symlinks, submodule escapes, oversized/binary inputs, and unsupported archive shapes.
- [ ] Add abort/cancellation handling around Git processes.
- [ ] Implement cleanup registry and startup reclamation for abandoned paths.
- [ ] Persist only identities, fingerprints, limits, and redacted failures.

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

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
