# SNT-029 — Grounded report generation, dashboard, and GitHub summary

| Field | Value |
|---|---|
| Milestone | M6 — Pull-request blast-radius product loop |
| Status | `not-started` |
| Depends on | SNT-005, SNT-025, SNT-026, SNT-028 |
| Blocks | Verification enrichment, final assignment delivery |
| PRD references | §8.6, §13.3/13.16, §17, FR-014 |

## Background

The report is the business output. It must be readable by a product-aware QA lead, grounded in structured findings/evidence, and detailed enough for an engineer to inspect without allowing generated prose to introduce new claims.

## Scope

- Deterministic report view model and mandatory sections.
- Structured model wording through `ModelGateway` using validated facts only.
- Claim/citation/evidence ID post-validation.
- Markdown canonical output and private Storage persistence; dashboard rendering.
- Technical drill-down to changed symbols/evidence paths.
- Predicted risk, coverage, unknowns, exclusions, stale/missing evidence, and QA recommendations.
- Verification placeholder/enrichment contract.
- Concise GitHub check summary/conclusion/external URL.
- Immutable assessment identity and generated-at/commit/policy/model/template versions.

## Implementation tasks

- [ ] Define report schema/view model before prose generation.
- [ ] Build deterministic fallback Markdown renderer.
- [ ] Add bounded structured wording call for titles/explanations/summaries.
- [ ] Validate that generated references/claims are subsets of supplied facts.
- [ ] Render product-first sections with optional engineering drill-down.
- [ ] Store Markdown and metadata privately; issue authorized/signed access.
- [ ] Build dashboard report route with evidence/source/artifact links.
- [ ] Build GitHub check summary with correct success/neutral/failure/action-required semantics.
- [ ] Prevent stale head/report races and make finalization idempotent.
- [ ] Add print/export-friendly layout; PDF remains optional.

## Acceptance criteria

- A non-engineering reviewer understands affected areas, why, evidence strength, uncertainty, and what to test.
- Every report claim maps to supplied finding/evidence IDs; hallucinated IDs/facts cause fallback or failure.
- Unknowns and unobserved coverage are clearly distinguished from no impact/feature absence.
- Report never says the PR is safe based on prediction or a limited passing scenario.
- GitHub check is concise, links to dashboard, and does not fail merely because risk is high.
- Report is immutable for `(repository, PR, head SHA, graph revision, policy version)` except append-only verification enrichment/versioned regeneration.
- Secrets/private raw artifacts are never embedded in public/check output.

## Required tests

- Report schema and fact-subset validation tests.
- Golden Markdown snapshots for high/medium/low/unknown/mixed/verification-unavailable cases.
- Malicious/hallucinated model output rejection tests.
- Dashboard authorization/private artifact tests.
- GitHub check conclusion and stale-head race tests.
- Accessibility/print browser tests.

## Out of scope

Automatic PR comments, editing GitHub source, final PDF requirement, and performing verification.

## Implementation notes

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
