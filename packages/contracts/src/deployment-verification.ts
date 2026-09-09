import { z } from "zod"

import {
  blastRadiusResultSchema,
  blastRadiusScenarioSchema,
} from "./blast-radius.ts"
import { riskSchema } from "./assessment.ts"
import { discoveryMissionSchema, missionBudgetSchema } from "./operations.ts"
import {
  applicationIdSchema,
  commitShaSchema,
  contentHashSchema,
  normalizedPathSchema,
  persistedTextSchema,
  publicHttpUrlSchema,
  pullRequestIdSchema,
  repositoryIdentitySchema,
  runIdSchema,
  schemaVersionSchema,
  secretReferenceSchema,
  stableEntityIdSchema,
  timestampSchema,
} from "./primitives.ts"

export const DEPLOYMENT_IDENTITY_POLICY_VERSION =
  "deployment-identity-policy-v1" as const
export const VERIFICATION_PLAN_POLICY_VERSION =
  "verification-plan-policy-v1" as const

export const deploymentRoleSchema = z.enum(["baseline", "pr_head"])
export const deploymentProviderSchema = z.literal("render")
export const deploymentPurposeSchema = z.enum([
  "baseline_observation",
  "pr_head_verification",
])

const providerResourceIdSchema = z.string().trim().min(1).max(256)

export const deploymentCompatibilitySchema = z.strictObject({
  fingerprint: contentHashSchema,
  authenticationRevision: z.number().int().nonnegative(),
  authenticationReferences: z.array(secretReferenceSchema).max(10),
  testDataSetupReference: persistedTextSchema.optional(),
  testDataResetReference: persistedTextSchema.optional(),
  allowedOrigins: z.array(publicHttpUrlSchema).min(1).max(20),
  policyFingerprint: contentHashSchema,
})

export const deploymentRegistrationSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: contentHashSchema,
    policyVersion: z.literal(DEPLOYMENT_IDENTITY_POLICY_VERSION),
    applicationId: applicationIdSchema,
    repository: repositoryIdentitySchema,
    role: deploymentRoleSchema,
    commitSha: commitShaSchema,
    publicUrl: publicHttpUrlSchema,
    healthPath: normalizedPathSchema,
    provider: z.strictObject({
      kind: deploymentProviderSchema,
      serviceId: providerResourceIdSchema,
      deployId: providerResourceIdSchema,
    }),
    compatibility: deploymentCompatibilitySchema,
    registeredAt: timestampSchema,
    expiresAt: timestampSchema,
    cleanupBy: timestampSchema,
  })
  .superRefine((registration, context) => {
    const registeredAt = Date.parse(registration.registeredAt)
    const expiresAt = Date.parse(registration.expiresAt)
    const cleanupBy = Date.parse(registration.cleanupBy)
    if (expiresAt <= registeredAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Deployment expiry must follow registration",
      })
    }
    if (cleanupBy < expiresAt) {
      context.addIssue({
        code: "custom",
        path: ["cleanupBy"],
        message: "Deployment cleanup cannot precede expiry",
      })
    }
    const publicOrigin = new URL(registration.publicUrl).origin
    if (
      !registration.compatibility.allowedOrigins.some(
        (value) => new URL(value).origin === publicOrigin
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["compatibility", "allowedOrigins"],
        message: "Allowed origins must include the deployment origin",
      })
    }
  })

export const deploymentProviderStatusSchema = z.enum([
  "created",
  "queued",
  "build_in_progress",
  "pre_deploy_in_progress",
  "update_in_progress",
  "live",
  "deactivated",
  "build_failed",
  "pre_deploy_failed",
  "update_failed",
  "canceled",
])

export const deploymentProviderProofSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  provider: deploymentProviderSchema,
  serviceId: providerResourceIdSchema,
  deployId: providerResourceIdSchema,
  repository: repositoryIdentitySchema.optional(),
  commitSha: commitShaSchema.optional(),
  publicUrl: publicHttpUrlSchema.optional(),
  status: deploymentProviderStatusSchema,
  observedAt: timestampSchema,
})

export const deploymentIdentityStateSchema = z.enum([
  "exact",
  "mismatch",
  "stale",
  "unreachable",
  "unknown",
])
export const deploymentTrustStateSchema = z.enum([
  "trusted",
  "untrusted",
  "stale",
  "unreachable",
  "unknown",
])
export const deploymentReadinessStateSchema = z.enum([
  "not_checked",
  "ready",
  "failed",
])

export const deploymentValidationReasonSchema = z.enum([
  "deployment_ready",
  "deployment_expired",
  "deployment_cleanup_overdue",
  "provider_unreachable",
  "provider_identity_unknown",
  "provider_deploy_not_live",
  "deployment_role_mismatch",
  "deployment_service_mismatch",
  "deployment_commit_mismatch",
  "deployment_repository_mismatch",
  "deployment_url_mismatch",
  "deployment_compatibility_mismatch",
  "deployment_readiness_failed",
  "credential_authorization_failed",
])

export const deploymentValidationRequestSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    applicationId: applicationIdSchema,
    purpose: deploymentPurposeSchema,
    assessmentId: z.uuid().optional(),
    pullRequestId: pullRequestIdSchema.optional(),
    expectedRepository: repositoryIdentitySchema,
    expectedCommitSha: commitShaSchema,
    expectedCompatibilityFingerprint: contentHashSchema,
    registration: deploymentRegistrationSchema,
  })
  .superRefine((request, context) => {
    const requiresPullRequest = request.purpose === "pr_head_verification"
    if (
      requiresPullRequest !==
      (request.assessmentId !== undefined &&
        request.pullRequestId !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["pullRequestId"],
        message:
          "PR-head verification requires assessment and pull-request identity; baseline observation cannot carry them",
      })
    }
  })

export const deploymentValidationResultSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    applicationId: applicationIdSchema,
    registrationId: contentHashSchema,
    purpose: deploymentPurposeSchema,
    assessmentId: z.uuid().optional(),
    pullRequestId: pullRequestIdSchema.optional(),
    expectedCommitSha: commitShaSchema,
    identityState: deploymentIdentityStateSchema,
    trustState: deploymentTrustStateSchema,
    readinessState: deploymentReadinessStateSchema,
    browserAccessAllowed: z.boolean(),
    credentialAccessAllowed: z.boolean(),
    reason: deploymentValidationReasonSchema,
    actionRequired: persistedTextSchema.optional(),
    proof: deploymentProviderProofSchema.optional(),
    validatedAt: timestampSchema,
  })
  .superRefine((result, context) => {
    const requiresPullRequest = result.purpose === "pr_head_verification"
    if (
      requiresPullRequest !==
      (result.assessmentId !== undefined && result.pullRequestId !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["pullRequestId"],
        message:
          "PR-head validation requires assessment and pull-request identity; baseline observation cannot carry them",
      })
    }
    const accessAllowed =
      result.identityState === "exact" &&
      result.trustState === "trusted" &&
      result.readinessState === "ready" &&
      result.reason === "deployment_ready"
    if (
      result.browserAccessAllowed !== accessAllowed ||
      result.credentialAccessAllowed !== accessAllowed
    ) {
      context.addIssue({
        code: "custom",
        path: ["browserAccessAllowed"],
        message: "Deployment access flags must match trusted readiness",
      })
    }
    if (accessAllowed && result.proof === undefined) {
      context.addIssue({
        code: "custom",
        path: ["proof"],
        message: "Trusted deployments require provider proof",
      })
    }
  })

export const verificationCheckpointKindSchema = z.enum([
  "reachability",
  "visible",
  "enabled",
  "transition",
  "request_status",
  "value",
  "error_absence",
])
export const verificationCheckpointOperatorSchema = z.enum([
  "equals",
  "present",
  "absent",
  "matches",
  "status_in",
  "changed",
  "unchanged",
])

export const verificationCheckpointSchema = z.strictObject({
  id: contentHashSchema,
  kind: verificationCheckpointKindSchema,
  sourceEntityId: stableEntityIdSchema,
  operator: verificationCheckpointOperatorSchema,
  expected: z.union([persistedTextSchema, z.number(), z.boolean()]).optional(),
  description: persistedTextSchema,
})

export const verificationSetupSchema = z.strictObject({
  method: z.enum(["none", "trusted_fixture_api", "user_interface"]),
  classification: z.enum(["outside_blast_radius", "inside_blast_radius"]),
  reference: persistedTextSchema.optional(),
  relatedEntityIds: z.array(stableEntityIdSchema).max(100),
  cleanupReference: persistedTextSchema.optional(),
})

export const verificationScenarioDefinitionSchema = z.strictObject({
  scenario: blastRadiusScenarioSchema,
  goal: persistedTextSchema,
  entryPath: normalizedPathSchema,
  checkpoints: z.array(verificationCheckpointSchema).min(1).max(20),
  setup: verificationSetupSchema,
  exclusions: z.array(persistedTextSchema).max(20),
})

export const verificationControlDefinitionSchema = z.strictObject({
  id: contentHashSchema,
  workflowId: stableEntityIdSchema,
  goal: persistedTextSchema,
  entryPath: normalizedPathSchema,
  checkpoints: z.array(verificationCheckpointSchema).min(1).max(20),
  setup: verificationSetupSchema,
  exclusions: z.array(persistedTextSchema).max(20),
})

export const verificationPlanningInputSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  applicationId: applicationIdSchema,
  runId: runIdSchema,
  deployment: deploymentValidationResultSchema,
  blastRadius: blastRadiusResultSchema,
  scenarios: z.array(verificationScenarioDefinitionSchema).max(1_000),
  controls: z.array(verificationControlDefinitionSchema).max(100),
  exclusions: z.array(persistedTextSchema).max(100),
})

export const verificationMissionPlanSchema = z
  .strictObject({
    kind: z.enum(["affected", "control"]),
    mission: discoveryMissionSchema,
    findingIds: z.array(contentHashSchema).max(100),
    scenarioIds: z.array(contentHashSchema).max(100),
    targetIds: z.array(stableEntityIdSchema).min(1).max(100),
    priority: riskSchema.exclude(["unknown"]),
    entryPath: normalizedPathSchema,
    setup: verificationSetupSchema,
    checkpoints: z.array(verificationCheckpointSchema).min(1).max(20),
    exclusions: z.array(persistedTextSchema).max(20),
  })
  .superRefine((plan, context) => {
    if (
      plan.mission.agent !== "application" ||
      plan.mission.mode !== "pr_change_validation"
    ) {
      context.addIssue({
        code: "custom",
        path: ["mission"],
        message:
          "Verification plans require Application Explorer validation missions",
      })
    }
    if (plan.kind === "affected" && plan.scenarioIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["scenarioIds"],
        message: "Affected missions require an impact scenario",
      })
    }
    if (plan.kind === "control" && plan.findingIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["findingIds"],
        message: "Control missions cannot claim impacted findings",
      })
    }
  })

export const verificationPlanSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: contentHashSchema,
    policyVersion: z.literal(VERIFICATION_PLAN_POLICY_VERSION),
    applicationId: applicationIdSchema,
    runId: runIdSchema,
    assessmentId: z.uuid(),
    blastRadiusResultId: contentHashSchema,
    status: z.enum(["planned", "verification_unavailable"]),
    deployment: deploymentValidationResultSchema,
    missions: z.array(verificationMissionPlanSchema).max(10),
    control: verificationMissionPlanSchema.optional(),
    budget: missionBudgetSchema,
    exclusions: z.array(persistedTextSchema).max(100),
    actionRequired: persistedTextSchema.optional(),
    createdAt: timestampSchema,
  })
  .superRefine((plan, context) => {
    const available = plan.deployment.browserAccessAllowed
    if (plan.status === "planned") {
      if (!available || plan.missions.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message:
            "Planned verification requires a trusted deployment and mission",
        })
      }
      if (plan.actionRequired !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["actionRequired"],
          message: "Planned verification cannot require deployment action",
        })
      }
    } else if (
      plan.missions.length > 0 ||
      plan.control !== undefined ||
      plan.actionRequired === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Unavailable verification must contain no executable missions and an action",
      })
    }
  })

export type DeploymentRegistration = z.infer<
  typeof deploymentRegistrationSchema
>
export type DeploymentProviderProof = z.infer<
  typeof deploymentProviderProofSchema
>
export type DeploymentValidationRequest = z.infer<
  typeof deploymentValidationRequestSchema
>
export type DeploymentValidationResult = z.infer<
  typeof deploymentValidationResultSchema
>
export type VerificationCheckpoint = z.infer<
  typeof verificationCheckpointSchema
>
export type VerificationSetup = z.infer<typeof verificationSetupSchema>
export type VerificationScenarioDefinition = z.infer<
  typeof verificationScenarioDefinitionSchema
>
export type VerificationControlDefinition = z.infer<
  typeof verificationControlDefinitionSchema
>
export type VerificationPlanningInput = z.infer<
  typeof verificationPlanningInputSchema
>
export type VerificationMissionPlan = z.infer<
  typeof verificationMissionPlanSchema
>
export type VerificationPlan = z.infer<typeof verificationPlanSchema>
