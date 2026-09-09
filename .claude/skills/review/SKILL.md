---
name: review
description: >
  Simple, bug-focused review for MVP and local demo changes. Use this skill when
  the user says 'review', '/review', 'check my work', 'verify', 'did it work',
  'is it done', 'review the changes', or asks whether current work is ready.
  Also supports reviewing an external PR by URL or reference.
metadata:
  user-invocable: "true"
---

# /review - Simple MVP Bug Review

Find bugs that could break the feature, local demo, or main user flow. This is a
lightweight review for an MVP, not a production-readiness, compliance, or
hardening audit.

Use exactly **one general-purpose review agent**. Do not launch separate security,
history, architecture, style, eligibility, or test agents.

Read the actual changed code. Do not trust implementation summaries alone.

## 1. Choose The Review Target

### Current work

Review the current working tree first, including staged, unstaged, and relevant
untracked files. If the working tree is clean, review the current branch against
its merge base with the repository's default branch.

Use `git status --short`, `git diff`, and `git diff --cached` to establish the
working-tree target. Use a merge-base diff only when there are no local changes.

If one clearly related `.context/<feature-id>/PLAN.md` or `QA-REPORT.md` exists,
read it briefly for intended behavior and already-known failures. These files are
context, not gates: do not stop the review because QA is missing, incomplete, or
failed, and do not produce a criterion-by-criterion compliance table unless the
user asks for one.

### External PR

For a PR URL or reference such as `owner/repo#123`, use `gh pr view <ref>` and
`gh pr diff <ref>` to collect the title, state, and diff. Review it even if it is
a draft or already has reviews unless the user says otherwise.

Return the review in chat. Do not post a GitHub comment unless the user explicitly
asks you to post it.

## 2. Run One Generalist Review

Launch one review agent with the diff, the files needed to understand the changed
code, and any concise feature context found above. Ask it to find only functional
bugs introduced by the changes, including:

- crashes, exceptions, hangs, or broken builds caused by changed logic
- incorrect conditions, state transitions, calculations, or data flow
- broken primary UI interactions or API behavior
- persistence, schema, or request/response mismatches on the main path
- missing boundary handling when a normal, realistic input triggers failure
- regressions in behavior directly affected by the changed lines

The reviewer must give each candidate a file and line, a realistic reproduction
path, and the user-visible or data-visible consequence.

Do not ask the agent to perform broad repository archaeology. It may inspect
nearby callers, tests, types, and configuration only when needed to prove or
disprove a candidate bug.

## 3. Keep The Scope Practical

Do not report:

- speculative attacks involving hostile or untrusted documents unless that is an
  explicit feature requirement or a normal demo input
- enterprise security, compliance, scaling, or production-hardening concerns
- theoretical edge cases without a realistic path in the current feature
- architecture preferences, refactoring ideas, style, naming, or maintainability
- generic test-coverage requests
- linter, formatter, or type-checker output as review findings
- pre-existing problems or code outside the change

Obvious secrets exposure, authentication bypass, destructive data loss, or code
execution remains reportable when the changed code creates a concrete reachable
path. Keep this exception narrow.

## 4. Validate And Report

After the single agent returns, validate each candidate against the code. Run only
small, targeted commands or tests needed to confirm a finding. Do not run a full
QA suite or launch more agents unless the user separately asks for deeper review.

Discard any finding that lacks a credible reproduction path or is merely a
possible improvement.

Report confirmed findings first, ordered by impact:

```markdown
## Review Results

1. **[HIGH] Short bug description** - `path/to/file.ts:42`

   Trigger: <realistic action or input>
   Impact: <what visibly breaks or what data is wrong>
   Fix: <concise direction>

## Verdict

**NEEDS FIX** - <short reason>
```

Use `HIGH` for a broken core flow, crash, data loss, or demo blocker. Use `MEDIUM`
for a real secondary-path bug worth fixing before the demo. Omit low-priority
notes and nitpicks.

If there are no confirmed bugs, say:

```markdown
## Review Results

No bugs found in the changed code.

## Verdict

**PASS** - Ready for the current MVP/demo scope.
```

Mention tests you could not run only when that leaves meaningful uncertainty.

## Boundaries

- Review only; do not modify code unless the user asks for fixes.
- Do not create commits, open PRs, or post comments as part of review.
- Do not expand a simple MVP review into a production readiness assessment.
