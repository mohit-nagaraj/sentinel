import { z } from "zod"

import {
  changedFileClassificationSchema,
  evidenceRelationshipSchema,
} from "./assessment.ts"
import { deploymentValidationResultSchema } from "./deployment-verification.ts"
import { discoveryMissionSchema, missionBudgetSchema } from "./operations.ts"
import {
  applicationIdSchema,
  artifactIdSchema,
  commitShaSchema,
  contentHashSchema,
  entityKindSchema,
  evidenceIdSchema,
  evidenceTierSchema,
  missionIdSchema,
  persistedTextSchema,
  repositoryIdentitySchema,
  repositoryPathSchema,
  reviewStateSchema,
  runIdSchema,
  schemaVersionSchema,
  sourceUriSchema,
  stableEntityIdSchema,
  timestampSchema,
} from "./primitives.ts"
import {
  MAX_GRAPH_REPLACEMENT_SCOPE,
  graphPublicationInputSchema,
  graphPublicationSummarySchema,
} from "./graph-publication.ts"

export const REFRESH_KNOWLEDGE_POLICY_VERSION =
  "refresh-knowledge-policy-v1" as const

function uniqueSorted<T extends z.ZodType>(schema: T, maximum: number) {
  return z
    .array(schema)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, {
      message: "Values must be unique",
    })
    .refine(
      (values) =>
        values.every(
          (value, index) =>
            index === 0 || String(values[index - 1]) <= String(value)
        ),
      { message: "Values must use deterministic ordering" }
    )
}

export const refreshKnowledgeStartInputSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    policyVersion: z.literal(REFRESH_KNOWLEDGE_POLICY_VERSION),
    applicationId: applicationIdSchema,
    runId: runIdSchema,
    repository: repositoryIdentitySchema,
    activeCommitSha: commitShaSchema,
    targetCommitSha: commitShaSchema,
    expectedGraphRevision: z.number().int().positive(),
    graphRevision: z.number().int().positive(),
    inputFingerprint: contentHashSchema,
    budget: missionBudgetSchema,
    startedAt: timestampSchema,
  })
  .superRefine((input, context) => {
    if (input.activeCommitSha === input.targetCommitSha) {
      context.addIssue({
        code: "custom",
        path: ["targetCommitSha"],
        message: "A refresh target must differ from the active commit",
      })
    }
    if (input.graphRevision !== input.expectedGraphRevision + 1) {
      context.addIssue({
        code: "custom",
        path: ["graphRevision"],
        message: "A refresh must target the next graph revision",
      })
    }
  })

export const refreshContextValidationSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: contentHashSchema,
    applicationId: applicationIdSchema,
    activeCommitSha: commitShaSchema,
    targetCommitSha: commitShaSchema,
    activeGraphRevision: z.number().int().positive(),
    activeGraphMatches: z.boolean(),
    relationship: z.enum(["descendant", "same", "unrelated", "unknown"]),
    deployment: deploymentValidationResultSchema,
    status: z.enum(["ready", "denied"]),
    reason: z.enum([
      "refresh_ready",
      "active_graph_mismatch",
      "deployment_not_ready",
      "target_not_descendant",
    ]),
    actionRequired: persistedTextSchema.optional(),
    validatedAt: timestampSchema,
  })
  .superRefine((result, context) => {
    if (result.deployment.applicationId !== result.applicationId) {
      context.addIssue({
        code: "custom",
        path: ["deployment", "applicationId"],
        message: "Refresh deployment validation cannot cross applications",
      })
    }
    const deploymentReady =
      result.deployment.purpose === "post_deployment_refresh" &&
      result.deployment.expectedCommitSha === result.targetCommitSha &&
      result.deployment.identityState === "exact" &&
      result.deployment.trustState === "trusted" &&
      result.deployment.readinessState === "ready" &&
      result.deployment.reason === "deployment_ready"
    const ready =
      result.activeGraphMatches &&
      result.relationship === "descendant" &&
      deploymentReady
    if ((result.status === "ready") !== ready) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Refresh readiness must match graph, ancestry, and deployment identity",
      })
    }
    if (result.status === "ready") {
      if (
        result.reason !== "refresh_ready" ||
        result.actionRequired !== undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: "Ready refresh validation cannot require operator action",
        })
      }
    } else if (
      result.reason === "refresh_ready" ||
      result.actionRequired === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["actionRequired"],
        message: "Denied refresh validation requires an actionable reason",
      })
    }
  })

export const refreshChangedFileSchema = z
  .strictObject({
    operation: z.enum(["added", "modified", "deleted", "renamed"]),
    oldPath: repositoryPathSchema.optional(),
    newPath: repositoryPathSchema.optional(),
    classifications: uniqueSorted(changedFileClassificationSchema, 7),
    contentHash: contentHashSchema.optional(),
  })
  .superRefine((file, context) => {
    const oldRequired = ["modified", "deleted", "renamed"].includes(
      file.operation
    )
    const newRequired = ["added", "modified", "renamed"].includes(
      file.operation
    )
    if (oldRequired !== (file.oldPath !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["oldPath"],
        message: `oldPath does not match ${file.operation} semantics`,
      })
    }
    if (newRequired !== (file.newPath !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["newPath"],
        message: `newPath does not match ${file.operation} semantics`,
      })
    }
    if (file.operation === "modified" && file.oldPath !== file.newPath) {
      context.addIssue({
        code: "custom",
        path: ["newPath"],
        message: "Modified files must retain their path",
      })
    }
    if (file.operation === "renamed" && file.oldPath === file.newPath) {
      context.addIssue({
        code: "custom",
        path: ["newPath"],
        message: "Renamed files require distinct paths",
      })
    }
  })

export const refreshChangeSetSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: contentHashSchema,
    baseSha: commitShaSchema,
    targetSha: commitShaSchema,
    files: z.array(refreshChangedFileSchema).max(10_000),
    complete: z.boolean(),
    warnings: z.array(persistedTextSchema).max(100),
  })
  .superRefine((changeSet, context) => {
    const keys = changeSet.files.map(
      (file) => `${file.oldPath ?? ""}\u0000${file.newPath ?? ""}`
    )
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "Changed file identities must be unique",
      })
    }
    if (keys.some((key, index) => index > 0 && keys[index - 1]! > key)) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "Changed files must use deterministic ordering",
      })
    }
  })

export const refreshGraphEntitySchema = z.strictObject({
  id: stableEntityIdSchema,
  kind: entityKindSchema,
  sourcePaths: uniqueSorted(repositoryPathSchema, 100),
  sourceUris: uniqueSorted(sourceUriSchema, 100),
  dependsOnIds: uniqueSorted(stableEntityIdSchema, 500),
  evidenceIds: uniqueSorted(evidenceIdSchema, 100),
  stale: z.boolean(),
})

export const refreshGraphLinkSchema = z.strictObject({
  id: evidenceIdSchema,
  fromId: stableEntityIdSchema,
  toId: stableEntityIdSchema,
  relationship: evidenceRelationshipSchema,
  evidenceTier: evidenceTierSchema,
  reviewState: reviewStateSchema,
  sourceIdentityHash: contentHashSchema,
  sourcePaths: uniqueSorted(repositoryPathSchema, 100),
  sourceUris: uniqueSorted(sourceUriSchema, 100),
  evidenceIds: uniqueSorted(evidenceIdSchema, 100),
})

export const immutableAssessmentReferenceSchema = z.strictObject({
  assessmentId: z.uuid(),
  evidenceIds: uniqueSorted(evidenceIdSchema, 1_000),
  artifactIds: uniqueSorted(artifactIdSchema, 1_000),
})

export const refreshGraphInventorySchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: contentHashSchema,
    applicationId: applicationIdSchema,
    graphRevision: z.number().int().positive(),
    indexedCommitSha: commitShaSchema,
    entities: z.array(refreshGraphEntitySchema).max(100_000),
    links: z.array(refreshGraphLinkSchema).max(100_000),
    immutableAssessments: z
      .array(immutableAssessmentReferenceSchema)
      .max(10_000),
  })
  .superRefine((inventory, context) => {
    for (const [field, ids] of [
      ["entities", inventory.entities.map(({ id }) => id)],
      ["links", inventory.links.map(({ id }) => id)],
    ] as const) {
      const stringIds = ids.map(String)
      if (new Set(stringIds).size !== stringIds.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} identities must be unique`,
        })
      }
      if (
        stringIds.some((id, index) => index > 0 && stringIds[index - 1]! > id)
      ) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must use deterministic ordering`,
        })
      }
    }
  })

export const refreshSourceScopeSchema = z.strictObject({
  documentationPaths: uniqueSorted(repositoryPathSchema, 10_000),
  typeScriptPaths: uniqueSorted(repositoryPathSchema, 10_000),
  phpPaths: uniqueSorted(repositoryPathSchema, 10_000),
  openApiPaths: uniqueSorted(repositoryPathSchema, 10_000),
  configurationPaths: uniqueSorted(repositoryPathSchema, 10_000),
  removedPaths: uniqueSorted(repositoryPathSchema, 10_000),
  sourceUris: uniqueSorted(sourceUriSchema, 1_000),
})

export const refreshScopePlanSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: contentHashSchema,
  applicationId: applicationIdSchema,
  runId: runIdSchema,
  activeCommitSha: commitShaSchema,
  targetCommitSha: commitShaSchema,
  expectedGraphRevision: z.number().int().positive(),
  graphRevision: z.number().int().positive(),
  sourceScope: refreshSourceScopeSchema,
  affectedEntityIds: uniqueSorted(stableEntityIdSchema, 100_000),
  reusedEntityIds: uniqueSorted(stableEntityIdSchema, 100_000),
  affectedWorkflowIds: uniqueSorted(stableEntityIdSchema, 20_000),
  reassessRequirementIds: uniqueSorted(stableEntityIdSchema, 20_000),
  invalidatedLinkIds: uniqueSorted(evidenceIdSchema, 100_000),
  reusableReviewedLinkIds: uniqueSorted(evidenceIdSchema, 100_000),
  replacementStableKeys: uniqueSorted(
    z.union([stableEntityIdSchema, evidenceIdSchema]),
    MAX_GRAPH_REPLACEMENT_SCOPE
  ),
  missions: z.array(discoveryMissionSchema).max(3),
  immutableAssessmentIds: uniqueSorted(z.uuid(), 10_000),
  retainedEvidenceIds: uniqueSorted(evidenceIdSchema, 20_000),
  retainedArtifactIds: uniqueSorted(artifactIdSchema, 20_000),
  warnings: z.array(persistedTextSchema).max(100),
  requiresPublication: z.boolean(),
})

export const refreshSourceMapResultSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: contentHashSchema,
  planId: contentHashSchema,
  targetCommitSha: commitShaSchema,
  indexedPaths: uniqueSorted(repositoryPathSchema, 50_000),
  removedEntityIds: uniqueSorted(stableEntityIdSchema, 100_000),
  nodeIds: uniqueSorted(stableEntityIdSchema, 100_000),
  linkIds: uniqueSorted(evidenceIdSchema, 100_000),
  evidenceIds: uniqueSorted(evidenceIdSchema, 100_000),
  unresolvedPaths: uniqueSorted(repositoryPathSchema, 10_000),
  warnings: z.array(persistedTextSchema).max(100),
})

export const refreshMissionReceiptSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  missionId: missionIdSchema,
  agent: z.enum(["documentation", "code", "application"]),
  resultId: contentHashSchema,
  status: z.enum(["succeeded", "unresolved"]),
  factIds: uniqueSorted(stableEntityIdSchema, 10_000),
  linkIds: uniqueSorted(evidenceIdSchema, 10_000),
  evidenceIds: uniqueSorted(evidenceIdSchema, 10_000),
  warnings: z.array(persistedTextSchema).max(100),
  budgetUsed: missionBudgetSchema,
})

export const refreshRetentionReceiptSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: contentHashSchema,
  planId: contentHashSchema,
  assessmentIds: uniqueSorted(z.uuid(), 10_000),
  evidenceIds: uniqueSorted(evidenceIdSchema, 20_000),
  artifactIds: uniqueSorted(artifactIdSchema, 20_000),
  retainedAt: timestampSchema,
})

export const refreshReconciliationSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: contentHashSchema,
    planId: contentHashSchema,
    sourceMapResultId: contentHashSchema,
    missionResultIds: uniqueSorted(contentHashSchema, 3),
    publication: graphPublicationInputSchema,
    coverageReassessedRequirementIds: uniqueSorted(
      stableEntityIdSchema,
      20_000
    ),
    retainedArtifactIds: uniqueSorted(artifactIdSchema, 20_000),
    unresolved: z.array(persistedTextSchema).max(1_000),
    warnings: z.array(persistedTextSchema).max(100),
  })
  .superRefine((result, context) => {
    if (result.publication.replacement.kind !== "affected") {
      context.addIssue({
        code: "custom",
        path: ["publication", "replacement"],
        message: "Incremental refresh must use affected graph replacement",
      })
    }
  })

export const refreshKnowledgeSummarySchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    applicationId: applicationIdSchema,
    runId: runIdSchema,
    status: z.enum(["completed", "denied"]),
    activeCommitSha: commitShaSchema,
    targetCommitSha: commitShaSchema,
    graphRevision: z.number().int().positive(),
    affectedEntityCount: z.number().int().nonnegative(),
    reusedEntityCount: z.number().int().nonnegative(),
    invalidatedLinkCount: z.number().int().nonnegative(),
    reassessedRequirementCount: z.number().int().nonnegative(),
    specialistMissionCount: z.number().int().nonnegative(),
    retainedEvidenceCount: z.number().int().nonnegative(),
    retainedArtifactCount: z.number().int().nonnegative(),
    warnings: z.array(persistedTextSchema).max(200),
    freshness: z.enum(["current", "unchanged"]),
    publication: graphPublicationSummarySchema.optional(),
    reason: persistedTextSchema.optional(),
    completedAt: timestampSchema,
  })
  .superRefine((summary, context) => {
    if (summary.status === "completed") {
      if (
        summary.publication === undefined ||
        summary.freshness !== "current" ||
        summary.reason !== undefined ||
        summary.publication.applicationId !== summary.applicationId ||
        summary.publication.runId !== summary.runId ||
        summary.publication.indexedCommitSha !== summary.targetCommitSha ||
        summary.publication.graphRevision !== summary.graphRevision
      ) {
        context.addIssue({
          code: "custom",
          path: ["publication"],
          message:
            "Completed refreshes require the matching active publication",
        })
      }
    } else if (
      summary.publication !== undefined ||
      summary.freshness !== "unchanged" ||
      summary.reason === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Denied refreshes must leave freshness unchanged and explain why",
      })
    }
  })

export type RefreshKnowledgeStartInput = z.infer<
  typeof refreshKnowledgeStartInputSchema
>
export type RefreshContextValidation = z.infer<
  typeof refreshContextValidationSchema
>
export type RefreshChangedFile = z.infer<typeof refreshChangedFileSchema>
export type RefreshChangeSet = z.infer<typeof refreshChangeSetSchema>
export type RefreshGraphEntity = z.infer<typeof refreshGraphEntitySchema>
export type RefreshGraphLink = z.infer<typeof refreshGraphLinkSchema>
export type RefreshGraphInventory = z.infer<typeof refreshGraphInventorySchema>
export type RefreshSourceScope = z.infer<typeof refreshSourceScopeSchema>
export type RefreshScopePlan = z.infer<typeof refreshScopePlanSchema>
export type RefreshSourceMapResult = z.infer<
  typeof refreshSourceMapResultSchema
>
export type RefreshMissionReceipt = z.infer<typeof refreshMissionReceiptSchema>
export type RefreshRetentionReceipt = z.infer<
  typeof refreshRetentionReceiptSchema
>
export type RefreshReconciliation = z.infer<typeof refreshReconciliationSchema>
export type RefreshKnowledgeSummary = z.infer<
  typeof refreshKnowledgeSummarySchema
>
