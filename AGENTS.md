# Repository Agent Instructions

## Verification Policy

- Keep local verification focused on the files, package, or behavior changed.
- Prefer a specific test file, Vitest project, or workspace package filter.
- Do not run full-workspace builds or suites locally by default, including
  `pnpm build`, `pnpm test`, and `pnpm test:integration`.
- Scope lint and type checks to changed files or packages when the tooling allows it.
- GitHub Actions in `.github/workflows/ci.yml` owns format, lint, typecheck,
  build, and the complete non-live test matrix.
- Run a full CI command locally only when the user explicitly requests it.
- Report which focused checks ran and describe the full CI result as pending until
  GitHub Actions completes.
