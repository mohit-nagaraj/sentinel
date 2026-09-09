import {
  coverageAssessmentGraphFactSchema,
  coverageAssessmentIdSchema,
  coverageAssessmentSchema,
  coverageAssessmentSummarySchema,
  coverageEvaluationInputSchema,
  coverageFreshnessSchema,
  coverageRevisionContextSchema,
  createClaimId,
  createStableKey,
  evidenceIdSchema,
  hashCanonical,
  stableEntityIdSchema,
  type CoverageAssessment,
  type CoverageAssessmentGraphFact,
  type CoverageAssessmentSummary,
  type CoverageEvaluationInput,
  type CoverageFreshness,
  type CoverageRevisionContext,
  type CoverageStatus,
  type LinkEvidenceRecord,
  type SubmittedEvidenceLink,
} from "@sentinel/contracts"

export interface CoverageAssessmentResult {
  readonly assessment: CoverageAssessment
  readonly graphFact: CoverageAssessmentGraphFact
  readonly summary: CoverageAssessmentSummary
  readonly evaluatorEvidence: LinkEvidenceRecord
  readonly assessmentLink: SubmittedEvidenceLink
}

function sortUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[]
}

function determineStatus(input: CoverageEvaluationInput): CoverageStatus {
  if (!input.evaluationRequested) return "not_evaluated"
  if (input.blockers.length > 0) return "blocked"
  if (input.ambiguities.length > 0) return "ambiguous"
  if (
    input.expectedCheckpointCount > 0 &&
    input.observedCheckpointCount === input.expectedCheckpointCount
  ) {
    return "observed"
  }
  if (input.observedCheckpointCount > 0) return "partially_observed"
  if (input.attemptEvidenceIds.length > 0) return "not_observed"
  return "not_evaluated"
}

function reasonFor(status: CoverageStatus, input: CoverageEvaluationInput) {
  switch (status) {
    case "observed":
      return {
        reasonCode: "all_checkpoints_observed",
        reason:
          "All expected checkpoints were supported by evidence within the assessment scope.",
      }
    case "partially_observed":
      return {
        reasonCode: "some_checkpoints_observed",
        reason:
          "Some expected checkpoints were supported by evidence, but scoped coverage is incomplete.",
      }
    case "not_observed":
      return {
        reasonCode: "bounded_attempt_without_observation",
        reason:
          "A bounded search completed without observing supporting behavior.",
      }
    case "blocked":
      return {
        reasonCode: input.blockers[0]?.reasonCode ?? "coverage_blocked",
        reason:
          "A recorded blocker prevented the scoped coverage attempt from completing.",
      }
    case "ambiguous":
      return {
        reasonCode: input.ambiguities[0]?.reasonCode ?? "coverage_ambiguous",
        reason:
          "The available evidence did not support one unambiguous coverage result.",
      }
    case "not_evaluated":
      return {
        reasonCode: "no_bounded_attempt",
        reason:
          "No bounded coverage attempt with evidence was recorded for this requirement.",
      }
  }
}

function wordingFor(status: CoverageStatus, scope: string) {
  switch (status) {
    case "observed":
      return `Evidence for this requirement was observed within ${scope}.`
    case "partially_observed":
      return `Some evidence for this requirement was observed within ${scope}, but coverage remains incomplete.`
    case "not_observed":
      return `This requirement was not observed within ${scope}.`
    case "blocked":
      return `Coverage within ${scope} was blocked. This result does not establish whether the behavior is available.`
    case "not_evaluated":
      return "This requirement was not evaluated in the current run."
    case "ambiguous":
      return `Evidence within ${scope} was ambiguous and requires human review.`
  }
}

function possibleCausesFor(
  status: CoverageStatus,
  input: CoverageEvaluationInput
): string[] {
  if (status === "not_observed") {
    return [
      "The relevant application configuration may not have been enabled.",
      "The explored account may not have had the required permissions.",
      "The behavior may occur outside the completed crawl scope.",
      "The available test data may not have exposed the behavior.",
      "The bounded crawl may have ended before reaching the behavior.",
    ]
  }
  if (status === "blocked") {
    return sortUnique(
      input.blockers.map(
        (blocker) => `Coverage was blocked by ${blocker.kind}.`
      )
    )
  }
  if (status === "partially_observed") {
    return [
      "One or more expected checkpoints remain outside observed evidence.",
    ]
  }
  if (status === "ambiguous") {
    return sortUnique(input.ambiguities.map((ambiguity) => ambiguity.summary))
  }
  return []
}

function humanActionsFor(input: CoverageEvaluationInput): string[] {
  return sortUnique([
    ...input.blockers.map((blocker) => blocker.humanAction),
    ...input.ambiguities.map((ambiguity) => ambiguity.humanAction),
  ])
}

function collectEvidenceIds(input: CoverageEvaluationInput) {
  return sortUnique([
    ...input.attemptEvidenceIds,
    ...input.supportingEvidenceIds,
    ...input.blockers.flatMap((blocker) => blocker.evidenceIds),
    ...input.ambiguities.flatMap((ambiguity) => ambiguity.evidenceIds),
  ])
}

export function createCoverageAssessment(
  inputValue: CoverageEvaluationInput
): CoverageAssessmentResult {
  const input = coverageEvaluationInputSchema.parse(inputValue)
  const scopeFingerprint = hashCanonical({
    scope: input.scope,
    revisionContext: input.revisionContext,
  })
  const id = coverageAssessmentIdSchema.parse(
    createStableKey({
      kind: "coverage-assessment",
      applicationId: input.applicationId,
      requirementId: input.requirementId,
      scopeFingerprint,
      runId: input.runId,
    })
  )
  const status = determineStatus(input)
  const { reason, reasonCode } = reasonFor(status, input)
  const evidenceIds =
    status === "not_evaluated" ? [] : collectEvidenceIds(input)
  const attemptEvidenceIds =
    status === "not_evaluated" ? [] : sortUnique(input.attemptEvidenceIds)
  const blockers = status === "blocked" ? input.blockers : []
  const ambiguities = status === "ambiguous" ? input.ambiguities : []
  const possibleCauses = possibleCausesFor(status, input)
  const wording = wordingFor(status, input.scope.summary)

  const assessment = coverageAssessmentSchema.parse({
    schemaVersion: 1,
    id,
    applicationId: input.applicationId,
    requirementId: input.requirementId,
    status,
    scope: input.scope,
    scopeFingerprint,
    revisionContext: input.revisionContext,
    environment: input.environment,
    reasonCode,
    reason,
    wording,
    ...(input.attemptSummary === undefined
      ? {}
      : { attemptSummary: input.attemptSummary }),
    possibleCauses,
    runId: input.runId,
    graphRevision: input.graphRevision,
    evidenceIds,
    attemptEvidenceIds,
    blockers,
    ambiguities,
    evaluatedAt: input.evaluatedAt,
  })

  const graphFact = coverageAssessmentGraphFactSchema.parse({
    schemaVersion: 1,
    id,
    applicationId: input.applicationId,
    requirementId: input.requirementId,
    status,
    scopeFingerprint,
    scopeSummary: input.scope.summary,
    reasonCode,
    wording,
    ...(input.attemptSummary === undefined
      ? {}
      : { attemptSummary: input.attemptSummary }),
    runId: input.runId,
    graphRevision: input.graphRevision,
    evidenceIds,
    attemptEvidenceIds,
    blockerKinds: sortUnique(blockers.map((blocker) => blocker.kind)),
    requirementSourceHash: input.revisionContext.requirementSourceHash,
    crawlConfigurationHash: input.revisionContext.crawlConfigurationHash,
    authenticationRevision: input.revisionContext.authenticationRevision,
    ...(input.revisionContext.testDataRevision === undefined
      ? {}
      : { testDataRevision: input.revisionContext.testDataRevision }),
    evaluatedAt: input.evaluatedAt,
  })

  const summary = coverageAssessmentSummarySchema.parse({
    id,
    requirementId: input.requirementId,
    status,
    scope: input.scope.summary,
    wording,
    reason,
    ...(input.attemptSummary === undefined
      ? {}
      : { attemptSummary: input.attemptSummary }),
    possibleCauses,
    blockerKinds: graphFact.blockerKinds,
    humanActions: humanActionsFor(input),
    evidenceCount: evidenceIds.length,
    attemptEvidenceCount: attemptEvidenceIds.length,
    evaluatedAt: input.evaluatedAt,
  })

  const evaluatorEvidenceId = evidenceIdSchema.parse(
    `evidence:v1:${hashCanonical({
      assessmentId: id,
      graphFact,
      kind: "coverage_evaluator",
    }).slice("sha256:".length)}`
  )
  const evaluatorEvidence: LinkEvidenceRecord = {
    reference: {
      schemaVersion: 1,
      id: evaluatorEvidenceId,
      applicationId: input.applicationId,
      runId: input.runId,
      status: "validated",
      kind: "coverage_assessment",
      sourceEntityId: stableEntityIdSchema.parse(id),
      contentHash: hashCanonical(graphFact),
      capturedAt: input.evaluatedAt,
    },
    provenance: { sourceKind: "system", observedAt: input.evaluatedAt },
    extractionMethod: "coverage_evaluator",
    bindings: [
      {
        fromId: stableEntityIdSchema.parse(input.requirementId),
        relationship: "HAS_ASSESSMENT",
        toId: stableEntityIdSchema.parse(id),
      },
    ],
    summary: assessment.wording,
  }
  const assessmentLink: SubmittedEvidenceLink = {
    id: createClaimId({
      applicationId: input.applicationId,
      missionId: input.scope.missionIds[0],
      subjectId: input.requirementId,
      predicate: "has_assessment",
      objectId: id,
      ordinal: 0,
    }),
    applicationId: input.applicationId,
    assertion: "supports",
    evidenceIds: [evaluatorEvidenceId],
    explanation: assessment.wording,
    fromId: input.requirementId,
    relationship: "HAS_ASSESSMENT",
    toId: id,
  }

  return { assessment, graphFact, summary, evaluatorEvidence, assessmentLink }
}

export function createCoverageAssessmentBatch(
  inputs: readonly CoverageEvaluationInput[]
): CoverageAssessmentResult[] {
  const keys = new Set<string>()
  const results = inputs.map((input) => {
    const parsed = coverageEvaluationInputSchema.parse(input)
    const key = `${parsed.applicationId}:${parsed.requirementId}`
    if (keys.has(key)) {
      throw new Error(
        `Coverage batch contains duplicate requirement ${parsed.requirementId}`
      )
    }
    keys.add(key)
    return createCoverageAssessment(parsed)
  })

  return results.sort((left, right) =>
    left.assessment.requirementId.localeCompare(right.assessment.requirementId)
  )
}

export function evaluateCoverageFreshness(
  assessmentInput: CoverageAssessment,
  currentInput: CoverageRevisionContext
): CoverageFreshness {
  const assessment = coverageAssessmentSchema.parse(assessmentInput)
  const current = coverageRevisionContextSchema.parse(currentInput)
  const reasons: Array<
    | "requirement_source_changed"
    | "crawl_configuration_changed"
    | "authentication_configuration_changed"
    | "test_data_configuration_changed"
  > = []

  if (
    assessment.revisionContext.requirementSourceHash !==
    current.requirementSourceHash
  ) {
    reasons.push("requirement_source_changed")
  }
  if (
    assessment.revisionContext.crawlConfigurationHash !==
    current.crawlConfigurationHash
  ) {
    reasons.push("crawl_configuration_changed")
  }
  if (
    assessment.revisionContext.authenticationRevision !==
    current.authenticationRevision
  ) {
    reasons.push("authentication_configuration_changed")
  }
  if (
    assessment.revisionContext.testDataRevision !== current.testDataRevision
  ) {
    reasons.push("test_data_configuration_changed")
  }

  return coverageFreshnessSchema.parse(
    reasons.length === 0
      ? { status: "current", reasons: [], requiresReassessment: false }
      : { status: "stale", reasons, requiresReassessment: true }
  )
}
