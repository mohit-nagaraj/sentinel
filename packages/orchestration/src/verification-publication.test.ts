import { describe, expect, it } from "vitest"

import {
  buildTargetedVerificationResult,
  evaluateVerificationMission,
} from "./verification-evaluator.ts"
import {
  TargetedVerificationPublicationService,
  buildReportVerification,
  buildTargetedVerificationEnrichment,
} from "./verification-publication.ts"
import {
  fixtureBudget,
  fixtureIds,
  fixtureMissionEvidence,
  fixtureMissionPlan,
  fixturePlan,
  fixtureSetup,
  fixtureValidation,
} from "./verification-test-fixtures.ts"

function publicationFixture() {
  const missionPlan = fixtureMissionPlan()
  const missionResult = evaluateVerificationMission({
    plan: missionPlan,
    setup: fixtureSetup({ plan: missionPlan }),
    head: fixtureMissionEvidence({ plan: missionPlan }),
    artifactPolicy: {
      successfulRetentionSeconds: 0,
      failureRetentionSeconds: 86_400,
      reportRetentionSeconds: 604_800,
    },
    now: new Date(fixtureIds.timestamp),
  })
  const plan = fixturePlan({ missions: [missionPlan] })
  const result = buildTargetedVerificationResult({
    plan,
    headValidation: fixtureValidation(),
    missionResults: [missionResult],
    budgetUsed: fixtureBudget,
    completedAt: new Date(fixtureIds.timestamp),
  })
  return { plan, result }
}

describe("targeted verification publication", () => {
  it("builds a separate enrichment without removing predicted findings", () => {
    const { result: value } = publicationFixture()
    const enrichment = buildTargetedVerificationEnrichment({ result: value })

    expect(enrichment).toMatchObject({
      assessmentId: value.assessmentId,
      headSha: value.headSha,
      resultId: value.id,
      status: "passed",
      predictedFindingIds: value.predictedFindingIds,
    })
    expect(enrichment.missionResultIds).toEqual([value.missionResults[0]!.id])
  })

  it("projects deterministic mission evidence into the report contract", () => {
    const { plan, result } = publicationFixture()

    expect(buildReportVerification({ plan, result })).toMatchObject({
      status: "passed",
      version: 0,
      reason: result.deterministicSummary,
      results: [
        {
          runId: result.runId,
          pullRequestId: result.pullRequestId,
          headSha: result.headSha,
          workflowId: fixtureIds.workflow,
          status: "passed",
          assertions: [
            {
              name: "Checkout advances to confirmation",
              passed: true,
              evidenceIds: [fixtureIds.evidence],
            },
          ],
        },
      ],
    })
  })

  it("reports a failed control as blocked attribution without hiding affected evidence", () => {
    const affectedPlan = fixtureMissionPlan()
    const controlPlan = fixtureMissionPlan({
      kind: "control",
      missionId: `mission:v1:${"9".repeat(64)}`,
    })
    const affectedResult = evaluateVerificationMission({
      plan: affectedPlan,
      setup: fixtureSetup({ plan: affectedPlan }),
      head: fixtureMissionEvidence({ plan: affectedPlan }),
      artifactPolicy: {
        successfulRetentionSeconds: 0,
        failureRetentionSeconds: 86_400,
        reportRetentionSeconds: 604_800,
      },
      now: new Date(fixtureIds.timestamp),
    })
    const controlResult = evaluateVerificationMission({
      plan: controlPlan,
      setup: fixtureSetup({ plan: controlPlan }),
      head: fixtureMissionEvidence({
        plan: controlPlan,
        observations: [
          {
            schemaVersion: 1,
            checkpointId: controlPlan.checkpoints[0]!.id,
            kind: "transition",
            beforeFingerprint: `sha256:${"a".repeat(64)}` as never,
            afterFingerprint: `sha256:${"a".repeat(64)}` as never,
            changed: false,
            evidenceIds: [fixtureIds.evidence] as never,
            observedAt: fixtureIds.timestamp,
          },
        ],
      }),
      artifactPolicy: {
        successfulRetentionSeconds: 0,
        failureRetentionSeconds: 86_400,
        reportRetentionSeconds: 604_800,
      },
      now: new Date(fixtureIds.timestamp),
    })
    const plan = fixturePlan({ missions: [affectedPlan], control: controlPlan })
    const value = buildTargetedVerificationResult({
      plan,
      headValidation: fixtureValidation(),
      missionResults: [affectedResult],
      controlResult,
      budgetUsed: fixtureBudget,
      completedAt: new Date(fixtureIds.timestamp),
    })

    expect(value.status).toBe("blocked")
    expect(buildReportVerification({ plan, result: value })).toMatchObject({
      status: "blocked",
      results: [{ status: "passed" }, { status: "blocked" }],
    })
  })

  it("resumes a failed check update from an existing idempotent append", async () => {
    const { plan, result: value } = publicationFixture()
    const appendCalls: string[] = []
    const checkCalls: unknown[] = []
    const dispositions = ["published", "existing"] as const
    let appendIndex = 0
    const checkResults = ["sync_pending", "published"] as const
    let checkIndex = 0
    const service = new TargetedVerificationPublicationService(
      {
        appendCurrent: async ({ idempotencyKey }) => {
          appendCalls.push(idempotencyKey)
          return {
            disposition: dispositions[appendIndex++] ?? "existing",
            version: 1,
          }
        },
      },
      {
        publishCheck: async (input) => {
          checkCalls.push(input)
          return checkResults[checkIndex++] ?? "published"
        },
      }
    )
    const input = {
      assessmentId: value.assessmentId,
      headSha: value.headSha,
      plan,
      result: value,
      idempotencyKey: `sha256:${"f".repeat(64)}`,
    }

    await expect(service.publishCurrent(input)).rejects.toThrow(
      "synchronization is pending"
    )
    await expect(service.publishCurrent(input)).resolves.toBe("existing")
    expect(appendCalls).toEqual([input.idempotencyKey, input.idempotencyKey])
    expect(checkCalls).toHaveLength(2)
    expect(checkCalls[1]).toMatchObject({
      lifecycle: {
        state: "completed",
        outcome: "analysis_succeeded",
        title: "Sentinel targeted verification passed",
      },
    })
  })

  it("does not update the GitHub check for a superseded assessment", async () => {
    const { plan, result: value } = publicationFixture()
    let checked = false
    const service = new TargetedVerificationPublicationService(
      {
        appendCurrent: async () => ({ disposition: "superseded" }),
      },
      {
        publishCheck: async () => {
          checked = true
          return "published"
        },
      }
    )
    await expect(
      service.publishCurrent({
        assessmentId: value.assessmentId,
        headSha: value.headSha,
        plan,
        result: value,
        idempotencyKey: `sha256:${"f".repeat(64)}`,
      })
    ).resolves.toBe("superseded")
    expect(checked).toBe(false)
  })
})
