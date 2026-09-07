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
  languageSchema,
  lineRangeSchema,
  nonEmptyStringSchema,
  normalizedPathSchema,
  persistedTextSchema,
  publicHttpUrlSchema,
  pullRequestIdSchema,
  repositoryIdentitySchema,
  repositoryPathSchema,
  reasonCodeSchema,
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
  .superRefine(
    (
      { baseRanges, baseSymbolIds, headRanges, headSymbolIds, operation },
      context
    ) => {
      if (
        operation === "added" &&
        (baseRanges.length > 0 || baseSymbolIds.length > 0)
      ) {
        context.addIssue({
          code: "custom",
          message: "Added changes cannot contain base-side ranges or symbols",
          path: ["baseRanges"],
        })
      }
      if (
        operation === "deleted" &&
        (headRanges.length > 0 || headSymbolIds.length > 0)
      ) {
        context.addIssue({
          code: "custom",
          message: "Deleted changes cannot contain head-side ranges or symbols",
          path: ["headRanges"],
        })
      }
    }
  )

export const baselineCompatibilityStatusSchema = z.enum([
  "exact",
  "safe_ancestor_warning",
  "stale_relevant",
  "unrelated_or_unknown",
])

export const baselineCompatibilityReasonSchema = z.enum([
  "graph_matches_pr_base",
  "ancestor_without_relevant_changes",
  "ancestor_with_relevant_changes",
  "baseline_not_ancestor_of_pr_base",
  "ancestry_unavailable",
])

export const baselineCompatibilitySchema = z
  .strictObject({
    status: baselineCompatibilityStatusSchema,
    assessmentAllowed: z.boolean(),
    graphCommitSha: commitShaSchema,
    baseSha: commitShaSchema,
    reason: baselineCompatibilityReasonSchema,
    relevantInterveningPaths: z.array(repositoryPathSchema).max(1_000),
  })
  .superRefine((value, context) => {
    const allowed =
      value.status === "exact" || value.status === "safe_ancestor_warning"
    if (value.assessmentAllowed !== allowed) {
      context.addIssue({
        code: "custom",
        message: "Baseline assessmentAllowed does not match its status",
        path: ["assessmentAllowed"],
      })
    }
    if (value.status === "exact" && value.graphCommitSha !== value.baseSha) {
      context.addIssue({
        code: "custom",
        message: "Exact baseline must equal the PR base commit",
        path: ["graphCommitSha"],
      })
    }
    const expectsRelevantPaths = value.status === "stale_relevant"
    if (expectsRelevantPaths !== value.relevantInterveningPaths.length > 0) {
      context.addIssue({
        code: "custom",
        message:
          "Only stale relevant baselines may contain relevant intervening paths",
        path: ["relevantInterveningPaths"],
      })
    }
    const expectedReason =
      value.status === "exact"
        ? "graph_matches_pr_base"
        : value.status === "safe_ancestor_warning"
          ? "ancestor_without_relevant_changes"
          : value.status === "stale_relevant"
            ? "ancestor_with_relevant_changes"
            : undefined
    if (expectedReason !== undefined && value.reason !== expectedReason) {
      context.addIssue({
        code: "custom",
        message: "Baseline reason does not match its status",
        path: ["reason"],
      })
    }
    if (
      value.status === "unrelated_or_unknown" &&
      value.reason !== "baseline_not_ancestor_of_pr_base" &&
      value.reason !== "ancestry_unavailable"
    ) {
      context.addIssue({
        code: "custom",
        message: "Unrelated baseline has an incompatible reason",
        path: ["reason"],
      })
    }
  })

export const changedFileClassificationSchema = z.enum([
  "source",
  "configuration",
  "schema",
  "generated",
  "lockfile",
  "binary",
  "unsupported",
])

export const changedFileUnresolvedReasonSchema = z.enum([
  "binary_file",
  "generated_file",
  "lockfile",
  "unsupported_language",
  "patch_unavailable",
  "no_changed_ranges",
  "no_enclosing_symbol",
  "indexer_unavailable",
  "indexer_failed",
  "symbol_match_ambiguous",
  "copied_file",
])

export const prDiffProvenanceSchema = z.strictObject({
  pullRequestId: pullRequestIdSchema,
  baseSha: commitShaSchema,
  headSha: commitShaSchema,
  diffHash: contentHashSchema,
})

export const changedFileSchema = z
  .strictObject({
    operation: z.enum(["added", "modified", "deleted", "renamed"]),
    oldPath: repositoryPathSchema.optional(),
    newPath: repositoryPathSchema.optional(),
    oldMode: z
      .string()
      .regex(/^[0-7]{6}$/)
      .optional(),
    newMode: z
      .string()
      .regex(/^[0-7]{6}$/)
      .optional(),
    similarity: z.number().int().min(0).max(100).optional(),
    language: languageSchema.optional(),
    classifications: z
      .array(changedFileClassificationSchema)
      .min(1)
      .max(7)
      .refine((values) => new Set(values).size === values.length, {
        message: "Changed file classifications must be unique",
      }),
    baseRanges: z.array(lineRangeSchema).max(1_000),
    headRanges: z.array(lineRangeSchema).max(1_000),
    binary: z.boolean(),
    noNewlineAtEnd: z.boolean(),
    mappingStatus: z.enum([
      "mapped",
      "partially_mapped",
      "unmapped",
      "not_applicable",
    ]),
    baseSymbolIds: z.array(codeSymbolIdSchema).max(500),
    headSymbolIds: z.array(codeSymbolIdSchema).max(500),
    unresolvedReasons: z
      .array(changedFileUnresolvedReasonSchema)
      .max(11)
      .refine((values) => new Set(values).size === values.length, {
        message: "Changed file unresolved reasons must be unique",
      }),
    provenance: prDiffProvenanceSchema,
  })
  .superRefine((value, context) => {
    if (value.operation === "added") {
      if (
        value.oldPath !== undefined ||
        value.baseRanges.length > 0 ||
        value.baseSymbolIds.length > 0
      ) {
        context.addIssue({
          code: "custom",
          message: "Added files cannot contain base-side evidence",
        })
      }
      if (value.newPath === undefined) {
        context.addIssue({
          code: "custom",
          message: "Added files need newPath",
        })
      }
    } else if (value.operation === "deleted") {
      if (
        value.newPath !== undefined ||
        value.headRanges.length > 0 ||
        value.headSymbolIds.length > 0
      ) {
        context.addIssue({
          code: "custom",
          message: "Deleted files cannot contain head-side evidence",
        })
      }
      if (value.oldPath === undefined) {
        context.addIssue({
          code: "custom",
          message: "Deleted files need oldPath",
        })
      }
    } else {
      if (value.oldPath === undefined || value.newPath === undefined) {
        context.addIssue({
          code: "custom",
          message: `${value.operation} files need both paths`,
        })
      } else if (
        value.operation === "modified" &&
        value.oldPath !== value.newPath
      ) {
        context.addIssue({
          code: "custom",
          message: "Modified file paths must match",
        })
      } else if (
        value.operation === "renamed" &&
        value.oldPath === value.newPath
      ) {
        context.addIssue({
          code: "custom",
          message: "Renamed file paths must differ",
        })
      }
    }
    if (
      value.mappingStatus === "mapped" &&
      value.unresolvedReasons.length > 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Mapped files cannot contain unresolved reasons",
        path: ["unresolvedReasons"],
      })
    }
    if (
      value.mappingStatus === "unmapped" &&
      value.unresolvedReasons.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Unmapped files require an unresolved reason",
        path: ["unresolvedReasons"],
      })
    }
  })

export const changedSymbolSideSchema = z.strictObject({
  id: codeSymbolIdSchema,
  filePath: repositoryPathSchema,
  qualifiedName: nonEmptyStringSchema,
  name: shortTextSchema,
  kind: reasonCodeSchema,
  language: languageSchema,
  range: lineRangeSchema,
  parentSymbolIds: z.array(codeSymbolIdSchema).max(32),
  contentHash: contentHashSchema,
})

export const changedSymbolSchema = z
  .strictObject({
    operation: z.enum(["added", "modified", "deleted", "renamed", "moved"]),
    base: changedSymbolSideSchema.optional(),
    head: changedSymbolSideSchema.optional(),
    baseRanges: z.array(lineRangeSchema).max(1_000),
    headRanges: z.array(lineRangeSchema).max(1_000),
    matchStrategy: z.enum([
      "unmatched",
      "same_structure",
      "git_rename_structure",
      "unique_exact_content",
    ]),
    unresolvedReasons: z
      .array(changedFileUnresolvedReasonSchema)
      .max(11)
      .refine((values) => new Set(values).size === values.length, {
        message: "Changed symbol unresolved reasons must be unique",
      }),
    provenance: prDiffProvenanceSchema,
  })
  .superRefine((value, context) => {
    if (
      value.operation === "added" &&
      (value.base !== undefined ||
        value.head === undefined ||
        value.baseRanges.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Added symbols are head-only",
      })
    }
    if (
      value.operation === "deleted" &&
      (value.base === undefined ||
        value.head !== undefined ||
        value.headRanges.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Deleted symbols are base-only",
      })
    }
    if (
      value.operation !== "added" &&
      value.operation !== "deleted" &&
      (value.base === undefined || value.head === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: `${value.operation} symbols require both sides`,
      })
    }
    if (
      (value.operation === "renamed" || value.operation === "moved") &&
      value.base !== undefined &&
      value.head !== undefined &&
      value.base.filePath === value.head.filePath
    ) {
      context.addIssue({
        code: "custom",
        message: `${value.operation} symbols must change paths`,
      })
    }
    if (
      value.operation === "modified" &&
      value.base !== undefined &&
      value.head !== undefined &&
      value.base.filePath !== value.head.filePath
    ) {
      context.addIssue({
        code: "custom",
        message: "Modified symbols must remain in the same path",
      })
    }
    const expectedStrategy = {
      added: "unmatched",
      deleted: "unmatched",
      modified: "same_structure",
      renamed: "git_rename_structure",
      moved: "unique_exact_content",
    }[value.operation]
    if (value.matchStrategy !== expectedStrategy) {
      context.addIssue({
        code: "custom",
        message: `${value.operation} symbols require ${expectedStrategy} matching`,
        path: ["matchStrategy"],
      })
    }
  })

export const prDiffAnalysisSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    pullRequestId: pullRequestIdSchema,
    repository: repositoryIdentitySchema,
    baseSha: commitShaSchema,
    headSha: commitShaSchema,
    diffHash: contentHashSchema,
    ancestry: z.literal("base_is_ancestor"),
    baseline: baselineCompatibilitySchema,
    files: z.array(changedFileSchema).max(10_000),
    symbols: z.array(changedSymbolSchema).max(100_000),
    summary: z.strictObject({
      fileCount: z.number().int().nonnegative(),
      symbolCount: z.number().int().nonnegative(),
      mappedFileCount: z.number().int().nonnegative(),
      unmappedFileCount: z.number().int().nonnegative(),
    }),
  })
  .superRefine((value, context) => {
    if (value.baseline.baseSha !== value.baseSha) {
      context.addIssue({
        code: "custom",
        message: "Baseline compatibility must reference the analysis base",
        path: ["baseline", "baseSha"],
      })
    }
    const expectedProvenance = {
      pullRequestId: value.pullRequestId,
      baseSha: value.baseSha,
      headSha: value.headSha,
      diffHash: value.diffHash,
    }
    for (const [collectionName, records] of [
      ["files", value.files],
      ["symbols", value.symbols],
    ] as const) {
      for (const [index, record] of records.entries()) {
        if (
          record.provenance.pullRequestId !==
            expectedProvenance.pullRequestId ||
          record.provenance.baseSha !== expectedProvenance.baseSha ||
          record.provenance.headSha !== expectedProvenance.headSha ||
          record.provenance.diffHash !== expectedProvenance.diffHash
        ) {
          context.addIssue({
            code: "custom",
            message: "PR diff record provenance does not match its analysis",
            path: [collectionName, index, "provenance"],
          })
        }
      }
    }
    const mappedFileCount = value.files.filter(
      ({ mappingStatus }) => mappingStatus === "mapped"
    ).length
    const unmappedFileCount = value.files.filter(
      ({ mappingStatus }) => mappingStatus === "unmapped"
    ).length
    const expectedSummary = {
      fileCount: value.files.length,
      symbolCount: value.symbols.length,
      mappedFileCount,
      unmappedFileCount,
    }
    for (const [field, expected] of Object.entries(expectedSummary)) {
      if (value.summary[field as keyof typeof expectedSummary] !== expected) {
        context.addIssue({
          code: "custom",
          message: `PR diff summary ${field} is inconsistent`,
          path: ["summary", field],
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
export type BaselineCompatibility = z.infer<typeof baselineCompatibilitySchema>
export type ChangedFile = z.infer<typeof changedFileSchema>
export type ChangedSymbolSide = z.infer<typeof changedSymbolSideSchema>
export type ChangedSymbol = z.infer<typeof changedSymbolSchema>
export type PrDiffAnalysis = z.infer<typeof prDiffAnalysisSchema>
export type AssessmentFinding = z.infer<typeof assessmentFindingSchema>
export type VerificationResult = z.infer<typeof verificationResultSchema>
