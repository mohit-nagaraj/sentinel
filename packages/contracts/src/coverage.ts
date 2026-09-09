import { z } from "zod"

import {
  applicationIdSchema,
  contentHashSchema,
  coverageAssessmentIdSchema,
  evidenceIdSchema,
  missionIdSchema,
  normalizedPathSchema,
  persistedTextSchema,
  reasonCodeSchema,
  requirementIdSchema,
  runIdSchema,
  schemaVersionSchema,
  screenIdSchema,
  timestampSchema,
  workflowIdSchema,
} from "./primitives.ts"

const uniqueIds = <T extends z.ZodType>(schema: T, label: string) =>
  z
    .array(schema)
    .max(500)
    .refine((values) => new Set(values.map(String)).size === values.length, {
      message: `${label} must be unique`,
    })

export const coverageStatusSchema = z.enum([
  "observed",
  "partially_observed",
  "not_observed",
  "blocked",
  "not_evaluated",
  "ambiguous",
])

export const coverageBlockerKindSchema = z.enum([
  "authentication",
  "policy",
  "unsafe_action",
  "test_data",
  "captcha",
  "payment",
  "destructive_action",
  "browser_failure",
])

export const coverageAuthenticationStateSchema = z.enum([
  "not_required",
  "configured",
  "missing",
  "invalid",
  "expired",
  "blocked",
  "unknown",
])

export const coverageTestDataStateSchema = z.enum([
  "not_required",
  "configured",
  "missing",
  "insufficient",
  "unknown",
])

export const coverageScopeSchema = z.strictObject({
  summary: persistedTextSchema,
  missionIds: uniqueIds(missionIdSchema, "Coverage mission IDs").min(1),
  workflowIds: uniqueIds(workflowIdSchema, "Coverage workflow IDs"),
  screenIds: uniqueIds(screenIdSchema, "Coverage screen IDs"),
  exploredRoutes: z
    .array(normalizedPathSchema)
    .max(500)
    .refine((values) => new Set(values).size === values.length, {
      message: "Coverage routes must be unique",
    }),
})

export const coverageRevisionContextSchema = z.strictObject({
  requirementSourceHash: contentHashSchema,
  crawlConfigurationHash: contentHashSchema,
  authenticationRevision: z.number().int().nonnegative(),
  testDataRevision: contentHashSchema.optional(),
})

export const coverageEnvironmentSchema = z.strictObject({
  authentication: coverageAuthenticationStateSchema,
  testData: coverageTestDataStateSchema,
})

export const coverageBlockerSchema = z.strictObject({
  kind: coverageBlockerKindSchema,
  reasonCode: reasonCodeSchema,
  summary: persistedTextSchema,
  humanAction: persistedTextSchema,
  evidenceIds: uniqueIds(evidenceIdSchema, "Blocker evidence IDs").min(1),
})

export const coverageAmbiguitySchema = z.strictObject({
  reasonCode: reasonCodeSchema,
  summary: persistedTextSchema,
  humanAction: persistedTextSchema,
  evidenceIds: uniqueIds(evidenceIdSchema, "Ambiguity evidence IDs").min(1),
})

const absenceClaimPattern =
  /\b(?:does not exist|doesn't exist|feature is absent|is not supported|are not supported|does not support|no such feature)\b/i

export const reportSafeCoverageWordingSchema = persistedTextSchema.refine(
  (wording) => !absenceClaimPattern.test(wording),
  { message: "Coverage wording cannot make an absolute absence claim" }
)

export const coverageEvaluationInputSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    applicationId: applicationIdSchema,
    requirementId: requirementIdSchema,
    runId: runIdSchema,
    graphRevision: z.number().int().nonnegative(),
    scope: coverageScopeSchema,
    revisionContext: coverageRevisionContextSchema,
    environment: coverageEnvironmentSchema,
    evaluationRequested: z.boolean(),
    expectedCheckpointCount: z.number().int().nonnegative().max(10_000),
    observedCheckpointCount: z.number().int().nonnegative().max(10_000),
    attemptSummary: reportSafeCoverageWordingSchema.optional(),
    attemptEvidenceIds: uniqueIds(
      evidenceIdSchema,
      "Coverage attempt evidence IDs"
    ),
    supportingEvidenceIds: uniqueIds(
      evidenceIdSchema,
      "Coverage supporting evidence IDs"
    ),
    blockers: z.array(coverageBlockerSchema).max(100),
    ambiguities: z.array(coverageAmbiguitySchema).max(100),
    evaluatedAt: timestampSchema,
  })
  .superRefine((input, context) => {
    if (input.observedCheckpointCount > input.expectedCheckpointCount) {
      context.addIssue({
        code: "custom",
        path: ["observedCheckpointCount"],
        message: "Observed checkpoints cannot exceed expected checkpoints",
      })
    }

    if (
      input.observedCheckpointCount > 0 &&
      input.supportingEvidenceIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["supportingEvidenceIds"],
        message: "Observed checkpoints require supporting evidence",
      })
    }

    if (
      (input.attemptEvidenceIds.length > 0 ||
        input.observedCheckpointCount > 0) &&
      input.attemptSummary === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["attemptSummary"],
        message: "Attempt evidence requires a bounded attempt summary",
      })
    }

    if (
      input.attemptEvidenceIds.length > 0 &&
      input.scope.workflowIds.length +
        input.scope.screenIds.length +
        input.scope.exploredRoutes.length ===
        0
    ) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message:
          "A bounded attempt must identify an explored workflow, screen, or route",
      })
    }

    if (
      input.observedCheckpointCount === 0 &&
      input.supportingEvidenceIds.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["supportingEvidenceIds"],
        message:
          "Supporting evidence requires at least one observed checkpoint",
      })
    }

    if (!input.evaluationRequested) {
      const hasEvaluationSignals =
        input.expectedCheckpointCount > 0 ||
        input.observedCheckpointCount > 0 ||
        input.attemptSummary !== undefined ||
        input.attemptEvidenceIds.length > 0 ||
        input.supportingEvidenceIds.length > 0 ||
        input.blockers.length > 0 ||
        input.ambiguities.length > 0
      if (hasEvaluationSignals) {
        context.addIssue({
          code: "custom",
          path: ["evaluationRequested"],
          message: "A non-requested evaluation cannot contain outcome signals",
        })
      }
    }
  })

export const coverageAssessmentSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: coverageAssessmentIdSchema,
    applicationId: applicationIdSchema,
    requirementId: requirementIdSchema,
    status: coverageStatusSchema,
    scope: coverageScopeSchema,
    scopeFingerprint: contentHashSchema,
    revisionContext: coverageRevisionContextSchema,
    environment: coverageEnvironmentSchema,
    reasonCode: reasonCodeSchema,
    reason: reportSafeCoverageWordingSchema,
    wording: reportSafeCoverageWordingSchema,
    attemptSummary: reportSafeCoverageWordingSchema.optional(),
    possibleCauses: z
      .array(persistedTextSchema)
      .max(20)
      .refine((values) => new Set(values).size === values.length, {
        message: "Possible causes must be unique",
      }),
    runId: runIdSchema,
    graphRevision: z.number().int().nonnegative(),
    evidenceIds: uniqueIds(evidenceIdSchema, "Coverage evidence IDs"),
    attemptEvidenceIds: uniqueIds(
      evidenceIdSchema,
      "Coverage attempt evidence IDs"
    ),
    blockers: z.array(coverageBlockerSchema).max(100),
    ambiguities: z.array(coverageAmbiguitySchema).max(100),
    evaluatedAt: timestampSchema,
  })
  .superRefine((assessment, context) => {
    const evidenceIds = new Set(assessment.evidenceIds.map(String))
    const referencedIds = [
      ...assessment.attemptEvidenceIds,
      ...assessment.blockers.flatMap((blocker) => blocker.evidenceIds),
      ...assessment.ambiguities.flatMap((ambiguity) => ambiguity.evidenceIds),
    ]
    if (referencedIds.some((id) => !evidenceIds.has(String(id)))) {
      context.addIssue({
        code: "custom",
        path: ["evidenceIds"],
        message:
          "Coverage evidence must include all attempt and issue evidence",
      })
    }

    if (
      (assessment.status === "observed" ||
        assessment.status === "partially_observed") &&
      assessment.evidenceIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidenceIds"],
        message: `${assessment.status} coverage requires supporting evidence`,
      })
    }

    if (
      assessment.status === "not_observed" &&
      assessment.attemptEvidenceIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["attemptEvidenceIds"],
        message: "Not-observed coverage requires bounded attempt evidence",
      })
    }

    if (
      assessment.status === "not_observed" &&
      assessment.scope.workflowIds.length +
        assessment.scope.screenIds.length +
        assessment.scope.exploredRoutes.length ===
        0
    ) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "Not-observed coverage requires a bounded explored scope",
      })
    }

    if (assessment.status === "blocked" && assessment.blockers.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["blockers"],
        message: "Blocked coverage requires a typed blocker",
      })
    }

    if (
      assessment.status === "ambiguous" &&
      assessment.ambiguities.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["ambiguities"],
        message: "Ambiguous coverage requires an evidence-backed ambiguity",
      })
    }

    if (
      assessment.status === "not_evaluated" &&
      (assessment.evidenceIds.length > 0 ||
        assessment.attemptEvidenceIds.length > 0 ||
        assessment.blockers.length > 0 ||
        assessment.ambiguities.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Not-evaluated coverage cannot contain evaluation outcomes",
      })
    }
  })

export const coverageAssessmentGraphFactSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: coverageAssessmentIdSchema,
  applicationId: applicationIdSchema,
  requirementId: requirementIdSchema,
  status: coverageStatusSchema,
  scopeFingerprint: contentHashSchema,
  scopeSummary: persistedTextSchema,
  reasonCode: reasonCodeSchema,
  wording: reportSafeCoverageWordingSchema,
  attemptSummary: reportSafeCoverageWordingSchema.optional(),
  runId: runIdSchema,
  graphRevision: z.number().int().nonnegative(),
  evidenceIds: uniqueIds(evidenceIdSchema, "Graph fact evidence IDs"),
  attemptEvidenceIds: uniqueIds(
    evidenceIdSchema,
    "Graph fact attempt evidence IDs"
  ),
  blockerKinds: z.array(coverageBlockerKindSchema).max(8),
  requirementSourceHash: contentHashSchema,
  crawlConfigurationHash: contentHashSchema,
  authenticationRevision: z.number().int().nonnegative(),
  testDataRevision: contentHashSchema.optional(),
  evaluatedAt: timestampSchema,
})

export const coverageAssessmentSummarySchema = z.strictObject({
  id: coverageAssessmentIdSchema,
  requirementId: requirementIdSchema,
  status: coverageStatusSchema,
  scope: persistedTextSchema,
  wording: reportSafeCoverageWordingSchema,
  reason: reportSafeCoverageWordingSchema,
  attemptSummary: reportSafeCoverageWordingSchema.optional(),
  possibleCauses: z.array(persistedTextSchema).max(20),
  blockerKinds: z.array(coverageBlockerKindSchema).max(8),
  humanActions: z.array(persistedTextSchema).max(100),
  evidenceCount: z.number().int().nonnegative(),
  attemptEvidenceCount: z.number().int().nonnegative(),
  evaluatedAt: timestampSchema,
})

export const coverageInvalidationReasonSchema = z.enum([
  "requirement_source_changed",
  "crawl_configuration_changed",
  "authentication_configuration_changed",
  "test_data_configuration_changed",
])

export const coverageFreshnessSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("current"),
    reasons: z.tuple([]),
    requiresReassessment: z.literal(false),
  }),
  z.strictObject({
    status: z.literal("stale"),
    reasons: z.array(coverageInvalidationReasonSchema).min(1).max(4),
    requiresReassessment: z.literal(true),
  }),
])

export type CoverageStatus = z.infer<typeof coverageStatusSchema>
export type CoverageBlockerKind = z.infer<typeof coverageBlockerKindSchema>
export type CoverageScope = z.infer<typeof coverageScopeSchema>
export type CoverageRevisionContext = z.infer<
  typeof coverageRevisionContextSchema
>
export type CoverageBlocker = z.infer<typeof coverageBlockerSchema>
export type CoverageAmbiguity = z.infer<typeof coverageAmbiguitySchema>
export type CoverageEvaluationInput = z.infer<
  typeof coverageEvaluationInputSchema
>
export type CoverageAssessment = z.infer<typeof coverageAssessmentSchema>
export type CoverageAssessmentGraphFact = z.infer<
  typeof coverageAssessmentGraphFactSchema
>
export type CoverageAssessmentSummary = z.infer<
  typeof coverageAssessmentSummarySchema
>
export type CoverageFreshness = z.infer<typeof coverageFreshnessSchema>
