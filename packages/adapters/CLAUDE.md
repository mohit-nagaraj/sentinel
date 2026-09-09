## Key Files

- `src/onboarding/compatibility.ts` - bounded compatibility and readiness inspector.
- `src/source/github/connector.ts` - immutable metadata and checkout orchestration.
- `src/source/github/github-app.ts` - raw webhook authentication, App tokens, PR metadata, and Checks API.
- `src/source/documentation/url-policy.ts` - DNS-pinned URL and network policy.
- `src/browser/policy.ts` - exact-origin and action-category browser policy.
- `src/code-explorer/tools.ts` - bounded Code specialist source and claim tools.
- `src/model-gateway/azure.ts` - strict Azure Responses model transport.
- `src/index.ts` - aggregate adapter exports.

## Conventions

- Keep source access read-only, bounded, and tied to immutable provider identity.
- Restrict GitHub App installation tokens by repository and to Contents read, Pull requests read, and Checks write.
- Reject unsupported repository identity before checkout and pin browser DNS before navigation.
- Apply the approved-origin policy to both HTTP and WebSocket browser traffic.
- Inject repository, URL, browser, and clock ports for deterministic tests.
- Treat errors as reason-coded compatibility output; never forward provider detail or secrets.
- Close checkouts, dispatchers, contexts, and browsers on every terminal path.
- Propagate runtime `AbortSignal` values through provider and source-tool calls.
- Use focused package subpaths when a consumer does not need the aggregate adapter graph.
- Colocate unit tests and keep live/provider tests opt-in.
