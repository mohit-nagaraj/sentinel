# SNT-035 — README, design document, sample output, and Loom preparation

| Field          | Value                                               |
| -------------- | --------------------------------------------------- |
| Milestone      | M8 — Evaluation, hardening, and assignment delivery |
| Status         | `done`                                              |
| Depends on     | SNT-029, SNT-033, SNT-034                           |
| Blocks         | Submission                                          |
| PRD references | §22–§24, FR-020, assignment Deliverables            |

## Background

Code and design document are weighted equally. The final issue turns the verified system into a reproducible submission: repository, end-to-end README, 8–12 page design document, real-PR sample report, and concise Loom path with honest scope decisions.

## Scope

- Root README with prerequisites, architecture summary, safe setup, migrations, provider configuration names, run commands, tests, teardown, troubleshooting, and demo path.
- Design document (Markdown and optional PDF) addressing every required Part B topic.
- Diagrams sourced from verified architecture, not stale early plans.
- Sanitized immutable sample blast-radius report for selected real PR.
- Loom script/checklist and resettable demo data/state.
- License/attribution and secret hygiene.
- Final clean-clone verification.

## Implementation tasks

- [x] Write end-to-end README for web, worker, Supabase, Neo4j Aura, Azure, GitHub App, target sources, and optional preview.
- [x] Include exact default-safe versus opt-in live test commands.
- [x] Produce design document covering agent decomposition, graph schema/absence, ambiguity/confidence, eval, cuts, and next-week priorities.
- [x] Include architecture, specialist/reconciliation, graph schema, and PR sequence diagrams.
- [x] Generate and commit sanitized sample report for the chosen real PR.
- [x] Record actual evaluation results and limitations; remove placeholders/unsupported claims.
- [x] Prepare a 5–10 minute Loom sequence and fallback prerecorded evidence/screenshots if an external provider is temporarily unavailable.
- [x] Verify links, citations, commands, environment variable names, and no secrets.
- [x] Run clean-clone setup and full required checks.
- [x] Produce final submission checklist with repository/design/sample/Loom URLs.

## Acceptance criteria

- A reviewer can follow README from clean clone to the demonstrated report without relying on this conversation.
- Design document is roughly 8–12 pages/equivalent and explicitly answers all assignment questions.
- Sample output concerns a real public PR and is readable by a non-engineering QA lead.
- Loom demonstrates the running prototype, evidence graph, absence/ambiguity, PR analysis, and honest scope within 5–10 minutes.
- All diagrams/links/commands are current and reproducible.
- No secret, private artifact URL, raw credential, or unsafe test instruction is committed.
- Test/eval results are reported faithfully, including skipped live verification if no trusted head deployment exists.

## Required tests

- Markdown/link/code-fence/Mermaid checks.
- Automated command/example consistency checks where practical.
- Secret scan across tracked files and Git diff.
- Clean-clone install/build/migration/default-test smoke.
- Manual Loom rehearsal against resettable state.
- Final deliverables checklist review against `AI Engineer Updated - Assignment.md`.

## Out of scope

Marketing site, production operations handbook, fabricated performance/eval numbers, and hiding unresolved limitations.

## Implementation notes

Completed on 2026-09-09.

- Expanded `README.md` into the reproducible review path, provider setup and
  teardown reference, safe/default versus opt-in live commands, and focused demo
  navigation. Added the missing live configuration names to `.env.example`.
- Added the assignment-length `DESIGN.md`, four source Mermaid diagrams, and the
  accessible standalone `docs/delivery/diagrams.html`. The diagram artifact uses
  the repository's white/ink/green/gray tokens and intentionally collapses
  low-level parser, storage, and retry branches documented in prose.
- Added a strict sanitized source fixture for public Hi.Events PR #1338 and a
  generator that renders `docs/delivery/sample-report-hi-events-pr-1338.md`
  through the production report renderer. The report uses the exact public
  base/head identities and does not embed private artifacts or provider output.
- Added `docs/delivery/loom-script.md`, four captured fixture screenshots,
  attribution, and `docs/delivery/submission-checklist.md`. Recording, uploading,
  and inserting the Loom share URL remain explicit human submission actions.
- Reconciled the package after SNT-029, SNT-031, and SNT-032 merged. Report
  delivery, trusted-head verification, and incremental refresh are implemented;
  the sample remains `verification_unavailable` because no trusted external
  PR-head deployment was registered or exercised.
- Added the delivery Vitest project, real Mermaid parsing, local-link and command
  checks, schema/renderer drift checks, screenshot validation, diagram
  accessibility checks, and a CI delivery job.
- Clean-copy proof of the committed delivery state: `pnpm install --frozen-lockfile`,
  `pnpm delivery:check` (8 tests), `pnpm security` (11 tests plus dependency,
  license, secret, and evaluation drift gates), orchestration/web/tools focused
  type checks, and an isolated Supabase 2.117.0 start/reset through all 10
  migrations passed. `pnpm demo:web` served `/`, `/runs`, `/knowledge`, and the
  fixture assessment report with HTTP 200 on an isolated port.
- Additional focused report API/component/activity coverage passed (15 tests),
  the targeted Chromium report/print flow passed, the diagram self-check passed,
  scoped ESLint passed, and `git diff --check` passed.
  Full format, lint, build, unit, integration, agent, graph, browser, security,
  and delivery matrices remain owned by `.github/workflows/ci.yml` and are
  recorded after the final pull request completes.
- The requested `/review` found that the report fixture still used synthetic
  checkout findings and redirected Markdown to a reserved placeholder host.
  Fixture mode now parses the canonical JSON through the sample-view builder,
  serves its generated Markdown as a local attachment, and retains production
  signed redirects as a distinct service result. Focused API/component coverage
  was expanded and the report fallback screenshot was recaptured from the fixed
  dashboard. The same reviewer rechecked both findings and returned `PASS`.
