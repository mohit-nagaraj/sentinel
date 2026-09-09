# Final submission checklist

Do not send the submission until every required row is checked. URLs point to
the intended `main` locations after this issue merges.

## Deliverables

| Deliverable     | URL                                                                                                  | Status                     |
| --------------- | ---------------------------------------------------------------------------------------------------- | -------------------------- |
| Repository      | https://github.com/mohit-nagaraj/sentinel                                                            | Ready after final PR merge |
| Design document | https://github.com/mohit-nagaraj/sentinel/blob/main/DESIGN.md                                        | Ready after final PR merge |
| Sample report   | https://github.com/mohit-nagaraj/sentinel/blob/main/docs/delivery/sample-report-hi-events-pr-1338.md | Ready after final PR merge |
| Loom            | Add the final share URL after recording                                                              | Human action required      |

## Automated evidence

- [ ] Final pull request CI is green for quality, build, unit, integration,
      agent, graph, browser, security, delivery, and GitGuardian checks.
- [ ] `pnpm delivery:check` regenerates no sample-report diff and all delivery
      contract/link/Markdown tests pass.
- [ ] `pnpm security` passes secret, ignored-file, dependency, license,
      malicious-input, and deterministic evaluation gates.
- [ ] Clean-copy `pnpm install --frozen-lockfile` and focused demo smoke pass.
- [ ] Git diff and tracked files contain no `.env`, key, credential, private
      artifact URL, or provider response.

## Assignment review

- [x] Part A crawl is represented by the policy-gated Playwright runtime and
      deterministic Application Explorer fixture.
- [x] Part A ingest is represented by sanitized web/repository documentation
      maps with citations.
- [x] Part A graph connects requirements, workflows/UI, endpoints, and code,
      with explicit coverage-assessment absence semantics.
- [x] Part A reason is represented by immutable PR investigation and
      deterministic blast-radius contracts, grounded report delivery, and a
      product-rendered deterministic sample.
- [x] Part B covers agent decomposition, graph/schema absence, ambiguity,
      evaluation across 100 runs, scope cuts, and three next-week priorities.
- [x] The selected PR is real and its base/head commits match GitHub PR #1338.
- [x] Actual deterministic evaluation results and skipped live verification are
      reported without extrapolating to model quality.
- [x] Licence and attribution notes are committed.

## Human recording and submission

- [ ] Rehearse `loom-script.md` against a reset `pnpm demo:web` process and keep
      the final take between 5 and 10 minutes.
- [ ] Confirm the recording contains no credential, `.env`, terminal history,
      private artifact, notification, or unrelated account data.
- [ ] Upload the Loom, set reviewer access, watch it once from a signed-out
      browser, and replace the pending Loom row with its share URL.
- [ ] Confirm every URL resolves from a signed-out browser after the final merge.
- [ ] Send repository, design, sample, and Loom URLs using the assignment's
      required email subject; keep SNT-031 verification execution explicit as the
      remaining cut.
