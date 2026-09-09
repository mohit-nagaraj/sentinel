# QA Plan Template

Use this full template when writing `QA.md` in Phase 1. Drop sections that don't apply to the feature under test — don't invent items to fill sections that are genuinely empty.

```markdown
# QA Plan: <Feature Name>

**Detected runtime:** <node+pnpm | node+npm | go | python+uv | docs-only | ...>
**Focused local checks:** <specific test files, projects, packages, or direct checks>
**CI-owned checks:** <full commands from the workflow; status is pending locally>
**Feature type:** <Backend | Frontend | Fullstack | Infrastructure | Docs-only>
**Browser verification:** <will run via Playwright | skipped — Playwright unavailable | N/A>

## 1. Standards Compliance
Checks that the change follows project conventions.

- [ ] <convention from CLAUDE.md / AGENTS.md>
- [ ] <logging pattern check>
- [ ] <file naming / directory placement>
- [ ] <test file placement per project convention>

## 2. Feature Completeness
For each success criterion in PLAN.md (or inferred from the diff if PLAN.md is absent AND you've confirmed scope with the user):

- [ ] <criterion> — verify by: <agentic check>

## 3. Agentic Self-Tests (First-Class)
Things the agent verifies directly via CLI / curl / scripts / file inspection. Prefer these over browser testing.

- [ ] Focused test: `<specific-test-command>` passes
- [ ] Package check: `<package-scoped-command>` passes (or skip)
- [ ] API endpoint responds: `curl -s -X POST <url> -d '<payload>'` returns expected shape
- [ ] Schema check: grep / psql for expected table/column
- [ ] Error paths: endpoint returns 400/401/404 with correct body for bad input
- [ ] CLI integration: run feature via command and inspect output

## 4. Automated Tests (Written if missing)
Unit/integration tests that should exist for this feature. Sub-agents write and run these in parallel.

- [ ] Unit: `<module>/<function>` — happy path + edge cases
- [ ] Integration: `<endpoint>` — valid input, invalid input, auth
- [ ] Regression: <specific bug risk>

## 5. Browser Verification (Optional — frontend only)
Populated only if feature is frontend/fullstack AND Playwright is available AND the URL pre-flight passed.

- [ ] Navigate to <URL> → no console errors
- [ ] <interaction> → <expected visible result>
- [ ] Responsive at 375/768/1440 breakpoints

## Cannot Test (Human Required)
Items neither agents nor automation can verify. Listed, not blocking.

- [ ] Design matches mockup exactly
- [ ] Animation timing feels right on low-end devices
- [ ] Copy tone matches brand voice
- [ ] <anything else genuinely needing human judgment>

## Environment
- Dev server: `<command>` (required for API/browser checks)
- Migrations: `<command>` (if schema changed)
- Env vars: <list> (if new)

## CI Pending
- Format, lint, typecheck, build, and all non-live test suites run in GitHub Actions.
```
