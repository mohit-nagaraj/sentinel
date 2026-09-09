## Key Files

- `src/operations.ts` - application, onboarding, compatibility, run, and mission contracts.
- `src/github-app.ts` - webhook, immutable-head assessment, check lifecycle, and App permission contracts.
- `src/primitives.ts` - shared URL, secret-reference, identity, and redaction primitives.
- `src/contracts.test.ts` - cross-boundary contract and invariant tests.
- `src/index.ts` - public package exports.

## Conventions

- Validate every external or persisted boundary with strict Zod schemas.
- Separate transient secret-bearing input from reference-only persisted types.
- Build stable identities and fingerprints from canonical structured input.
- Return structured issues with field paths; invalid input must not throw incidental parser errors.
- Export public schemas and inferred types through `src/index.ts`.
- Colocate deterministic unit tests with contract sources.
