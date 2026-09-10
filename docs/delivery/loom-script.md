# Loom recording script

Target length: 8 minutes 30 seconds. Record at 1440p or 1080p with browser zoom
at 100%. Start from a fresh `pnpm demo:web` process so the in-memory state is
known. Keep the repository and `DESIGN.md` open in separate tabs.

## Before recording

- Run `pnpm delivery:check` and `pnpm security`.
- Start `pnpm demo:web`; confirm `/api/health`, `/`, `/runs`, and `/knowledge`
  load at `http://127.0.0.1:3000`.
- Close notifications, credential managers, terminal history, provider consoles,
  and unrelated tabs. Use no `.env` file or live provider credential on screen.
- Open the sample report and design document at their committed revisions.
- State up front that the UI uses resettable deterministic fixtures and the
  sample report is golden-fixture output, not a live PR-head verification.

## Timed sequence

### 0:00-0:40 - Problem and scope

Show the repository and the design-document opening. Use the spoken intro below.
Stay on the one-question framing, Hi.Events attribution, checkout as an excluded
control, and that this recording uses resettable fixtures.

### 0:40-1:45 - Safe onboarding

Open `/`. Show the Hi.Events repository/deployment/documentation inputs, detected
TypeScript/React and PHP/Laravel capabilities, safe browser action scope, and
confirmation invalidation. Call out immutable commit identity, credential
references, and the fact that confirmation does not silently start work.

### 1:45-3:00 - Specialist activity

Open `/runs`, choose the fixture run, and scan the Documentation, Code,
Application, and Curator lanes. Show a tool decision, evidence emission, budget,
and terminal/interrupt state. Say that the model chooses bounded tools, while
strict schemas, scope, budget, replay, and evidence validation are deterministic.
Do not describe the activity feed as chain-of-thought.

### 3:00-4:15 - Evidence graph and absence

Open `/knowledge`. Show one complete evidence path from requirement through
workflow/UI/API/code, then show coverage. Open the promotion-code item and explain
the difference between `not_observed`, `blocked`, `ambiguous`, and true feature
absence. Show a pending review/interrupt if available.

### 4:15-5:55 - Real PR and reference report

Open Hi.Events PR #1338, point to its immutable base/head identities, then open
`/assessments/00000000-0000-4000-8000-000000000029`. Read the executive summary,
affected UI/workflow/requirement findings, one evidence path, recommended QA,
coverage, and unknowns; show print or Markdown download. Explain that report
delivery is implemented, while this view and the committed sample use a
deterministic fixture rather than a persisted live assessment.

### 5:55-6:55 - Evaluation and security

Show `docs/evaluation/snt-033-baseline.md`: 400 deterministic executions, stable
normalized evidence, no model usage, and the stated limitations. Show the
security gate summary or CI checks. Mention hard failures for unsupported
critical claims and unsafe tools, current GitHub token scanning, dependency and
license policy, and that live/paid evaluation needs explicit confirmation.

### 6:55-7:55 - Architecture and decisions

If you stay on 8:30, use the compressed architecture beat below while showing the
four DESIGN.md diagrams. If you want specialists, parsers, Neo4j, and
relationships said properly, extend this slot (or record a second Loom) and read
the full spoken architecture script.

### 7:55-8:30 - Honest close

Show the scope/next-week section. Repeat the three highest-value next steps:
compile/deploy the production root graphs, run the trusted Hi.Events
base/head calibration study, then validate a second target. End on the
submission checklist and repository URL.

## Spoken architecture script

Use this as the words for the intro, `/runs`, `/knowledge`, and DESIGN.md
segments. Read it; do not improvise chain-of-thought or live-verification claims.
The fixture UI is on screen; this narration is about how the product is built.

### Intro (~45s)

Sentinel answers one question: given product docs, a live app, its source, and a
real pull request, **what product behavior deserves regression attention, and
why?**

It is not a chatbot that summarizes a diff. It builds an evidence graph that
connects three persistent sources — documentation, observed UI, and
implementation — then, when a PR opens, walks only evidence-backed paths from
changed code to screens, workflows, and requirements.

The demo target is the Hi.Events fork. The reference change is attribution
tracking and the admin attribution report. Checkout stays in the graph only as
an excluded control, so we can tell product failure from environment failure.

What you are about to see is a resettable deterministic fixture. Report delivery
and the engines are real; this recording does not pretend a trusted PR-head
deployment was registered.

The design rule underneath everything: **the model chooses where to look.
Deterministic code decides what counts as evidence, what enters the graph, and
what the report may claim.**

### Compressed architecture beat (~60s, for the 8:30 cut)

Three specialists, not one agent: Documentation Explorer, Code Explorer,
Application Explorer, then a Curator that only reconciles validated proposals.
Parsers run first: TypeScript through `ts-morph`, PHP through an isolated
nikic/PHP-Parser CLI that never executes Hi.Events, docs as a deterministic map,
Playwright for the live app. Facts land in Neo4j as a typed, revisioned graph.
Postgres owns runs and which revision is active. Blast radius is a fixed walk
from `CHANGES` along allowlisted edges like `HANDLED_BY`, `TRIGGERS_API`,
`ACTS_ON`, `HAS_STEP`, `COVERED_BY`. Missing product behavior is a
`CoverageAssessment` on the requirement, not a deleted node. Agents choose
where to look; code decides what can be published or called verified.

### Why three specialists, not one agent (~50s)

Documentation, code, and a live product are different evidence spaces. A docs
root is a web of pages. A repo is thousands of symbols. A workflow spans
screens and network calls. One unrestricted ReAct loop would mix those
permissions and invent links.

So onboarding runs three bounded specialists, then a Curator:

1. **Documentation Explorer** — given an approved document map, it chooses which
   page or section answers the mission and proposes atomic, testable
   requirements. It cannot browse arbitrary URLs or create uncited requirements.
2. **Code Explorer** — it does not parse the repo itself. Parsers first build a
   deterministic index. The explorer then chooses which symbol, call, or
   endpoint slice to inspect and proposes implementation paths. It has no shell,
   no git write, no graph write.
3. **Application Explorer** — Playwright observe → decide → act → observe. It
   only sees opaque, state-bound action IDs and named safe inputs. No raw
   selectors, no injected JavaScript, no secret values in the model.

The **Evidence Curator** is not a fourth omniscient agent. It sees compact
validated proposals and conflicts. It can request a follow-up like “which
observed control triggers this endpoint?” It cannot mint arbitrary edges, change
evidence tiers, or bypass budgets. When the round limit hits, we publish
ambiguity or a coverage gap instead of looping toward fake certainty.

All three specialists share one LangGraph kernel: mission mode, tool allowlist,
budget, no-progress limit, checkpoint fingerprint. A resumed thread cannot
silently swap tools or prompts. LangGraph is **how work executes**. Neo4j is
**what we know**. Those are not the same store.

### Parsers and indexes (before any agent) (~50s)

Agents never eat a git tree. Adapters produce facts first.

- **TypeScript and React** use `ts-morph` and the TypeScript compiler API:
  modules, components, hooks, calls, and frontend routes with exact file ranges.
- **PHP and Laravel** use a small isolated CLI, `tools/php-indexer`, on
  **nikic/PHP-Parser**. It resolves names, emits JSON facts, and never boots or
  executes Hi.Events. We did not use a JavaScript PHP parser because namespace
  resolution and source positions actually matter on this codebase.
- **Routes and OpenAPI** normalize Laravel routes and Scramble endpoints so a
  browser-observed request can match a handler symbol.
- **Docs** are a deterministic map: Crawlee same-host crawl, `remark-parse` for
  repo Markdown, sanitized HTML. Citations have to be exact sections.
- **The live app** is direct Playwright. Discovery and later verification replay
  are separate jobs. Verification, when it runs, must hit a deployment of the
  **PR head**, not the baseline.

Every fact carries application, revision, extraction method, and an evidence
tier. Tier A is direct structure or observation. Tier B is a corroborated
mapping. Tier C is semantic and stays reviewable. Tier D cannot carry a
confident blast-radius path. A model cannot promote its own assertion.

### How the graph is implemented (~50s)

Four kinds of state, on purpose:

1. **Postgres** — applications, runs, leases, interrupts, assessments, which
   graph revision is active.
2. **Neo4j** — typed product knowledge, scoped by application and revision.
   Publication stages a pending batch, validates it, then switches the active
   revision atomically. We do not keep `knowledge-v1`, `v2` trees on disk.
3. **Private object storage** — screenshots and traces, content-addressed, short
   signed URLs only.
4. **Ephemeral runtime** — checkouts, ASTs, DOM, Playwright pages, prompts.
   Those never become checkpoint state.

Stable IDs are content-derived. A code symbol is repo, commit, language,
qualified name, path, and range. A UI element is screen, semantic role, and
context fingerprint — not a CSS selector. That is what makes reuse and “this
edge is stale” possible.

Blast radius is a **fixed Cypher pattern** from changed symbols toward UI,
workflow, and requirement targets, inside one application and the active
revision. Stale, conflicted, pending-review, wrong-direction, cyclic, over-depth,
or Tier-D edges become caveats, not confident findings.

### Important relationships (say these on `/knowledge`) (~60s)

The graph is facts plus **allowlisted** edges. Direction is part of the schema.

The path a QA lead should be able to follow, for example “submit order” or
“open attribution report”:

| Relationship | Meaning |
| --- | --- |
| `STATES` | A doc section states a requirement |
| `COVERED_BY` | That requirement is covered by a workflow |
| `HAS_STEP` / `NEXT` | Ordered flow steps |
| `ON_SCREEN` / `CONTAINS` | Step or screen to UI |
| `ACTS_ON` | The user action on a control |
| `TRIGGERS_API` | That control fires an endpoint |
| `CALLS_API` / `HANDLED_BY` | Frontend or route to the Laravel/TS symbol |
| `CALLS`, `READS`, `WRITES` | Symbol-to-symbol and domain entities |
| `CHANGES` | The pull request touches this symbol |
| `HAS_ASSESSMENT` | Requirement → coverage record, not a missing node |

Also `MATCHES_ROUTE`, `RENDERED_BY`, `BINDS` for screen-to-frontend-symbol.

Say it as a path, not a list: a doc section **states** a requirement; that
requirement is **covered by** a workflow; the workflow **has steps**, and those
steps are **next** to each other; a step sits **on a screen** and **acts on** a
control the screen **contains**; that control **triggers an API**, which is
**handled by** a code symbol, or a frontend symbol **calls the API**. Symbols
**call**, **read**, and **write** domain entities. The PR **changes** symbols.
The requirement **has an assessment** so we can say not observed without
deleting the requirement.

When I open the promotion-code item, I am not saying “Hi.Events has no promo
codes.” I am showing a **coverage assessment**: `not_observed`, `blocked`,
`ambiguous`, or `not_evaluated` are scoped statuses. True absence is a reviewed
conclusion, not a null traversal.

### Honest close for this segment (~20s)

PR investigation starts at `CHANGES`, walks only those allowlisted
relationships, and scores risk separately from evidence strength. The report
must cite evidence IDs; unknown remains visible. Passing one Playwright scenario
does not delete an impacted requirement.

This recording still uses the fixture graph and
`verification_unavailable` for runtime QA. The architecture is what I just
described; the missing piece is a trusted PR-head deploy, not a prettier
sentence.

## Fallback evidence package

If an external provider is unavailable, keep the demo on deterministic local
fixtures and use these committed artifacts:

- `docs/delivery/screenshots/onboarding.png`
- `docs/delivery/screenshots/activity.png`
- `docs/delivery/screenshots/knowledge-path.png`
- `docs/delivery/screenshots/assessment-report.png`
- `docs/delivery/sample-report-hi-events-pr-1338.md`
- `docs/evaluation/snt-033-baseline.md`
- `docs/security/threat-model.md`

Do not substitute an untrusted or mismatched deployment. Say
`verification_unavailable`, show the action needed to unblock it, and continue
with the static assessment evidence.

## Rehearsal record

| Check                                            | Result                             |
| ------------------------------------------------ | ---------------------------------- |
| Deterministic demo reset and routes              | Pending final clean-copy rehearsal |
| Timed narration between 5 and 10 minutes         | Pending human rehearsal            |
| No credential/private artifact visible           | Pending human rehearsal            |
| Every on-screen claim matches committed evidence | Pending human rehearsal            |
| Loom URL added to submission checklist           | Pending recording                  |
