import { describe, expect, it } from "vitest"

import { deploymentValidationResultSchema } from "@sentinel/contracts"

import {
  ApplicationExplorerVerificationExecutor,
  type ApplicationExplorerVerificationSession,
  type VerificationExecutionCache,
} from "./verification-executor.ts"
import {
  fixtureExplorerOutput,
  fixtureMissionEvidence,
  fixtureMissionPlan,
  fixtureValidation,
} from "./verification-test-fixtures.ts"

function harness(
  input: { readonly fail?: boolean; readonly closeFailures?: number } = {}
) {
  const calls: string[] = []
  let closeFailures = input.closeFailures ?? 0
  const values = new Map<string, ReturnType<typeof fixtureMissionEvidence>>()
  const session: ApplicationExplorerVerificationSession = {
    run: async (request) => {
      calls.push(`run:${request.entryUrl}`)
      expect(request.allowedOrigins).toEqual(["https://head.onrender.com"])
      if (input.fail) throw new Error("browser failed")
      const evidence = fixtureMissionEvidence({
        plan: request.plan,
        phase: request.phase,
      })
      return {
        explorer: fixtureExplorerOutput({ mission: request.plan.mission }),
        checkpointObservations: evidence.checkpointObservations,
        artifacts: evidence.artifacts,
        semanticFingerprint: evidence.semanticFingerprint,
        completedAt: evidence.completedAt,
      }
    },
    close: async ({ idempotencyKey }) => {
      calls.push(`close:${idempotencyKey}`)
      if (closeFailures > 0) {
        closeFailures -= 1
        throw new Error("browser close failed")
      }
    },
  }
  const cache: VerificationExecutionCache = {
    get: async (key) => values.get(key) ?? null,
    put: async (key, evidence) => {
      values.set(key, evidence)
      return evidence
    },
  }
  return {
    calls,
    executor: new ApplicationExplorerVerificationExecutor(session, cache),
  }
}

describe("ApplicationExplorerVerificationExecutor", () => {
  it("runs the bounded Application Explorer session and closes its browser context", async () => {
    const test = harness()
    const plan = fixtureMissionPlan()
    const evidence = await test.executor.execute({
      plan,
      deployment: fixtureValidation(),
      phase: "head",
      idempotencyKey: "execute-head",
    })

    expect(evidence.missionId).toBe(plan.mission.id)
    expect(test.calls).toEqual([
      "run:https://head.onrender.com/checkout",
      "close:execute-head",
    ])
  })

  it("replays cached evidence without opening another browser context", async () => {
    const test = harness()
    const request = {
      plan: fixtureMissionPlan(),
      deployment: fixtureValidation(),
      phase: "head" as const,
      idempotencyKey: "execute-head",
    }
    const first = await test.executor.execute(request)
    const second = await test.executor.execute(request)

    expect(second).toEqual(first)
    expect(test.calls.filter((call) => call.startsWith("run:"))).toHaveLength(1)
    expect(test.calls.filter((call) => call.startsWith("close:"))).toHaveLength(
      2
    )
  })

  it("retries cleanup after evidence was cached but browser close failed", async () => {
    const test = harness({ closeFailures: 1 })
    const request = {
      plan: fixtureMissionPlan(),
      deployment: fixtureValidation(),
      phase: "head" as const,
      idempotencyKey: "execute-close-retry",
    }

    await expect(test.executor.execute(request)).rejects.toThrow(
      "browser close failed"
    )
    await expect(test.executor.execute(request)).resolves.toMatchObject({
      missionId: request.plan.mission.id,
    })
    expect(test.calls.filter((call) => call.startsWith("run:"))).toHaveLength(1)
    expect(test.calls.filter((call) => call.startsWith("close:"))).toHaveLength(
      2
    )
  })

  it("closes the browser context when execution fails", async () => {
    const test = harness({ fail: true })
    await expect(
      test.executor.execute({
        plan: fixtureMissionPlan(),
        deployment: fixtureValidation(),
        phase: "head",
        idempotencyKey: "execute-failed",
      })
    ).rejects.toThrow("browser failed")
    expect(test.calls.at(-1)).toBe("close:execute-failed")
  })

  it("refuses untrusted deployments before opening a session", async () => {
    const test = harness()
    const trusted = fixtureValidation()
    const deployment = deploymentValidationResultSchema.parse({
      ...trusted,
      identityState: "mismatch",
      trustState: "untrusted",
      readinessState: "not_checked",
      browserAccessAllowed: false,
      credentialAccessAllowed: false,
      reason: "deployment_commit_mismatch",
      actionRequired: "Deploy the expected head",
      proof: undefined,
    })
    await expect(
      test.executor.execute({
        plan: fixtureMissionPlan(),
        deployment,
        phase: "head",
        idempotencyKey: "execute-denied",
      })
    ).rejects.toThrow("trusted ready deployment")
    expect(test.calls).toEqual([])
  })
})
