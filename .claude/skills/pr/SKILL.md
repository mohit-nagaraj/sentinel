---
name: pr
description: >
  Create a pull request after verification. Runs final checks and delegates to the
  project's pr-draft skill if available.
  Use this skill when the user says 'pr', '/pr', 'ship', 'ship it', 'create pr',
  'open pr', 'ready to merge', 'let's ship', or after /review completes.
compatibility: Designed for Claude Code
metadata:
  user-invocable: "true"
---

# /pr — Ship It

You are the final step of the ystack workflow. You verify everything is ready, then create a pull request.

## Phase 0: Pre-flight Checks

Check existing focused verification before creating the PR. Do not duplicate the
full CI pipeline locally.

### 1. Verification status

Check if `/review` has been run:
```bash
ls .context/*/PLAN.md 2>/dev/null
```

If a PLAN.md exists, check whether all success criteria have been verified. If not:
> Success criteria haven't been verified. Run `/review` first?

### 2. Focused local verification

Read the focused checks recorded in `SUMMARY.md` or `QA-REPORT.md`. If there is
no evidence yet, run only the narrowest test or package check covering the changed
behavior. Do not run `pnpm build`, the full `pnpm test` or
`pnpm test:integration` suites, or other full-workspace checks locally.

### 3. Clean working tree

```bash
git status
```

All changes should be committed. If there are unstaged changes, ask the user what to do.

## Phase 1: Create PR

### If project has `pr-draft` skill

Delegate to the project's `pr-draft` skill. It knows the project's PR conventions, monorepo grouping, and section format.

> Delegating to `pr-draft` for PR creation...

### If no `pr-draft` skill

Create the PR directly:

1. **Ensure branch is pushed:**
   ```bash
   git push -u origin HEAD
   ```

2. **Generate PR title** — Conventional Commits format:
   ```
   feat(payments): add refund reason tracking
   ```

3. **Generate PR body** from the plan and changes:

   ```markdown
   ## Summary

   - [What was built and why, 1-3 bullets from DECISIONS.md]

   ## Changes

   - [Grouped by package/module from the diff]

   ## Verification

   - [Success criteria from PLAN.md, marked as checked]

   ## Test Plan

   - [x] [Focused local checks that passed]
   - [ ] GitHub Actions full verification
   - [ ] [Feature-specific manual test steps, if any]
   ```

4. **Ask about PR status:**
   > Create as **draft** or **ready for review**?

5. **Create the PR:**
   ```bash
   gh pr create --title "<title>" --body "<body>" [--draft]
   ```

## Phase 2: Wait For CI

After the PR exists, use GitHub Actions as the complete verification gate:

```bash
gh pr checks --watch --fail-fast
```

Do not report the PR as ready while required CI is pending or failing. If CI
fails, report the failing check and its log evidence. Reproduce and verify only
the affected scope locally; do not rerun the complete CI command unless the user
explicitly requests it.

## Phase 3: Clean Up

After CI is green:

1. **Verify progress** — confirm all features in scope are checked in `.ystack/progress/<module>.md`.

2. **Archive `.context/`** — don't delete, just note it's done:
   ```
   Feature context at .context/<feature-id>/ can be cleaned up.
   ```

3. **Report:**
   ```
   PR created: <URL>

   ## Summary
   - Feature: <name>
   - Commits: N
   - Files changed: N
   - All criteria verified: yes
   - Full CI: PASS
   ```

---

## What This Skill Does NOT Do

- **Does not write code.** That's `/go`.
- **Does not review code.** That's `/review`.
- **Does not rerun the full CI pipeline locally.** GitHub Actions is the full verification gate.
- **Does not force-push.** Ever.
- **Does not merge.** Only creates the PR. Merging is a human decision.
