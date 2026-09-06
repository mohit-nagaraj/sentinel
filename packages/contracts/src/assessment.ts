import { z } from "zod"

import {
  applicationIdSchema,
  apiEndpointIdSchema,
  artifactIdSchema,
  capabilityIdSchema,
  codeSymbolIdSchema,
  commitShaSchema,
  contentHashSchema,
  coverageAssessmentIdSchema,
  documentPageIdSchema,
  documentSectionIdSchema,
  documentSourceIdSchema,
  domainEntityIdSchema,
  evidenceIdSchema,
  evidenceTierSchema,
  findingIdSchema,
  flowStepIdSchema,
  frontendRouteIdSchema,
  httpMethodSchema,
  lineRangeSchema,
  nonEmptyStringSchema,
  normalizedPathSchema,
  persistedTextSchema,
  publicHttpUrlSchema,
  pullRequestIdSchema,
  repositoryIdentitySchema,
  repositoryPathSchema,
  requirementIdSchema,
  reviewStateSchema,
  runIdSchema,
  schemaVersionSchema,
  screenIdSchema,
  shortTextSchema,
  stableEntityIdSchema,
  timestampSchema,
  uiElementIdSchema,
  workflowIdSchema,
} from "./primitives.ts"

export const evidenceRelationshipSchema = z.enum([
  "HAS_PAGE",
  "HAS_SECTION",
  "LINKS_TO",
  "STATES",
  "REQUIRES",
  "COVERED_BY",
  "HAS_STEP",
  "NEXT",
  "ON_SCREEN",
  "ACTS_ON",
  "CONTAINS",
  "MATCHES_ROUTE",
  "RENDERED_BY",
  "BINDS",
  "TRIGGERS_API",
  "CALLS_API",
  "HANDLED_BY",
  "CALLS",
  "READS",
  "WRITES",
  "CHANGES",
  "HAS_ASSESSMENT",
])

const evidenceLinkFields = {
  schemaVersion: schemaVersionSchema,
  id: evidenceIdSchema,
  applicationId: applicationIdSchema,
  extractionMethod: z.string().trim().min(1).max(128),
  evidenceTier: evidenceTierSchema,
  explanation: persistedTextSchema,
  evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
  sourceCommitSha: commitShaSchema.optional(),
  crawlRunId: runIdSchema.optional(),
  artifactId: artifactIdSchema.optional(),
  reviewState: reviewStateSchema,
  graphRevision: z.number().int().nonnegative(),
  lastConfirmedAt: timestampSchema,
}

function evidenceLinkVariant<
  const Relationship extends z.infer<typeof evidenceRelationshipSchema>,
  FromId extends z.ZodType,
  ToId extends z.ZodType,
>(relationship: Relationship, fromId: FromId, toId: ToId) {
  return z.strictObject({
    ...evidenceLinkFields,
    fromId,
    relationship: z.literal(relationship),
    toId,
  })
}

export const evidenceLinkSchema = z.discriminatedUnion("relationship", [
  evidenceLinkVariant("HAS_PAGE", documentSourceIdSchema, documentPageIdSchema),
  evidenceLinkVariant(
    "HAS_SECTION",
    documentPageIdSchema,
    documentSectionIdSchema
  ),
  evidenceLinkVariant("LINKS_TO", documentPageIdSchema, documentPageIdSchema),
  evidenceLinkVariant("STATES", documentSectionIdSchema, requirementIdSchema),
  evidenceLinkVariant("REQUIRES", requirementIdSchema, capabilityIdSchema),
  evidenceLinkVariant("COVERED_BY", requirementIdSchema, workflowIdSchema),
  evidenceLinkVariant("HAS_STEP", workflowIdSchema, flowStepIdSchema),
  evidenceLinkVariant("NEXT", flowStepIdSchema, flowStepIdSchema),
  evidenceLinkVariant("ON_SCREEN", flowStepIdSchema, screenIdSchema),
  evidenceLinkVariant("ACTS_ON", flowStepIdSchema, uiElementIdSchema),
  evidenceLinkVariant("CONTAINS", screenIdSchema, uiElementIdSchema),
  evidenceLinkVariant("MATCHES_ROUTE", screenIdSchema, frontendRouteIdSchema),
  evidenceLinkVariant(
    "RENDERED_BY",
    z.union([screenIdSchema, uiElementIdSchema]),
    codeSymbolIdSchema
  ),
  evidenceLinkVariant("BINDS", uiElementIdSchema, codeSymbolIdSchema),
  evidenceLinkVariant("TRIGGERS_API", uiElementIdSchema, apiEndpointIdSchema),
  evidenceLinkVariant("CALLS_API", codeSymbolIdSchema, apiEndpointIdSchema),
  evidenceLinkVariant("HANDLED_BY", apiEndpointIdSchema, codeSymbolIdSchema),
  evidenceLinkVariant("CALLS", codeSymbolIdSchema, codeSymbolIdSchema),
  evidenceLinkVariant("READS", codeSymbolIdSchema, domainEntityIdSchema),
  evidenceLinkVariant("WRITES", codeSymbolIdSchema, domainEntityIdSchema),
  evidenceLinkVariant("CHANGES", pullRequestIdSchema, codeSymbolIdSchema),
  evidenceLinkVariant(
    "HAS_ASSESSMENT",
    requirementIdSchema,
    coverageAssessmentIdSchema
  ),
])

export const coverageStatusSchema = z.enum([
  "observed",
  "partially_observed",
  "not_observed",
  "blocked",
  "not_evaluated",
  "ambiguous",
])

export const coverageAssessmentSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: coverageAssessmentIdSchema,
  applicationId: applicationIdSchema,
  requirementId: requirementIdSchema,
  status: coverageStatusSchema,
  scope: nonEmptyStringSchema,
  reason: nonEmptyStringSchema,
  possibleCauses: z.array(nonEmptyStringSchema).max(20),
  runId: runIdSchema,
  evidenceIds: z.array(evidenceIdSchema).max(100),
})

export const pullRequestSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: pullRequestIdSchema,
  applicationId: applicationIdSchema,
  repository: repositoryIdentitySchema,
  number: z.number().int().positive(),
  title: shortTextSchema,
  baseSha: commitShaSchema,
  headSha: commitShaSchema,
  analyzedAt: timestampSchema,
})

export const prChangeSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    pullRequestId: pullRequestIdSchema,
    operation: z.enum(["added", "modified", "deleted", "renamed"]),
    classifications: z
      .array(z.enum(["configuration", "schema"]))
      .max(2)
      .refine((values) => new Set(values).size === values.length, {
        message: "File classifications must be unique",
      }),
    oldPath: repositoryPathSchema.optional(),
    newPath: repositoryPathSchema.optional(),
    baseRanges: z.array(lineRangeSchema).max(1_000),
    headRanges: z.array(lineRangeSchema).max(1_000),
    baseSymbolIds: z.array(codeSymbolIdSchema).max(500),
    headSymbolIds: z.array(codeSymbolIdSchema).max(500),
    diffHash: contentHashSchema,
  })
  .superRefine(({ newPath, oldPath, operation }, context) => {
    const requirePath = (
      path: string | undefined,
      field: "newPath" | "oldPath"
    ) => {
      if (path === undefined) {
        context.addIssue({
          code: "custom",
          message: `${field} is required for ${operation} changes`,
          path: [field],
        })
      }
    }

    if (operation === "added" || operation === "modified") {
      requirePath(newPath, "newPath")
      if (operation === "added" && oldPath !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Added changes cannot include oldPath",
          path: ["oldPath"],
        })
      }
      if (
        operation === "modified" &&
        oldPath !== undefined &&
        newPath !== undefined &&
        oldPath !== newPath
      ) {
        context.addIssue({
          code: "custom",
          message: "Modified paths must match; use renamed for path changes",
          path: ["newPath"],
        })
      }
    } else if (operation === "deleted") {
      requirePath(oldPath, "oldPath")
      if (newPath !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Deleted changes cannot include newPath",
          path: ["newPath"],
        })
      }
    } else {
      requirePath(oldPath, "oldPath")
      requirePath(newPath, "newPath")
      if (oldPath !== undefined && oldPath === newPath) {
        context.addIssue({
          code: "custom",
          message: "Renamed changes require distinct oldPath and newPath",
          path: ["newPath"],
        })
      }
    }
  })

export const riskSchema = z.enum(["high", "medium", "low", "unknown"])
export const verificationStatusSchema = z.enum([
  "passed",
  "failed",
  "behavior_changed",
  "blocked",
  "not_run",
  "verification_unavailable",
])

export const assessmentFindingSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: findingIdSchema,
  applicationId: applicationIdSchema,
  pullRequestId: pullRequestIdSchema,
  risk: riskSchema,
  evidenceStrength: evidenceTierSchema,
  title: shortTextSchema,
  summary: persistedTextSchema,
  changedSymbolIds: z.array(codeSymbolIdSchema).max(500),
  screenIds: z.array(screenIdSchema).max(500),
  workflowIds: z.array(workflowIdSchema).max(500),
  requirementIds: z.array(requirementIdSchema).max(500),
  evidencePaths: z
    .array(z.array(stableEntityIdSchema).min(2).max(50))
    .min(1)
    .max(100),
  recommendedScenarios: z.array(persistedTextSchema).max(50),
  verificationStatus: verificationStatusSchema,
})

const verificationAssertionSchema = z.strictObject({
  name: shortTextSchema,
  passed: z.boolean(),
  evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
})

const verificationRequestSchema = z.strictObject({
  method: httpMethodSchema,
  normalizedPath: normalizedPathSchema,
  status: z.number().int().min(100).max(599),
})

const verificationBase = {
  schemaVersion: schemaVersionSchema,
  runId: runIdSchema,
  pullRequestId: pullRequestIdSchema,
  headSha: commitShaSchema,
  workflowId: workflowIdSchema,
  requirementIds: z.array(requirementIdSchema).max(100),
  completedAt: timestampSchema,
}

function executedVerificationVariant(
  status: "passed" | "failed" | "behavior_changed"
) {
  return z.strictObject({
    ...verificationBase,
    status: z.literal(status),
    deploymentUrl: publicHttpUrlSchema,
    requirementIds: z.array(requirementIdSchema).min(1).max(100),
    assertions: z.array(verificationAssertionSchema).min(1).max(100),
    requests: z.array(verificationRequestSchema).max(500),
  })
}

export const verificationResultSchema = z
  .discriminatedUnion("status", [
    executedVerificationVariant("passed"),
    executedVerificationVariant("failed"),
    executedVerificationVariant("behavior_changed"),
    z.strictObject({
      ...verificationBase,
      status: z.literal("blocked"),
      deploymentUrl: publicHttpUrlSchema,
      assertions: z.array(verificationAssertionSchema).max(100),
      requests: z.array(verificationRequestSchema).max(500),
    }),
    z.strictObject({
      ...verificationBase,
      status: z.literal("not_run"),
      assertions: z.array(verificationAssertionSchema).max(0),
      requests: z.array(verificationRequestSchema).max(0),
    }),
    z.strictObject({
      ...verificationBase,
      status: z.literal("verification_unavailable"),
      assertions: z.array(verificationAssertionSchema).max(0),
      requests: z.array(verificationRequestSchema).max(0),
    }),
  ])
  .superRefine(({ assertions, status }, context) => {
    if (
      status === "passed" &&
      assertions.some((assertion) => !assertion.passed)
    ) {
      context.addIssue({
        code: "custom",
        message: "Passed verification cannot contain failed assertions",
        path: ["assertions"],
      })
    }
    if (
      status === "failed" &&
      assertions.every((assertion) => assertion.passed)
    ) {
      context.addIssue({
        code: "custom",
        message: "Failed verification requires at least one failed assertion",
        path: ["assertions"],
      })
    }
  })

export type EvidenceLink = z.infer<typeof evidenceLinkSchema>
export type CoverageAssessment = z.infer<typeof coverageAssessmentSchema>
export type PullRequest = z.infer<typeof pullRequestSchema>
export type PrChange = z.infer<typeof prChangeSchema>
export type AssessmentFinding = z.infer<typeof assessmentFindingSchema>
export type VerificationResult = z.infer<typeof verificationResultSchema>
