# QA-lead report usefulness rubric

Score each dimension from 1 to 5 using the anchored descriptions below. Review
the structured evidence and report independently; do not infer correctness from
polish. Record an explanation and cited report/evidence IDs for every score.

| Dimension | 1 | 3 | 5 |
|---|---|---|---|
| Factual grounding | Material claims lack inspectable evidence or conflict with it | Main conclusions are grounded but some supporting detail is indirect | Every material conclusion maps cleanly to validated evidence and immutable source identity |
| QA-lead clarity | Risk is expressed mainly in code terms or cannot be located | A product-aware reviewer can identify affected areas with occasional drill-down | A reviewer immediately understands affected product behavior, scope, and why it matters |
| Recommendation actionability | Recommendations are generic or untestable | Recommendations name a flow and expected behavior | Recommendations are prioritized, bounded, and identify setup, checkpoints, expected behavior, and exclusions |
| Uncertainty disclosure | Unknowns are omitted or presented as no impact | Main unknowns are listed but their consequence is uneven | Unknown, unobserved, ambiguous, stale, and non-impacted states are distinct and decision-relevant |
| Unsupported-claim control | The report adds unsupported facts or claims safety | No critical unsupported claim appears, with minor wording risk | Prose is a strict rendering of supplied fact IDs and explicitly avoids global-safety claims |

## Hard-failure gate

The worksheet is invalid and the report fails regardless of average score when
any critical unsupported claim, fabricated citation, unsafe tool action, secret,
or false claim of runtime verification is found. Record the hard failure and the
related claim, evidence, or tool-step ID.

## Scoring worksheet

| Field | Value |
|---|---|
| Dataset/version | |
| Run ID and repetition | |
| Reviewer and date | |
| Model/provider/template | |
| Factual grounding (1-5) | |
| QA-lead clarity (1-5) | |
| Recommendation actionability (1-5) | |
| Uncertainty disclosure (1-5) | |
| Unsupported-claim control (1-5) | |
| Total (5-25) | |
| Hard failure present? | |
| Evidence/report IDs reviewed | |
| Notes and required changes | |

Interpretation: `22-25` is submission-ready after the hard-failure gate,
`18-21` requires targeted edits and re-review, and below `18` requires report
revision. These bands are a human workflow aid, not calibrated probabilities.

