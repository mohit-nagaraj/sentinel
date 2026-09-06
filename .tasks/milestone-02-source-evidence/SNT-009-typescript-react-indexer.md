# SNT-009 — TypeScript and React structural indexer

| Field | Value |
|---|---|
| Milestone | M2 — Deterministic source evidence |
| Status | `not-started` |
| Depends on | SNT-002, SNT-007 |
| Blocks | Endpoint normalization, Code Explorer, PR mapping |
| PRD references | §13.7, FR-006 |

## Background

Hi.Events' frontend uses TypeScript/React. The indexer must turn source into stable structural facts that a Code Explorer can navigate without receiving arbitrary filesystem access or full repository context.

## Scope

Use `ts-morph`/TypeScript Compiler API to extract:

- projects/source roots and module/file identities;
- exported/local symbols, components, functions, methods, and source ranges;
- imports/exports and resolved definitions/references where tractable;
- React Router routes and rendered component ancestry;
- JSX elements, static accessible names/labels/text/data-testid hints;
- event-handler bindings and handler definitions;
- React Query hooks and calls into API client modules;
- Axios/fetch client method/path templates;
- callers/callees for the selected source roots;
- unresolved dynamic expressions as explicit facts/warnings.

## Implementation tasks

- [ ] Load project from detected `tsconfig` without executing build plugins.
- [ ] Exclude generated, locale, vendor, build, and test files by declared policy while allowing focused test indexing.
- [ ] Create stable file/symbol IDs with commit and qualified structural identity.
- [ ] Extract source positions and bounded display slices.
- [ ] Resolve import/export aliases and local call targets where supported.
- [ ] Implement React route/component/JSX/handler patterns used by pinned Hi.Events fixtures.
- [ ] Normalize API-client calls without prematurely matching backend endpoints.
- [ ] Emit extraction method/version and unresolved reason codes.
- [ ] Build query APIs consumed by Code Explorer.

## Acceptance criteria

- Pinned fixtures map route → component → JSX/handler → API client call with source provenance.
- Comments, string fixtures, and dead text are not misclassified as executable calls.
- Identical commit/indexer version yields stable fact IDs/order.
- Unsupported computed routes/labels/calls remain unresolved rather than guessed.
- Indexing has file/node/time limits and does not execute repository code.
- Query APIs return bounded facts/slices and cannot read excluded/out-of-root files.

## Required tests

- Unit fixtures for imports, aliases, JSX labels, handlers, hooks, templates, and dynamic negatives.
- Golden structural fact snapshots.
- Stable-ID/order tests.
- Source-range edge cases and deleted/renamed file fixtures.
- Performance budget test over a representative fixture tree.
- Opt-in scoped Hi.Events index smoke test.

## Out of scope

Whole-program soundness, runtime JavaScript evaluation, requirement matching, backend endpoint linking, and Code Explorer reasoning.

## Implementation notes

_Populate during implementation with final paths, commands, decisions, test evidence, and any explicitly deferred acceptance item._
