import {
  deploymentValidationResultSchema,
  verificationMissionEvidenceSchema,
  verificationMissionPlanSchema,
  type ApplicationExplorerMissionOutput,
  type DeploymentValidationResult,
  type VerificationArtifactCandidate,
  type VerificationCheckpointObservation,
  type VerificationMissionEvidence,
  type VerificationMissionPlan,
} from "@sentinel/contracts"

import type { TargetedVerificationMissionPort } from "./targeted-verification.ts"

export interface ApplicationExplorerVerificationSession {
  run(
    input: {
      readonly plan: VerificationMissionPlan
      readonly phase: "baseline" | "head"
      readonly entryUrl: string
      readonly allowedOrigins: readonly string[]
      readonly maxBrowserActions: number
      readonly maxModelCalls: number
      readonly idempotencyKey: string
    },
    signal?: AbortSignal
  ): Promise<{
    readonly explorer: ApplicationExplorerMissionOutput
    readonly checkpointObservations: readonly VerificationCheckpointObservation[]
    readonly artifacts: readonly VerificationArtifactCandidate[]
    readonly semanticFingerprint: string
    readonly modelExplanation?: string
    readonly completedAt: string
  }>
  close(input: { readonly idempotencyKey: string }): Promise<void>
}

export interface VerificationExecutionCache {
  get(idempotencyKey: string): Promise<VerificationMissionEvidence | null>
  put(
    idempotencyKey: string,
    evidence: VerificationMissionEvidence
  ): Promise<VerificationMissionEvidence>
}

function trustedDeployment(value: DeploymentValidationResult) {
  const deployment = deploymentValidationResultSchema.parse(value)
  if (
    deployment.identityState !== "exact" ||
    deployment.trustState !== "trusted" ||
    deployment.readinessState !== "ready" ||
    !deployment.browserAccessAllowed ||
    !deployment.credentialAccessAllowed ||
    deployment.proof?.publicUrl === undefined
  ) {
    throw new Error("Verification executor requires a trusted ready deployment")
  }
  return deployment
}

function sameExecution(
  evidence: VerificationMissionEvidence,
  plan: VerificationMissionPlan,
  phase: "baseline" | "head"
): boolean {
  return (
    evidence.applicationId === plan.mission.applicationId &&
    evidence.runId === plan.mission.runId &&
    evidence.missionId === plan.mission.id &&
    evidence.phase === phase
  )
}

export class ApplicationExplorerVerificationExecutor implements TargetedVerificationMissionPort {
  constructor(
    private readonly session: ApplicationExplorerVerificationSession,
    private readonly cache: VerificationExecutionCache
  ) {}

  async execute(
    input: {
      readonly plan: VerificationMissionPlan
      readonly deployment: DeploymentValidationResult
      readonly phase: "baseline" | "head"
      readonly idempotencyKey: string
    },
    signal?: AbortSignal
  ): Promise<VerificationMissionEvidence> {
    const plan = verificationMissionPlanSchema.parse(input.plan)
    const deployment = trustedDeployment(input.deployment)
    if (deployment.applicationId !== plan.mission.applicationId) {
      throw new Error("Verification deployment crosses the mission application")
    }
    const cached = await this.cache.get(input.idempotencyKey)
    if (cached !== null) {
      const evidence = verificationMissionEvidenceSchema.parse(cached)
      if (!sameExecution(evidence, plan, input.phase)) {
        throw new Error(
          "Verification execution cache contains a conflicting mission"
        )
      }
      return evidence
    }

    const publicUrl = new URL(deployment.proof!.publicUrl!)
    const entryUrl = new URL(plan.entryPath, publicUrl).toString()
    try {
      const result = await this.session.run(
        {
          plan,
          phase: input.phase,
          entryUrl,
          allowedOrigins: [publicUrl.origin],
          maxBrowserActions: plan.mission.budget.browserActions,
          maxModelCalls: plan.mission.budget.modelCalls,
          idempotencyKey: input.idempotencyKey,
        },
        signal
      )
      const evidence = verificationMissionEvidenceSchema.parse({
        schemaVersion: 1,
        applicationId: plan.mission.applicationId,
        runId: plan.mission.runId,
        missionId: plan.mission.id,
        phase: input.phase,
        explorer: result.explorer,
        checkpointObservations: result.checkpointObservations,
        artifacts: result.artifacts,
        semanticFingerprint: result.semanticFingerprint,
        ...(result.modelExplanation === undefined
          ? {}
          : { modelExplanation: result.modelExplanation }),
        completedAt: result.completedAt,
      })
      const stored = verificationMissionEvidenceSchema.parse(
        await this.cache.put(input.idempotencyKey, evidence)
      )
      if (!sameExecution(stored, plan, input.phase)) {
        throw new Error(
          "Verification execution cache changed the mission identity"
        )
      }
      return stored
    } finally {
      await this.session.close({ idempotencyKey: input.idempotencyKey })
    }
  }
}
