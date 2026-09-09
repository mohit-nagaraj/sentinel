# SNT-015 — Documentation Explorer agent

| Field | Value |
|---|---|
| Milestone | M3 — Specialist discovery agents |
| Status | `done` |
| Depends on | SNT-008, SNT-014 |
| Blocks | Evidence linking, coverage, Curator, evaluation |
| PRD references | §13.5, §15, FR-004 |

## Background

A documentation root does not reveal which linked pages contain testable behavior. The agent must iteratively search/read/follow approved evidence while every requirement remains cited and validated.

## Mission modes

- `baseline_discovery`
- `targeted_requirement_lookup`
- `conflict_resolution`

## Scope

Implement the Documentation Explorer using the shared kernel and only:

- `list_document_tree`
- `search_documentation`
- `read_document_section`
- `inspect_linked_sections`
- `submit_requirement_claim`
- `finish_document_mission`

Add mission-specific prompts, context construction, claim validation, source-citation checks, and coverage/no-progress completion rules.

## Implementation tasks

- [ ] Implement bounded tool adapters over SNT-008 APIs.
- [ ] Define context selection that includes mission, compact history, and only relevant section excerpts.
- [ ] Define structured atomic requirement/acceptance-criterion extraction.
- [ ] Require claim excerpt IDs to exist and support the returned statement.
- [ ] Separate requirements from marketing, setup, architecture, examples, and unsupported claims.
- [ ] Track visited searches/sections/links and prevent circular rereading.
- [ ] Emit newly discovered capability terms for other specialists.
- [ ] Return conflicts, missing evidence, and recommended follow-ups explicitly.
- [ ] Add baseline and targeted completion validators.

## Acceptance criteria

- Starting from a docs root/map—not a preselected page list—the agent discovers the golden relevant sections.
- Every requirement/criterion cites an exact approved section/excerpt.
- The agent cannot fetch an unapproved URL or read beyond section/content budget.
- Repeated/circular navigation terminates with a typed reason.
- Product claims unsupported by excerpts are rejected before mission completion.
- Conflicting sources remain distinct and create an unresolved item.
- Output is a valid `MissionResult`, not free-form prose.

## Required tests

- Golden mission over a small linked documentation fixture with distractor marketing/setup pages.
- Targeted lookup and conflict-resolution trajectories.
- Citation fabrication/mismatch negative tests.
- Off-map URL/tool/scope denial tests.
- Circular links/no-progress/budget exhaustion tests.
- Repeated scripted runs measuring requirement/citation stability.
- Opt-in Hi.Events documentation mission eval after the target docs are fixed.

## Out of scope

Writing source documentation, browser UI discovery, code matching, final evidence tier assignment, and Neo4j writes.

## Implementation notes

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
