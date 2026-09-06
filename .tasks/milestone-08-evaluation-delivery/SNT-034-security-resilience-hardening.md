# SNT-034 — Security, resilience, and regression hardening

| Field | Value |
|---|---|
| Milestone | M8 — Evaluation, hardening, and assignment delivery |
| Status | `not-started` |
| Depends on | SNT-026, SNT-029, SNT-031, SNT-032, SNT-033 |
| Blocks | Final assignment delivery |
| PRD references | §17–§20, NFR-003–NFR-009 |

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

- [ ] Write compact data-flow/threat model and trust-boundary checklist.
- [ ] Add malicious document/DOM/source/model payload corpus.
- [ ] Verify agents cannot expand tools/scope or smuggle graph edges/URLs/selectors.
- [ ] Test webhook replay/signature/install/repository confusion.
- [ ] Test source path/symlink/archive/size and documentation SSRF/redirect controls.
- [ ] Test browser destructive/payment/message/secret and cross-host controls.
- [ ] Test RLS, private Storage, signed URL expiry, Neo4j namespace, checkpoint schema isolation.
- [ ] Inject crashes/timeouts/rate limits at every external boundary.
- [ ] Verify retry/idempotency and non-idempotent interrupt behavior.
- [ ] Add automated secret scan and dependency audit with documented exception policy.
- [ ] Run full cumulative test/eval/build suite on clean environment.

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

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
