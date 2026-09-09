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

Run all checks before creating the PR. If any fail, stop and report.

### 1. Verification status

Check if `/review` has been run:
```bash
ls .context/*/PLAN.md 2>/dev/null
```

If a PLAN.md exists, check whether all success criteria have been verified. If not:
> Success criteria haven't been verified. Run `/review` first?

### 2. Lint and typecheck

```bash
pnpm fix 2>/dev/null    # or the project's lint fix command
pnpm typecheck 2>/dev/null
pnpm check 2>/dev/null
```

If any fail, report the errors and offer to fix.

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

   - [ ] `pnpm typecheck` passes
   - [ ] `pnpm check` passes
   - [ ] [Feature-specific manual test steps]
   ```

4. **Ask about PR status:**
   > Create as **draft** or **ready for review**?

5. **Create the PR:**
   ```bash
   gh pr create --title "<title>" --body "<body>" [--draft]
   ```

## Phase 2: Clean Up

After the PR is created:

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
   ```

---

## What This Skill Does NOT Do

- **Does not write code.** That's `/go`.
- **Does not review code.** That's `/review`.
- **Does not force-push.** Ever.
- **Does not merge.** Only creates the PR. Merging is a human decision.
