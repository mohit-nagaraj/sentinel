# SNT-029 — Grounded report generation, dashboard, and GitHub summary

| Field          | Value                                              |
| -------------- | -------------------------------------------------- |
| Milestone      | M6 — Pull-request blast-radius product loop        |
| Status         | `done`                                             |
| Depends on     | SNT-005, SNT-025, SNT-026, SNT-028                 |
| Blocks         | Verification enrichment, final assignment delivery |
| PRD references | §8.6, §13.3/13.16, §17, FR-014                     |

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

- [x] Define report schema/view model before prose generation.
- [x] Build deterministic fallback Markdown renderer.
- [x] Add bounded structured wording call for titles/explanations/summaries.
- [x] Validate that generated references/claims are subsets of supplied facts.
- [x] Render product-first sections with optional engineering drill-down.
- [x] Store Markdown and metadata privately; issue authorized/signed access.
- [x] Build dashboard report route with evidence/source/artifact links.
- [x] Build GitHub check summary with correct success/neutral/failure/action-required semantics.
- [x] Prevent stale head/report races and make finalization idempotent.
- [x] Add print/export-friendly layout; PDF remains optional.

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

- `packages/contracts/src/report.ts` defines the immutable source/view/artifact,
  mandatory-section, citation, coverage, and append-only verification contracts.
- `packages/orchestration/src/report.ts` generates deterministic reports, limits
  model wording to exact supplied choices with complete citations, renders the
  canonical Markdown, projects GitHub outcomes, and finalizes reports only for a
  current assessment head.
- `packages/storage/src/assessment-report-{repository,service}.ts` and
  `supabase/migrations/20260909000200_assessment_reports.sql` provide private
  artifact delivery, owner-scoped reads, report-scoped excerpts, immutable
  compare-and-set finalization, retry reuse, and versioned verification
  enrichment.
- `apps/web/app/assessments/[assessmentId]` and
  `apps/web/components/assessment-report-workspace.tsx` provide the authorized
  product-first dashboard, engineering drill-down, Markdown download, and a
  print layout that expands all evidence without duplicating report content.
- Predicted risk never fails a GitHub check by itself. Verification failure and
  infrastructure/action-required outcomes remain distinct, and transient check
  synchronization is retried rather than misclassified as supersession.
- The ystack bug review found ungrounded model prose, retry artifact conflicts,
  and over-broad safety wording. Exact deterministic wording choices,
  authoritative stored-artifact reuse, and contextual assurance validation fix
  all three findings.
- Focused verification: 116 report/blast-radius/investigation/storage/web tests,
  all four affected package typechecks, changed-file lint/format/whitespace
  checks, and the Chromium dashboard, keyboard, mobile, print, and PDF flow
  passed. Complete CI remains pending GitHub Actions.
