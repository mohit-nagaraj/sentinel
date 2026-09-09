import { describe, expect, it } from "vitest"

import {
  buildTargetedVerificationResult,
  evaluateVerificationMission,
} from "./verification-evaluator.ts"
import {
  TargetedVerificationPublicationService,
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

function result() {
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
  return buildTargetedVerificationResult({
    plan: fixturePlan({ missions: [missionPlan] }),
    headValidation: fixtureValidation(),
    missionResults: [missionResult],
    budgetUsed: fixtureBudget,
    completedAt: new Date(fixtureIds.timestamp),
  })
}

describe("targeted verification publication", () => {
  it("builds a separate enrichment without removing predicted findings", () => {
    const value = result()
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

  it("resumes a failed check update from an existing idempotent append", async () => {
    const value = result()
    const appendCalls: string[] = []
    const checkCalls: unknown[] = []
    const dispositions = ["published", "existing"] as const
    let appendIndex = 0
    const checkResults = [false, true]
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
          return checkResults.shift() ?? true
        },
      }
    )
    const input = {
      assessmentId: value.assessmentId,
      headSha: value.headSha,
      result: value,
      idempotencyKey: `sha256:${"f".repeat(64)}`,
    }

    await expect(service.publishCurrent(input)).rejects.toThrow(
      "check update was not published"
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
    const value = result()
    let checked = false
    const service = new TargetedVerificationPublicationService(
      {
        appendCurrent: async () => ({ disposition: "superseded" }),
      },
      {
        publishCheck: async () => {
          checked = true
          return true
        },
      }
    )
    await expect(
      service.publishCurrent({
        assessmentId: value.assessmentId,
        headSha: value.headSha,
        result: value,
        idempotencyKey: `sha256:${"f".repeat(64)}`,
      })
    ).resolves.toBe("superseded")
    expect(checked).toBe(false)
  })
})
