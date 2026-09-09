import { describe, expect, it } from "vitest"

import {
  applicationExplorerMissionOutputSchema,
  deploymentValidationResultSchema,
  verificationMissionEvidenceSchema,
  verificationMissionPlanSchema,
  verificationSetupReceiptSchema,
  type VerificationCheckpoint,
  type VerificationCheckpointObservation,
} from "@sentinel/contracts"

import {
  buildBlockedSetupVerificationMission,
  buildTargetedVerificationResult,
  evaluateVerificationCheckpoint,
  evaluateVerificationMission,
} from "./verification-evaluator.ts"
import {
  fixtureBudget,
  fixtureCheckpoint,
  fixtureIds,
  fixtureMissionEvidence,
  fixtureMissionPlan,
  fixturePlan,
  fixtureSetup,
  fixtureValidation,
} from "./verification-test-fixtures.ts"

const artifactPolicy = {
  successfulRetentionSeconds: 0,
  failureRetentionSeconds: 86_400,
  reportRetentionSeconds: 604_800,
}

function booleanObservation(input: {
  readonly checkpoint: VerificationCheckpoint
  readonly value: boolean
}): VerificationCheckpointObservation {
  const common = {
    schemaVersion: 1 as const,
    checkpointId: input.checkpoint.id,
    evidenceIds: [fixtureIds.evidence] as never,
    observedAt: fixtureIds.timestamp,
  }
  switch (input.checkpoint.kind) {
    case "reachability":
      return {
        ...common,
        kind: "reachability",
        reachable: input.value,
        normalizedRoute: "/checkout",
      }
    case "visible":
      return { ...common, kind: "visible", visible: input.value }
    case "enabled":
      return { ...common, kind: "enabled", enabled: input.value }
    case "transition":
      return {
        ...common,
        kind: "transition",
        beforeFingerprint: `sha256:${"a".repeat(64)}` as never,
        afterFingerprint:
          `sha256:${(input.value ? "b" : "a").repeat(64)}` as never,
        changed: input.value,
      }
    case "error_absence":
      return {
        ...common,
        kind: "error_absence",
        errors: input.value
          ? []
          : [
              {
                kind: "page",
                message: "Checkout crashed" as never,
                observedAt: fixtureIds.timestamp,
              },
            ],
      }
    default:
      throw new Error("Boolean observation fixture does not support this kind")
  }
}

describe("deterministic checkpoint catalog", () => {
  it.each([
    ["reachability", "present", true],
    ["visible", "present", true],
    ["enabled", "equals", true],
    ["transition", "changed", true],
    ["error_absence", "absent", true],
  ] as const)(
    "evaluates %s without model authority",
    (kind, operator, value) => {
      const checkpoint = fixtureCheckpoint({
        kind,
        operator,
        ...(operator === "equals" ? { expected: true } : {}),
      })
      const assertion = evaluateVerificationCheckpoint({
        checkpoint,
        observation: booleanObservation({ checkpoint, value }),
        now: new Date(fixtureIds.timestamp),
      })
      expect(assertion.outcome).toBe("passed")
    }
  )

  it("evaluates exact request method, path, and HTTP status", () => {
    const checkpoint = fixtureCheckpoint({
      kind: "request_status",
      operator: "status_in",
      request: {
        method: "POST",
        normalizedPath: "/api/orders",
        statuses: [200, 201],
      },
    })
    const assertion = evaluateVerificationCheckpoint({
      checkpoint,
      observation: {
        schemaVersion: 1,
        checkpointId: checkpoint.id,
        kind: "request_status",
        evidenceIds: [fixtureIds.evidence] as never,
        requests: [
          {
            requestId: `sha256:${"5".repeat(64)}` as never,
            method: "POST",
            normalizedPath: "/api/orders",
            resourceType: "fetch",
            status: 500,
            outcome: "response",
            startedAt: fixtureIds.timestamp,
            completedAt: fixtureIds.timestamp,
            durationMs: 10,
          },
        ],
        observedAt: fixtureIds.timestamp,
      },
      now: new Date(fixtureIds.timestamp),
    })
    expect(assertion).toMatchObject({
      outcome: "failed",
      reasonCode: "request_status_not_observed",
    })
  })

  it("blocks incompatible or missing observations instead of guessing", () => {
    const checkpoint = fixtureCheckpoint({
      kind: "visible",
      operator: "matches",
      expected: "Continue" as never,
    })
    expect(evaluateVerificationCheckpoint({ checkpoint }).outcome).toBe(
      "blocked"
    )
    expect(
      evaluateVerificationCheckpoint({
        checkpoint,
        observation: booleanObservation({ checkpoint, value: true }),
      }).reasonCode
    ).toBe("checkpoint_operator_invalid")
  })
})

describe("mission verdicts", () => {
  it("passes preserved behavior and discards only successful diagnostic artifacts", () => {
    const plan = fixtureMissionPlan()
    const head = fixtureMissionEvidence({ plan })
    const baseline = fixtureMissionEvidence({ plan, phase: "baseline" })
    const result = evaluateVerificationMission({
      plan,
      setup: fixtureSetup({ plan }),
      head,
      baseline,
      artifactPolicy,
      now: new Date(fixtureIds.timestamp),
    })

    expect(result).toMatchObject({
      status: "passed",
      failureCategory: "none",
      comparison: { status: "preserved" },
    })
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        artifactId: fixtureIds.screenshot,
        disposition: "retain",
        reason: "report_evidence",
      }),
      expect.objectContaining({
        artifactId: fixtureIds.trace,
        disposition: "delete",
        reason: "successful_run",
      }),
    ])
  })

  it("treats label-only agent adaptation as preserved when semantic evidence is unchanged", () => {
    const plan = fixtureMissionPlan()
    const baseline = fixtureMissionEvidence({
      plan,
      phase: "baseline",
      modelExplanation: "The button label was Continue",
    })
    const head = fixtureMissionEvidence({
      plan,
      modelExplanation: "The agent adapted to a Next step label",
    })
    const result = evaluateVerificationMission({
      plan,
      setup: fixtureSetup({ plan }),
      baseline,
      head,
      artifactPolicy,
    })
    expect(result.status).toBe("passed")
    expect(result.modelExplanation).toContain("adapted")
  })

  it("reports a real head regression even when the model calls it safe", () => {
    const plan = fixtureMissionPlan()
    const failedObservation = booleanObservation({
      checkpoint: plan.checkpoints[0]!,
      value: false,
    })
    const result = evaluateVerificationMission({
      plan,
      setup: fixtureSetup({ plan }),
      baseline: fixtureMissionEvidence({ plan, phase: "baseline" }),
      head: fixtureMissionEvidence({
        plan,
        observations: [failedObservation],
        modelExplanation: "Everything appears safe",
      }),
      artifactPolicy,
    })

    expect(result).toMatchObject({
      status: "failed",
      failureCategory: "product_regression",
    })
    expect(
      result.artifacts.every(({ disposition }) => disposition === "retain")
    ).toBe(true)
  })

  it("classifies an API error from baseline/head request evidence", () => {
    const checkpoint = fixtureCheckpoint({
      kind: "request_status",
      operator: "status_in",
      request: {
        method: "POST",
        normalizedPath: "/api/orders",
        statuses: [200, 201],
      },
    })
    const plan = fixtureMissionPlan({ checkpoint })
    const requestObservation = (status: number) => ({
      schemaVersion: 1 as const,
      checkpointId: checkpoint.id,
      kind: "request_status" as const,
      evidenceIds: [fixtureIds.evidence] as never,
      requests: [
        {
          requestId: `sha256:${String(status)[0]!.repeat(64)}` as never,
          method: "POST" as const,
          normalizedPath: "/api/orders",
          resourceType: "fetch",
          status,
          outcome: "response" as const,
          startedAt: fixtureIds.timestamp,
          completedAt: fixtureIds.timestamp,
          durationMs: 10,
        },
      ],
      observedAt: fixtureIds.timestamp,
    })
    const result = evaluateVerificationMission({
      plan,
      setup: fixtureSetup({ plan }),
      baseline: fixtureMissionEvidence({
        plan,
        phase: "baseline",
        observations: [requestObservation(201)],
      }),
      head: fixtureMissionEvidence({
        plan,
        observations: [requestObservation(500)],
      }),
      artifactPolicy,
    })
    expect(result).toMatchObject({
      status: "failed",
      failureCategory: "product_regression",
      assertions: [{ reasonCode: "request_status_not_observed" }],
    })
  })

  it("classifies a deterministically denied action as a policy block", () => {
    const plan = fixtureMissionPlan()
    const evidence = fixtureMissionEvidence({ plan })
    const summary = "A destructive action was denied by browser policy"
    const explorer = applicationExplorerMissionOutputSchema.parse({
      ...evidence.explorer,
      result: {
        ...evidence.explorer.result,
        status: "needs_human",
        stopReason: { code: "unsafe_action_denied", summary },
      },
      terminal: {
        schemaVersion: 1,
        classification: "unsafe_boundary",
        status: "needs_human",
        reasonCode: "unsafe_action_denied",
        summary,
      },
      blockers: [
        {
          schemaVersion: 1,
          kind: "unsafe_action",
          reasonCode: "unsafe_action_denied",
          summary,
          recoverable: false,
          evidenceIds: [fixtureIds.evidence],
        },
      ],
    })
    const blockedEvidence = verificationMissionEvidenceSchema.parse({
      ...evidence,
      explorer,
    })
    const result = evaluateVerificationMission({
      plan,
      setup: fixtureSetup({ plan }),
      head: blockedEvidence,
      artifactPolicy,
    })
    expect(result).toMatchObject({
      status: "blocked",
      failureCategory: "policy_block",
    })
  })

  it("does not blame the PR when the same checkpoint fails on baseline", () => {
    const plan = fixtureMissionPlan()
    const failed = booleanObservation({
      checkpoint: plan.checkpoints[0]!,
      value: false,
    })
    const result = evaluateVerificationMission({
      plan,
      setup: fixtureSetup({ plan }),
      baseline: fixtureMissionEvidence({
        plan,
        phase: "baseline",
        observations: [failed],
      }),
      head: fixtureMissionEvidence({ plan, observations: [failed] }),
      artifactPolicy,
    })
    expect(result).toMatchObject({
      status: "blocked",
      failureCategory: "environment_instability",
    })
  })

  it("separates trusted outside-impact setup failure from product regression", () => {
    const original = fixtureMissionPlan()
    const plan = verificationMissionPlanSchema.parse({
      ...original,
      setup: {
        method: "trusted_fixture_api",
        classification: "outside_blast_radius",
        reference: "Create an isolated event",
        relatedEntityIds: [],
        cleanupReference: "Delete the isolated event",
      },
    })
    const draft = fixtureSetup({ plan, status: "failed" })
    const setup = verificationSetupReceiptSchema.parse({
      ...draft,
      method: "trusted_fixture_api",
    })
    const result = buildBlockedSetupVerificationMission({
      plan,
      setup,
      artifactPolicy,
    })
    expect(result).toMatchObject({
      status: "blocked",
      failureCategory: "setup_failure",
      assertions: [],
    })
  })

  it("marks deterministic but acceptance-preserving semantic differences as behavior changed", () => {
    const plan = fixtureMissionPlan()
    const result = evaluateVerificationMission({
      plan,
      setup: fixtureSetup({ plan }),
      baseline: fixtureMissionEvidence({
        plan,
        phase: "baseline",
        semanticFingerprint: `sha256:${"d".repeat(64)}`,
      }),
      head: fixtureMissionEvidence({
        plan,
        semanticFingerprint: `sha256:${"e".repeat(64)}`,
      }),
      artifactPolicy,
    })
    expect(result.status).toBe("behavior_changed")
  })
})

describe("aggregate verdict precedence", () => {
  it("lets a failed control block PR attribution without erasing predicted findings", () => {
    const affectedPlan = fixtureMissionPlan()
    const controlPlan = fixtureMissionPlan({
      kind: "control",
      missionId: `mission:v1:${"f".repeat(64)}`,
    })
    const plan = fixturePlan({ missions: [affectedPlan], control: controlPlan })
    const affected = evaluateVerificationMission({
      plan: affectedPlan,
      setup: fixtureSetup({ plan: affectedPlan }),
      head: fixtureMissionEvidence({ plan: affectedPlan }),
      artifactPolicy,
    })
    const failedControl = evaluateVerificationMission({
      plan: controlPlan,
      setup: fixtureSetup({ plan: controlPlan }),
      head: fixtureMissionEvidence({
        plan: controlPlan,
        observations: [
          booleanObservation({
            checkpoint: controlPlan.checkpoints[0]!,
            value: false,
          }),
        ],
      }),
      artifactPolicy,
    })
    const result = buildTargetedVerificationResult({
      plan,
      headValidation: fixtureValidation(),
      missionResults: [affected],
      controlResult: failedControl,
      budgetUsed: fixtureBudget,
    })

    expect(result.status).toBe("blocked")
    expect(result.predictedFindingIds).toEqual(affectedPlan.findingIds)
  })

  it("returns verification_unavailable without executed claims for a stale head", () => {
    const plan = fixturePlan()
    const unavailable = deploymentValidationResultSchema.parse({
      schemaVersion: 1,
      applicationId: fixtureIds.application,
      registrationId: plan.deployment.registrationId,
      purpose: "pr_head_verification",
      assessmentId: fixtureIds.assessment,
      pullRequestId: fixtureIds.pullRequest,
      expectedCommitSha: fixtureIds.headSha,
      identityState: "mismatch",
      trustState: "untrusted",
      readinessState: "not_checked",
      browserAccessAllowed: false,
      credentialAccessAllowed: false,
      reason: "deployment_commit_mismatch",
      actionRequired: "Deploy the expected head",
      validatedAt: fixtureIds.timestamp,
    })
    const result = buildTargetedVerificationResult({
      plan,
      headValidation: unavailable,
      missionResults: [],
      budgetUsed: fixtureBudget,
    })
    expect(result).toMatchObject({
      status: "verification_unavailable",
      missionResults: [],
      predictedFindingIds: plan.missions[0]!.findingIds,
    })
  })
})
