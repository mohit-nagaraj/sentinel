import type {
  EvaluationCase,
  EvaluationDataset,
  ObservedEvaluationOutput,
} from "./schema.ts"
import { zeroBudget } from "./schema.ts"

export function createGoldenObservation(
  evaluationCase: EvaluationCase
): ObservedEvaluationOutput {
  const expected = evaluationCase.expected
  return {
    facts: expected.facts.map(({ id }) => id),
    evidenceFacts: structuredClone(expected.evidenceFacts),
    acceptedLinks: expected.links
      .filter(({ label }) => label === "positive")
      .map(({ id }) => id),
    citations: expected.citations.map(({ claimId, evidenceIds, critical }) => ({
      claimId,
      evidenceIds: [...evidenceIds],
      supported: true,
      critical,
    })),
    paths: expected.paths.map(({ id, nodeIds }) => ({
      id,
      nodeIds: [...nodeIds],
    })),
    visibleUnknownIds: [...expected.blastRadius.unknownIds],
    impactedIds: [...expected.blastRadius.impactedIds],
    trajectory: expected.trajectory.phases.flatMap(({ stepIds }) =>
      stepIds.map((stepId) => ({
        stepId,
        kind: stepId.startsWith("tool:")
          ? ("tool" as const)
          : ("evidence" as const),
        name: stepId,
        scopeAllowed: true,
        evidenceCorrect: true,
        unsafe: false,
      }))
    ),
    terminalStatus: expected.trajectory.acceptedTerminalStatuses[0]!,
    usage: { ...zeroBudget },
    normalizedEvidence: structuredClone(expected.evidenceFacts),
  }
}

export function findEvaluationCase(
  dataset: EvaluationDataset,
  caseId: string
): EvaluationCase {
  const evaluationCase = dataset.splits
    .flatMap(({ cases }) => cases)
    .find(({ id }) => id === caseId)
  if (evaluationCase === undefined) {
    throw new Error(`Unknown evaluation case ${caseId}`)
  }
  return evaluationCase
}
