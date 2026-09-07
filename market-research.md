# Sentinel — Marketplace Research & Comparison

> How Claude Code, Codex, and the code-knowledge-graph ecosystem approach code
> understanding and token efficiency — and how those choices compare with
> Sentinel's design in [`PRD.md`](./PRD.md) and [`decisions.md`](./decisions.md).

| Field | Value |
|---|---|
| Purpose | Decision-support research, not new architecture |
| Research date | 2026-09-07 |
| Scope | Context strategies of coding agents + code KG / GraphRAG / blast-radius tools |
| Authority | `PRD.md` remains the product authority; this file only informs decisions |

---

## 0. TL;DR (read this first)

1. **The premise needs one correction.** Claude Code does **not** maintain a
   persistent "knowledge DB of code." It tried exactly that early on (RAG + a
   local vector DB using Voyage embeddings) and **deliberately removed it** in
   favor of *agentic search* (grep/glob/read) plus *just-in-time context*. The
   creator, Boris Cherny, confirmed this publicly: *"Early versions used RAG + a
   local vector db, but we found pretty quickly that agentic search generally
   works better."* Codex (OpenAI) follows the same no-index philosophy.

2. **The token-saving thing you remember is real, but it is not a code graph.**
   The big, widely-shared "token reduction" results from Anthropic are:
   - **Just-in-time context loading / context engineering** — load lightweight
     identifiers (paths, queries) and pull content on demand rather than
     pre-indexing everything.
   - **Code execution with MCP** — let the agent write code that calls tools and
     post-processes results in a sandbox, so bulky intermediate data never hits
     the context window. Anthropic's worked example drops **150,000 → 2,000
     tokens (~98.7%)**. This is about *tool/result bloat*, not code understanding.
   - **Sub-agent isolation, compaction, and structured note-taking** — keep the
     detailed search context inside disposable sub-agents / summaries.
   None of these is a code knowledge base.

3. **But your instinct is still right for *your* problem.** Sentinel is not an
   interactive code-writing assistant; it is a **cross-layer traceability and
   blast-radius engine** (requirements ↔ live UI ↔ code). For *that* job, the
   market **does** build persistent graphs, and the closest analogs
   (ContextQA, CodeRadius, ImpactTrace, code-review-graph, GitNexus) all do.
   Sentinel's design is well-aligned with the state of the art — and its
   **three-layer graph with a live-crawl UI layer and explicit absence modeling
   is more ambitious than any single tool found in this survey.**

4. **Net:** keep the graph (it is justified by the use case, unlike interactive
   coding). Adopt the coding-agents' *token discipline* (bounded tools, small
   typed slices, sub-agent isolation) — which the PRD already largely does.
   Consider two concrete borrows: **SCIP-based reference resolution** for the
   deterministic substrate, and a **PageRank-style ranked repo map** to seed the
   Code Explorer. Treat embeddings as a *calibrated later* option, not an MVP need.

---

## 1. What Sentinel is trying to build (grounded recap)

From `PRD.md` and `decisions.md`, Sentinel is an **application-intelligence
product** that connects three forms of product knowledge into one Neo4j evidence
graph and reasons over it:

- **Intent** — requirements extracted from documentation (Documentation Explorer).
- **Observed behavior** — workflows/screens/elements discovered by a live
  Playwright crawl (Application Explorer).
- **Implementation** — routes, components, endpoints, handlers, services,
  entities from deterministic AST indexers (TS/`ts-morph`, PHP/`nikic/PHP-Parser`)
  navigated by a Code Explorer.

For a real PR it maps changed symbols into the graph, traverses outward, and
emits a **blast-radius report** ("which UI, workflows, requirements are at risk")
for a non-engineer QA lead, optionally verified by replaying flows on a PR-head
deployment.

Key design choices that matter for this comparison:

- **Deterministic substrate + bounded agents.** AST/index/crawl/diff are
  deterministic; agents only decide *what to investigate next* through typed,
  authority-limited tools (§13, §15 of the PRD).
- **Typed messages, not agent chat** (`DiscoveryMission`, `MissionResult`,
  evidence refs).
- **Evidence tiers (A–D) + provenance** on every cross-layer edge; risk and
  evidence strength are kept separate.
- **Absence is first-class** — a `CoverageAssessment` node distinguishes
  "not observed" from "never checked."
- **No vector DB in the MVP** (§10.1) — lexical + deterministic candidates +
  bounded model comparison.
- **Neo4j = knowledge; LangGraph = execution.** They are deliberately separate.

---

## 2. The landscape, in six families

The market splits into families with very different assumptions. Sentinel
borrows from several but sits in family **F**.

### A. Agentic search / just-in-time — *no index* (Claude Code, Codex, Amp, Cline)

- **Mechanism:** a `while(tool_call)` loop. The model uses `Glob` (path match,
  near-zero tokens) → `Grep` (ripgrep regex) → `Read` (full file, ~500–1500
  tokens) to retrieve *just-in-time*. No embeddings, no vector store, no
  pre-computed index. The codebase itself is the index.
- **Why they dropped RAG:** code identifiers are *exact* (`getUserById` is not
  semantically "near" `fetchAccountDetails`), indexes drift during active
  editing, embeddings leak code, and there is zero setup/staleness cost.
- **Token discipline comes from elsewhere:** sub-agents with isolated context
  windows (the Explore sub-agent runs on a cheaper model and returns only a
  ~1–2k-token summary), **compaction** (summarize history near the limit),
  **structured note-taking** (todo/NOTES.md), **tool-result clearing**, and
  prompt caching.
- **Codex** is the same shape: agentic file reading + `AGENTS.md` up-front
  context, no persistent code KG.
- **Relevance to Sentinel:** this is the *token philosophy* to emulate for the
  Code/Doc/Application Explorers — small bounded tools, sub-agent isolation,
  return distilled claims not transcripts. The PRD already does this.

Sources: Anthropic *Effective context engineering for AI agents* (2025-09-29);
*Code execution with MCP*; Claude Code architecture deep-dives (cc.bruniaux.com,
karaxai.com, finisky.github.io); HN comments by Boris Cherny.

### B. Repo maps — *ranked structural skeleton in the prompt* (Aider)

- **Mechanism:** parse every file with **tree-sitter**, build a graph where files
  are nodes and edges are symbol references, run **personalized PageRank**
  (weighted toward files/identifiers in the current chat), then **binary-search**
  the ranked definitions to fit a **token budget (default ~1k tokens)**. The
  result is a compact "here are the most important symbols and signatures" map
  injected before each turn.
- **Why it matters:** it is the cleanest published answer to "give the model
  structural awareness without dumping the repo" — deterministic, cheap,
  budget-bounded, no embeddings.
- **Relevance to Sentinel:** Sentinel's Repository Inspector + module map +
  bounded `list_repository_modules`/`search_symbols` tools are the same idea, but
  navigated on-demand instead of pre-injected. **A PageRank-style importance
  ranking would improve the Code Explorer's entry context** (see §5).

### C. Code knowledge graphs / semantic DBs — *heavyweight, precise* (CodeQL, Glean, Kythe, SCIP/LSIF, Joern)

| System | Origin / purpose | What's in it | Query surface | Reality check |
|---|---|---|---|---|
| **CodeQL** | GitHub; security variant analysis | Per-language *relational* DB of code; deep dataflow inside a query | QL language | Per-run, per-query; not a *persistent* intelligence layer; expert-only |
| **Glean** | Meta; language facts at scale | Types, refs, defs; schema-per-language | Angle | Consumers build their own analyses; self-hosting is a platform project |
| **Kythe** | Google; cross-reference indexing | Structural xrefs; per-language indexers | protobuf serving | Low-level; no out-of-box semantic/AI surface |
| **SCIP / LSIF** | Sourcegraph; code navigation | Symbol graph (defs/refs) | LSP-style nav | Build-time index; not a *behavior* graph |
| **Joern** | Security; Code Property Graph | AST + CFG + PDG combined | CPG queries | Built for vuln detection, not product/business traceability |

- **Takeaway:** these are the "serious" code graphs, but they are **structural**
  (symbol/type/xref) — none models *requirements* or *observed runtime UI*, and
  most are per-language with cross-boundary work left to the consumer. They are
  potential *substrate* for Sentinel's code layer, not competitors to its thesis.
- **Concrete borrow: SCIP.** SCIP indexers exist for TypeScript and many
  languages and give precise def/ref resolution. Blarify (family D) reports SCIP
  is **~330× faster than LSP** for reference resolution with identical accuracy.
  This could harden Sentinel's TS layer and cut Code Explorer hops. (PHP SCIP
  support is weaker, which is exactly why the PRD's dedicated `nikic/PHP-Parser`
  CLI is the right call for the majority-PHP Hi.Events target.)

### D. GraphRAG-over-code — *the direct "code knowledge graph" trend* (CodeGraph, code-graph-rag, blarify, GitNexus, codebase-memory-mcp, potpie)

This is the family the user is intuiting — recent, agent-native, MCP-exposed.

- **CodeGraph** (MIT, ~32k★): tree-sitter → symbols + edges (calls, imports,
  inheritance) in **local SQLite (FTS5)**; returns *deterministic* call
  relationships (not probabilities) via MCP. Claims **~57% token reduction /
  ~35% lower cost** across 7 projects by handing the model a prebuilt map.
- **code-graph-rag** (vitali87): tree-sitter → **Memgraph**, NL→Cypher, multi-
  language monorepo under one schema, AST-surgical edits, MCP server.
- **blarify**: repo → graph (Neo4j/FalkorDB), **SCIP** for fast refs; graph
  traversal for debugging/refactoring.
- **GitNexus / codebase-memory-mcp**: cross-service edges (REST/gRPC/GraphQL/
  pub-sub), **framework route extraction**, cross-repo **contract registry** that
  detects when a change breaks a downstream consumer.
- **potpie**: broader **context graph for the SDLC** — indexes code *plus* PRs,
  issues, decisions, source history, team knowledge; installs skills into Claude
  Code / Codex / Cursor.
- **Several add embeddings** (CodeGraph variants, code-graph-rag) for fuzzy
  "what relates to auth?" queries, bridging vectors ↔ graph entities.
- **Relevance to Sentinel:** this validates the graph bet for *understanding*
  (as opposed to *editing*) use cases. **But every one of these stops at the code
  layer** (plus, in GitNexus, service contracts). None ingests product
  requirements from docs or observed runtime UI from a live crawl. Sentinel's
  requirements + UI layers are the differentiator.

### E. Embeddings indexers — *semantic retrieval* (Cursor, Sourcegraph Cody)

- **Cursor:** **Merkle tree** of file hashes for incremental change detection →
  syntactic chunking → embeddings in a remote vector DB (Turbopuffer); only
  changed files are re-embedded. Great for fuzzy semantic recall; no explicit
  cross-layer relationships.
- **Cody:** layers **SCIP code graph** on top of keyword + embeddings, so it can
  disambiguate the "wrong `UserService`" via import/call chains across repos.
  This *hybrid* (graph + embeddings + keyword) is the most relevant blueprint if
  Sentinel ever adds vectors.
- **Relevance to Sentinel:** confirms §10.1 — embeddings are a *quality/recall*
  optimization, valuable at documentation scale or for fuzzy capability matching,
  not a correctness requirement for a narrow slice. Cody shows the right way to
  add them later: **graph as the source of truth, embeddings as a recall aid.**

### F. Blast-radius / change-impact / requirements-traceability — *Sentinel's actual neighborhood*

These are the closest analogs and the most important to study.

| Tool | Graph contents | Blast radius | Requirements? | Live UI? | PR/CI gate | Notes |
|---|---|---|---|---|---|---|
| **ContextQA** | requirements + tests + app | ✅ pre-merge | ✅ | app-model | ✅ GitHub/GitLab/Jenkins | **Commercial embodiment of this assignment's thesis**; links reqs↔tests↔code, runs targeted regression |
| **CodeRadius** | services/APIs/queues/DBs across repos | ✅ `cr blast`, semantic exit codes | ❌ | ❌ | ✅ policy/tier-0 | Architecture drift vs Backstage/OpenAPI/CODEOWNERS; targeted tests; MCP-native; 200k-LOC in <5 min |
| **ImpactTrace** | static skeleton + LLM implicit contracts | ✅ visual map | ❌ | ❌ | pre-commit | Finds *implicit* shared-schema/state links across services |
| **code-review-graph (CRG)** | SQLite AST graph + embeddings | ✅ `get_impact_radius` | ❌ | ❌ | review-time | `get_review_context` returns risk+impacted+test-gaps in **~111 tokens**; ~25 MCP tools allow-listed to ~8 |
| **Sentinel** | **requirements + observed UI + code**, evidence-tiered | ✅ ranked, evidence-path-backed | ✅ | ✅ Playwright crawl | ✅ GitHub App check | + explicit **absence** modeling + optional **PR-head verification** |

- **ContextQA is the one to name in your design doc.** It is essentially the
  productized version of the assignment (requirements + tests + app knowledge
  graph → change-to-blast-radius → targeted regression before merge). Its
  existence *validates* the thesis and gives you a credible differentiation
  story: Sentinel adds a **live-crawl observed-UI layer**, **evidence tiers with
  provenance**, **explicit absence/coverage modeling**, and **optional behavioral
  verification on a PR-head deployment** rather than relying on a pre-declared
  app model / test tags.
- **CodeRadius and CRG show the token target to beat:** a code-review call that
  returns *risk + impacted nodes + test gaps* in **~111 tokens**. Sentinel's
  report generator and GitHub check summary should aim for similarly compact,
  structured payloads and reserve full evidence paths for on-demand drill-down.

---

## 3. Deep comparison across the dimensions that matter

| Dimension | Claude Code / Codex (A) | Aider repo map (B) | Code KGs / GraphRAG (C/D) | Cursor / Cody (E) | Blast-radius tools (F) | **Sentinel** |
|---|---|---|---|---|---|---|
| Persistent index | **No** (by choice) | Ephemeral, per-turn | Yes (per-lang / SQLite / Neo4j) | Yes (vectors) | Yes | **Yes (Neo4j, one active revision)** |
| Primary retrieval | Agentic grep/glob | PageRank skeleton | Graph traversal (+vectors) | Vector similarity | Graph traversal | **Graph traversal over evidence-tiered edges** |
| Cross-layer scope | Code files | Code files | Code (+services in GitNexus) | Code files | Code (+reqs/tests in ContextQA) | **Requirements + UI + code (3 layers)** |
| Runtime/observed behavior | No | No | No | No | app-model (ContextQA) | **Yes — live Playwright crawl** |
| Determinism vs LLM | LLM-driven | Deterministic map | Deterministic graph + LLM Q&A | Vectors + LLM | Hybrid | **Deterministic substrate, bounded-agent navigation, deterministic authority** |
| Absence modeling | n/a | n/a | n/a | n/a | test-gap lists | **First-class `CoverageAssessment` (not-observed vs never-checked)** |
| Provenance / auditability | Weak (transcript) | n/a | Varies | Weak | Varies | **Strong — every edge carries method/source/tier/review state** |
| Staleness handling | None to be stale | Regen per turn | Re-index | Merkle incremental | Incremental | **Scoped refresh replaces affected facts transactionally** |
| Token strategy | JIT + sub-agents + compaction | ~1k-token budget | Prebuilt map (~57% cut) | Vector top-k | ~111-token review context | **Bounded tools + typed small slices + sub-agent-style specialists** |
| Setup cost | Zero | Low | Medium (indexing) | Medium | Medium | **Higher (crawl+index+reconcile) — justified by product, not per-query** |

**Reading of this table.** Sentinel is *not* competing with Claude Code/Codex —
it is a different product category (understanding/traceability, not editing). On
its own axis (family F) it is at or beyond the frontier: it is the only entry
that unifies **all three layers**, adds **observed runtime behavior**, and models
**absence** explicitly. The cost is a heavier onboarding, which is acceptable
because the graph is amortized across every PR (a core `decisions.md` principle),
unlike a coding agent that pays per session.

---

## 4. Where Sentinel is genuinely differentiated

1. **Tri-layer graph.** No surveyed tool connects *documented intent* +
   *observed UI* + *implementation* in one graph. GraphRAG tools stop at code;
   ContextQA gets closest (reqs+tests+app) but via a declared app model, not a
   live crawl.
2. **Observed-behavior layer from a live crawl.** The Playwright
   observe→decide→act loop producing `Workflow/FlowStep/Screen/UIElement` with
   runtime network evidence is unique here and is exactly what lets Sentinel say
   "this endpoint was invoked during checkout," which static graphs cannot.
3. **Absence as an observation.** `CoverageAssessment` directly answers the
   assignment's hardest question ("how do you model requirements that *should* be
   testable but aren't reflected in the UI?"). None of the market tools do this;
   they list "test gaps" at best.
4. **Evidence tiers + provenance + risk-vs-confidence separation.** Matches
   CodeGraph's "definitive vs probability" ethos but goes further with A–D tiers,
   per-edge extraction method/source/commit, and review states.
5. **Deterministic authority boundary.** Agents propose; validators/policy/graph
   writer decide. This is stronger governance than the "LLM writes Cypher" or
   "LLM graph transformer" pattern common in family D (which risks hallucinated
   edges).

---

## 5. Concrete, prioritized recommendations

**Keep as-is (validated by the market):**

- The persistent Neo4j graph — justified for traceability/blast-radius; the
  coding-agents' "no index" argument does *not* transfer to your use case.
- No vector DB in MVP (§10.1) — aligns with the 2026 "vectorless by default"
  trend; add embeddings only when documentation-scale fuzzy matching demands it,
  and if so, follow **Cody's pattern (graph = truth, vectors = recall)**.
- Deterministic substrate + bounded typed tools — this *is* the token-efficient
  pattern the coding agents preach.

**Adopt (high value, low regret):**

1. **PageRank-style importance ranking for the code map.** Borrow Aider's idea:
   rank symbols/files by reference centrality so the Code Explorer's first hop
   and the blast-radius "graph centrality within scope" signal (§13.14) are
   principled rather than ad hoc. You already store the edges; ranking is cheap.
2. **SCIP-based reference resolution for the TS/React layer.** Faster, more
   accurate defs/refs than hand-rolled `ts-morph` traversal for cross-file
   references (blarify: ~330× vs LSP); keep the PHP CLI as-is. Reduces agent hops
   and token spend on `find_references`/`trace_callers`.
3. **Ultra-compact review payload.** Mirror CRG/CodeRadius: the GitHub check +
   report header should return risk + impacted-count + test-gaps in a tiny,
   structured blob (target low-hundreds of tokens), with full evidence paths
   fetched on demand. Good for both humans and any downstream agent/MCP consumer.

**Consider (later / if scope allows):**

4. **Expose Sentinel's graph over MCP.** Every family-D/F tool ships an MCP
   server so coding agents can consume the graph. A read-only `analyze_blast_radius`
   / `get_review_context` MCP surface would make Sentinel useful *inside* Claude
   Code/Cursor and is a strong "another week" item.
5. **Code-execution-with-MCP style post-processing** only if Explorer tools start
   returning large result sets — let a node filter/aggregate in code so raw
   payloads never enter model context. Likely over-engineering for the MVP slice.

**Watch / de-risk:**

- **ContextQA overlap.** Acknowledge it in the design doc as market validation
  and differentiate on live-crawl UI + PR-head verification + absence modeling.
  Reviewers will likely know a tool in this space exists; naming it shows
  awareness.
- **Don't let agents write graph edges.** Several family-D tools use an "LLM
  graph transformer" that can hallucinate relationships. Sentinel's
  deterministic-writer boundary is a strength — keep it explicit in the doc as a
  contrast.
- **Onboarding cost is the honest weakness.** The coding agents' "zero setup,
  never stale" pitch is real. Sentinel's counter is amortization (onboard once,
  reuse per PR) + scoped refresh — make that argument explicitly.

---

## 6. Answering the original question directly

> "I remember reading that they built something to consume fewer tokens in Claude
> Code — surely a knowledge DB of code."

- **What actually exists in Claude Code:** *no* code knowledge DB. Token savings
  come from **just-in-time context loading**, **agentic search (grep/glob/read)**,
  **sub-agent isolation**, **compaction**, **structured note-taking**, and
  (separately) **code execution with MCP** (~98.7% on the tool-bloat example).
  Early RAG/embeddings were tried and removed.
- **Who *does* build a code knowledge DB:** the GraphRAG-over-code family
  (CodeGraph, code-graph-rag, blarify, GitNexus, potpie) and the blast-radius
  family (CodeRadius, ImpactTrace, ContextQA, CRG). Their token wins come from
  handing the model a *prebuilt structural map / tiny review context* instead of
  raw files (CodeGraph ~57%; CRG ~111-token review context).
- **What this means for Sentinel:** you are building in the *right* family for
  your problem. Adopt the coding-agents' **token discipline** at the tool
  boundary, keep the **graph** for cross-layer reasoning, and lean into the three
  things no one else combines: **observed UI, requirement intent, and explicit
  absence.**

---

## 7. Sources

**Coding agents & context strategy**
- Anthropic — *Effective context engineering for AI agents* (2025-09-29):
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic — *Code execution with MCP: building more efficient AI agents*:
  https://www.anthropic.com/engineering/code-execution-with-mcp
- *How Claude Code Works: Architecture & Internals*: https://cc.bruniaux.com/guide/architecture/
- *How Claude Code Actually Works: A Systems-Level Deep Dive*: https://karaxai.com/posts/how-claude-code-works-systems-deep-dive/
- *Dissecting Claude Code's RAG Mechanism*: https://finisky.github.io/en/claude-code-rag/
- *Agentic Search vs. RAG (why Claude Code doesn't index)*: https://aiskill.market/blog/agentic-search-vs-rag-why-claude-code-doesnt-index

**Repo maps**
- Aider — *Building a better repository map with tree-sitter*: https://aider.chat/2023/10/22/repomap.html
- Aider — *Repository map* docs: https://aider.chat/docs/repomap.html
- *How Aider's repomap uses PageRank*: https://anishgandhi.com/aider-pagerank-codebase-ranking/

**Code knowledge graphs / GraphRAG**
- *Code Knowledge Graphs: Why Open-Source Stacks Stall at Enterprise Scale* (Joern/Kythe/Glean/SCIP/CodeQL): https://corestory.ai/post/code-knowledge-graphs-why-open-source-stacks-stall-at-enterprise-scale
- *Knowledge Graph Tools for AI Code Agents* (Graphify/GitNexus/codebase-memory-mcp/CodeGraph): https://antaoalmada.dev/posts/Code-Agent-Knowledge-Graphs/
- *Code Intelligence Tools for AI Agents Compared*: https://rywalker.com/research/code-intelligence-tools
- CodeGraph (token-reduction claims): https://medium.com/kd-agentic/codegraph-the-open-source-knowledge-graph-that-makes-ai-coding-tools-dramatically-cheaper-190f8b89f8a7
- code-graph-rag: https://github.com/vitali87/code-graph-rag
- blarify (SCIP vs LSP): https://github.com/blarApp/blarify
- potpie: https://github.com/potpie-ai/potpie

**Embeddings indexers**
- Cursor — *Securely indexing large codebases*: https://cursor.com/blog/secure-codebase-indexing
- *Cursor vs Sourcegraph Cody: embeddings & monorepo scale*: https://dexiio.pages.dev/compare/cursor-vs-sourcegraph-cody-embeddings-and-monorepo-scale/

**Blast-radius / impact / traceability (closest analogs)**
- CodeRadius: https://coderadius.ai/ · https://github.com/coderadius-ai/coderadius
- ImpactTrace: https://github.com/ash01825/Impacttrace
- ContextQA — *AI Impact Analysis for Testing*: https://contextqa.com/platform/impact-analysis/
- code-review-graph (CRG) + Graphify: https://dev.to/mir_mursalin_ankur/graphify-code-review-graph-build-a-self-updating-knowledge-graph-for-claude-code-and-other-ai-j1m
