import {
  applicationExplorerMissionOutputSchema,
  deploymentValidationRequestSchema,
  deploymentValidationResultSchema,
  hashCanonical,
  targetedVerificationStartInputSchema,
  verificationMissionEvidenceSchema,
  verificationPlanSchema,
  verificationSetupReceiptSchema,
  type ApplicationExplorerMissionOutput,
  type DeploymentValidationResult,
  type TargetedVerificationStartInput,
  type VerificationCheckpoint,
  type VerificationCheckpointObservation,
  type VerificationMissionEvidence,
  type VerificationMissionPlan,
  type VerificationPlan,
  type VerificationSetupReceipt,
} from "@sentinel/contracts"

export const fixtureIds = {
  application: `application:v1:${"a".repeat(64)}`,
  run: "run:123e4567-e89b-42d3-a456-426614174000",
  assessment: "123e4567-e89b-42d3-a456-426614174001",
  pullRequest: `pull-request:v1:${"b".repeat(64)}`,
  mission: `mission:v1:${"c".repeat(64)}`,
  workflow: `workflow:v1:${"d".repeat(64)}`,
  headSha: "e".repeat(40),
  baseSha: "f".repeat(40),
  evidence: `evidence:v1:${"1".repeat(64)}`,
  screenshot: `artifact:v1:${"2".repeat(64)}`,
  trace: `artifact:v1:${"3".repeat(64)}`,
  timestamp: "2026-09-09T10:00:00.000Z",
} as const

export const fixtureBudget = {
  toolCalls: 40,
  contentBytes: 256_000,
  documentBytes: 0,
  documentPages: 0,
  documentSections: 0,
  sourceLines: 0,
  repositoryBytes: 0,
  repositoryFiles: 0,
  browserActions: 16,
  modelCalls: 3,
  modelInputTokens: 24_000,
  modelOutputTokens: 4_000,
  reconciliationRounds: 1,
  elapsedMs: 180_000,
}

export function fixtureCheckpoint(
  overrides: Partial<VerificationCheckpoint> = {}
): VerificationCheckpoint {
  return {
    id: `sha256:${"4".repeat(64)}` as never,
    kind: "transition",
    sourceEntityId: fixtureIds.workflow as never,
    operator: "changed",
    description: "Checkout advances to confirmation" as never,
    ...overrides,
  }
}

export function fixtureValidation(
  overrides: Partial<DeploymentValidationResult> = {}
): DeploymentValidationResult {
  return deploymentValidationResultSchema.parse({
    schemaVersion: 1,
    applicationId: fixtureIds.application,
    registrationId: `sha256:${"5".repeat(64)}`,
    purpose: "pr_head_verification",
    assessmentId: fixtureIds.assessment,
    pullRequestId: fixtureIds.pullRequest,
    expectedCommitSha: fixtureIds.headSha,
    identityState: "exact",
    trustState: "trusted",
    readinessState: "ready",
    browserAccessAllowed: true,
    credentialAccessAllowed: true,
    reason: "deployment_ready",
    proof: {
      schemaVersion: 1,
      provider: "render",
      serviceId: "srv-head",
      deployId: "dep-head",
      repository: {
        host: "github.com",
        owner: "hieventsdev",
        name: "hi.events",
      },
      commitSha: fixtureIds.headSha,
      publicUrl: "https://head.onrender.com",
      status: "live",
      observedAt: fixtureIds.timestamp,
    },
    validatedAt: fixtureIds.timestamp,
    ...overrides,
  })
}

export function fixtureMissionPlan(
  input: {
    readonly checkpoint?: VerificationCheckpoint
    readonly kind?: "affected" | "control"
    readonly missionId?: string
  } = {}
): VerificationMissionPlan {
  const checkpoint = input.checkpoint ?? fixtureCheckpoint()
  return {
    kind: input.kind ?? "affected",
    mission: {
      schemaVersion: 1,
      id: (input.missionId ?? fixtureIds.mission) as never,
      runId: fixtureIds.run as never,
      applicationId: fixtureIds.application as never,
      agent: "application",
      mode: "pr_change_validation",
      goal: "Verify the checkout behavior" as never,
      seedEvidenceIds: [],
      questions: ["Does checkout reach confirmation?" as never],
      scope: {
        repositoryPaths: [],
        sourceUris: [],
        allowedHosts: ["head.onrender.com"],
        allowedTools: [
          "observe_page",
          "perform_observed_action",
          "navigate_history",
          "finish_application_mission",
        ],
      },
      budget: fixtureBudget,
      successCriteria: [checkpoint.description],
    },
    findingIds:
      (input.kind ?? "affected") === "control"
        ? []
        : ([`sha256:${"6".repeat(64)}`] as never),
    scenarioIds:
      (input.kind ?? "affected") === "control"
        ? []
        : ([`sha256:${"7".repeat(64)}`] as never),
    targetIds: [fixtureIds.workflow] as never,
    priority: "high",
    entryPath: "/checkout",
    setup: {
      method: "none",
      classification: "outside_blast_radius",
      relatedEntityIds: [],
    },
    checkpoints: [checkpoint],
    exclusions: [],
  }
}

export function fixturePlan(
  input: {
    readonly missions?: VerificationMissionPlan[]
    readonly control?: VerificationMissionPlan
    readonly deployment?: DeploymentValidationResult
  } = {}
): VerificationPlan {
  const deployment = input.deployment ?? fixtureValidation()
  const missions = input.missions ?? [fixtureMissionPlan()]
  const draft = {
    schemaVersion: 1 as const,
    policyVersion: "verification-plan-policy-v1" as const,
    applicationId: fixtureIds.application,
    runId: fixtureIds.run,
    assessmentId: fixtureIds.assessment,
    blastRadiusResultId: `sha256:${"8".repeat(64)}`,
    status: "planned" as const,
    deployment,
    missions,
    ...(input.control === undefined ? {} : { control: input.control }),
    budget: fixtureBudget,
    exclusions: [],
    createdAt: fixtureIds.timestamp,
  }
  return verificationPlanSchema.parse({
    ...draft,
    id: hashCanonical(draft),
  })
}

function checkpointState(mission: VerificationMissionPlan["mission"]) {
  return {
    schemaVersion: 1,
    applicationId: mission.applicationId,
    missionId: mission.id,
    runId: mission.runId,
    currentObservationEvidenceId: fixtureIds.evidence,
    currentStateFingerprint: `sha256:${"9".repeat(64)}`,
    currentScreenId: `screen:v1:${"0".repeat(64)}`,
    path: [],
    frontier: [],
    visits: [],
    replayBoundary: {
      schemaVersion: 1,
      recipe: {
        schemaVersion: 1,
        applicationId: mission.applicationId,
        sourceRunId: mission.runId,
        entryUrl: "https://head.onrender.com/checkout",
        steps: [],
        createdAt: fixtureIds.timestamp,
      },
      replaySafePathLength: 0,
      checkpointPathLength: 0,
      requiresHumanReview: false,
    },
    budgetUsed: fixtureBudget,
    observedRuntimeRequestCount: 0,
    consecutiveNoProgress: 0,
    startedAt: fixtureIds.timestamp,
    updatedAt: fixtureIds.timestamp,
  }
}

export function fixtureExplorerOutput(
  input: {
    readonly mission?: VerificationMissionPlan["mission"]
    readonly blocked?: boolean
  } = {}
): ApplicationExplorerMissionOutput {
  const mission = input.mission ?? fixtureMissionPlan().mission
  const blocked = input.blocked ?? false
  const status = blocked ? "partial" : "complete"
  const reasonCode = blocked ? "dead_end" : "goal_completed"
  const summary = blocked
    ? "The safe action space ended before the checkpoint"
    : "The verification goal was observed"
  return applicationExplorerMissionOutputSchema.parse({
    schemaVersion: 1,
    result: {
      schemaVersion: 1,
      missionId: mission.id,
      status,
      claims: [],
      unresolved: [],
      exclusions: [],
      suggestedFollowups: [],
      stopReason: { code: reasonCode, summary },
      budgetUsed: fixtureBudget,
    },
    terminal: {
      schemaVersion: 1,
      classification: blocked ? "dead_end" : "goal_completed",
      status,
      reasonCode,
      summary,
    },
    checkpoint: checkpointState(mission),
    evidenceClaims: [],
    blockers: blocked
      ? [
          {
            schemaVersion: 1,
            kind: "dead_end",
            reasonCode,
            summary,
            recoverable: false,
            evidenceIds: [fixtureIds.evidence],
          },
        ]
      : [],
  })
}

export function fixtureMissionEvidence(
  input: {
    readonly plan?: VerificationMissionPlan
    readonly phase?: "baseline" | "head"
    readonly observations?: VerificationCheckpointObservation[]
    readonly semanticFingerprint?: string
    readonly blocked?: boolean
    readonly modelExplanation?: string
  } = {}
): VerificationMissionEvidence {
  const plan = input.plan ?? fixtureMissionPlan()
  return verificationMissionEvidenceSchema.parse({
    schemaVersion: 1,
    applicationId: fixtureIds.application,
    runId: fixtureIds.run,
    missionId: plan.mission.id,
    phase: input.phase ?? "head",
    explorer: fixtureExplorerOutput({
      mission: plan.mission,
      ...(input.blocked === undefined ? {} : { blocked: input.blocked }),
    }),
    checkpointObservations: input.observations ?? [
      {
        schemaVersion: 1,
        checkpointId: plan.checkpoints[0]!.id,
        kind: "transition",
        beforeFingerprint: `sha256:${"a".repeat(64)}`,
        afterFingerprint: `sha256:${"b".repeat(64)}`,
        changed: true,
        evidenceIds: [fixtureIds.evidence],
        observedAt: fixtureIds.timestamp,
      },
    ],
    artifacts: [
      {
        artifactId: fixtureIds.screenshot,
        kind: "screenshot",
        purpose: "report",
        capturedAt: fixtureIds.timestamp,
      },
      {
        artifactId: fixtureIds.trace,
        kind: "trace",
        purpose: "diagnostic",
        capturedAt: fixtureIds.timestamp,
      },
    ],
    semanticFingerprint:
      input.semanticFingerprint ?? `sha256:${"c".repeat(64)}`,
    ...(input.modelExplanation === undefined
      ? {}
      : { modelExplanation: input.modelExplanation }),
    completedAt: fixtureIds.timestamp,
  })
}

export function fixtureSetup(
  input: {
    readonly plan?: VerificationMissionPlan
    readonly status?: "not_required" | "prepared" | "failed"
  } = {}
): VerificationSetupReceipt {
  const plan = input.plan ?? fixtureMissionPlan()
  const status = input.status ?? "not_required"
  const draft = {
    schemaVersion: 1 as const,
    missionId: plan.mission.id,
    classification: plan.setup.classification,
    method: plan.setup.method,
    status,
    idempotencyKey: hashCanonical({
      missionId: plan.mission.id,
      kind: "setup",
    }),
    evidenceIds: status === "failed" ? [fixtureIds.evidence] : [],
    artifacts:
      status === "failed"
        ? [
            {
              artifactId: fixtureIds.screenshot,
              kind: "screenshot" as const,
              purpose: "diagnostic" as const,
              capturedAt: fixtureIds.timestamp,
            },
          ]
        : [],
    cleanupRequired: status === "prepared",
    reasonCode:
      status === "failed"
        ? "fixture_setup_failed"
        : status === "prepared"
          ? "fixture_setup_prepared"
          : "setup_not_required",
    summary:
      status === "failed"
        ? "Trusted fixture setup failed"
        : status === "prepared"
          ? "Trusted fixture setup completed"
          : "No external setup was required",
    preparedAt: fixtureIds.timestamp,
  }
  return verificationSetupReceiptSchema.parse({
    ...draft,
    id: hashCanonical(draft),
  })
}

export function fixtureStartInput(
  plan = fixturePlan()
): TargetedVerificationStartInput {
  const headValidation = deploymentValidationRequestSchema.parse({
    schemaVersion: 1,
    applicationId: fixtureIds.application,
    purpose: "pr_head_verification",
    assessmentId: fixtureIds.assessment,
    pullRequestId: fixtureIds.pullRequest,
    expectedRepository: {
      host: "github.com",
      owner: "hieventsdev",
      name: "hi.events",
    },
    expectedCommitSha: fixtureIds.headSha,
    expectedCompatibilityFingerprint: `sha256:${"d".repeat(64)}`,
    registration: {
      schemaVersion: 1,
      id: plan.deployment.registrationId,
      policyVersion: "deployment-identity-policy-v1",
      applicationId: fixtureIds.application,
      repository: {
        host: "github.com",
        owner: "hieventsdev",
        name: "hi.events",
      },
      role: "pr_head",
      commitSha: fixtureIds.headSha,
      publicUrl: "https://head.onrender.com",
      healthPath: "/health",
      provider: {
        kind: "render",
        serviceId: "srv-head",
        deployId: "dep-head",
      },
      compatibility: {
        fingerprint: `sha256:${"d".repeat(64)}`,
        authenticationRevision: 0,
        authenticationReferences: [],
        allowedOrigins: ["https://head.onrender.com"],
        policyFingerprint: `sha256:${"e".repeat(64)}`,
      },
      registeredAt: "2026-09-09T09:00:00.000Z",
      expiresAt: "2026-09-10T09:00:00.000Z",
      cleanupBy: "2026-09-10T10:00:00.000Z",
    },
  })
  return targetedVerificationStartInputSchema.parse({
    schemaVersion: 1,
    policyVersion: "targeted-verification-policy-v1",
    plan,
    headValidation,
    artifactPolicy: {
      successfulRetentionSeconds: 0,
      failureRetentionSeconds: 86_400,
      reportRetentionSeconds: 604_800,
    },
    totalBudget: {
      ...fixtureBudget,
      toolCalls: fixtureBudget.toolCalls * 3,
      contentBytes: fixtureBudget.contentBytes * 3,
      browserActions: fixtureBudget.browserActions * 3,
      modelCalls: fixtureBudget.modelCalls * 3,
      modelInputTokens: fixtureBudget.modelInputTokens * 3,
      modelOutputTokens: fixtureBudget.modelOutputTokens * 3,
      reconciliationRounds: fixtureBudget.reconciliationRounds * 3,
      elapsedMs: fixtureBudget.elapsedMs * 3,
    },
    startedAtMs: Date.parse(fixtureIds.timestamp),
  })
}
