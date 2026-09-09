# Hi.Events evaluation fixture

`hi-events-pr-1338.golden.json` is a sanitized, human-reviewed golden set for
[Hi.Events PR #1338](https://github.com/HiEventsDev/Hi.Events/pull/1338), using
the immutable base and head commits recorded by GitHub. Labels cover the admin
attribution vertical slice: requirements, browser controls and requests,
frontend and Laravel symbols, positive and negative graph links, unknowns,
blast radius, and safe specialist trajectories.

The fixture contains no copied source files, screenshots, credentials, DOM
dumps, or raw model output. Short structural labels were derived from the public
PR metadata and diff and then manually normalized for Sentinel's contracts.

The development split is for evaluator and prompt iteration. The held-out split
is withheld by the runner from target execution, but its labels are committed so
the test suite is reproducible. This is a logical holdout, not a secrecy claim;
the report must retain that contamination limitation.

The deterministic suite is safe by default. Live or paid evaluation must supply
an estimated usage record and the exact confirmation token exported as
`PAID_EVALUATION_CONFIRMATION`; neither credentials nor live execution are
enabled by this dataset.
