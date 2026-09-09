# SNT-034 — Security, resilience, and regression hardening

| Field          | Value                                               |
| -------------- | --------------------------------------------------- |
| Milestone      | M8 — Evaluation, hardening, and assignment delivery |
| Status         | `done`                                              |
| Depends on     | SNT-026, SNT-029, SNT-031, SNT-032, SNT-033         |
| Blocks         | Final assignment delivery                           |
| PRD references | §17–§20, NFR-003–NFR-009                            |

## Background

Sentinel consumes untrusted repositories, documents, DOM, webhooks, and model outputs while using credentials and browsers. Before submission, cross-module failure and trust boundaries must be tested as a complete system.

## Scope

- Threat-model review of target repository, docs, browser, GitHub webhook/App, model tools, Supabase, Neo4j, artifacts, and preview environment.
- Prompt-injection and tool-confusion resistance across all specialists.
- SSRF/path/symlink/resource-exhaustion/deserialization/XSS controls.
- Secret scanning/redaction and credential lifecycle.
- Cross-application/revision/run isolation.
- Fault injection: provider, browser, Git, DB, graph, Storage, webhook/check, worker crash.
- Checkpoint/idempotency/non-idempotent recovery.
- Full cumulative regression suite and CI gates.
- Dependency/license/vulnerability review appropriate to submission.

## Implementation tasks

- [x] Write compact data-flow/threat model and trust-boundary checklist.
- [x] Add malicious document/DOM/source/model payload corpus.
- [x] Verify agents cannot expand tools/scope or smuggle graph edges/URLs/selectors.
- [x] Test webhook replay/signature/install/repository confusion.
- [x] Test source path/symlink/archive/size and documentation SSRF/redirect controls.
- [x] Test browser destructive/payment/message/secret and cross-host controls.
- [x] Test RLS, private Storage, signed URL expiry, Neo4j namespace, checkpoint schema isolation.
- [x] Inject crashes/timeouts/rate limits at every external boundary.
- [x] Verify retry/idempotency and non-idempotent interrupt behavior.
- [x] Add automated secret scan and dependency audit with documented exception policy.
- [x] Run full cumulative test/eval/build suite on clean environment.

## Acceptance criteria

- No known path lets untrusted content invoke an unauthorized tool/action/query or expose a secret.
- Cross-application/run/revision data does not leak through API, Realtime, Storage, Neo4j, or checkpoints.
- External failure produces typed, redacted, recoverable or terminal state without partial active graph publication.
- Duplicate webhooks/runs/tool results and retries remain idempotent.
- Non-idempotent browser uncertainty never auto-replays.
- Default CI uses no live/paid credentials and all deterministic suites pass.
- Any unresolved security limitation is explicit in the design document and demo scope.

## Required tests

- Full malicious-input/security matrix.
- Cross-boundary authorization/isolation integration tests.
- Provider/fault-injection and checkpoint-recovery tests.
- Secret scan and ignored-file validation.
- Dependency vulnerability/license checks.
- Full regression, build, and eval suite.

## Out of scope

Formal penetration-test certification, production SOC controls, arbitrary hostile-code execution sandbox, and production-scale DDoS resilience.

## Implementation notes

- `docs/security/threat-model.md` defines the data flow, trust-boundary checklist,
  abuse invariants, fault/recovery matrix, verification evidence, and explicit
  demo limitations. Untrusted content can contribute evidence but never tool,
  URL, path, browser, namespace, revision, or publication authority.
- `tests/fixtures/security/malicious-inputs.json` and the `security` Vitest
  project cover inert prompt injection, active DOM/XSS removal, SSRF and redirect
  targets, source traversal, secret-bearing model structures, URL/selector/edge
  tool smuggling, destructive/payment/message/cross-host browser actions, unknown
  submissions, and exact-byte webhook tampering.
- Existing boundary suites remain authoritative for webhook replay and identity,
  Git tree/symlink/blob limits, DNS-pinned documentation redirects, browser
  action identity and uncertain replay, owner/application/run/revision isolation,
  RLS and private Storage, fixed checkpoint schema, parameterized Neo4j queries,
  staged graph publication, provider/Git/browser/database/graph/storage/check
  failures, worker crashes, cleanup, leases, retries, and idempotency. The threat
  model links every boundary to those tests.
- `tools/security` implements cross-platform tracked/untracked high-confidence
  secret scanning without printing matched values, exact fingerprinted fixture
  exceptions, semantic ignored-file checks, production advisory validation,
  production license validation, and expiry enforcement. Policy and rationales
  live in `security/policy.json`; `docs/security/security-policy.md` documents
  the review procedure.
- Next.js, `@next/env`, and `eslint-config-next` were upgraded from 16.2.6 to
  16.3.3. Workspace overrides pin patched PostCSS 8.5.28 and xmldom 0.9.12.
  `apps/web/types/url-pattern.d.ts` supplies the current URLPattern names missing
  from TypeScript 5.9's DOM library without disabling library checks.
- Production audit has zero high/critical findings. Two moderate Crawlee
  transitives have exact exceptions expiring 2026-10-09: the stream-json fix is
  an unverified major outside Crawlee's range, and the advertised adm-zip patch
  is not published. Sentinel does not invoke either affected path on target
  content and independently bounds crawler/source inputs.
- `pnpm security` is a default-safe aggregate gate for secrets/ignored files,
  dependencies, licenses, the malicious suite, and deterministic SNT-033 100-run
  artifact drift. `.github/workflows/ci.yml` runs it with no live/paid credentials
  alongside the existing complete quality, build, unit, agent, graph, browser,
  and integration matrix.
- Focused verification on 2026-09-09: 349 tests passed (225 boundary unit, 25
  authenticated web route/proxy, 12 worker, 51 storage/migration/idempotency, 6
  real-browser Application Explorer integration, and 11 malicious/policy cases).
  The 19 merged SNT-030 deployment-identity and verification-planning contract,
  adapter, and orchestration tests also passed on the combined branch.
  Web, docs, and tools typechecks passed; all three security inventory gates and
  deterministic eval regeneration passed. Full CI remains pending GitHub Actions.
- The combined base does not implement SNT-029 report delivery, SNT-031
  trusted-head execution, or SNT-032 incremental refresh. SNT-030 now defines
  Render preview identity and bounded verification planning, and its focused
  security/identity tests join this issue's gate, but no trusted PR-head
  deployment is registered. This issue hardens all currently reachable surfaces
  but makes no claim for absent execution paths. The demo must report verification
  as unavailable and must not imply deployed refresh or final report delivery
  occurred; those limitations are explicit in the threat model for incorporation
  into the SNT-035 design document.
- The ystack `/review` found that the secret scanner missed current
  `github_pat_` fine-grained PATs and stateless `ghs_APPID_JWT` installation
  tokens. Detection now treats GitHub token bodies as opaque variable-length
  values using GitHub's current format guidance, and focused tests cover classic,
  fine-grained, and stateless formats without exposing matches in findings.
- The first CI security run exposed Linux-only Sharp license metadata. The gate
  now has an exact expiring exception for the unmodified dynamically loaded
  `@img/sharp-libvips-linux-x64@1.3.3` artifact while keeping LGPL outside the
  general allowlist; a regression proves unrelated LGPL packages still fail.
