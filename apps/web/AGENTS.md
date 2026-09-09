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
- `lib/run-control.ts` - owner-scoped run command/read service and readiness projection.
- `app/api/control/[[...path]]/route.ts` - authenticated run control HTTP boundary.
- `app/runs/[runId]/page.tsx` - owner-scoped activity snapshot entry point.
- `components/run-activity-workspace.tsx` - live specialist lanes, controls, budgets, and screenshot storyboard.
- `lib/activity-feed.ts` and `lib/realtime-client.ts` - canonical cursor convergence and private Broadcast wake transport.
- `lib/github-assessments.ts` - shared signed-webhook/manual PR assessment and check synchronization service.
- `app/api/github/[[...path]]/route.ts` - raw webhook and operator-authenticated manual PR HTTP boundary.

## Conventions

- Read the installed Next.js guide before changing framework behavior.
- Treat every Server Action as a public endpoint and authorize it independently.
- Treat every Route Handler operation as a public endpoint, authorize it independently, and return private/no-store public DTOs.
- Keep fixture authorization bypass unavailable when `NODE_ENV=production`.
- Import focused `@sentinel/adapters/onboarding` or `@sentinel/adapters/github-app` server subpaths, not the adapters root.
- Verify webhook signatures over exact bounded bytes before parsing or invoking storage.
- Return `OnboardingActionState`; never reflect credential or storage-state values.
- Keep operational UI compact, responsive, keyboard accessible, and on existing theme tokens.
- Colocate web tests and keep full browser flows under `tests/browser`.
- Keep PostgreSQL events canonical; Realtime payloads only wake owner-scoped catch-up and lifecycle refresh.
