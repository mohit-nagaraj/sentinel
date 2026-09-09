# Sentinel evaluation protocol

Sentinel evaluates deterministic stage output, externally observable specialist
behavior, and end-to-end evidence separately. This follows current agent-eval
guidance to score final outcomes, individual steps, and trajectories rather than
judging prose alone. Flexible trajectory phases recognize multiple valid tool
orders while still penalizing unnecessary, out-of-scope, or unsafe actions.

Primary references used for the design:

- [LangChain trajectory evaluations](https://docs.langchain.com/langsmith/trajectory-evals)
  describes strict, unordered, subset, and superset matching for agent tools.
- [LangChain evaluation approaches](https://docs.langchain.com/langsmith/evaluation-approaches)
  separates final-response, single-step, and trajectory evaluation.
- [LangChain repetitions](https://docs.langchain.com/langsmith/repetition)
  recommends repeated experiments and distribution reporting for variable agents.
- [OpenAI's contextual eval playbook](https://openai.com/index/evals-drive-next-chapter-of-ai/)
  recommends expert-authored golden examples, real cases, costly edge cases, and
  ongoing human audits.

## Dataset and isolation

The committed fixture uses public Hi.Events PR #1338 at its exact base and head
commits. It contains normalized labels, not copied source, DOM, screenshots, or
credentials. Development cases cover documentation extraction, reconciliation,
and browser checkpoint behavior. The held-out case covers the complete static PR
blast-radius path. The schema rejects duplicate case IDs and input fingerprints
across splits. During execution the target receives only input and scope; labels
remain inside the scorer.

Because the labels are committed, the held-out split prevents accidental runtime
leakage but cannot guarantee model-training secrecy. Every report preserves this
limitation.

## Scale to 100 runs

The default baseline executes all four deterministic cases 100 times and checks
normalized evidence stability. A submission does not need 100 expensive browser
and model runs. A representative model-backed sample should use the same runner
with explicit estimated cost confirmation, then report all repetitions. Scale is
obtained by layering:

1. Run deterministic nodes and fixtures 100 times on every change.
2. Run a smaller repeated specialist sample with scripted tools and real model
   decisions when credentials and budget are explicitly approved.
3. Run the full live/browser path sparingly against a trusted immutable target.
4. Route disagreements, hard failures, and rubric uncertainty to human review.

This avoids spending model budget on deterministic parsing and graph logic while
still measuring model-dependent tool selection and terminal behavior.

## Baseline interpretation

`snt-033-baseline.md` and `snt-033-baseline.json` are deterministic harness
conformance evidence. A perfect baseline proves that stable golden observations
remain stable and the report pipeline works; it is not a claim that a live model
or deployment achieves perfect quality. Mutation tests prove the metrics reject
known regressions. Live results must be generated and reported separately.

