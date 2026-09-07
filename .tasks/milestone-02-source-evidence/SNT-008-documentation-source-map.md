# SNT-008 — Documentation discovery, parsing, and provenance map

| Field | Value |
|---|---|
| Milestone | M2 — Deterministic source evidence |
| Status | `done` |
| Depends on | SNT-002, SNT-003, SNT-007 |
| Blocks | Documentation Explorer |
| PRD references | §12 document nodes, §13.5, FR-004 |

## Background

The Documentation Explorer needs a bounded, searchable evidence space. This issue discovers and parses approved web/repository documentation deterministically; it does not decide which sections satisfy a semantic mission.

## Scope

- Approved root/path and same-hostname policies.
- `robots.txt` and sitemap discovery/loading.
- Crawlee request frontier, deduplication, retries, page/byte/time limits.
- Static HTML fetching; Playwright fallback only for configured client-rendered docs.
- Canonical URL/link normalization and safe redirect handling.
- Repository Markdown from pinned commits.
- `remark-parse`/mdast heading/list/link structure.
- jsdom + Readability where suitable + DOMPurify + deterministic main/article fallback.
- `DocumentSource`, `DocumentPage`, `DocumentSection`, and `LINKS_TO` fact generation.
- Search index over titles, heading paths, and sanitized text (lexical/BM25-style is sufficient).

## Implementation tasks

- [x] Implement web/repository source adapters into one fact contract.
- [x] Respect robots/sitemap and restrict host/path/protocol/redirects.
- [x] Strip navigation/repeated chrome, scripts, styles, forms, and unsafe markup.
- [x] Preserve exact source excerpts and offsets/heading paths.
- [x] Produce deterministic section IDs/content hashes/link edges.
- [x] Detect unchanged, changed, removed, duplicate, and failed pages.
- [x] Implement bounded tree/list/search/read-section repository APIs.
- [x] Store sanitized durable section facts/metadata; upload only evidence artifacts that earn retention.
- [x] Emit explicit partial-crawl warnings and coverage statistics.

## Acceptance criteria

- Same inputs produce stable page/section identities and hashes.
- Off-host/out-of-path/javascript/mailto/file links never enter the frontier.
- Repository Markdown is tied to the configured commit.
- Sanitized output contains no executable script/event-handler content.
- Every section can be traced to source URI/path, heading hierarchy, and exact excerpt.
- Duplicate/canonical pages do not create duplicate requirements inputs.
- One failed page does not invalidate successful pages unless minimum-source criteria fail.
- Search/read tools never return content outside the approved map.

## Required tests

- Local HTTP fixture covering sitemap, robots, redirect, canonical, duplicate, client-rendered fallback, and malicious HTML.
- Markdown AST fixtures for nested headings/lists/links/code blocks.
- Stable hashing/section-boundary tests.
- SSRF/off-host/path-budget security tests.
- Incremental changed/removed/unchanged page tests.
- Search ranking and result-bound tests.

## Out of scope

Requirement extraction, arbitrary web search, embeddings/vector database, documentation agent loop, and product-specific page allowlists.

## Implementation notes

- Web and pinned-checkout adapters live in `packages/adapters/src/source/documentation`; both produce the existing contract-validated `DocumentSource`, `DocumentPage`, and `DocumentSection` fact shapes plus deterministic `LINKS_TO` edges.
- The web frontier uses Crawlee 3.18.1 core/basic in disposable memory. Every root, robots/sitemap entry, link, redirect, canonical hint, and rendered-browser request is constrained by protocol/origin/path policy. Undici's connection lookup rejects every private/reserved result, with a second explicit check for literal IP hosts. HTTP/private-network access is available only through named test options.
- Static HTML uses jsdom 26.1.0, Readability 0.6.0 where no explicit main/article is suitable, and DOMPurify 3.4.15. Repository Markdown uses remark-parse 11/mdast and is addressed by connector-proven commit URI. Raw responses, DOMs, and ASTs remain disposable.
- Section offsets address the sanitized canonical page text; each durable excerpt is exactly `sanitizedText.slice(startOffset, endOffset)`. Duplicate canonical/content pages and repeated identical sections collapse deterministically.
- `DocumentationMapIndex` exposes bounded tree/list/search/read/link APIs over prepared IDs only. Incremental input classifies added/changed/unchanged pages and reports removals, failures, duplicates, byte/page/time caps, and minimum-source coverage.
- `20260907000200_documentation_maps.sql` adds private RLS-enabled map/page/section/link tables. `DocumentMapRepository.replace` swaps sanitized facts transactionally; no raw page artifact is retained by default.
- Verification on 2026-09-07: formatting, zero-warning lint, TypeScript build, 40 files and 249 default tests passed; 7 focused files and 11 tests passed; 1 disposable Postgres persistence/RLS integration test passed.
