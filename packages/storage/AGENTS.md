## Key Files

- `src/onboarding-repository.ts` - owner-scoped onboarding persistence and public projection.
- `src/secret-service.ts` - Supabase Vault reference lifecycle.
- `src/database.ts` - server-only Postgres client and transaction port.
- `src/source-repository.ts` - normalized source status persistence.
- `src/run-repository.ts` - lease-safe runs and idempotent ordered events.
- `src/index.ts` - public storage exports.

## Conventions

- Parse database rows and writes through contract schemas.
- Scope onboarding reads and mutations by server-derived operator ID next to the query.
- Store only opaque target-secret references in ordinary tables and DTOs.
- Protect delayed inspection and confirmation with compare-and-set fingerprints.
- Preserve current graph identity on failed or stale configuration changes.
- Use scripted database unit tests and opt-in disposable Supabase integration tests.
- Require bounded event idempotency keys and reject conflicting retries.
