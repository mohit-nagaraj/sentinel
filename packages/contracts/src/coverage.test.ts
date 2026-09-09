import { describe, expect, it } from "vitest"

import {
  applicationIdSchema,
  contentHashSchema,
  coverageAssessmentSchema,
  coverageEvaluationInputSchema,
  evidenceIdSchema,
  missionIdSchema,
  reportSafeCoverageWordingSchema,
  requirementIdSchema,
  runIdSchema,
} from "./index.ts"

const applicationId = applicationIdSchema.parse(
  `application:v1:${"1".repeat(64)}`
)
const requirementId = requirementIdSchema.parse(
  `requirement:v1:${"2".repeat(64)}`
)
const missionId = missionIdSchema.parse(`mission:v1:${"3".repeat(64)}`)
const runId = runIdSchema.parse("run:11111111-1111-4111-8111-111111111111")
const evidenceId = evidenceIdSchema.parse(`evidence:v1:${"4".repeat(64)}`)
const hash = contentHashSchema.parse(`sha256:${"5".repeat(64)}`)

function evaluation() {
  return {
    schemaVersion: 1 as const,
    applicationId,
    requirementId,
    runId,
    graphRevision: 2,
    scope: {
      summary: "the public checkout route",
      missionIds: [missionId],
      workflowIds: [],
      screenIds: [],
      exploredRoutes: ["/checkout"],
    },
    revisionContext: {
      requirementSourceHash: hash,
      crawlConfigurationHash: hash,
      authenticationRevision: 1,
    },
    environment: {
      authentication: "configured" as const,
      testData: "configured" as const,
    },
    evaluationRequested: true,
    expectedCheckpointCount: 1,
    observedCheckpointCount: 0,
    attemptSummary:
      "Searched the public checkout route for the expected control.",
    attemptEvidenceIds: [evidenceId],
    supportingEvidenceIds: [],
    blockers: [],
    ambiguities: [],
    evaluatedAt: "2026-09-09T04:00:00.000Z",
  }
}

describe("coverage contracts", () => {
  it("requires a bounded scope and attempt summary for attempted coverage", () => {
    expect(coverageEvaluationInputSchema.safeParse(evaluation()).success).toBe(
      true
    )

    expect(
      coverageEvaluationInputSchema.safeParse({
        ...evaluation(),
        attemptSummary: undefined,
      }).success
    ).toBe(false)
    expect(
      coverageEvaluationInputSchema.safeParse({
        ...evaluation(),
        scope: { ...evaluation().scope, exploredRoutes: [] },
      }).success
    ).toBe(false)
  })

  it("rejects externally constructed not-observed assessments without attempt evidence", () => {
    const invalid = {
      schemaVersion: 1,
      id: `coverage-assessment:v1:${"6".repeat(64)}`,
      applicationId,
      requirementId,
      status: "not_observed",
      scope: evaluation().scope,
      scopeFingerprint: hash,
      revisionContext: evaluation().revisionContext,
      environment: evaluation().environment,
      reasonCode: "bounded_attempt_without_observation",
      reason: "No matching control was observed.",
      wording: "This requirement was not observed within checkout.",
      possibleCauses: [],
      runId,
      graphRevision: 2,
      evidenceIds: [],
      attemptEvidenceIds: [],
      blockers: [],
      ambiguities: [],
      evaluatedAt: evaluation().evaluatedAt,
    }

    expect(coverageAssessmentSchema.safeParse(invalid).success).toBe(false)
  })

  it("rejects absolute absence language at the persisted boundary", () => {
    expect(
      reportSafeCoverageWordingSchema.safeParse(
        "The promotion-code feature does not exist."
      ).success
    ).toBe(false)
    expect(
      reportSafeCoverageWordingSchema.safeParse(
        "The promotion-code behavior was not observed within checkout."
      ).success
    ).toBe(true)
    expect(
      coverageEvaluationInputSchema.safeParse({
        ...evaluation(),
        attemptSummary: "The promotion-code feature does not exist.",
      }).success
    ).toBe(false)
  })
})
