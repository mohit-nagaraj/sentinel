import { z } from "zod"

import { evidenceLinkSchema, evidenceRelationshipSchema } from "./assessment.ts"
import {
  apiEndpointFactSchema,
  evidenceReferenceSchema,
  frontendRouteFactSchema,
} from "./facts.ts"
import {
  apiEndpointIdSchema,
  applicationIdSchema,
  capabilityIdSchema,
  claimIdSchema,
  codeSymbolIdSchema,
  commitShaSchema,
  contentHashSchema,
  coverageAssessmentIdSchema,
  documentPageIdSchema,
  documentSectionIdSchema,
  documentSourceIdSchema,
  domainEntityIdSchema,
  evidenceIdSchema,
  flowStepIdSchema,
  frontendRouteIdSchema,
  httpMethodSchema,
  lineRangeSchema,
  persistedTextSchema,
  provenanceSchema,
  pullRequestIdSchema,
  repositoryPathSchema,
  requirementIdSchema,
  runIdSchema,
  schemaVersionSchema,
  screenIdSchema,
  shortTextSchema,
  stableEntityIdSchema,
  uiElementIdSchema,
  workflowIdSchema,
} from "./primitives.ts"

export const EVIDENCE_LINKING_SCHEMA_VERSION = 1 as const
export const MAX_ADJUDICATION_CANDIDATES = 20 as const

export const evidenceExtractionMethodSchema = z.enum([
  "document_parse",
  "sanitized_link_map",
  "cited_excerpt",
  "validated_requirement_extraction",
  "crawl_record",
  "browser_transition",
  "locator_action",
  "accessibility_snapshot",
  "normalized_route_match",
  "route_component_ancestry",
  "exact_ui_text",
  "jsx_ast_binding",
  "runtime_request_match",
  "frontend_http_call",
  "laravel_route_action",
  "source_call",
  "source_reference",
  "entity_read",
  "entity_write",
  "diff_symbol_overlap",
  "coverage_evaluator",
  "semantic_capability_match",
  "name_similarity",
])

export const linkEvidenceBindingSchema = z.strictObject({
  fromId: stableEntityIdSchema,
  relationship: evidenceRelationshipSchema,
  toId: stableEntityIdSchema,
})

export const linkEvidenceRecordSchema = z
  .strictObject({
    reference: evidenceReferenceSchema,
    provenance: provenanceSchema,
    extractionMethod: evidenceExtractionMethodSchema,
    bindings: z.array(linkEvidenceBindingSchema).max(20).default([]),
    summary: persistedTextSchema,
  })
  .superRefine(({ provenance, reference }, context) => {
    if (
      reference.contentHash !== undefined &&
      "contentHash" in provenance &&
      provenance.contentHash !== undefined &&
      reference.contentHash !== provenance.contentHash
    ) {
      context.addIssue({
        code: "custom",
        path: ["reference", "contentHash"],
        message: "Evidence content hash must match its source provenance",
      })
    }
  })

const submittedLinkFields = {
  id: claimIdSchema,
  applicationId: applicationIdSchema,
  assertion: z.enum(["supports", "contradicts"]),
  evidenceIds: z
    .array(evidenceIdSchema)
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Claim evidence IDs must be unique",
    }),
  explanation: persistedTextSchema,
}

function submittedLinkVariant<
  const Relationship extends z.infer<typeof evidenceRelationshipSchema>,
  FromId extends z.ZodType,
  ToId extends z.ZodType,
>(relationship: Relationship, fromId: FromId, toId: ToId) {
  return z.strictObject({
    ...submittedLinkFields,
    fromId,
    relationship: z.literal(relationship),
    toId,
  })
}

export const submittedEvidenceLinkSchema = z.discriminatedUnion(
  "relationship",
  [
    submittedLinkVariant(
      "HAS_PAGE",
      documentSourceIdSchema,
      documentPageIdSchema
    ),
    submittedLinkVariant(
      "HAS_SECTION",
      documentPageIdSchema,
      documentSectionIdSchema
    ),
    submittedLinkVariant(
      "LINKS_TO",
      documentPageIdSchema,
      documentPageIdSchema
    ),
    submittedLinkVariant(
      "STATES",
      documentSectionIdSchema,
      requirementIdSchema
    ),
    submittedLinkVariant("REQUIRES", requirementIdSchema, capabilityIdSchema),
    submittedLinkVariant("COVERED_BY", requirementIdSchema, workflowIdSchema),
    submittedLinkVariant("HAS_STEP", workflowIdSchema, flowStepIdSchema),
    submittedLinkVariant("NEXT", flowStepIdSchema, flowStepIdSchema),
    submittedLinkVariant("ON_SCREEN", flowStepIdSchema, screenIdSchema),
    submittedLinkVariant("ACTS_ON", flowStepIdSchema, uiElementIdSchema),
    submittedLinkVariant("CONTAINS", screenIdSchema, uiElementIdSchema),
    submittedLinkVariant(
      "MATCHES_ROUTE",
      screenIdSchema,
      frontendRouteIdSchema
    ),
    submittedLinkVariant(
      "RENDERED_BY",
      z.union([screenIdSchema, uiElementIdSchema]),
      codeSymbolIdSchema
    ),
    submittedLinkVariant("BINDS", uiElementIdSchema, codeSymbolIdSchema),
    submittedLinkVariant(
      "TRIGGERS_API",
      uiElementIdSchema,
      apiEndpointIdSchema
    ),
    submittedLinkVariant("CALLS_API", codeSymbolIdSchema, apiEndpointIdSchema),
    submittedLinkVariant("HANDLED_BY", apiEndpointIdSchema, codeSymbolIdSchema),
    submittedLinkVariant("CALLS", codeSymbolIdSchema, codeSymbolIdSchema),
    submittedLinkVariant("READS", codeSymbolIdSchema, domainEntityIdSchema),
    submittedLinkVariant("WRITES", codeSymbolIdSchema, domainEntityIdSchema),
    submittedLinkVariant("CHANGES", pullRequestIdSchema, codeSymbolIdSchema),
    submittedLinkVariant(
      "HAS_ASSESSMENT",
      requirementIdSchema,
      coverageAssessmentIdSchema
    ),
  ]
)

const observationFields = {
  evidenceIds: z
    .array(evidenceIdSchema)
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Observation evidence IDs must be unique",
    }),
}

const sourceRelationshipObservationSchema = z.discriminatedUnion(
  "relationship",
  [
    z.strictObject({
      relationship: z.literal("BINDS"),
      fromId: uiElementIdSchema,
      toId: codeSymbolIdSchema,
    }),
    z.strictObject({
      relationship: z.literal("CALLS"),
      fromId: codeSymbolIdSchema,
      toId: codeSymbolIdSchema,
    }),
    z.strictObject({
      relationship: z.literal("READS"),
      fromId: codeSymbolIdSchema,
      toId: domainEntityIdSchema,
    }),
    z.strictObject({
      relationship: z.literal("WRITES"),
      fromId: codeSymbolIdSchema,
      toId: domainEntityIdSchema,
    }),
  ]
)

export const exactLinkObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...observationFields,
    kind: z.literal("diff_symbol"),
    pullRequestId: pullRequestIdSchema,
    symbolId: codeSymbolIdSchema,
    filePath: repositoryPathSchema,
    changedRange: lineRangeSchema,
    symbolRange: lineRangeSchema,
    commitSha: commitShaSchema,
  }),
  z.strictObject({
    ...observationFields,
    kind: z.literal("runtime_request"),
    uiElementId: uiElementIdSchema,
    method: httpMethodSchema,
    normalizedPath: z.string().trim().startsWith("/").max(2_048),
    runId: runIdSchema,
  }),
  z.strictObject({
    ...observationFields,
    kind: z.literal("frontend_call"),
    symbolId: codeSymbolIdSchema,
    method: httpMethodSchema,
    normalizedPath: z.string().trim().startsWith("/").max(2_048),
    commitSha: commitShaSchema,
  }),
  z.strictObject({
    ...observationFields,
    kind: z.literal("route_handler"),
    handlerSymbolId: codeSymbolIdSchema,
    method: httpMethodSchema,
    normalizedPath: z.string().trim().startsWith("/").max(2_048),
    commitSha: commitShaSchema,
  }),
  z.strictObject({
    ...observationFields,
    kind: z.literal("source_relationship"),
    source: sourceRelationshipObservationSchema,
    commitSha: commitShaSchema,
  }),
  z.strictObject({
    ...observationFields,
    kind: z.literal("runtime_route"),
    screenId: screenIdSchema,
    normalizedPath: z.string().trim().startsWith("/").max(2_048),
    runId: runIdSchema,
  }),
  z.strictObject({
    ...observationFields,
    kind: z.literal("route_component"),
    fromId: z.union([screenIdSchema, uiElementIdSchema]),
    componentSymbolId: codeSymbolIdSchema,
    routeId: frontendRouteIdSchema,
    commitSha: commitShaSchema,
    runId: runIdSchema,
  }),
])

export const semanticEntitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("requirement"),
    id: requirementIdSchema,
    applicationId: applicationIdSchema,
    name: shortTextSchema,
    capabilityTerms: z.array(shortTextSchema).max(50),
    evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal("workflow"),
    id: workflowIdSchema,
    applicationId: applicationIdSchema,
    name: shortTextSchema,
    capabilityTerms: z.array(shortTextSchema).max(50),
    evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal("capability"),
    id: capabilityIdSchema,
    applicationId: applicationIdSchema,
    name: shortTextSchema,
    capabilityTerms: z.array(shortTextSchema).max(50),
    evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal("screen"),
    id: screenIdSchema,
    applicationId: applicationIdSchema,
    name: shortTextSchema,
    capabilityTerms: z.array(shortTextSchema).max(50),
    evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal("ui_element"),
    id: uiElementIdSchema,
    applicationId: applicationIdSchema,
    name: shortTextSchema,
    capabilityTerms: z.array(shortTextSchema).max(50),
    evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal("code_symbol"),
    id: codeSymbolIdSchema,
    applicationId: applicationIdSchema,
    name: shortTextSchema,
    capabilityTerms: z.array(shortTextSchema).max(50),
    evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
  }),
])

export const evidenceLinkingInputSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    applicationId: applicationIdSchema,
    runId: runIdSchema,
    graphRevision: z.number().int().nonnegative(),
    compatibleRunIds: z
      .array(runIdSchema)
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Compatible run IDs must be unique",
      }),
    compatibleCommitShas: z
      .array(commitShaSchema)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Compatible commit SHAs must be unique",
      }),
    evidence: z.array(linkEvidenceRecordSchema).max(10_000),
    submittedLinks: z.array(submittedEvidenceLinkSchema).max(5_000),
    exactObservations: z.array(exactLinkObservationSchema).max(10_000),
    apiEndpoints: z.array(apiEndpointFactSchema).max(10_000),
    frontendRoutes: z.array(frontendRouteFactSchema).max(10_000),
    semanticEntities: z.array(semanticEntitySchema).max(5_000),
    maxCandidates: z
      .number()
      .int()
      .positive()
      .max(MAX_ADJUDICATION_CANDIDATES)
      .default(MAX_ADJUDICATION_CANDIDATES),
  })
  .superRefine((input, context) => {
    if (!input.compatibleRunIds.includes(input.runId)) {
      context.addIssue({
        code: "custom",
        path: ["compatibleRunIds"],
        message: "The linking run must be included in compatible run IDs",
      })
    }

    for (const [collection, ids] of [
      ["evidence", input.evidence.map(({ reference }) => reference.id)],
      ["submittedLinks", input.submittedLinks.map(({ id }) => id)],
      ["apiEndpoints", input.apiEndpoints.map(({ id }) => id)],
      ["frontendRoutes", input.frontendRoutes.map(({ id }) => id)],
      ["semanticEntities", input.semanticEntities.map(({ id }) => id)],
    ] as const) {
      const stringIds = ids.map(String)
      if (new Set(stringIds).size !== stringIds.length) {
        context.addIssue({
          code: "custom",
          path: [collection],
          message: `${collection} identities must be unique`,
        })
      }
    }
  })

export const evidenceCandidateIdSchema = z
  .string()
  .regex(/^candidate:v1:[a-f0-9]{64}$/)
  .brand<"EvidenceCandidateId">()

export const evidenceCandidateDispositionSchema = z.enum([
  "not_requested",
  "selected",
  "rejected",
  "abstained",
])

export const evidenceReviewCandidateSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: evidenceCandidateIdSchema,
  applicationId: applicationIdSchema,
  fromId: stableEntityIdSchema,
  relationship: z.enum(["REQUIRES", "COVERED_BY", "RENDERED_BY"]),
  toId: stableEntityIdSchema,
  evidenceTier: z.enum(["C", "D"]),
  evidenceIds: z.array(evidenceIdSchema).min(1).max(200),
  normalizedTerms: z.array(shortTextSchema).max(50),
  explanation: persistedTextSchema,
  modelDisposition: evidenceCandidateDispositionSchema,
  modelReason: persistedTextSchema.optional(),
  reviewState: z.literal("pending"),
  confidentPathEligible: z.literal(false),
})

export const evidenceAdjudicationRequestSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  applicationId: applicationIdSchema,
  candidates: z
    .array(
      evidenceReviewCandidateSchema.omit({
        modelDisposition: true,
        modelReason: true,
      })
    )
    .min(1)
    .max(MAX_ADJUDICATION_CANDIDATES),
})

export const evidenceAdjudicationDecisionSchema = z.strictObject({
  candidateId: evidenceCandidateIdSchema,
  decision: z.enum(["select", "reject", "abstain"]),
  reason: persistedTextSchema,
})

export const evidenceAdjudicationResultSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    decisions: z
      .array(evidenceAdjudicationDecisionSchema)
      .max(MAX_ADJUDICATION_CANDIDATES),
  })
  .refine(
    ({ decisions }) =>
      new Set(decisions.map(({ candidateId }) => candidateId)).size ===
      decisions.length,
    {
      path: ["decisions"],
      message: "Candidate adjudication decisions must be unique",
    }
  )

export const evidenceLinkRejectionCodeSchema = z.enum([
  "missing_evidence",
  "invalid_evidence_status",
  "application_mismatch",
  "incompatible_run",
  "incompatible_commit",
  "unsupported_source",
  "unsupported_relationship_evidence",
  "required_evidence_missing",
  "evidence_binding_mismatch",
  "no_exact_match",
  "ambiguous_exact_match",
  "model_invalid_output",
])

export const evidenceLinkRejectionSchema = z.strictObject({
  id: contentHashSchema,
  code: evidenceLinkRejectionCodeSchema,
  claimId: claimIdSchema.optional(),
  observationKey: contentHashSchema.optional(),
  evidenceIds: z.array(evidenceIdSchema).max(100),
  summary: persistedTextSchema,
})

export const evidenceLinkConflictSchema = z.strictObject({
  id: contentHashSchema,
  applicationId: applicationIdSchema,
  fromId: stableEntityIdSchema,
  relationship: evidenceRelationshipSchema,
  toId: stableEntityIdSchema,
  supportingClaimIds: z.array(claimIdSchema).min(1).max(500),
  contradictingClaimIds: z.array(claimIdSchema).min(1).max(500),
  evidenceIds: z
    .array(evidenceIdSchema)
    .min(1)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Conflict evidence IDs must be unique",
    }),
  status: z.literal("unresolved"),
  reviewState: z.literal("pending"),
  summary: persistedTextSchema,
})

export const pendingEvidenceLinkBatchSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    applicationId: applicationIdSchema,
    runId: runIdSchema,
    graphRevision: z.number().int().nonnegative(),
    status: z.literal("pending"),
    evidence: z.array(linkEvidenceRecordSchema).max(10_000),
    links: z.array(evidenceLinkSchema).max(10_000),
    reviewCandidates: z
      .array(evidenceReviewCandidateSchema)
      .max(MAX_ADJUDICATION_CANDIDATES),
    conflicts: z.array(evidenceLinkConflictSchema).max(5_000),
    rejections: z.array(evidenceLinkRejectionSchema).max(20_000),
    batchHash: contentHashSchema,
  })
  .superRefine((batch, context) => {
    const sortedCollections = [
      ["evidence", batch.evidence.map(({ reference }) => reference.id)],
      ["links", batch.links.map(({ id }) => id)],
      ["reviewCandidates", batch.reviewCandidates.map(({ id }) => id)],
      ["conflicts", batch.conflicts.map(({ id }) => id)],
      ["rejections", batch.rejections.map(({ id }) => id)],
    ] as const

    for (const [field, identities] of sortedCollections) {
      const stringIdentities = identities.map(String)
      if (new Set(stringIdentities).size !== stringIdentities.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} identities must be unique`,
        })
      }
      if (
        stringIdentities.some(
          (identity, index) => identity !== [...stringIdentities].sort()[index]
        )
      ) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must use deterministic identity ordering`,
        })
      }
    }

    for (const [index, link] of batch.links.entries()) {
      if (
        !["A", "B"].includes(link.evidenceTier) ||
        link.reviewState !== "not_required"
      ) {
        context.addIssue({
          code: "custom",
          path: ["links", index],
          message:
            "Only authoritative Tier A/B links belong in the pending fact batch",
        })
      }
    }

    for (const [index, record] of batch.evidence.entries()) {
      if (
        record.reference.applicationId !== batch.applicationId ||
        record.reference.status !== "validated"
      ) {
        context.addIssue({
          code: "custom",
          path: ["evidence", index],
          message:
            "Pending batch evidence must be validated in the active application namespace",
        })
      }
    }

    for (const [field, values] of [
      ["links", batch.links],
      ["reviewCandidates", batch.reviewCandidates],
      ["conflicts", batch.conflicts],
    ] as const) {
      for (const [index, value] of values.entries()) {
        if (value.applicationId !== batch.applicationId) {
          context.addIssue({
            code: "custom",
            path: [field, index, "applicationId"],
            message: `${field} cannot cross the pending batch application namespace`,
          })
        }
      }
    }
  })

export type EvidenceExtractionMethod = z.infer<
  typeof evidenceExtractionMethodSchema
>
export type LinkEvidenceRecord = z.infer<typeof linkEvidenceRecordSchema>
export type LinkEvidenceBinding = z.infer<typeof linkEvidenceBindingSchema>
export type SubmittedEvidenceLink = z.infer<typeof submittedEvidenceLinkSchema>
export type ExactLinkObservation = z.infer<typeof exactLinkObservationSchema>
export type SemanticEntity = z.infer<typeof semanticEntitySchema>
export type EvidenceLinkingInput = z.infer<typeof evidenceLinkingInputSchema>
export type EvidenceCandidateId = z.infer<typeof evidenceCandidateIdSchema>
export type EvidenceReviewCandidate = z.infer<
  typeof evidenceReviewCandidateSchema
>
export type EvidenceAdjudicationRequest = z.infer<
  typeof evidenceAdjudicationRequestSchema
>
export type EvidenceAdjudicationResult = z.infer<
  typeof evidenceAdjudicationResultSchema
>
export type EvidenceLinkRejection = z.infer<typeof evidenceLinkRejectionSchema>
export type EvidenceLinkConflict = z.infer<typeof evidenceLinkConflictSchema>
export type PendingEvidenceLinkBatch = z.infer<
  typeof pendingEvidenceLinkBatchSchema
>
