# Specialist Agents Progress

## SNT-017 Application Explorer

- [x] Define strict Application Explorer decisions, checkpoint, frontier, claim, blocker, and result contracts.
- [x] Implement the guarded browser tools and adaptive mission runtime.
- [x] Verify deterministic and real-browser mission, denial, recovery, and stability trajectories.
- [ ] Record verified SNT-017 documentation and milestone status.

## Decisions

| Date       | Decision                                                                            | Reason                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-08 | State/action visitation is keyed by state fingerprint plus public action signature. | Opaque action IDs are observation-bound and may change after re-observation, while the signature preserves deterministic loop detection without exposing selectors. |
| 2026-09-08 | The Application Explorer uses structural browser and structured-planner ports.      | SNT-017 remains composable with the existing Playwright and Azure gateway adapters without claiming or duplicating the absent SNT-014 generic kernel.               |
| 2026-09-08 | Backtracked alternatives emit separate contiguous workflow claims.                  | Browser back/reload transitions remain replay evidence but do not become misleading product workflow steps.                                                         |
| 2026-09-08 | Planner context includes bounded progress and recent semantic actions.              | Model decisions need frontier, coverage, runtime-evidence, and recent-action context to adapt without a hardcoded workflow sequence.                                |
| 2026-09-08 | Evidence projection bounds expanded UI and request claims.                          | Selected UI action and representative request claims keep output bounded while each step retains the authoritative transition evidence reference.                   |
