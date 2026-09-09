import {
  applicationIdSchema,
  contentHashSchema,
  coverageEvaluationInputSchema,
  evidenceIdSchema,
  missionIdSchema,
  requirementIdSchema,
  runIdSchema,
  screenIdSchema,
  workflowIdSchema,
  type CoverageEvaluationInput,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import {
  createCoverageAssessment,
  createCoverageAssessmentBatch,
  evaluateCoverageFreshness,
} from "./coverage-assessment.ts"
import { createEvidenceLinker } from "./evidence-linker.ts"

const applicationId = applicationIdSchema.parse(
  `application:v1:${"1".repeat(64)}`
)
const requirementId = requirementIdSchema.parse(
  `requirement:v1:${"2".repeat(64)}`
)
const missionId = missionIdSchema.parse(`mission:v1:${"3".repeat(64)}`)
const runId = runIdSchema.parse("run:11111111-1111-4111-8111-111111111111")
const workflowId = workflowIdSchema.parse(`workflow:v1:${"4".repeat(64)}`)
const screenId = screenIdSchema.parse(`screen:v1:${"5".repeat(64)}`)
const attemptEvidenceId = evidenceIdSchema.parse(
  `evidence:v1:${"6".repeat(64)}`
)
const supportingEvidenceId = evidenceIdSchema.parse(
  `evidence:v1:${"7".repeat(64)}`
)
const issueEvidenceId = evidenceIdSchema.parse(`evidence:v1:${"8".repeat(64)}`)
const requirementHash = contentHashSchema.parse(`sha256:${"a".repeat(64)}`)
const crawlHash = contentHashSchema.parse(`sha256:${"b".repeat(64)}`)
const testDataHash = contentHashSchema.parse(`sha256:${"c".repeat(64)}`)

function input(
  overrides: Record<string, unknown> = {}
): CoverageEvaluationInput {
  return coverageEvaluationInputSchema.parse({
    schemaVersion: 1,
    applicationId,
    requirementId,
    runId,
    graphRevision: 3,
    scope: {
      summary: "the checkout workflow and payment screen",
      missionIds: [missionId],
      workflowIds: [workflowId],
      screenIds: [screenId],
      exploredRoutes: ["/checkout/payment"],
    },
    revisionContext: {
      requirementSourceHash: requirementHash,
      crawlConfigurationHash: crawlHash,
      authenticationRevision: 2,
      testDataRevision: testDataHash,
    },
    environment: {
      authentication: "configured",
      testData: "configured",
    },
    evaluationRequested: true,
    expectedCheckpointCount: 2,
    observedCheckpointCount: 0,
    attemptSummary: "Searched checkout and payment for the required behavior.",
    attemptEvidenceIds: [attemptEvidenceId],
    supportingEvidenceIds: [],
    blockers: [],
    ambiguities: [],
    evaluatedAt: "2026-09-09T04:00:00.000Z",
    ...overrides,
  })
}

describe("coverage status rules", () => {
  it.each([
    [
      "observed",
      {
        expectedCheckpointCount: 2,
        observedCheckpointCount: 2,
        supportingEvidenceIds: [supportingEvidenceId],
      },
    ],
    [
      "partially_observed",
      {
        expectedCheckpointCount: 2,
        observedCheckpointCount: 1,
        supportingEvidenceIds: [supportingEvidenceId],
      },
    ],
    ["not_observed", {}],
    [
      "blocked",
      {
        blockers: [
          {
            kind: "authentication",
            reasonCode: "login_required",
            summary: "Authentication was required before checkout.",
            humanAction: "Supply safe test credentials.",
            evidenceIds: [issueEvidenceId],
          },
        ],
      },
    ],
    [
      "not_evaluated",
      {
        evaluationRequested: false,
        expectedCheckpointCount: 0,
        attemptSummary: undefined,
        attemptEvidenceIds: [],
      },
    ],
    [
      "ambiguous",
      {
        ambiguities: [
          {
            reasonCode: "multiple_workflows_match",
            summary: "Two unrelated workflows matched the requirement.",
            humanAction: "Select the intended workflow.",
            evidenceIds: [issueEvidenceId],
          },
        ],
      },
    ],
  ] as const)("assigns %s deterministically", (status, overrides) => {
    const first = createCoverageAssessment(input(overrides))
    const second = createCoverageAssessment(input(overrides))

    expect(first).toStrictEqual(second)
    expect(first.assessment.status).toBe(status)
    expect(first.graphFact.status).toBe(status)
    expect(first.summary.status).toBe(status)
    expect(first.assessment.wording).not.toMatch(
      /does not exist|is not supported|feature is absent/i
    )
  })

  it("denies a negative assertion when no bounded attempt exists", () => {
    const result = createCoverageAssessment(
      input({
        expectedCheckpointCount: 1,
        attemptSummary: undefined,
        attemptEvidenceIds: [],
      })
    )

    expect(result.assessment.status).toBe("not_evaluated")
    expect(result.assessment.wording).toBe(
      "This requirement was not evaluated in the current run."
    )
  })

  it.each(["authentication", "policy", "unsafe_action", "test_data"] as const)(
    "preserves a distinct %s blocker and human action",
    (kind) => {
      const result = createCoverageAssessment(
        input({
          blockers: [
            {
              kind,
              reasonCode: `${kind}_blocked`,
              summary: `${kind} prevented the bounded attempt.`,
              humanAction: `Resolve the ${kind} blocker.`,
              evidenceIds: [issueEvidenceId],
            },
          ],
        })
      )

      expect(result.assessment.status).toBe("blocked")
      expect(result.graphFact.blockerKinds).toEqual([kind])
      expect(result.summary.humanActions).toEqual([
        `Resolve the ${kind} blocker.`,
      ])
    }
  )

  it("does not interpolate a qualified blocker limitation into report wording", () => {
    const result = createCoverageAssessment(
      input({
        blockers: [
          {
            kind: "authentication",
            reasonCode: "login_unavailable",
            summary: "Login is not supported in this environment.",
            humanAction: "Supply a supported authentication environment.",
            evidenceIds: [issueEvidenceId],
          },
        ],
      })
    )

    expect(result.assessment.status).toBe("blocked")
    expect(result.assessment.wording).toBe(
      "Coverage within the checkout workflow and payment screen was blocked. This result does not establish whether the behavior is available."
    )
    expect(result.summary.reason).toBe(
      "A recorded blocker prevented the scoped coverage attempt from completing."
    )
  })
})

describe("coverage identity and evidence", () => {
  it("advances not-observed coverage with new evidence without changing identity", () => {
    const notObserved = createCoverageAssessment(input())
    const observed = createCoverageAssessment(
      input({
        observedCheckpointCount: 2,
        supportingEvidenceIds: [supportingEvidenceId],
      })
    )

    expect(notObserved.assessment.status).toBe("not_observed")
    expect(observed.assessment.status).toBe("observed")
    expect(observed.assessment.id).toBe(notObserved.assessment.id)
    expect(observed.evaluatorEvidence.reference.id).not.toBe(
      notObserved.evaluatorEvidence.reference.id
    )
    expect(observed.assessment.evidenceIds).toContain(supportingEvidenceId)
  })

  it("creates one explicit, deterministically ordered result per requirement", () => {
    const secondRequirementId = requirementIdSchema.parse(
      `requirement:v1:${"9".repeat(64)}`
    )
    const results = createCoverageAssessmentBatch([
      input({
        requirementId: secondRequirementId,
        evaluationRequested: false,
        expectedCheckpointCount: 0,
        attemptSummary: undefined,
        attemptEvidenceIds: [],
        scope: {
          ...input().scope,
          workflowIds: [],
          screenIds: [],
          exploredRoutes: [],
        },
      }),
      input({
        observedCheckpointCount: 2,
        supportingEvidenceIds: [supportingEvidenceId],
      }),
    ])

    expect(results).toHaveLength(2)
    expect(results.map((result) => result.assessment.requirementId)).toEqual(
      [requirementId, secondRequirementId].sort()
    )
    expect(results.map((result) => result.assessment.status).sort()).toEqual([
      "not_evaluated",
      "observed",
    ])
  })

  it("emits evidence that the authoritative linker accepts for HAS_ASSESSMENT", async () => {
    const result = createCoverageAssessment(input())
    const batch = await createEvidenceLinker().link({
      schemaVersion: 1,
      applicationId,
      runId,
      graphRevision: 3,
      compatibleRunIds: [runId],
      compatibleCommitShas: [],
      evidence: [result.evaluatorEvidence],
      submittedLinks: [result.assessmentLink],
      exactObservations: [],
      apiEndpoints: [],
      frontendRoutes: [],
      semanticEntities: [],
      maxCandidates: 20,
    })

    expect(batch.rejections).toHaveLength(0)
    expect(batch.links).toEqual([
      expect.objectContaining({
        fromId: requirementId,
        relationship: "HAS_ASSESSMENT",
        toId: result.assessment.id,
        evidenceTier: "A",
      }),
    ])
  })
})

describe("coverage invalidation", () => {
  it("marks source, crawl, authentication, and test-data changes stale", () => {
    const assessment = createCoverageAssessment(input()).assessment
    expect(
      evaluateCoverageFreshness(assessment, assessment.revisionContext)
    ).toEqual({
      status: "current",
      reasons: [],
      requiresReassessment: false,
    })

    expect(
      evaluateCoverageFreshness(assessment, {
        requirementSourceHash: contentHashSchema.parse(
          `sha256:${"d".repeat(64)}`
        ),
        crawlConfigurationHash: contentHashSchema.parse(
          `sha256:${"e".repeat(64)}`
        ),
        authenticationRevision: 3,
        testDataRevision: contentHashSchema.parse(`sha256:${"f".repeat(64)}`),
      })
    ).toEqual({
      status: "stale",
      reasons: [
        "requirement_source_changed",
        "crawl_configuration_changed",
        "authentication_configuration_changed",
        "test_data_configuration_changed",
      ],
      requiresReassessment: true,
    })
  })
})
