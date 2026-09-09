import { z } from "zod"

import {
  evidenceLinkSchema,
  evidenceRelationshipSchema,
  pullRequestSchema,
} from "./assessment.ts"
import {
  coverageAssessmentGraphFactSchema,
  coverageStatusSchema,
} from "./coverage.ts"
import { linkEvidenceRecordSchema } from "./evidence-linking.ts"
import {
  apiEndpointFactSchema,
  capabilityFactSchema,
  codeFileFactSchema,
  codeSymbolFactSchema,
  documentPageFactSchema,
  documentSectionFactSchema,
  documentSourceFactSchema,
  domainEntityFactSchema,
  flowStepFactSchema,
  frontendRouteFactSchema,
  requirementCandidateSchema,
  screenFactSchema,
  uiElementFactSchema,
  workflowFactSchema,
} from "./facts.ts"
import {
  applicationIdSchema,
  commitShaSchema,
  contentHashSchema,
  entityKindSchema,
  evidenceIdSchema,
  evidenceTierSchema,
  persistedTextSchema,
  provenanceSchema,
  reasonCodeSchema,
  reviewStateSchema,
  runIdSchema,
  schemaVersionSchema,
  shortTextSchema,
  stableEntityIdSchema,
  timestampSchema,
} from "./primitives.ts"

export const MAX_GRAPH_PUBLICATION_BATCH_SIZE = 1_000 as const
export const MAX_GRAPH_QUERY_DEPTH = 12 as const
export const MAX_GRAPH_QUERY_RESULTS = 200 as const
export const MAX_PR_GRAPH_QUERY_SEEDS = 500 as const

const acceptedEvidenceTierSchema = evidenceTierSchema.exclude(["D"])
const graphIdentitySchema = z.union([stableEntityIdSchema, evidenceIdSchema])

export const graphApplicationFactSchema = z
  .strictObject({
    id: applicationIdSchema,
    applicationId: applicationIdSchema,
    name: shortTextSchema,
    indexedCommitSha: commitShaSchema,
  })
  .refine(({ applicationId, id }) => applicationId === id, {
    message: "The graph application root must use its application namespace",
    path: ["id"],
  })

const publicationNodeMetadata = {
  extractionMethod: reasonCodeSchema,
  evidenceTier: acceptedEvidenceTierSchema,
  evidenceIds: z
    .array(evidenceIdSchema)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Node evidence IDs must be unique",
    }),
  provenance: provenanceSchema,
  reviewState: reviewStateSchema,
}

function publicationNodeVariant<
  const Kind extends z.infer<typeof entityKindSchema>,
  Fact extends z.ZodType,
>(kind: Kind, fact: Fact) {
  return z.strictObject({
    kind: z.literal(kind),
    fact,
    ...publicationNodeMetadata,
  })
}

export const graphPublicationNodeSchema = z
  .discriminatedUnion("kind", [
    publicationNodeVariant("application", graphApplicationFactSchema),
    publicationNodeVariant("document-source", documentSourceFactSchema),
    publicationNodeVariant("document-page", documentPageFactSchema),
    publicationNodeVariant("document-section", documentSectionFactSchema),
    publicationNodeVariant("requirement", requirementCandidateSchema),
    publicationNodeVariant("capability", capabilityFactSchema),
    publicationNodeVariant("workflow", workflowFactSchema),
    publicationNodeVariant("flow-step", flowStepFactSchema),
    publicationNodeVariant("screen", screenFactSchema),
    publicationNodeVariant("ui-element", uiElementFactSchema),
    publicationNodeVariant("frontend-route", frontendRouteFactSchema),
    publicationNodeVariant("code-file", codeFileFactSchema),
    publicationNodeVariant("code-symbol", codeSymbolFactSchema),
    publicationNodeVariant("api-endpoint", apiEndpointFactSchema),
    publicationNodeVariant("domain-entity", domainEntityFactSchema),
    publicationNodeVariant(
      "coverage-assessment",
      coverageAssessmentGraphFactSchema
    ),
    publicationNodeVariant("pull-request", pullRequestSchema),
  ])
  .superRefine((node, context) => {
    if (node.evidenceTier === "C" && node.reviewState !== "accepted") {
      context.addIssue({
        code: "custom",
        message: "Tier C graph nodes require an accepted human review",
        path: ["reviewState"],
      })
    }
    if (["pending", "rejected"].includes(node.reviewState)) {
      context.addIssue({
        code: "custom",
        message: "Pending or rejected nodes cannot enter a graph publication",
        path: ["reviewState"],
      })
    }
  })

export const graphReplacementScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("full") }),
  z.strictObject({
    kind: z.literal("affected"),
    stableKeys: z
      .array(graphIdentitySchema)
      .min(1)
      .max(50_000)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Affected graph identities must be unique",
      }),
  }),
])

function addOrderingIssue(
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  values: readonly string[]
): void {
  const sorted = [...values].sort()
  if (values.some((value, index) => value !== sorted[index])) {
    context.addIssue({
      code: "custom",
      message: "Graph publication collections must use deterministic ordering",
      path: [...path],
    })
  }
}

export const graphPublicationInputSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    applicationId: applicationIdSchema,
    runId: runIdSchema,
    inputFingerprint: contentHashSchema,
    indexedCommitSha: commitShaSchema,
    expectedGraphRevision: z.number().int().nonnegative(),
    graphRevision: z.number().int().positive(),
    replacement: graphReplacementScopeSchema,
    nodes: z.array(graphPublicationNodeSchema).min(1).max(100_000),
    links: z.array(evidenceLinkSchema).max(100_000),
    evidence: z.array(linkEvidenceRecordSchema).max(100_000),
    retainedEvidenceIds: z
      .array(evidenceIdSchema)
      .max(20_000)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Retained evidence IDs must be unique",
      }),
    batchSize: z
      .number()
      .int()
      .positive()
      .max(MAX_GRAPH_PUBLICATION_BATCH_SIZE)
      .default(250),
  })
  .superRefine((input, context) => {
    if (input.graphRevision !== input.expectedGraphRevision + 1) {
      context.addIssue({
        code: "custom",
        message:
          "The pending graph revision must immediately follow the active revision",
        path: ["graphRevision"],
      })
    }

    const nodeIds = input.nodes.map(({ fact }) => String(fact.id))
    const linkIds = input.links.map(({ id }) => String(id))
    const evidenceIds = input.evidence.map(({ reference }) =>
      String(reference.id)
    )
    for (const [field, ids] of [
      ["nodes", nodeIds],
      ["links", linkIds],
      ["evidence", evidenceIds],
    ] as const) {
      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: "custom",
          message: `${field} identities must be unique`,
          path: [field],
        })
      }
      addOrderingIssue(context, [field], ids)
    }
    addOrderingIssue(
      context,
      ["retainedEvidenceIds"],
      input.retainedEvidenceIds.map(String)
    )
    if (input.replacement.kind === "affected") {
      addOrderingIssue(
        context,
        ["replacement", "stableKeys"],
        input.replacement.stableKeys.map(String)
      )
    }

    const applicationRoots = input.nodes.filter(
      ({ kind }) => kind === "application"
    )
    if (applicationRoots.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "A publication requires exactly one application root",
        path: ["nodes"],
      })
    }

    for (const [index, node] of input.nodes.entries()) {
      if (node.fact.applicationId !== input.applicationId) {
        context.addIssue({
          code: "custom",
          message: "Graph nodes cannot cross application namespaces",
          path: ["nodes", index, "fact", "applicationId"],
        })
      }
      if (
        node.kind === "application" &&
        node.fact.indexedCommitSha !== input.indexedCommitSha
      ) {
        context.addIssue({
          code: "custom",
          message:
            "The application root commit must match the publication commit",
          path: ["nodes", index, "fact", "indexedCommitSha"],
        })
      }
      if (
        node.kind === "coverage-assessment" &&
        node.fact.graphRevision !== input.graphRevision
      ) {
        context.addIssue({
          code: "custom",
          message: "Coverage facts must target the pending graph revision",
          path: ["nodes", index, "fact", "graphRevision"],
        })
      }
    }

    const evidenceById = new Map(
      input.evidence.map((record) => [String(record.reference.id), record])
    )
    for (const [index, record] of input.evidence.entries()) {
      if (
        record.reference.applicationId !== input.applicationId ||
        record.reference.status !== "validated"
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Publication evidence must be validated in the active application namespace",
          path: ["evidence", index, "reference"],
        })
      }
    }

    for (const [index, link] of input.links.entries()) {
      if (link.applicationId !== input.applicationId) {
        context.addIssue({
          code: "custom",
          message: "Graph links cannot cross application namespaces",
          path: ["links", index, "applicationId"],
        })
      }
      if (link.graphRevision !== input.graphRevision) {
        context.addIssue({
          code: "custom",
          message: "Graph links must target the pending graph revision",
          path: ["links", index, "graphRevision"],
        })
      }
      if (link.evidenceTier === "D") {
        context.addIssue({
          code: "custom",
          message: "Tier D links cannot enter the current graph",
          path: ["links", index, "evidenceTier"],
        })
      }
      if (
        ["pending", "rejected"].includes(link.reviewState) ||
        (link.evidenceTier === "C" && link.reviewState !== "accepted")
      ) {
        context.addIssue({
          code: "custom",
          message: "Inferred graph links require accepted review",
          path: ["links", index, "reviewState"],
        })
      }
      for (const evidenceId of link.evidenceIds) {
        const record = evidenceById.get(String(evidenceId))
        if (record === undefined) {
          context.addIssue({
            code: "custom",
            message:
              "Every graph link evidence ID must resolve to validated provenance",
            path: ["links", index, "evidenceIds"],
          })
          continue
        }
        if (
          !record.bindings.some(
            (binding) =>
              String(binding.fromId) === String(link.fromId) &&
              binding.relationship === link.relationship &&
              String(binding.toId) === String(link.toId)
          )
        ) {
          context.addIssue({
            code: "custom",
            message:
              "Every graph link evidence record must bind the published relationship endpoints",
            path: ["links", index, "evidenceIds"],
          })
        }
      }
    }

    if (input.replacement.kind === "full") {
      const publishedNodeIds = new Set(nodeIds)
      for (const [index, link] of input.links.entries()) {
        if (
          !publishedNodeIds.has(String(link.fromId)) ||
          !publishedNodeIds.has(String(link.toId))
        ) {
          context.addIssue({
            code: "custom",
            message:
              "Full publications must contain both endpoints for every link",
            path: ["links", index],
          })
        }
      }
    }
  })

const countSchema = z.number().int().nonnegative()

export const graphPublicationSummarySchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  applicationId: applicationIdSchema,
  runId: runIdSchema,
  inputFingerprint: contentHashSchema,
  indexedCommitSha: commitShaSchema,
  expectedGraphRevision: z.number().int().nonnegative(),
  graphRevision: z.number().int().positive(),
  publicationHash: contentHashSchema,
  replacementKind: z.enum(["full", "affected"]),
  nodeCounts: z.record(entityKindSchema, countSchema),
  relationshipCounts: z.record(evidenceRelationshipSchema, countSchema),
  coverageCounts: z.record(coverageStatusSchema, countSchema),
  evidenceTierCounts: z.record(acceptedEvidenceTierSchema, countSchema),
  nodeCount: countSchema,
  relationshipCount: countSchema,
  retainedEvidenceCount: countSchema,
  publishedAt: timestampSchema,
})

export const graphReadScopeSchema = z.strictObject({
  applicationId: applicationIdSchema,
  graphRevision: z.number().int().positive(),
})

export const graphEntitySummarySchema = z.strictObject({
  id: stableEntityIdSchema,
  kind: entityKindSchema,
  title: persistedTextSchema,
  evidenceTier: acceptedEvidenceTierSchema,
  evidenceIds: z.array(evidenceIdSchema).max(100),
  provenance: provenanceSchema,
  reviewState: reviewStateSchema,
  graphRevision: z.number().int().positive(),
})

export const graphCoverageViewSchema = z.strictObject({
  ...graphEntitySummarySchema.shape,
  requirementId: stableEntityIdSchema,
  status: coverageStatusSchema,
  scope: persistedTextSchema,
  wording: persistedTextSchema,
  reasonCode: reasonCodeSchema,
})

export const graphPathEvidenceSchema = z.strictObject({
  evidenceId: evidenceIdSchema,
  extractionMethod: reasonCodeSchema,
  provenance: provenanceSchema,
})

export const graphPathRelationshipSchema = z.strictObject({
  id: evidenceIdSchema,
  type: evidenceRelationshipSchema,
  fromId: stableEntityIdSchema,
  toId: stableEntityIdSchema,
  evidenceTier: acceptedEvidenceTierSchema,
  extractionMethod: z.string().trim().min(1).max(128),
  evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
  evidence: z.array(graphPathEvidenceSchema).min(1).max(100),
  reviewState: reviewStateSchema,
  graphRevision: z.number().int().positive(),
})

export const graphEvidencePathSchema = z.strictObject({
  nodes: z
    .array(graphEntitySummarySchema)
    .min(2)
    .max(MAX_GRAPH_QUERY_DEPTH + 1),
  relationships: z
    .array(graphPathRelationshipSchema)
    .min(1)
    .max(MAX_GRAPH_QUERY_DEPTH),
})

export const graphPathQuerySchema = z.strictObject({
  ...graphReadScopeSchema.shape,
  startId: stableEntityIdSchema,
  endId: stableEntityIdSchema,
  relationshipTypes: z
    .array(evidenceRelationshipSchema)
    .min(1)
    .max(evidenceRelationshipSchema.options.length)
    .refine((values) => new Set(values).size === values.length, {
      message: "Graph relationship filters must be unique",
    }),
  evidenceTiers: z
    .array(acceptedEvidenceTierSchema)
    .min(1)
    .max(3)
    .refine((values) => new Set(values).size === values.length, {
      message: "Graph evidence tier filters must be unique",
    }),
  maxDepth: z.number().int().positive().max(MAX_GRAPH_QUERY_DEPTH).default(8),
  limit: z.number().int().positive().max(MAX_GRAPH_QUERY_RESULTS).default(20),
})

export const graphPullRequestSeedQuerySchema = z.strictObject({
  ...graphReadScopeSchema.shape,
  changedSymbolIds: z
    .array(stableEntityIdSchema)
    .min(1)
    .max(500)
    .refine(
      (ids) => ids.every((id) => String(id).startsWith("code-symbol:v1:")),
      { message: "PR graph seeds must be code symbol identities" }
    ),
  evidenceTiers: z
    .array(acceptedEvidenceTierSchema)
    .min(1)
    .max(3)
    .default(["A", "B"]),
  maxDepth: z.number().int().positive().max(MAX_GRAPH_QUERY_DEPTH).default(8),
  limit: z.number().int().positive().max(MAX_GRAPH_QUERY_RESULTS).default(50),
})

export const graphPullRequestImpactQuerySchema = z.strictObject({
  ...graphReadScopeSchema.shape,
  seedIds: z
    .array(stableEntityIdSchema)
    .min(1)
    .max(MAX_PR_GRAPH_QUERY_SEEDS)
    .refine(
      (ids) =>
        ids.every((id) =>
          [
            "code-file:v1:",
            "code-symbol:v1:",
            "api-endpoint:v1:",
            "domain-entity:v1:",
          ].some((prefix) => String(id).startsWith(prefix))
        ),
      {
        message: "PR impact seeds must be code, endpoint, or domain identities",
      }
    )
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "PR impact seed identities must be unique",
    }),
  evidenceTiers: z
    .array(acceptedEvidenceTierSchema)
    .min(1)
    .max(3)
    .default(["A", "B"]),
  maxDepth: z.number().int().positive().max(MAX_GRAPH_QUERY_DEPTH).default(8),
  limit: z.number().int().positive().max(MAX_GRAPH_QUERY_RESULTS).default(50),
})

export type GraphApplicationFact = z.infer<typeof graphApplicationFactSchema>
export type GraphPublicationNode = z.infer<typeof graphPublicationNodeSchema>
export type GraphPublicationInput = z.infer<typeof graphPublicationInputSchema>
export type GraphPublicationSummary = z.infer<
  typeof graphPublicationSummarySchema
>
export type GraphReadScope = z.infer<typeof graphReadScopeSchema>
export type GraphEntitySummary = z.infer<typeof graphEntitySummarySchema>
export type GraphCoverageView = z.infer<typeof graphCoverageViewSchema>
export type GraphPathEvidence = z.infer<typeof graphPathEvidenceSchema>
export type GraphPathRelationship = z.infer<typeof graphPathRelationshipSchema>
export type GraphEvidencePath = z.infer<typeof graphEvidencePathSchema>
export type GraphPathQuery = z.infer<typeof graphPathQuerySchema>
export type GraphPullRequestSeedQuery = z.infer<
  typeof graphPullRequestSeedQuerySchema
>
export type GraphPullRequestImpactQuery = z.infer<
  typeof graphPullRequestImpactQuerySchema
>
