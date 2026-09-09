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

Show the repository and the design-document opening. Say: Sentinel connects
product intent, observed UI behavior, and code evidence to explain the blast
radius of a real pull request. The deep slice is Hi.Events attribution; checkout
is retained only as an explicitly excluded environment control.
the implemented report, verification, and refresh engines are demonstrated with
deterministic data because no trusted external PR-head deployment was registered.

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

Use the four design-document diagrams to summarize source ingestion, specialist
reconciliation, graph absence semantics, and PR assessment. Name the core
trade-off: agents decide where to look; deterministic code decides what can be
read, accepted, published, retried, or called verified.

### 7:55-8:30 - Honest close

Show the scope/next-week section. Repeat the three highest-value next steps:
compile/deploy the production root graphs, run the trusted Hi.Events
base/head calibration study, then validate a second target. End on the
submission checklist and repository URL.

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
