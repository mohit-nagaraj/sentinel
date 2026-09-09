import { z } from "zod"

import {
  databaseApplicationIdSchema,
  databaseInterruptIdSchema,
  databaseRunIdSchema,
} from "./run-control.ts"
import {
  artifactIdSchema,
  commitShaSchema,
  contentHashSchema,
  evidenceIdSchema,
  evidenceTierSchema,
  entityKindSchema,
  persistedTextSchema,
  reasonCodeSchema,
  reviewStateSchema,
  schemaVersionSchema,
  sourceUriSchema,
  stableEntityIdSchema,
  timestampSchema,
} from "./primitives.ts"
import { applicationStatusSchema, sourceKindSchema } from "./operations.ts"

export const knowledgeCoverageStatusSchema = z.enum([
  "observed",
  "partially_observed",
  "not_observed",
  "blocked",
  "not_evaluated",
  "ambiguous",
])

export const knowledgePageLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(50)
  .default(20)

export const knowledgeCursorSchema = z.string().trim().min(1).max(512)

export const knowledgeSourceSchema = z.strictObject({
  id: stableEntityIdSchema,
  kind: sourceKindSchema,
  uri: sourceUriSchema,
  status: z.enum(["pending", "ready", "warning", "blocked", "failed"]),
  freshness: z.enum(["current", "stale", "unknown"]),
  checkedAt: timestampSchema.optional(),
})

export const knowledgeCountsSchema = z.strictObject({
  requirements: z.number().int().nonnegative(),
  workflows: z.number().int().nonnegative(),
  screens: z.number().int().nonnegative(),
  uiElements: z.number().int().nonnegative(),
  apiEndpoints: z.number().int().nonnegative(),
  codeSymbols: z.number().int().nonnegative(),
  ambiguousLinks: z.number().int().nonnegative(),
  pendingReviews: z.number().int().nonnegative(),
})

export const knowledgeOverviewSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  application: z.strictObject({
    id: databaseApplicationIdSchema,
    name: z.string().trim().min(1).max(512),
    deploymentUrl: z.url({ protocol: /^https?$/ }),
    status: applicationStatusSchema,
    indexedCommitSha: commitShaSchema.optional(),
    graphRevision: z.number().int().nonnegative(),
    refreshedAt: timestampSchema.optional(),
    stale: z.boolean(),
  }),
  sources: z.array(knowledgeSourceSchema).max(100),
  counts: knowledgeCountsSchema,
  lastSuccessfulRunAt: timestampSchema.optional(),
})

export const coverageItemSchema = z.strictObject({
  requirementId: stableEntityIdSchema.refine((value) =>
    value.startsWith("requirement:v1:")
  ),
  statement: persistedTextSchema,
  actor: z.string().trim().min(1).max(512).optional(),
  capability: z.string().trim().min(1).max(512),
  status: knowledgeCoverageStatusSchema,
  summary: persistedTextSchema,
  scope: persistedTextSchema.optional(),
  possibleCauses: z.array(persistedTextSchema).max(10),
  reviewerActions: z.array(persistedTextSchema).max(10),
  workflowCount: z.number().int().nonnegative(),
  evidenceTiers: z.array(evidenceTierSchema).max(4),
  stale: z.boolean(),
})

export const coveragePageSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  items: z.array(coverageItemSchema).max(50),
  nextCursor: knowledgeCursorSchema.optional(),
})

export const workflowCoverageItemSchema = z.strictObject({
  workflowId: stableEntityIdSchema.refine((value) =>
    value.startsWith("workflow:v1:")
  ),
  name: z.string().trim().min(1).max(512),
  actor: z.string().trim().min(1).max(512),
  requirementCount: z.number().int().nonnegative(),
  screenCount: z.number().int().nonnegative(),
  stepCount: z.number().int().nonnegative(),
  status: z.enum(["observed", "partial", "unlinked"]),
  stale: z.boolean(),
})

export const workflowCoveragePageSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  items: z.array(workflowCoverageItemSchema).max(50),
  nextCursor: knowledgeCursorSchema.optional(),
})

export const evidencePathNodeKindSchema = z.enum([
  "document-section",
  "requirement",
  "workflow",
  "flow-step",
  "screen",
  "ui-element",
  "frontend-route",
  "api-endpoint",
  "code-symbol",
  "domain-entity",
])

export const evidencePathNodeSchema = z.strictObject({
  id: stableEntityIdSchema,
  kind: evidencePathNodeKindSchema,
  label: z.string().trim().min(1).max(512),
  detail: persistedTextSchema.optional(),
  sourceUri: sourceUriSchema.optional(),
  artifactId: artifactIdSchema.optional(),
})

export const evidencePathLinkSchema = z.strictObject({
  id: evidenceIdSchema,
  relationship: reasonCodeSchema,
  tier: evidenceTierSchema,
  reviewState: reviewStateSchema,
  extractionMethod: z.string().trim().min(1).max(128),
  sourceIdentityHash: contentHashSchema,
  sourceCommitSha: commitShaSchema.optional(),
  sourceRunId: z.string().trim().min(1).max(512).optional(),
  capturedAt: timestampSchema.optional(),
  explanation: persistedTextSchema,
  sourceUri: sourceUriSchema.optional(),
  artifactId: artifactIdSchema.optional(),
  stale: z.boolean(),
})

export const evidencePathSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: z.string().trim().min(1).max(512),
    requirementId: stableEntityIdSchema.refine((value) =>
      value.startsWith("requirement:v1:")
    ),
    complete: z.boolean(),
    nodes: z.array(evidencePathNodeSchema).min(2).max(12),
    links: z.array(evidencePathLinkSchema).min(1).max(11),
  })
  .superRefine((path, context) => {
    if (path.links.length !== path.nodes.length - 1) {
      context.addIssue({
        code: "custom",
        path: ["links"],
        message: "Evidence paths require exactly one link between each node",
      })
    }
  })

export const knowledgeGraphNodeSchema = z.strictObject({
  id: stableEntityIdSchema,
  kind: entityKindSchema,
  label: z.string().trim().min(1).max(512),
  detail: persistedTextSchema.optional(),
  tier: evidenceTierSchema.exclude(["D"]),
  reviewState: reviewStateSchema,
  stale: z.boolean(),
})

export const knowledgeGraphRelationshipSchema = z.strictObject({
  id: evidenceIdSchema,
  fromId: stableEntityIdSchema,
  toId: stableEntityIdSchema,
  relationship: reasonCodeSchema,
  tier: evidenceTierSchema.exclude(["D"]),
  reviewState: reviewStateSchema,
  stale: z.boolean(),
})

export const knowledgeGraphSearchResultSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  items: z.array(knowledgeGraphNodeSchema).max(50),
})

export const knowledgeGraphNeighborhoodSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  seedId: stableEntityIdSchema,
  nodes: z.array(knowledgeGraphNodeSchema).min(1).max(200),
  relationships: z.array(knowledgeGraphRelationshipSchema).max(400),
  truncated: z.boolean(),
})

export const linkReviewRecordSchema = z.strictObject({
  id: databaseInterruptIdSchema,
  decision: z.enum(["accepted", "rejected"]),
  reason: persistedTextSchema,
  sourceIdentityHash: contentHashSchema,
  decidedAt: timestampSchema,
  stale: z.boolean(),
})

export const linkReviewItemSchema = z.strictObject({
  kind: z.literal("link"),
  id: evidenceIdSchema,
  relationship: reasonCodeSchema,
  title: z.string().trim().min(1).max(512),
  summary: persistedTextSchema,
  tier: evidenceTierSchema,
  sourceIdentityHash: contentHashSchema,
  from: evidencePathNodeSchema,
  to: evidencePathNodeSchema,
  competingEvidence: z.array(evidencePathLinkSchema).max(10),
  currentReview: linkReviewRecordSchema.optional(),
  previousReviews: z.array(linkReviewRecordSchema).max(20),
})

export const interruptReviewItemSchema = z.strictObject({
  kind: z.literal("interrupt"),
  id: databaseInterruptIdSchema,
  runId: databaseRunIdSchema,
  decisionId: reasonCodeSchema,
  title: z.string().trim().min(1).max(512),
  summary: persistedTextSchema,
  createdAt: timestampSchema,
  status: z.enum(["pending", "responded"]),
})

export const knowledgeReviewItemSchema = z.discriminatedUnion("kind", [
  linkReviewItemSchema,
  interruptReviewItemSchema,
])

export const knowledgeReviewPageSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  items: z.array(knowledgeReviewItemSchema).max(50),
  nextCursor: knowledgeCursorSchema.optional(),
})

export const knowledgeReviewDecisionSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  decision: z.enum(["accepted", "rejected"]),
  reason: persistedTextSchema.min(3),
  sourceIdentityHash: contentHashSchema.optional(),
})

export const knowledgeReviewDecisionResultSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  idempotent: z.boolean(),
  item: knowledgeReviewItemSchema,
})

export const privateArtifactExcerptSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  artifactId: artifactIdSchema,
  mimeType: z.enum([
    "application/json",
    "text/html",
    "text/markdown",
    "text/plain",
  ]),
  excerpt: persistedTextSchema,
  truncated: z.boolean(),
})

export type KnowledgeCoverageStatus = z.infer<
  typeof knowledgeCoverageStatusSchema
>
export type KnowledgeOverview = z.infer<typeof knowledgeOverviewSchema>
export type KnowledgeCounts = z.infer<typeof knowledgeCountsSchema>
export type CoverageItem = z.infer<typeof coverageItemSchema>
export type CoveragePage = z.infer<typeof coveragePageSchema>
export type WorkflowCoverageItem = z.infer<typeof workflowCoverageItemSchema>
export type WorkflowCoveragePage = z.infer<typeof workflowCoveragePageSchema>
export type EvidencePath = z.infer<typeof evidencePathSchema>
export type EvidencePathNode = z.infer<typeof evidencePathNodeSchema>
export type EvidencePathLink = z.infer<typeof evidencePathLinkSchema>
export type KnowledgeGraphNode = z.infer<typeof knowledgeGraphNodeSchema>
export type KnowledgeGraphRelationship = z.infer<
  typeof knowledgeGraphRelationshipSchema
>
export type KnowledgeGraphSearchResult = z.infer<
  typeof knowledgeGraphSearchResultSchema
>
export type KnowledgeGraphNeighborhood = z.infer<
  typeof knowledgeGraphNeighborhoodSchema
>
export type LinkReviewRecord = z.infer<typeof linkReviewRecordSchema>
export type LinkReviewItem = z.infer<typeof linkReviewItemSchema>
export type InterruptReviewItem = z.infer<typeof interruptReviewItemSchema>
export type KnowledgeReviewItem = z.infer<typeof knowledgeReviewItemSchema>
export type KnowledgeReviewPage = z.infer<typeof knowledgeReviewPageSchema>
export type KnowledgeReviewDecision = z.infer<
  typeof knowledgeReviewDecisionSchema
>
export type PrivateArtifactExcerpt = z.infer<
  typeof privateArtifactExcerptSchema
>
