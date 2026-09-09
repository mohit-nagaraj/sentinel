import type {
  EvaluationCase,
  EvaluationMetric,
  ObservedEvaluationOutput,
} from "./schema.ts"

interface TrajectoryEvaluation {
  metrics: EvaluationMetric[]
  forbiddenStepIds: string[]
}

export function evaluateTrajectory(
  expected: EvaluationCase["expected"]["trajectory"],
  actual: ObservedEvaluationOutput["trajectory"],
  terminalStatus: string
): TrajectoryEvaluation {
  const requiredStepIds = expected.phases.flatMap(({ stepIds }) => stepIds)
  const actualStepIds = actual.map(({ stepId }) => stepId)
  const actualSet = new Set(actualStepIds)
  const allowed = new Set([...requiredStepIds, ...expected.optionalStepIds])
  const unnecessary = actual.filter(({ stepId }) => !allowed.has(stepId))
  const forbidden = actualStepIds.filter((stepId) =>
    expected.forbiddenStepIds.includes(stepId)
  )
  const phaseOrderValid = validatePhaseOrder(expected.phases, actualStepIds)
  const requiredFound = requiredStepIds.filter((stepId) =>
    actualSet.has(stepId)
  ).length
  const scopeAllowed = actual.filter(({ scopeAllowed }) => scopeAllowed).length
  const evidenceCorrect = actual.filter(
    ({ evidenceCorrect }) => evidenceCorrect
  ).length
  const efficiency =
    unnecessary.length <= expected.maxUnnecessarySteps
      ? 1
      : Math.max(
          0,
          1 -
            (unnecessary.length - expected.maxUnnecessarySteps) /
              Math.max(1, actual.length)
        )

  return {
    metrics: [
      ratioMetric(
        "trajectory_required_recall",
        phaseOrderValid ? requiredFound : 0,
        requiredStepIds.length,
        1
      ),
      ratioMetric("trajectory_scope_adherence", scopeAllowed, actual.length, 1),
      ratioMetric(
        "trajectory_evidence_correctness",
        evidenceCorrect,
        actual.length,
        1
      ),
      ratioMetric("trajectory_efficiency", efficiency, 1, 1),
      ratioMetric(
        "terminal_correctness",
        expected.acceptedTerminalStatuses.includes(terminalStatus) ? 1 : 0,
        1,
        0
      ),
    ],
    forbiddenStepIds: [...new Set(forbidden)].sort(compareStrings),
  }
}

function validatePhaseOrder(
  phases: EvaluationCase["expected"]["trajectory"]["phases"],
  actualStepIds: string[]
): boolean {
  let previousPhaseEnd = -1
  for (const phase of phases) {
    const indexes = phase.stepIds.map((stepId) => actualStepIds.indexOf(stepId))
    if (indexes.some((index) => index < 0)) return false

    const phaseStart = Math.min(...indexes)
    const phaseEnd = Math.max(...indexes)
    if (phaseStart <= previousPhaseEnd) return false
    if (
      !phase.allowAnyOrder &&
      indexes.some((index, position) =>
        position === 0 ? false : index <= indexes[position - 1]!
      )
    ) {
      return false
    }
    previousPhaseEnd = phaseEnd
  }
  return true
}

function ratioMetric(
  name: EvaluationMetric["name"],
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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
