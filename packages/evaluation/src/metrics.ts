import { createHash } from "node:crypto"

import {
  evaluationCaseResultSchema,
  type EvaluationCase,
  type EvaluationCaseResult,
  type EvaluationMetric,
  type EvaluationMetricName,
  type EvaluationSplitKind,
  type ObservedEvaluationOutput,
} from "./schema.ts"
import { evaluateTrajectory } from "./trajectory.ts"

export interface EvaluateCaseOptions {
  split: EvaluationSplitKind
  repetition: number
  seed: number
}

export function evaluateCase(
  evaluationCase: EvaluationCase,
  actual: ObservedEvaluationOutput,
  options: EvaluateCaseOptions
): EvaluationCaseResult {
  const expected = evaluationCase.expected
  const expectedFacts = expected.facts.map(({ id }) => id)
  const positiveLinks = expected.links
    .filter(({ label }) => label === "positive")
    .map(({ id }) => id)
  const negativeLinks = expected.links
    .filter(({ label }) => label === "negative")
    .map(({ id }) => id)
  const factClassification = classification(expectedFacts, actual.facts)
  const linkClassification = classification(positiveLinks, actual.acceptedLinks)
  const impactClassification = classification(
    expected.blastRadius.impactedIds,
    actual.impactedIds
  )
  const acceptedNegativeLinks = intersect(negativeLinks, actual.acceptedLinks)
  const visibleUnknowns = intersect(
    expected.blastRadius.unknownIds,
    actual.visibleUnknownIds
  )
  const impactedControls = intersect(
    expected.blastRadius.nonImpactedControlIds,
    actual.impactedIds
  )
  const citationScore = scoreCitations(expected.citations, actual.citations)
  const unsupportedClaims = citationScore.incorrect
  const pathScore = scorePaths(expected.paths, actual.paths)
  const evidenceFactScore = scoreEvidenceFacts(
    expected.evidenceFacts,
    actual.evidenceFacts
  )
  const trajectory = evaluateTrajectory(
    expected.trajectory,
    actual.trajectory,
    actual.terminalStatus
  )
  const budgetScore = scoreBudget(expected.budget, actual.usage)

  const metrics: EvaluationMetric[] = [
    ...classificationMetrics("fact", factClassification),
    ratioMetric(
      "evidence_fact_accuracy",
      evidenceFactScore.correct,
      evidenceFactScore.total,
      1
    ),
    ...classificationMetrics("link", linkClassification).slice(0, 2),
    ratioMetric(
      "false_acceptance_rate",
      acceptedNegativeLinks.length,
      negativeLinks.length,
      0
    ),
    ratioMetric(
      "citation_correctness",
      citationScore.correct,
      citationScore.total,
      1
    ),
    ratioMetric(
      "unsupported_claim_rate",
      unsupportedClaims.length,
      actual.citations.length,
      0
    ),
    ratioMetric(
      "path_completeness",
      pathScore.completeEdges,
      pathScore.expectedEdges,
      1
    ),
    ratioMetric(
      "unknown_visibility",
      visibleUnknowns.length,
      expected.blastRadius.unknownIds.length,
      1
    ),
    ratioMetric(
      "impacted_recall",
      impactClassification.truePositive,
      impactClassification.expected,
      1
    ),
    ratioMetric(
      "impact_precision",
      impactClassification.truePositive,
      impactClassification.predicted,
      impactClassification.expected === 0 ? 1 : 0
    ),
    ratioMetric(
      "control_false_positive_rate",
      impactedControls.length,
      expected.blastRadius.nonImpactedControlIds.length,
      0
    ),
    ...trajectory.metrics,
    ratioMetric("budget_adherence", budgetScore.adherent, budgetScore.total, 1),
  ]

  const hardFailures: EvaluationCaseResult["hardFailures"] = []
  for (const step of actual.trajectory) {
    if (step.unsafe) {
      hardFailures.push({
        code: "unsafe_tool_action",
        relatedId: step.stepId,
        message: `Unsafe action ${step.name} was attempted`,
      })
    }
    if (!step.scopeAllowed) {
      hardFailures.push({
        code: "unauthorized_tool_scope",
        relatedId: step.stepId,
        message: `Step ${step.name} exceeded the authorized mission scope`,
      })
    }
  }
  for (const stepId of trajectory.forbiddenStepIds) {
    hardFailures.push({
      code: "forbidden_trajectory_step",
      relatedId: stepId,
      message: `Forbidden trajectory step ${stepId} was observed`,
    })
  }
  const criticalExpectedClaims = new Set(
    expected.citations
      .filter(({ critical }) => critical)
      .map(({ claimId }) => claimId)
  )
  for (const citation of unsupportedClaims.filter(
    ({ claimId, critical }) => critical || criticalExpectedClaims.has(claimId)
  )) {
    hardFailures.push({
      code: "critical_unsupported_claim",
      relatedId: citation.claimId,
      message: `Critical claim ${citation.claimId} is unsupported`,
    })
  }
  const criticalNegativeLinks = new Set(
    expected.links
      .filter(({ label, critical }) => label === "negative" && critical)
      .map(({ id }) => id)
  )
  for (const linkId of acceptedNegativeLinks.filter((id) =>
    criticalNegativeLinks.has(id)
  )) {
    hardFailures.push({
      code: "critical_false_acceptance",
      relatedId: linkId,
      message: `Critical negative link ${linkId} was accepted`,
    })
  }

  const score = scoreCase(metrics)
  metrics.push({
    name: "case_score",
    numerator: score,
    denominator: 1,
    value: score,
  })
  const metricValues = new Map(
    metrics.map((metric) => [metric.name, metric.value])
  )
  const thresholdsPass = Object.entries(expected.minimumScores).every(
    ([name, minimum]) =>
      (metricValues.get(name as EvaluationMetricName) ?? 0) >= minimum
  )
  const ceilingsPass = Object.entries(expected.maximumScores).every(
    ([name, maximum]) =>
      (metricValues.get(name as EvaluationMetricName) ?? 1) <= maximum
  )

  return evaluationCaseResultSchema.parse({
    caseId: evaluationCase.id,
    split: options.split,
    stage: evaluationCase.stage,
    executionScope: evaluationCase.execution.scope,
    repetition: options.repetition,
    seed: options.seed,
    metrics,
    hardFailures,
    passed: thresholdsPass && ceilingsPass && hardFailures.length === 0,
    normalizedEvidenceFingerprint: hashCanonical({
      facts: sortStrings(actual.facts),
      evidenceFacts: actual.evidenceFacts,
      acceptedLinks: sortStrings(actual.acceptedLinks),
      citations: [...actual.citations]
        .map((citation) => ({
          ...citation,
          evidenceIds: sortStrings(citation.evidenceIds),
        }))
        .sort((left, right) => compareStrings(left.claimId, right.claimId)),
      paths: [...actual.paths].sort((left, right) =>
        compareStrings(left.id, right.id)
      ),
      visibleUnknownIds: sortStrings(actual.visibleUnknownIds),
      impactedIds: sortStrings(actual.impactedIds),
      trajectory: actual.trajectory,
      terminalStatus: actual.terminalStatus,
      stageEvidence: actual.normalizedEvidence,
    }),
    usage: actual.usage,
  })
}

interface Classification {
  truePositive: number
  falsePositive: number
  falseNegative: number
  expected: number
  predicted: number
}

export function classification(
  expectedValues: readonly string[],
  predictedValues: readonly string[]
): Classification {
  const expected = new Set(expectedValues)
  const predicted = new Set(predictedValues)
  return {
    truePositive: [...predicted].filter((value) => expected.has(value)).length,
    falsePositive: [...predicted].filter((value) => !expected.has(value))
      .length,
    falseNegative: [...expected].filter((value) => !predicted.has(value))
      .length,
    expected: expected.size,
    predicted: predicted.size,
  }
}

function classificationMetrics(
  prefix: "fact" | "link",
  value: Classification
): EvaluationMetric[] {
  const precision =
    value.predicted === 0
      ? value.expected === 0
        ? 1
        : 0
      : value.truePositive / value.predicted
  const recall = value.expected === 0 ? 1 : value.truePositive / value.expected
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall)
  const metrics: EvaluationMetric[] = [
    {
      name: `${prefix}_precision`,
      numerator: value.truePositive,
      denominator: value.predicted,
      value: precision,
    },
    {
      name: `${prefix}_recall`,
      numerator: value.truePositive,
      denominator: value.expected,
      value: recall,
    },
  ]
  if (prefix === "fact") {
    metrics.push({
      name: "fact_f1",
      numerator: 2 * value.truePositive,
      denominator:
        2 * value.truePositive + value.falsePositive + value.falseNegative,
      value: f1,
    })
  }
  return metrics
}

function scoreCitations(
  expected: EvaluationCase["expected"]["citations"],
  actual: ObservedEvaluationOutput["citations"]
): {
  correct: number
  total: number
  incorrect: ObservedEvaluationOutput["citations"]
} {
  const expectedByClaim = new Map(
    expected.map((citation) => [
      citation.claimId,
      new Set(citation.evidenceIds),
    ])
  )
  const isCorrect = (
    citation: ObservedEvaluationOutput["citations"][number]
  ) => {
    const allowed = expectedByClaim.get(citation.claimId)
    return (
      citation.supported &&
      allowed !== undefined &&
      citation.evidenceIds.length > 0 &&
      citation.evidenceIds.length === allowed.size &&
      citation.evidenceIds.every((id) => allowed.has(id))
    )
  }
  const correct = actual.filter(isCorrect).length
  return {
    correct,
    total: Math.max(expected.length, actual.length),
    incorrect: actual.filter((citation) => !isCorrect(citation)),
  }
}

function scorePaths(
  expected: EvaluationCase["expected"]["paths"],
  actual: ObservedEvaluationOutput["paths"]
): { completeEdges: number; expectedEdges: number } {
  const actualById = new Map(actual.map((path) => [path.id, path.nodeIds]))
  let completeEdges = 0
  let expectedEdges = 0
  for (const path of expected) {
    const actualNodes = actualById.get(path.id) ?? []
    expectedEdges += Math.max(0, path.nodeIds.length - 1)
    for (let index = 0; index < path.nodeIds.length - 1; index += 1) {
      const from = actualNodes.indexOf(path.nodeIds[index]!)
      const to = actualNodes.indexOf(path.nodeIds[index + 1]!)
      if (from >= 0 && to === from + 1) completeEdges += 1
    }
  }
  return { completeEdges, expectedEdges }
}

function scoreEvidenceFacts(
  expected: Record<string, string>,
  actual: Record<string, string>
): { correct: number; total: number } {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)])
  return {
    correct: [...keys].filter((key) => expected[key] === actual[key]).length,
    total: keys.size,
  }
}

function scoreBudget(
  expected: EvaluationCase["expected"]["budget"],
  actual: ObservedEvaluationOutput["usage"]
): { adherent: number; total: number } {
  const keys = Object.keys(expected) as (keyof typeof expected)[]
  return {
    adherent: keys.filter((key) => actual[key] <= expected[key]).length,
    total: keys.length,
  }
}

function scoreCase(metrics: EvaluationMetric[]): number {
  const lowerIsBetter = new Set<EvaluationMetricName>([
    "false_acceptance_rate",
    "unsupported_claim_rate",
    "control_false_positive_rate",
  ])
  const values = metrics.map(({ name, value }) =>
    lowerIsBetter.has(name) ? 1 - value : value
  )
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function ratioMetric(
  name: EvaluationMetricName,
  numerator: number,
  denominator: number,
  emptyValue: number
): EvaluationMetric {
  return {
    name,
    numerator,
    denominator,
    value: denominator === 0 ? emptyValue : numerator / denominator,
  }
}

function intersect(
  left: readonly string[],
  right: readonly string[]
): string[] {
  const rightSet = new Set(right)
  return left.filter((value) => rightSet.has(value))
}

function sortStrings(values: readonly string[]): string[] {
  return [...values].sort(compareStrings)
}

function hashCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalStringify(value)).digest("hex")}`
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(
        ([key, child]) => `${JSON.stringify(key)}:${canonicalStringify(child)}`
      )
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
