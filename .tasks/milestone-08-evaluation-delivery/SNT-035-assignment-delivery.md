# SNT-035 — README, design document, sample output, and Loom preparation

| Field | Value |
|---|---|
| Milestone | M8 — Evaluation, hardening, and assignment delivery |
| Status | `not-started` |
| Depends on | SNT-029, SNT-033, SNT-034 |
| Blocks | Submission |
| PRD references | §22–§24, FR-020, assignment Deliverables |

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

- [ ] Write end-to-end README for web, worker, Supabase, Neo4j Aura, Azure, GitHub App, target sources, and optional preview.
- [ ] Include exact default-safe versus opt-in live test commands.
- [ ] Produce design document covering agent decomposition, graph schema/absence, ambiguity/confidence, eval, cuts, and next-week priorities.
- [ ] Include architecture, specialist/reconciliation, graph schema, and PR sequence diagrams.
- [ ] Generate and commit sanitized sample report for the chosen real PR.
- [ ] Record actual evaluation results and limitations; remove placeholders/unsupported claims.
- [ ] Prepare a 5–10 minute Loom sequence and fallback prerecorded evidence/screenshots if an external provider is temporarily unavailable.
- [ ] Verify links, citations, commands, environment variable names, and no secrets.
- [ ] Run clean-clone setup and full required checks.
- [ ] Produce final submission checklist with repository/design/sample/Loom URLs.

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

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
