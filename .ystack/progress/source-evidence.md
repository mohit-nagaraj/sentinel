# Source Evidence Progress

## SNT-011 OpenAPI Endpoint Normalization

- [x] Define the canonical endpoint model and identity.
- [ ] Build the constrained OpenAPI importer.
- [ ] Add cross-source matching, conflict reporting, and redaction.
- [ ] Expose and verify the completed endpoint evidence boundary.

## Decisions

| Date | Decision | Reason |
|---|---|---|
| 2026-09-07 | Endpoint identity is the shared stable key over application, uppercase HTTP method, and normalized path shape. | This uses the existing contract identity boundary and makes parameter names irrelevant while preserving method differences. |
| 2026-09-07 | Prefix removal is explicit configuration. | Version and deployment prefixes cannot be guessed without creating false matches. |
