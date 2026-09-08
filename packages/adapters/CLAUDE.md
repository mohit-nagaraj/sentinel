## Key Files

- `src/onboarding/compatibility.ts` - bounded compatibility and readiness inspector.
- `src/source/github/connector.ts` - immutable metadata and checkout orchestration.
- `src/source/documentation/url-policy.ts` - DNS-pinned URL and network policy.
- `src/browser/policy.ts` - exact-origin and action-category browser policy.
- `src/index.ts` - aggregate adapter exports.

## Conventions

- Keep source access read-only, bounded, and tied to immutable provider identity.
- Reject unsupported repository identity before checkout and pin browser DNS before navigation.
- Apply the approved-origin policy to both HTTP and WebSocket browser traffic.
- Inject repository, URL, browser, and clock ports for deterministic tests.
- Treat errors as reason-coded compatibility output; never forward provider detail or secrets.
- Close checkouts, dispatchers, contexts, and browsers on every terminal path.
- Use focused package subpaths when a consumer does not need the aggregate adapter graph.
- Colocate unit tests and keep live/provider tests opt-in.
