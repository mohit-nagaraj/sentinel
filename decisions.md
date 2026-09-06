# Sentinel — User-Directed Decision Log

This file records the architectural corrections and product decisions made during discussion. Each line captures the chosen direction; the complete specification and rationale live in [`PRD.md`](./PRD.md).

## Product and lifecycle

- Treat the live application, documentation, and repository as the three persistent onboarding sources; a pull request is a later analysis trigger, not a fourth baseline source.
- Onboard the three persistent sources once, then reuse the resulting knowledge graph for each PR instead of re-ingesting and recrawling everything per assessment.
- Model PR assessment as its own workflow that starts when a PR is submitted or opened and produces a provisional blast-radius report.
- Refresh the graph only after a merged change is deployed, re-indexing changed code and recrawling affected or stale workflows rather than rebuilding everything by default.
- Present Sentinel as a persistent application-intelligence product with onboarding, readiness, assessment, verification, and refresh states—not merely four disconnected CLI commands.
- Remember that the submission deadline is five days, while still respecting the assignment's 16-hour scope signal by choosing depth over unnecessary breadth.

## Target and extensibility

- Use the public fork [`mohit-nagaraj/Hi.Events`](https://github.com/mohit-nagaraj/Hi.Events) as the demonstration repository.
- Make PHP/Laravel and TypeScript/React extraction excellent for the Hi.Events demo instead of attempting shallow support for many languages.
- Keep adapter boundaries so other languages and frameworks can be added later, but place those adapters explicitly outside the assignment scope.
- Keep onboarding configuration-driven and never hardcode pre-known Hi.Events graph links, affected screens, or blast-radius conclusions.
- Require the indexed/deployed commit and PR base/head commits to align; do not analyze a PR against a baseline that already contains its changes.
- Treat AI-generated Hi.Events backend documentation as candidate context only and verify important implementation edges with source code, Laravel routes, OpenAPI, and browser-observed requests.
- Require the fork to expose sufficient version-controlled product documentation; Sentinel ingests what the target supplies rather than hardcoding or inventing a Hi.Events documentation subset.
- Treat the exact documentation content and target-owned seed/reset mechanism as prerequisites owned by the fork, not architecture questions Sentinel must answer in its PRD.
- Leave the public baseline/PR-head sandbox mechanism unresolved until deployment options are evaluated; do not make local-only execution the final assignment architecture.

## Product experience

- Provide a simple product frontend for connecting sources, confirming scope, viewing run status, inspecting knowledge, and analyzing PRs instead of requiring users to author YAML.
- Keep implementation details such as graph revisions, temporary JSON, hashes, storage paths, and `knowledge-vN` concepts hidden from ordinary end users.
- Use clear product statuses such as `Initializing knowledge`, `Ready`, `Assessing PR`, `Verifying`, `Refreshing`, `Needs review`, `Stale`, and `Failed` rather than “creating knowledge for the nth time.”
- Use Mermaid diagrams in the PRD because they are version-controlled, GitHub-rendered, diffable, and directly understandable by Claude Code and Codex.
- Collect the target application's required login fields during onboarding and store only a restricted secret reference, then create Playwright session state at run time.

## PR reasoning and QA verification

- Use AST/static extraction inside the code layer; it complements the crawl → ingest → graph → reason pipeline rather than replacing it.
- Add a targeted Playwright QA run after blast-radius prediction when a deployment of the PR head is available.
- Separate exploratory Playwright discovery from deterministic verification replay because they serve different reliability goals.
- Keep predicted blast radius separate from observed QA results: impact means “at risk,” while verification records `passed`, `failed`, `behavior changed`, `blocked`, or `not run`.
- Never claim that Playwright verified a PR by testing only the baseline deployment; require a preview or other deployment tied to the PR head.
- Run graph-selected affected workflows and, where feasible, one unaffected control flow rather than rerunning a broad test suite without prioritization.
- Do not remove an impacted requirement from the report merely because one targeted scenario passed; passing evidence does not prove the PR safe.
- Include a GitHub App in the MVP so PR open/update events trigger analysis and one GitHub check reports progress and summary, while the Sentinel dashboard remains the canonical full report.
- Keep manual PR URL submission as a fallback and demo path that calls the same assessment service rather than duplicating the workflow.

## Persistence and repository ownership

- Use Supabase Postgres rather than SQLite for Sentinel's operational application state, runs, assessments, hashes, and review decisions.
- Use the configured Neo4j Aura instance for the active cross-layer knowledge graph and Supabase private Storage only for durable evidence worth retaining.
- Never write Sentinel output to the user's repository or default branch; source repositories are read-only inputs checked out into an ephemeral Sentinel-owned workspace.
- Do not add a persistent `.artifacts/` directory; the cloud worker uses disposable runtime-local temporary storage, while durable evidence belongs in Supabase Storage.
- Do not persist full repository clones, parser ASTs, complete source copies, or intermediate candidate files after their run has completed.
- Do not retain `diff.patch` by default; store the repository identity, immutable base/head SHAs, normalized diff hash, changed ranges/symbols, and derived findings so the diff remains reproducible.
- Do not maintain duplicate `knowledge-v1`, `knowledge-v2`, and similar artifact trees; keep one current active graph plus compact run/audit metadata and immutable assessment reports.
- Remove or supersede stale facts when a successful refresh becomes active; stale evidence must not remain part of current blast-radius traversal.
- Preserve old artifacts only when an immutable historical assessment report still references them or a retention/debugging rule explicitly requires them.

## Agent architecture — selected reasoning

- I selected three bounded specialist discovery agents because all three evidence spaces require iterative investigation rather than a known one-shot path: documentation spans linked pages, implementation spans folders/languages/layers, and application behavior spans multiple stateful screens.
- For documentation, my reasoning was that Sentinel may receive only a documentation root and must discover how it is structured, where testable product behavior lives, and which linked pages clarify a requirement; therefore a fixed page list plus one extraction call is insufficient.
- For code, my reasoning was that AST parsing alone produces structural facts but does not decide which of many routes, components, API clients, actions, handlers, services, repositories, tests, and domain entities form the product path being investigated; therefore a Code Explorer must navigate a deterministic repository index.
- For the live application, my reasoning was that a workflow starts on one screen, traverses choices and intermediate states, and ends elsewhere; therefore Playwright needs an observe → decide → act → observe feedback loop rather than a hardcoded single-screen script.
- For PR review, my reasoning was that static traversal is only the first pass: the system should investigate changed code, derive affected missions, prepare unrelated prerequisites deterministically, exercise relevant UI behavior on a trusted PR-head deployment, observe feedback, and adapt within a bounded loop.
- Use a custom LangGraph.js `StateGraph` as the execution framework because the selected architecture now needs three loops, parallel onboarding branches, bounded reconciliation, durable checkpoints, per-node retries, human interrupts, event streaming, and node/partial-path testing.
- Keep LangGraph and Neo4j separate: LangGraph controls how work executes, while Neo4j stores what Sentinel knows about requirements, UI, workflows, and code.
- Use three reusable specialist subgraphs: Documentation Explorer, Code Explorer, and Application Explorer, each with explicit mission modes, state, constrained tools, budgets, typed results, stop conditions, and abstention/escalation.
- Use a bounded Evidence Curator to compare a compact cross-layer coverage matrix and propose focused follow-up missions; it is not an unrestricted master agent and cannot browse, mutate Neo4j, assign final evidence tiers, alter risk formulas, or bypass budgets/policy.
- Exchange typed `DiscoveryMission`, `MissionResult`, claim, and evidence-reference objects between agents rather than passing free-form transcripts.
- Let agents propose evidence-backed claims, but keep deterministic validators responsible for schema checks, evidence tiers, browser safety, verification verdicts, risk calculation, and Neo4j writes.
- Cap reconciliation rounds and per-agent tool/content/action/model budgets so “improve the knowledge graph” cannot become an endless loop.

## Documentation, code, and application tools

- Build the Documentation Explorer on a deterministic map created with Crawlee sitemap/robots/same-host crawling, `remark-parse` for repository Markdown, and sanitized HTML parsing with jsdom, Mozilla Readability where appropriate, DOMPurify, and deterministic main/article fallbacks.
- Give the Documentation Explorer bounded tools for listing the documentation tree, searching, reading cited sections, inspecting approved links, submitting requirement claims, and finishing or abstaining; it cannot browse arbitrary web URLs or create uncited requirements.
- Use `ts-morph`/TypeScript Compiler API to build the TypeScript/React repository skeleton before the Code Explorer navigates it.
- Use a small isolated PHP CLI with `nikic/PHP-Parser` instead of the JavaScript `php-parser` package because Hi.Events is majority PHP and accurate namespace resolution and source positions matter; the process emits JSON facts and never executes the target application.
- Give the Code Explorer bounded module/symbol/text search, source inspection, definition/reference, caller/callee, endpoint/frontend bridge, and test-corroboration tools; do not give it arbitrary shell, Git, filesystem, or graph-write authority.
- Use direct Playwright as the Application Explorer's observation, action, evidence, and verification layer rather than hiding these assignment-critical boundaries behind Stagehand.
- Give the Application Explorer only state-bound opaque action IDs, named safe input slots, bounded history navigation, and finish/escalation tools; never expose arbitrary selectors, JavaScript, URLs, shell access, or credential values.
- Checkpoint browser references and safe action history—not live `Page` objects—and recover by restoring authentication and replaying only safe/idempotent steps while verifying state fingerprints; interrupt on uncertain non-idempotent boundaries.
- During PR validation, use trusted fixture/API setup for prerequisites outside the blast radius and exercise setup through the UI only when that setup behavior is itself affected.

## Runtime, UX, and evaluation

- Use Azure OpenAI through the official `openai` TypeScript package inside custom LangGraph nodes because Azure credits are available; keep a small internal model gateway and exact endpoint/deployment configuration in server environment secrets.
- Store LangGraph checkpoints with `PostgresSaver` in a non-exposed Supabase `langgraph_checkpoint` schema keyed by Sentinel run ID; checkpoint only compact mission/evidence references and budgets, not documents, source files, ASTs, DOMs, screenshots, credentials, or Neo4j copies.
- Stream LangGraph state/custom/tool lifecycle events into redacted `run_events`, then fan them out through private Supabase Realtime Broadcast.
- Show Documentation, Code, and Application lanes plus cross-layer reconciliation in the UI, including structured decisions, tool/action status, evidence gained, budgets, and latest action-aligned screenshot.
- Show concise reason codes/summaries rather than chain-of-thought, and never expose prompts, secrets, cookies, raw credentials, internal selectors, or arbitrary full DOM.
- Use action-aligned screenshot storyboards for the MVP; treat real-time Playwright screencast as optional future polish.
- Evaluate whole graphs, individual nodes, partial paths, checkpoints/resume, specialist tool trajectories, cross-source reconciliation, unsafe-tool denial, repeated missions, blast-radius accuracy, and report usefulness.
- Treat Langfuse as optional observability/evaluation infrastructure, not as the agent framework or an MVP dependency.

## Scope discipline and reliability

- Build a narrow, working Hi.Events vertical slice across requirements, UI, frontend, API, backend, and one real PR rather than indexing the whole repository shallowly.
- Keep bounded structured calls such as section extraction, page classification, candidate comparison, PR-intent summarization, and report wording as model operations—not extra agents.
- Do not introduce a generic ReAct agent for every stage, an unrestricted supervisor/master agent, free-form inter-agent chat, Stagehand, Mastra, OpenAI Agents SDK, Agno, or Microsoft Agent Framework into the MVP.
- Represent uncertainty with evidence tiers and review states instead of presenting uncalibrated model confidence percentages as probabilities.
- Model absence as a scoped status such as `not observed`, `blocked`, or `not evaluated`, never as an unsupported claim that a feature does not exist.
- Avoid Redis, Celery, a universal test generator, and a polished graph explorer unless the core assignment is complete and they add demonstrable value.
