import { z } from "zod"

import { hashCanonical } from "./identity.ts"
import { applicationExplorerMissionOutputSchema } from "./application-explorer.ts"
import { verificationRequestSchema } from "./assessment.ts"
import {
  browserNetworkEvidenceSchema,
  browserRuntimeErrorEvidenceSchema,
} from "./browser-runtime.ts"
import {
  deploymentValidationRequestSchema,
  deploymentValidationResultSchema,
  verificationCheckpointSchema,
  verificationMissionPlanSchema,
  verificationPlanSchema,
} from "./deployment-verification.ts"
import { missionBudgetSchema } from "./operations.ts"
import {
  applicationIdSchema,
  artifactIdSchema,
  commitShaSchema,
  contentHashSchema,
  evidenceIdSchema,
  missionIdSchema,
  persistedTextSchema,
  pullRequestIdSchema,
  runIdSchema,
  schemaVersionSchema,
  timestampSchema,
} from "./primitives.ts"

export const TARGETED_VERIFICATION_POLICY_VERSION =
  "targeted-verification-policy-v1" as const
export const MAX_VERIFICATION_MISSION_RESULTS = 12 as const
export const MAX_VERIFICATION_ARTIFACTS = 500 as const

const unique = <T extends z.ZodType>(schema: T, label: string) =>
  z
    .array(schema)
    .refine((values) => new Set(values.map(String)).size === values.length, {
      message: `${label} must be unique`,
    })

const checkpointObservationBase = {
  schemaVersion: schemaVersionSchema,
  checkpointId: contentHashSchema,
  evidenceIds: unique(evidenceIdSchema, "Checkpoint observation evidence IDs")
    .min(1)
    .max(100),
  observedAt: timestampSchema,
}

export const verificationCheckpointObservationSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      ...checkpointObservationBase,
      kind: z.literal("reachability"),
      reachable: z.boolean(),
      normalizedRoute: z.string().min(1).max(2_048),
    }),
    z.strictObject({
      ...checkpointObservationBase,
      kind: z.literal("visible"),
      visible: z.boolean(),
    }),
    z.strictObject({
      ...checkpointObservationBase,
      kind: z.literal("enabled"),
      enabled: z.boolean(),
    }),
    z.strictObject({
      ...checkpointObservationBase,
      kind: z.literal("transition"),
      beforeFingerprint: contentHashSchema,
      afterFingerprint: contentHashSchema,
      changed: z.boolean(),
    }),
    z.strictObject({
      ...checkpointObservationBase,
      kind: z.literal("request_status"),
      requests: z.array(browserNetworkEvidenceSchema).min(1).max(100),
    }),
    z.strictObject({
      ...checkpointObservationBase,
      kind: z.literal("value"),
      value: z
        .union([persistedTextSchema, z.number(), z.boolean(), z.null()])
        .optional(),
    }),
    z.strictObject({
      ...checkpointObservationBase,
      kind: z.literal("error_absence"),
      errors: z.array(browserRuntimeErrorEvidenceSchema).max(100),
    }),
  ]
)

export const verificationAssertionOutcomeSchema = z.enum([
  "passed",
  "failed",
  "blocked",
])

export const deterministicVerificationAssertionSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    checkpoint: verificationCheckpointSchema,
    outcome: verificationAssertionOutcomeSchema,
    reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/),
    summary: persistedTextSchema,
    evidenceIds: unique(evidenceIdSchema, "Assertion evidence IDs").max(100),
    evaluatedAt: timestampSchema,
  })
  .superRefine((assertion, context) => {
    if (assertion.outcome !== "blocked" && assertion.evidenceIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["evidenceIds"],
        message: "Executed deterministic assertions require observed evidence",
      })
    }
  })

export const verificationArtifactKindSchema = z.enum([
  "screenshot",
  "trace",
  "network",
  "console",
  "state",
])

export const verificationArtifactCandidateSchema = z.strictObject({
  artifactId: artifactIdSchema,
  kind: verificationArtifactKindSchema,
  purpose: z.enum(["diagnostic", "report"]),
  capturedAt: timestampSchema,
})

export const verificationArtifactDecisionSchema = z
  .strictObject({
    artifactId: artifactIdSchema,
    kind: verificationArtifactKindSchema,
    disposition: z.enum(["retain", "delete"]),
    reason: z.enum(["failure_evidence", "report_evidence", "successful_run"]),
    private: z.literal(true),
    deleteAfter: timestampSchema.optional(),
  })
  .superRefine((artifact, context) => {
    if (
      (artifact.disposition === "retain") !==
      (artifact.deleteAfter !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["deleteAfter"],
        message: "Retained verification artifacts require a deletion deadline",
      })
    }
    if (
      artifact.disposition === "delete" &&
      artifact.reason !== "successful_run"
    ) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Only successful non-report artifacts are deleted immediately",
      })
    }
  })

export const verificationSetupReceiptSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: contentHashSchema,
    missionId: missionIdSchema,
    classification: z.enum(["outside_blast_radius", "inside_blast_radius"]),
    method: z.enum(["none", "trusted_fixture_api", "user_interface"]),
    status: z.enum(["not_required", "prepared", "failed"]),
    idempotencyKey: contentHashSchema,
    evidenceIds: unique(evidenceIdSchema, "Setup evidence IDs").max(100),
    artifacts: z.array(verificationArtifactCandidateSchema).max(100),
    cleanupRequired: z.boolean(),
    reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/),
    summary: persistedTextSchema,
    preparedAt: timestampSchema,
  })
  .superRefine((receipt, context) => {
    if (receipt.status === "not_required" && receipt.cleanupRequired) {
      context.addIssue({
        code: "custom",
        path: ["cleanupRequired"],
        message: "Setup that was not required cannot require cleanup",
      })
    }
    if (
      receipt.classification === "inside_blast_radius" &&
      receipt.method !== "user_interface"
    ) {
      context.addIssue({
        code: "custom",
        path: ["method"],
        message: "Impacted setup must execute through the user interface",
      })
    }
  })

export const verificationMissionEvidenceSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    applicationId: applicationIdSchema,
    runId: runIdSchema,
    missionId: missionIdSchema,
    phase: z.enum(["baseline", "head"]),
    explorer: applicationExplorerMissionOutputSchema,
    checkpointObservations: z
      .array(verificationCheckpointObservationSchema)
      .max(20),
    artifacts: z
      .array(verificationArtifactCandidateSchema)
      .max(MAX_VERIFICATION_ARTIFACTS),
    semanticFingerprint: contentHashSchema,
    modelExplanation: persistedTextSchema.optional(),
    completedAt: timestampSchema,
  })
  .superRefine((evidence, context) => {
    if (
      evidence.explorer.result.missionId !== evidence.missionId ||
      evidence.explorer.checkpoint.runId !== evidence.runId ||
      evidence.explorer.checkpoint.applicationId !== evidence.applicationId
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Explorer evidence does not belong to the verification mission",
      })
    }
    const ids = evidence.checkpointObservations.map(
      ({ checkpointId }) => checkpointId
    )
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["checkpointObservations"],
        message: "Checkpoint observations must be unique",
      })
    }
  })

export const verificationComparisonSchema = z
  .strictObject({
    status: z.enum(["not_available", "preserved", "changed"]),
    changedCheckpointIds: unique(
      contentHashSchema,
      "Changed checkpoint IDs"
    ).max(20),
    baselineFingerprint: contentHashSchema.optional(),
    headFingerprint: contentHashSchema.optional(),
  })
  .superRefine((comparison, context) => {
    if (
      (comparison.status === "not_available") !==
      (comparison.baselineFingerprint === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["baselineFingerprint"],
        message: "Only an available comparison has a baseline fingerprint",
      })
    }
    if (
      comparison.status !== "not_available" &&
      comparison.headFingerprint === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["headFingerprint"],
        message: "Executed baseline comparisons require a head fingerprint",
      })
    }
  })

export const verificationFailureCategorySchema = z.enum([
  "none",
  "product_regression",
  "setup_failure",
  "environment_instability",
  "policy_block",
  "agent_block",
])

export const verificationMissionResultSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: contentHashSchema,
    kind: z.enum(["affected", "control", "followup"]),
    missionId: missionIdSchema,
    status: z.enum([
      "passed",
      "failed",
      "behavior_changed",
      "blocked",
      "not_run",
    ]),
    failureCategory: verificationFailureCategorySchema,
    setup: verificationSetupReceiptSchema,
    assertions: z.array(deterministicVerificationAssertionSchema).max(20),
    requests: z.array(verificationRequestSchema).max(500),
    comparison: verificationComparisonSchema,
    evidenceIds: unique(evidenceIdSchema, "Mission result evidence IDs").max(
      500
    ),
    artifacts: z
      .array(verificationArtifactDecisionSchema)
      .max(MAX_VERIFICATION_ARTIFACTS),
    deterministicSummary: persistedTextSchema,
    modelExplanation: persistedTextSchema.optional(),
    completedAt: timestampSchema,
  })
  .superRefine((result, context) => {
    if (
      (result.status === "passed" || result.status === "behavior_changed") &&
      result.assertions.some(({ outcome }) => outcome !== "passed")
    ) {
      context.addIssue({
        code: "custom",
        path: ["assertions"],
        message: "Passing or changed behavior requires passing checkpoints",
      })
    }
    if (
      result.status === "failed" &&
      !result.assertions.some(({ outcome }) => outcome === "failed")
    ) {
      context.addIssue({
        code: "custom",
        path: ["assertions"],
        message: "Failed verification requires a failed checkpoint",
      })
    }
    const noFailure = result.failureCategory === "none"
    if (
      noFailure !==
      ["passed", "behavior_changed", "not_run"].includes(result.status)
    ) {
      context.addIssue({
        code: "custom",
        path: ["failureCategory"],
        message: "Verification status and failure category conflict",
      })
    }
  })

export const verificationGapFollowupSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: contentHashSchema,
  round: z.literal(1),
  gapCheckpointIds: unique(contentHashSchema, "Gap checkpoint IDs")
    .min(1)
    .max(20),
  mission: verificationMissionPlanSchema,
  reason: persistedTextSchema,
})

export const verificationArtifactPolicySchema = z.strictObject({
  successfulRetentionSeconds: z.number().int().min(0).max(86_400),
  failureRetentionSeconds: z
    .number()
    .int()
    .min(3_600)
    .max(30 * 86_400),
  reportRetentionSeconds: z
    .number()
    .int()
    .min(3_600)
    .max(90 * 86_400),
})

export const targetedVerificationStartInputSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    policyVersion: z.literal(TARGETED_VERIFICATION_POLICY_VERSION),
    plan: verificationPlanSchema,
    headValidation: deploymentValidationRequestSchema,
    baselineValidation: deploymentValidationRequestSchema.optional(),
    artifactPolicy: verificationArtifactPolicySchema,
    totalBudget: missionBudgetSchema,
    startedAtMs: z.number().int().nonnegative(),
  })
  .superRefine((input, context) => {
    if (
      input.plan.applicationId !== input.headValidation.applicationId ||
      input.plan.assessmentId !== input.headValidation.assessmentId ||
      input.plan.deployment.pullRequestId !==
        input.headValidation.pullRequestId ||
      input.plan.deployment.expectedCommitSha !==
        input.headValidation.expectedCommitSha ||
      input.headValidation.purpose !== "pr_head_verification"
    ) {
      context.addIssue({
        code: "custom",
        path: ["headValidation"],
        message: "Head validation does not match the verification plan",
      })
    }
    if (
      input.baselineValidation !== undefined &&
      (input.baselineValidation.applicationId !== input.plan.applicationId ||
        input.baselineValidation.purpose !== "baseline_observation")
    ) {
      context.addIssue({
        code: "custom",
        path: ["baselineValidation"],
        message:
          "Baseline validation does not match the verification application",
      })
    }
  })

export function createTargetedVerificationInputId(input: unknown) {
  return hashCanonical({
    kind: "targeted-verification-input",
    input: targetedVerificationStartInputSchema.parse(input),
    version: 1,
  })
}

export const targetedVerificationResultSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: contentHashSchema,
    policyVersion: z.literal(TARGETED_VERIFICATION_POLICY_VERSION),
    assessmentId: z.uuid(),
    applicationId: applicationIdSchema,
    runId: runIdSchema,
    pullRequestId: pullRequestIdSchema,
    headSha: commitShaSchema,
    status: z.enum([
      "passed",
      "failed",
      "behavior_changed",
      "blocked",
      "not_run",
      "verification_unavailable",
    ]),
    headValidation: deploymentValidationResultSchema,
    baselineValidation: deploymentValidationResultSchema.optional(),
    predictedFindingIds: unique(contentHashSchema, "Predicted finding IDs").max(
      13_000
    ),
    missionResults: z
      .array(verificationMissionResultSchema)
      .max(MAX_VERIFICATION_MISSION_RESULTS),
    controlResult: verificationMissionResultSchema.optional(),
    followup: verificationGapFollowupSchema.optional(),
    budgetUsed: missionBudgetSchema,
    artifacts: z
      .array(verificationArtifactDecisionSchema)
      .max(MAX_VERIFICATION_ARTIFACTS),
    deterministicSummary: persistedTextSchema,
    actionRequired: persistedTextSchema.optional(),
    completedAt: timestampSchema,
  })
  .superRefine((result, context) => {
    if (
      result.headValidation.applicationId !== result.applicationId ||
      result.headValidation.assessmentId !== result.assessmentId ||
      result.headValidation.pullRequestId !== result.pullRequestId ||
      result.headValidation.expectedCommitSha !== result.headSha
    ) {
      context.addIssue({
        code: "custom",
        path: ["headValidation"],
        message: "Verification result head validation identity conflicts",
      })
    }
    if (
      result.controlResult !== undefined &&
      result.controlResult.kind !== "control"
    ) {
      context.addIssue({
        code: "custom",
        path: ["controlResult"],
        message: "Control result must identify a control mission",
      })
    }
    if (
      result.status === "verification_unavailable" &&
      (result.missionResults.length > 0 || result.controlResult !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["missionResults"],
        message: "Unavailable verification cannot claim executed missions",
      })
    }
    if (
      result.status === "failed" &&
      !result.missionResults.some(({ status }) => status === "failed")
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Failed verification requires a failed affected mission",
      })
    }
    if (
      result.controlResult !== undefined &&
      ["failed", "blocked"].includes(result.controlResult.status) &&
      result.status !== "blocked"
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Failed controls make the environment verdict blocked",
      })
    }
  })

export const targetedVerificationEnrichmentSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: contentHashSchema,
  assessmentId: z.uuid(),
  pullRequestId: pullRequestIdSchema,
  headSha: commitShaSchema,
  resultId: contentHashSchema,
  version: z.number().int().positive(),
  status: z.enum([
    "passed",
    "failed",
    "behavior_changed",
    "blocked",
    "not_run",
    "verification_unavailable",
  ]),
  predictedFindingIds: unique(
    contentHashSchema,
    "Enrichment predicted finding IDs"
  ).max(13_000),
  missionResultIds: unique(
    contentHashSchema,
    "Enrichment mission result IDs"
  ).max(MAX_VERIFICATION_MISSION_RESULTS),
  evidenceIds: unique(evidenceIdSchema, "Enrichment evidence IDs").max(5_000),
  artifactIds: unique(artifactIdSchema, "Enrichment artifact IDs").max(
    MAX_VERIFICATION_ARTIFACTS
  ),
  summary: persistedTextSchema,
  appendedAt: timestampSchema,
})

export type VerificationCheckpointObservation = z.infer<
  typeof verificationCheckpointObservationSchema
>
export type DeterministicVerificationAssertion = z.infer<
  typeof deterministicVerificationAssertionSchema
>
export type VerificationArtifactCandidate = z.infer<
  typeof verificationArtifactCandidateSchema
>
export type VerificationArtifactDecision = z.infer<
  typeof verificationArtifactDecisionSchema
>
export type VerificationSetupReceipt = z.infer<
  typeof verificationSetupReceiptSchema
>
export type VerificationMissionEvidence = z.infer<
  typeof verificationMissionEvidenceSchema
>
export type VerificationComparison = z.infer<
  typeof verificationComparisonSchema
>
export type VerificationFailureCategory = z.infer<
  typeof verificationFailureCategorySchema
>
export type VerificationMissionResult = z.infer<
  typeof verificationMissionResultSchema
>
export type VerificationGapFollowup = z.infer<
  typeof verificationGapFollowupSchema
>
export type VerificationArtifactPolicy = z.infer<
  typeof verificationArtifactPolicySchema
>
export type TargetedVerificationStartInput = z.infer<
  typeof targetedVerificationStartInputSchema
>
export type TargetedVerificationResult = z.infer<
  typeof targetedVerificationResultSchema
>
export type TargetedVerificationEnrichment = z.infer<
  typeof targetedVerificationEnrichmentSchema
>
