# Specialist Agents Progress

## SNT-017 Application Explorer

- [x] Define strict Application Explorer decisions, checkpoint, frontier, claim, blocker, and result contracts.
- [ ] Implement the guarded browser tools and adaptive mission runtime.
- [ ] Verify deterministic and real-browser mission, denial, recovery, and stability trajectories.
- [ ] Record verified SNT-017 documentation and milestone status.

## Decisions

| Date | Decision | Reason |
|---|---|---|
| 2026-09-08 | State/action visitation is keyed by state fingerprint plus public action signature. | Opaque action IDs are observation-bound and may change after re-observation, while the signature preserves deterministic loop detection without exposing selectors. |
