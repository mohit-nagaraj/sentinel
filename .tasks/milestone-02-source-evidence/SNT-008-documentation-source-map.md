# SNT-008 — Documentation discovery, parsing, and provenance map

| Field | Value |
|---|---|
| Milestone | M2 — Deterministic source evidence |
| Status | `not-started` |
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

- [ ] Implement web/repository source adapters into one fact contract.
- [ ] Respect robots/sitemap and restrict host/path/protocol/redirects.
- [ ] Strip navigation/repeated chrome, scripts, styles, forms, and unsafe markup.
- [ ] Preserve exact source excerpts and offsets/heading paths.
- [ ] Produce deterministic section IDs/content hashes/link edges.
- [ ] Detect unchanged, changed, removed, duplicate, and failed pages.
- [ ] Implement bounded tree/list/search/read-section repository APIs.
- [ ] Store sanitized durable section facts/metadata; upload only evidence artifacts that earn retention.
- [ ] Emit explicit partial-crawl warnings and coverage statistics.

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

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
