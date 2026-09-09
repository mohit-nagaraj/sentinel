# Graph Reconciliation Progress

## SNT-018 Evidence Validation And Linking

- [x] Define strict evidence-linking, adjudication, conflict, rejection, and pending-batch contracts.
- [x] Validate evidence identity, source kind, run, commit, relationship method, and exact endpoint bindings.
- [x] Resolve exact diff, endpoint, handler, source, runtime, route, and component links in trust order.
- [x] Assign authoritative Tier A/B links deterministically and keep Tier C/D candidates review-only.
- [x] Merge corroborating provenance, retain contradictions, and emit stable idempotent ordering.
- [x] Prove the policy matrix, adversarial adjudication, ambiguity, stale-version, conflict, and replay cases.

## SNT-020 Coverage Assessments And Absence Semantics

- [x] Define scoped assessment, environment, blocker, revision, graph-fact, and UI-summary contracts.
- [x] Assign observed, partial, not-observed, blocked, not-evaluated, and ambiguous statuses deterministically.
- [x] Require bounded scope and attempt evidence before producing not-observed coverage.
- [x] Emit stable assessments with immutable evaluator evidence and authoritative assessment-link candidates.
- [x] Invalidate assessments on requirement source, crawl configuration, authentication, and test-data changes.
- [x] Prove blocker separation, report wording, evidence advancement, batch completeness, linker integration, and replay idempotency.

## SNT-019 Evidence Curator And Bounded Reconciliation

- [x] Define strict compact coverage, Curator mission, review, reconciliation event, and terminal result contracts.
- [x] Classify cross-layer, conflict, review, and stale-evidence gaps deterministically from validated evidence state.
- [x] Validate advisory model missions against parent-owned identity, agent, mode, scope, tool, budget, relevance, and round policy.
- [x] Fan independent specialist missions out dynamically and merge committed receipts and durable results without lost updates.
- [x] Rebuild coverage after specialist results and stop on sufficiency, no material gain, round limit, budget, or no valid mission.
- [x] Checkpoint and resume accepted or rejected human decisions with serialized run execution.
- [x] Emit stable reconciliation activity only after the corresponding state is committed and prove reporting retry recovery.

## Decisions

| Date       | Decision                                                                                                          | Reason                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 2026-09-09 | Require relationship-specific endpoint bindings on every evidence record used by a submitted authoritative claim. | A matching extraction-method label cannot prove an unrelated subject/object relationship.                     |
| 2026-09-09 | Treat exact observations as deterministic inputs and reject stale or equally specific route matches.              | Exact tiers require a unique compatible structural match rather than every pattern that happens to match.     |
| 2026-09-09 | Keep all model-adjudicated Tier C/D candidates outside the pending authoritative link set.                        | Model selection can prioritize review but cannot create graph truth or enter confident blast-radius paths.    |
| 2026-09-09 | Derive link IDs from relationship endpoints and confirmation time from cited evidence.                            | Duplicate support strengthens one stable link, and identical reprocessing remains byte-for-byte idempotent.   |
| 2026-09-09 | Derive coverage status only from normalized attempt, checkpoint, blocker, and ambiguity inputs.                   | A model summary or missing graph relationship must never become an authoritative absence declaration.         |
| 2026-09-09 | Keep assessment identity stable across outcome evidence while content-addressing evaluator evidence.              | New evidence can advance one scoped assessment without mutating or aliasing the evidence that justified it.   |
| 2026-09-09 | Generate public reasons and wording deterministically and validate retained attempt summaries.                    | Qualified blocker details remain available internally without crashing or leaking absolute absence claims.    |
| 2026-09-09 | Treat Curator model output as advisory mission proposals and derive mission authority in the parent graph.        | A structured model call cannot grant itself tools, graph writes, evidence authority, or additional budget.    |
| 2026-09-09 | Serialize each Curator run and report reconciliation activity from post-commit graph nodes with stable IDs.       | Duplicate starts and event retries must not repeat specialist work or advertise state that was not committed. |
| 2026-09-09 | Count both new links/gap closure and strengthened evidence fingerprints as material reconciliation gain.          | Corroboration can improve evidence quality without changing aggregate link or gap counts.                     |
