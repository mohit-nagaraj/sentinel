import { MemorySaver } from "@langchain/langgraph"
import { describe, expect, it } from "vitest"

import {
  deploymentValidationRequestSchema,
  deploymentValidationResultSchema,
  createTargetedVerificationInputId,
  hashCanonical,
  targetedVerificationResultSchema,
  targetedVerificationStartInputSchema,
  verificationGapFollowupSchema,
  verificationMissionEvidenceSchema,
  verificationMissionPlanSchema,
  verificationMissionResultSchema,
  verificationSetupReceiptSchema,
  type DeploymentValidationRequest,
  type DeploymentValidationResult,
  type TargetedVerificationResult,
  type VerificationGapFollowup,
  type VerificationMissionEvidence,
  type VerificationMissionPlan,
  type VerificationMissionResult,
  type VerificationSetupReceipt,
} from "@sentinel/contracts"

import { InMemoryResumeCoordinator } from "./resume-coordinator.ts"
import {
  createTargetedVerificationCompiledRunGraph,
  createTargetedVerification,
  type TargetedVerificationDependencies,
  type TargetedVerificationStore,
} from "./targeted-verification.ts"
import {
  fixtureIds,
  fixtureMissionEvidence,
  fixtureMissionPlan,
  fixturePlan,
  fixtureSetup,
  fixtureStartInput,
  fixtureValidation,
} from "./verification-test-fixtures.ts"

class MemoryVerificationStore implements TargetedVerificationStore {
  readonly inputs = new Map<string, ReturnType<typeof fixtureStartInput>>()
  readonly validations = new Map<string, DeploymentValidationResult>()
  readonly setups = new Map<string, VerificationSetupReceipt>()
  readonly evidence = new Map<string, VerificationMissionEvidence>()
  readonly missionResults = new Map<string, VerificationMissionResult>()
  readonly results = new Map<string, TargetedVerificationResult>()

  async saveInput(value: ReturnType<typeof fixtureStartInput>) {
    const id = createTargetedVerificationInputId(value)
    this.set(this.inputs, id, value)
    return id
  }

  async loadInput(id: string) {
    const value = this.inputs.get(id)
    if (value === undefined) throw new Error("input missing")
    return value
  }

  async saveValidation(value: DeploymentValidationResult) {
    const parsed = deploymentValidationResultSchema.parse(value)
    const id = hashCanonical({
      kind: "fixture-deployment-validation",
      parsed,
    })
    this.set(this.validations, id, parsed)
    return id
  }

  async loadValidation(id: string) {
    const value = this.validations.get(id)
    if (value === undefined) throw new Error("validation missing")
    return value
  }

  async saveSetup(value: VerificationSetupReceipt) {
    const parsed = verificationSetupReceiptSchema.parse(value)
    this.set(this.setups, parsed.id, parsed)
    return parsed.id
  }

  async loadSetup(id: string) {
    const value = this.setups.get(id)
    if (value === undefined) throw new Error("setup missing")
    return value
  }

  async saveEvidence(value: VerificationMissionEvidence) {
    const parsed = verificationMissionEvidenceSchema.parse(value)
    const id = hashCanonical({ kind: "fixture-verification-evidence", parsed })
    this.set(this.evidence, id, parsed)
    return id
  }

  async loadEvidence(id: string) {
    const value = this.evidence.get(id)
    if (value === undefined) throw new Error("evidence missing")
    return value
  }

  async saveMissionResult(value: VerificationMissionResult) {
    const parsed = verificationMissionResultSchema.parse(value)
    this.set(this.missionResults, parsed.id, parsed)
    return parsed.id
  }

  async loadMissionResults(ids: readonly string[]) {
    return ids.map((id) => {
      const value = this.missionResults.get(id)
      if (value === undefined) throw new Error("mission result missing")
      return value
    })
  }

  async saveResult(value: TargetedVerificationResult) {
    const parsed = targetedVerificationResultSchema.parse(value)
    this.set(this.results, parsed.id, parsed)
    return parsed.id
  }

  async loadResult(id: string) {
    const value = this.results.get(id)
    if (value === undefined) throw new Error("result missing")
    return value
  }

  private set<T>(map: Map<string, T>, id: string, value: T) {
    const existing = map.get(id)
    if (
      existing !== undefined &&
      hashCanonical(existing) !== hashCanonical(value)
    ) {
      throw new Error("fixture store conflict")
    }
    map.set(id, value)
  }
}

function unavailableValidation(
  request: DeploymentValidationRequest
): DeploymentValidationResult {
  return deploymentValidationResultSchema.parse({
    schemaVersion: 1,
    applicationId: request.applicationId,
    registrationId: request.registration.id,
    purpose: request.purpose,
    ...(request.assessmentId === undefined
      ? {}
      : { assessmentId: request.assessmentId }),
    ...(request.pullRequestId === undefined
      ? {}
      : { pullRequestId: request.pullRequestId }),
    expectedCommitSha: request.expectedCommitSha,
    identityState: "mismatch",
    trustState: "untrusted",
    readinessState: "not_checked",
    browserAccessAllowed: false,
    credentialAccessAllowed: false,
    reason: "deployment_commit_mismatch",
    actionRequired: "Deploy the expected head",
    validatedAt: fixtureIds.timestamp,
  })
}

function baselinePair() {
  const head = fixtureStartInput().headValidation
  const request = deploymentValidationRequestSchema.parse({
    schemaVersion: 1,
    applicationId: head.applicationId,
    purpose: "baseline_observation",
    expectedRepository: head.expectedRepository,
    expectedCommitSha: fixtureIds.baseSha,
    expectedCompatibilityFingerprint: head.expectedCompatibilityFingerprint,
    registration: {
      ...head.registration,
      id: `sha256:${"0".repeat(64)}`,
      role: "baseline",
      commitSha: fixtureIds.baseSha,
      publicUrl: "https://baseline.onrender.com",
      provider: {
        kind: "render",
        serviceId: "srv-baseline",
        deployId: "dep-baseline",
      },
      compatibility: {
        ...head.registration.compatibility,
        allowedOrigins: ["https://baseline.onrender.com"],
      },
    },
  })
  const validation = deploymentValidationResultSchema.parse({
    schemaVersion: 1,
    applicationId: request.applicationId,
    registrationId: request.registration.id,
    purpose: "baseline_observation",
    expectedCommitSha: request.expectedCommitSha,
    identityState: "exact",
    trustState: "trusted",
    readinessState: "ready",
    browserAccessAllowed: true,
    credentialAccessAllowed: true,
    reason: "deployment_ready",
    proof: {
      schemaVersion: 1,
      provider: "render",
      serviceId: request.registration.provider.serviceId,
      deployId: request.registration.provider.deployId,
      repository: request.expectedRepository,
      commitSha: request.expectedCommitSha,
      publicUrl: request.registration.publicUrl,
      status: "live",
      observedAt: fixtureIds.timestamp,
    },
    validatedAt: fixtureIds.timestamp,
  })
  return { request, validation }
}

function harness(
  input: {
    readonly setupStatus?: "not_required" | "prepared" | "failed"
    readonly headValidations?: DeploymentValidationResult[]
    readonly missionEvidence?: (
      plan: VerificationMissionPlan,
      phase: "baseline" | "head"
    ) => VerificationMissionEvidence
    readonly followup?: VerificationGapFollowup
    readonly current?: boolean[]
    readonly publication?: "published" | "existing" | "superseded"
  } = {}
) {
  const store = new MemoryVerificationStore()
  const calls: string[] = []
  const validations = [...(input.headValidations ?? [])]
  const current = [...(input.current ?? [])]
  const published: TargetedVerificationResult[] = []
  const applied: string[][] = []
  const dependencies: TargetedVerificationDependencies = {
    owner: "verification-test",
    control: {
      assertActive: async () => {
        calls.push("active")
      },
    },
    events: { append: async () => undefined },
    effects: { execute: async () => undefined },
    resumeAuthorization: { authorize: async () => true },
    resumeCoordinator: new InMemoryResumeCoordinator(),
    store,
    currentHead: {
      isCurrent: async () => {
        calls.push("current")
        return current.shift() ?? true
      },
    },
    identity: {
      validate: async (request) => {
        calls.push(`identity:${request.purpose}`)
        if (request.purpose === "baseline_observation") {
          return baselinePair().validation
        }
        return validations.shift() ?? fixtureValidation()
      },
    },
    setup: {
      prepare: async ({ deployments, plan }) => {
        calls.push(
          `setup:${deployments.baseline === undefined ? "head" : "pair"}:${plan.mission.id}`
        )
        return fixtureSetup({
          plan,
          status: input.setupStatus ?? "prepared",
        })
      },
      cleanup: async ({ receipt }) => {
        calls.push(`cleanup:${receipt.missionId}`)
      },
    },
    mission: {
      execute: async ({ phase, plan }) => {
        calls.push(`mission:${phase}:${plan.mission.id}`)
        return (
          input.missionEvidence?.(plan, phase) ??
          fixtureMissionEvidence({ plan, phase })
        )
      },
    },
    curator: {
      proposeFollowup: async () => {
        calls.push("curator")
        return input.followup ?? null
      },
    },
    artifacts: {
      apply: async ({ decisions }) => {
        applied.push(decisions.map(({ artifactId }) => artifactId))
      },
    },
    publisher: {
      publishCurrent: async ({ result }) => {
        calls.push("publish")
        published.push(result)
        return input.publication ?? "published"
      },
    },
    now: () => new Date(fixtureIds.timestamp),
  }
  const service = createTargetedVerification({
    dependencies,
    checkpointer: new MemorySaver(),
  }).service
  return { applied, calls, published, service, store }
}

describe("verifyPullRequestGraph", () => {
  it("revalidates immediately before browser execution and publishes a deterministic pass", async () => {
    const test = harness()
    const result = await test.service.start(fixtureStartInput())

    expect(result.result).toMatchObject({
      status: "passed",
      predictedFindingIds: fixturePlan().missions[0]!.findingIds,
    })
    const missionIndex = test.calls.findIndex((value) =>
      value.startsWith("mission:head")
    )
    expect(test.calls[missionIndex - 1]).toBe("current")
    expect(test.calls[missionIndex - 2]).toBe("identity:pr_head_verification")
    expect(test.published).toHaveLength(1)
    expect(test.applied).toHaveLength(1)
  })

  it("stops before browser execution when the immediate head proof changes", async () => {
    const start = fixtureStartInput()
    const test = harness({
      headValidations: [
        fixtureValidation(),
        unavailableValidation(start.headValidation),
      ],
    })
    const result = await test.service.start(start)

    expect(result.result.status).toBe("verification_unavailable")
    expect(test.calls.some((value) => value.startsWith("mission:"))).toBe(false)
    expect(result.result.missionResults).toEqual([])
  })

  it("categorizes trusted fixture setup failure without running the agent", async () => {
    const original = fixtureMissionPlan()
    const mission = verificationMissionPlanSchema.parse({
      ...original,
      setup: {
        method: "trusted_fixture_api",
        classification: "outside_blast_radius",
        reference: "Create event fixture",
        relatedEntityIds: [],
        cleanupReference: "Delete event fixture",
      },
    })
    const test = harness({ setupStatus: "failed" })
    const result = await test.service.start(
      fixtureStartInput(fixturePlan({ missions: [mission] }))
    )

    expect(result.result).toMatchObject({
      status: "blocked",
      missionResults: [{ status: "blocked", failureCategory: "setup_failure" }],
    })
    expect(test.calls.some((value) => value.startsWith("mission:"))).toBe(false)
  })

  it("prepares and cleans both validated environments around baseline/head execution", async () => {
    const original = fixtureMissionPlan()
    const mission = verificationMissionPlanSchema.parse({
      ...original,
      setup: {
        method: "trusted_fixture_api",
        classification: "outside_blast_radius",
        reference: "Create matching isolated events",
        relatedEntityIds: [],
        cleanupReference: "Delete both isolated events",
      },
    })
    const plan = fixturePlan({ missions: [mission] })
    const baseline = baselinePair()
    const start = targetedVerificationStartInputSchema.parse({
      ...fixtureStartInput(plan),
      baselineValidation: baseline.request,
    })
    const test = harness()
    const result = await test.service.start(start)

    expect(result.result.missionResults[0]).toMatchObject({
      status: "passed",
      comparison: { status: "preserved" },
    })
    expect(
      test.calls.filter(
        (value) => value.startsWith("mission:") || value.startsWith("setup:")
      )
    ).toEqual([
      `setup:pair:${mission.mission.id}`,
      `mission:baseline:${mission.mission.id}`,
      `mission:head:${mission.mission.id}`,
    ])
    expect(test.calls).toContain(`cleanup:${mission.mission.id}`)
  })

  it("uses a failed control to block environment attribution", async () => {
    const affected = fixtureMissionPlan()
    const control = fixtureMissionPlan({
      kind: "control",
      missionId: `mission:v1:${"f".repeat(64)}`,
    })
    const test = harness({
      missionEvidence: (plan, phase) =>
        plan.kind === "control"
          ? fixtureMissionEvidence({ plan, phase, observations: [] })
          : fixtureMissionEvidence({ plan, phase }),
    })
    const result = await test.service.start(
      fixtureStartInput(fixturePlan({ missions: [affected], control }))
    )

    expect(result.result.status).toBe("blocked")
    expect(result.result.controlResult).toMatchObject({
      status: "blocked",
      failureCategory: "environment_instability",
    })
    expect(result.result.predictedFindingIds).toEqual(affected.findingIds)
  })

  it("does not claim a pass when another affected mission was not run", async () => {
    const first = fixtureMissionPlan()
    const second = verificationMissionPlanSchema.parse({
      ...first,
      mission: {
        ...first.mission,
        id: `mission:v1:${"2".repeat(64)}`,
        goal: "Verify another impacted checkout checkpoint",
      },
      findingIds: [`sha256:${"3".repeat(64)}`],
      scenarioIds: [`sha256:${"4".repeat(64)}`],
    })
    const plan = fixturePlan({ missions: [first, second] })
    const start = targetedVerificationStartInputSchema.parse({
      ...fixtureStartInput(plan),
      totalBudget: first.mission.budget,
    })
    const test = harness()
    const result = await test.service.start(start)

    expect(result.result.status).toBe("blocked")
    expect(
      Object.fromEntries(
        result.result.missionResults.map(({ missionId, status }) => [
          missionId,
          status,
        ])
      )
    ).toEqual({
      [first.mission.id]: "passed",
      [second.mission.id]: "not_run",
    })
    expect(result.result.predictedFindingIds).toEqual(
      [...first.findingIds, ...second.findingIds].sort()
    )
  })

  it("allows only one named, in-budget evidence-gap follow-up", async () => {
    const first = fixtureMissionPlan()
    const followupMission = verificationMissionPlanSchema.parse({
      ...first,
      mission: {
        ...first.mission,
        id: `mission:v1:${"9".repeat(64)}`,
        goal: "Resolve the named transition evidence gap",
      },
    })
    const followup = verificationGapFollowupSchema.parse({
      schemaVersion: 1,
      id: `sha256:${"a".repeat(64)}`,
      round: 1,
      gapCheckpointIds: [first.checkpoints[0]!.id],
      mission: followupMission,
      reason: "The initial mission did not observe the planned transition",
    })
    const test = harness({
      followup,
      missionEvidence: (plan, phase) =>
        plan.mission.id === first.mission.id
          ? fixtureMissionEvidence({ plan, phase, observations: [] })
          : fixtureMissionEvidence({ plan, phase }),
    })
    const result = await test.service.start(fixtureStartInput())

    expect(result.result.followup?.id).toBe(followup.id)
    expect(result.result.status).toBe("passed")
    expect(result.result.missionResults).toEqual([
      expect.objectContaining({ status: "blocked", kind: "affected" }),
      expect.objectContaining({ status: "passed", kind: "followup" }),
    ])
    expect(
      test.calls.filter((value) => value.startsWith("mission:head"))
    ).toHaveLength(2)
    expect(test.calls.filter((value) => value === "curator")).toHaveLength(1)
  })

  it("cancels a head race before the browser and never publishes", async () => {
    const test = harness({ current: [true, false] })

    await expect(test.service.start(fixtureStartInput())).rejects.toMatchObject(
      {
        name: "CancelledOrchestrationError",
      }
    )
    expect(test.calls.some((value) => value.startsWith("mission:"))).toBe(false)
    expect(test.published).toHaveLength(0)
  })

  it("replays a completed checkpoint without duplicating external effects", async () => {
    const test = harness()
    const input = fixtureStartInput()
    const first = await test.service.start(input)
    const before = [...test.calls]
    const second = await test.service.start(input)

    expect(second.result.id).toBe(first.result.id)
    expect(test.calls).toEqual(before)
    expect(test.published).toHaveLength(1)
  })

  it("adapts verify_pr run commands to the compiled run-graph contract", async () => {
    const test = harness()
    const resolved = fixtureStartInput()
    const compiled = createTargetedVerificationCompiledRunGraph({
      service: test.service,
      resolver: { resolve: async () => resolved },
    })
    const signal = new AbortController().signal
    const result = await compiled.start(
      {
        runId: "123e4567-e89b-42d3-a456-426614174000",
        applicationId: "123e4567-e89b-42d3-a456-426614174010",
        budget: resolved.totalBudget,
        payload: { assessmentId: fixtureIds.assessment },
        configurationFingerprint: `sha256:${"d".repeat(64)}`,
      },
      {
        signal,
        assertActive: async () => undefined,
        registerCleanup: () => undefined,
      }
    )
    expect(result).toEqual({
      status: "succeeded",
      publication: {
        kind: "verification",
        assessmentId: fixtureIds.assessment,
      },
    })
  })
})
