# Graph Reconciliation Progress

## SNT-018 Evidence Validation And Linking

- [x] Define strict evidence-linking, adjudication, conflict, rejection, and pending-batch contracts.
- [x] Validate evidence identity, source kind, run, commit, relationship method, and exact endpoint bindings.
- [x] Resolve exact diff, endpoint, handler, source, runtime, route, and component links in trust order.
- [x] Assign authoritative Tier A/B links deterministically and keep Tier C/D candidates review-only.
- [x] Merge corroborating provenance, retain contradictions, and emit stable idempotent ordering.
- [x] Prove the policy matrix, adversarial adjudication, ambiguity, stale-version, conflict, and replay cases.

## Decisions

| Date       | Decision                                                                                                          | Reason                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 2026-09-09 | Require relationship-specific endpoint bindings on every evidence record used by a submitted authoritative claim. | A matching extraction-method label cannot prove an unrelated subject/object relationship.                   |
| 2026-09-09 | Treat exact observations as deterministic inputs and reject stale or equally specific route matches.              | Exact tiers require a unique compatible structural match rather than every pattern that happens to match.   |
| 2026-09-09 | Keep all model-adjudicated Tier C/D candidates outside the pending authoritative link set.                        | Model selection can prioritize review but cannot create graph truth or enter confident blast-radius paths.  |
| 2026-09-09 | Derive link IDs from relationship endpoints and confirmation time from cited evidence.                            | Duplicate support strengthens one stable link, and identical reprocessing remains byte-for-byte idempotent. |
