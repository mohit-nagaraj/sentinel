<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Key Files

- `app/page.tsx` - server-rendered control-plane entry point.
- `app/actions.ts` - authorized onboarding Server Actions.
- `proxy.ts` - request-level operator token challenge.
- `components/onboarding-control-plane.tsx` - application rail and onboarding workflow.
- `lib/control-plane.ts` - server-only data access, secret reconciliation, and public DTO boundary.
- `lib/operator-auth.ts` - constant-time Basic/Bearer token verification.

## Conventions

- Read the installed Next.js guide before changing framework behavior.
- Treat every Server Action as a public endpoint and authorize it independently.
- Keep fixture authorization bypass unavailable when `NODE_ENV=production`.
- Import the focused `@sentinel/adapters/onboarding` server subpath, not the adapters root.
- Return `OnboardingActionState`; never reflect credential or storage-state values.
- Keep operational UI compact, responsive, keyboard accessible, and on existing theme tokens.
- Colocate web tests and keep full browser flows under `tests/browser`.
