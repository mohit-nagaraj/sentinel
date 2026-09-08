import { z } from "zod"

import {
  apiEndpointIdSchema,
  claimIdSchema,
  codeFileIdSchema,
  codeSymbolIdSchema,
  contentHashSchema,
  evidenceIdSchema,
  httpMethodSchema,
  languageSchema,
  lineRangeSchema,
  missionIdSchema,
  persistedTextSchema,
  reasonCodeSchema,
  repositoryPathSchema,
  schemaVersionSchema,
  shortTextSchema,
  stableEntityIdSchema,
  terminalStatusSchema,
} from "./primitives.ts"
import {
  discoveryMissionSchema,
  missionBudgetSchema,
  proposedClaimSchema,
  unresolvedQuestionSchema,
} from "./operations.ts"

export const CODE_EXPLORER_SCHEMA_VERSION = 1 as const

export const codeExplorerToolNames = [
  "list_repository_modules",
  "search_symbols",
  "search_code_text",
  "inspect_symbol",
  "find_definition",
  "find_references",
  "trace_callers",
  "trace_callees",
  "find_endpoint_handler",
  "find_frontend_callers",
  "inspect_tests",
  "submit_code_claim",
  "finish_code_mission",
] as const

export const codeExplorerToolNameSchema = z.enum(codeExplorerToolNames)

const boundedLimitSchema = z.number().int().positive().max(100).optional()
const pathFilterFields = {
  pathPrefix: repositoryPathSchema.optional(),
  languages: z.array(languageSchema).min(1).max(3).optional(),
  limit: boundedLimitSchema,
}

export const listRepositoryModulesInputSchema = z.strictObject({
  ...pathFilterFields,
})

export const searchSymbolsInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(512),
  ...pathFilterFields,
})

export const searchCodeTextInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(512),
  caseSensitive: z.boolean().optional(),
  ...pathFilterFields,
})

export const inspectSymbolInputSchema = z.strictObject({
  symbolId: codeSymbolIdSchema,
})

export const findDefinitionInputSchema = z.strictObject({
  qualifiedName: z.string().trim().min(1).max(4_096),
  languages: z.array(languageSchema).min(1).max(3).optional(),
})

export const findReferencesInputSchema = z.strictObject({
  symbolId: codeSymbolIdSchema,
  limit: boundedLimitSchema,
})

const traceInputFields = {
  symbolId: codeSymbolIdSchema,
  maxHops: z.number().int().positive().max(10).optional(),
  limit: boundedLimitSchema,
}

export const traceCallersInputSchema = z.strictObject(traceInputFields)
export const traceCalleesInputSchema = z.strictObject(traceInputFields)

const endpointInputFields = {
  method: httpMethodSchema,
  normalizedPath: z.string().trim().min(1).max(2_048),
  limit: boundedLimitSchema,
}

export const findEndpointHandlerInputSchema =
  z.strictObject(endpointInputFields)
export const findFrontendCallersInputSchema =
  z.strictObject(endpointInputFields)

export const inspectTestsInputSchema = z.discriminatedUnion("targetKind", [
  z.strictObject({
    targetKind: z.literal("symbol"),
    symbolId: codeSymbolIdSchema,
    limit: boundedLimitSchema,
  }),
  z.strictObject({
    targetKind: z.literal("endpoint"),
    method: httpMethodSchema,
    normalizedPath: z.string().trim().min(1).max(2_048),
    limit: boundedLimitSchema,
  }),
  z.strictObject({
    targetKind: z.literal("text"),
    query: z.string().trim().min(1).max(512),
    limit: boundedLimitSchema,
  }),
])

export const codeEvidenceKindSchema = z.enum([
  "definition",
  "import",
  "reference",
  "call",
  "route_handler",
  "frontend_call",
  "openapi_operation",
  "source_slice",
  "test_corroboration",
  "lexical_match",
  "unresolved_dynamic",
])

export const codeEvidenceStrengthSchema = z.enum([
  "structural",
  "corroborating",
  "lexical",
  "unresolved",
])

export const codeClaimPredicateSchema = z.enum([
  "calls",
  "calls_api",
  "handled_by",
  "reads",
  "references",
])

export const codeEntityReferenceSchema = z.union([
  apiEndpointIdSchema,
  codeFileIdSchema,
  codeSymbolIdSchema,
  stableEntityIdSchema,
])

export const codeSourceEvidenceSchema = z.strictObject({
  evidenceId: evidenceIdSchema,
  kind: codeEvidenceKindSchema,
  strength: codeEvidenceStrengthSchema,
  filePath: repositoryPathSchema,
  range: lineRangeSchema,
  sourceEntityId: codeEntityReferenceSchema.optional(),
  targetEntityId: codeEntityReferenceSchema.optional(),
  detail: reasonCodeSchema.optional(),
})

export const codeSymbolSummarySchema = z.strictObject({
  entityType: z.literal("symbol"),
  id: codeSymbolIdSchema,
  qualifiedName: z.string().trim().min(1).max(4_096),
  name: shortTextSchema,
  language: languageSchema,
  kind: reasonCodeSchema,
  filePath: repositoryPathSchema,
  range: lineRangeSchema,
})

export const codeModuleSummarySchema = z.strictObject({
  entityType: z.literal("module"),
  key: z.string().trim().min(1).max(2_048),
  path: repositoryPathSchema,
  languages: z.array(languageSchema).min(1).max(3),
  fileCount: z.number().int().nonnegative(),
  symbolCount: z.number().int().nonnegative(),
})

export const codeEndpointSummarySchema = z.strictObject({
  entityType: z.literal("endpoint"),
  id: apiEndpointIdSchema,
  method: httpMethodSchema,
  normalizedPath: z.string().trim().min(1).max(2_048),
  sourceKinds: z.array(reasonCodeSchema).min(1).max(10),
  handlerSymbolIds: z.array(codeSymbolIdSchema).max(20),
})

export const codeTextMatchSchema = z.strictObject({
  entityType: z.literal("text_match"),
  key: contentHashSchema,
  language: languageSchema,
  filePath: repositoryPathSchema,
  range: lineRangeSchema,
  text: z.string().trim().min(1).max(512),
})

export const codeTestSummarySchema = z.strictObject({
  entityType: z.literal("test"),
  key: contentHashSchema,
  language: languageSchema,
  filePath: repositoryPathSchema,
  range: lineRangeSchema,
  name: shortTextSchema,
  corroboratesOnly: z.literal(true),
})

export const codeExplorerEntitySchema = z.discriminatedUnion("entityType", [
  codeSymbolSummarySchema,
  codeModuleSummarySchema,
  codeEndpointSummarySchema,
  codeTextMatchSchema,
  codeTestSummarySchema,
])

export const codeStructuralEdgeSchema = z
  .strictObject({
    kind: codeEvidenceKindSchema,
    sourceId: codeEntityReferenceSchema,
    targetId: codeEntityReferenceSchema.optional(),
    unresolvedTarget: z.string().trim().min(1).max(4_096).optional(),
    evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
  })
  .superRefine((edge, context) => {
    if (
      (edge.targetId === undefined) ===
      (edge.unresolvedTarget === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Structural edges require exactly one resolved or unresolved target",
      })
    }
  })

export const codeSourceSliceSchema = z.strictObject({
  filePath: repositoryPathSchema,
  language: languageSchema,
  range: lineRangeSchema,
  text: z.string().max(32_768),
  contentHash: contentHashSchema,
  truncated: z.boolean(),
  evidenceId: evidenceIdSchema,
})

export const codeUnresolvedKindSchema = z.enum([
  "computed_url",
  "dependency_injection",
  "dynamic_call",
  "magic_method",
  "reflection",
  "unresolved_reference",
  "unmapped_endpoint",
])

export const codeUnresolvedBoundarySchema = z.strictObject({
  kind: codeUnresolvedKindSchema,
  question: persistedTextSchema,
  reasonCode: reasonCodeSchema,
  evidenceIds: z.array(evidenceIdSchema).max(100),
  suggestedAgent: z.enum(["documentation", "application"]).optional(),
})

export const codeToolMetricsSchema = z.strictObject({
  sourceLines: z.number().int().nonnegative(),
  contentBytes: z.number().int().nonnegative(),
  resultItems: z.number().int().nonnegative(),
  traversalHops: z.number().int().nonnegative(),
})

export const codeToolObservationSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  toolName: codeExplorerToolNameSchema.exclude([
    "submit_code_claim",
    "finish_code_mission",
  ]),
  summary: persistedTextSchema,
  entities: z.array(codeExplorerEntitySchema).max(200),
  edges: z.array(codeStructuralEdgeSchema).max(500),
  sourceSlices: z.array(codeSourceSliceSchema).max(20),
  evidence: z.array(codeSourceEvidenceSchema).max(500),
  unresolved: z.array(codeUnresolvedBoundarySchema).max(100),
  metrics: codeToolMetricsSchema,
})

export const submitCodeClaimInputSchema = z.strictObject({
  subjectId: codeEntityReferenceSchema,
  predicate: codeClaimPredicateSchema,
  objectId: codeEntityReferenceSchema,
  evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
  explanation: persistedTextSchema,
})

export const codeProposedClaimSchema = proposedClaimSchema
  .extend({
    predicate: codeClaimPredicateSchema,
    evidence: z.array(codeSourceEvidenceSchema).min(1).max(100),
  })
  .superRefine((claim, context) => {
    const supplied = [...claim.evidenceIds].sort()
    const attached = [
      ...new Set(claim.evidence.map(({ evidenceId }) => evidenceId)),
    ].sort()
    if (
      supplied.length !== attached.length ||
      supplied.some((evidenceId, index) => evidenceId !== attached[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Claim evidence IDs must match attached source evidence",
        path: ["evidenceIds"],
      })
    }
    if (!claim.evidence.some(({ strength }) => strength === "structural")) {
      context.addIssue({
        code: "custom",
        message: "Code claims require structural source evidence",
        path: ["evidence"],
      })
    }
  })

export const codePathEdgeSchema = z.strictObject({
  subjectId: codeEntityReferenceSchema,
  predicate: codeClaimPredicateSchema,
  objectId: codeEntityReferenceSchema,
  evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
})

export const codePathProposalSchema = z
  .strictObject({
    nodes: z.array(codeEntityReferenceSchema).min(2).max(50),
    edges: z.array(codePathEdgeSchema).min(1).max(49),
  })
  .superRefine((path, context) => {
    if (new Set(path.nodes).size !== path.nodes.length) {
      context.addIssue({ code: "custom", message: "Path nodes must be unique" })
    }
    if (path.edges.length !== path.nodes.length - 1) {
      context.addIssue({
        code: "custom",
        message: "A path must have one edge between each adjacent node",
        path: ["edges"],
      })
    }
    path.edges.forEach((edge, index) => {
      if (
        edge.subjectId !== path.nodes[index] ||
        edge.objectId !== path.nodes[index + 1]
      ) {
        context.addIssue({
          code: "custom",
          message: "Path edges must connect adjacent nodes in order",
          path: ["edges", index],
        })
      }
    })
  })

export const codeImplementationPathSchema = codePathProposalSchema.safeExtend({
  key: contentHashSchema,
})

export const finishCodeMissionInputSchema = z.strictObject({
  status: terminalStatusSchema,
  claimIds: z.array(claimIdSchema).max(500),
  paths: z.array(codePathProposalSchema).max(100),
  unresolved: z.array(codeUnresolvedBoundarySchema).max(100),
  exclusions: z.array(persistedTextSchema).max(100),
  suggestedFollowups: z.array(discoveryMissionSchema).max(20),
  stopReason: z.strictObject({
    code: reasonCodeSchema,
    summary: persistedTextSchema,
  }),
})

export const codeMissionResultSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    missionId: missionIdSchema,
    status: terminalStatusSchema,
    claims: z.array(codeProposedClaimSchema).max(500),
    paths: z.array(codeImplementationPathSchema).max(100),
    unresolved: z.array(unresolvedQuestionSchema).max(100),
    unresolvedBoundaries: z.array(codeUnresolvedBoundarySchema).max(100),
    exclusions: z.array(persistedTextSchema).max(100),
    suggestedFollowups: z.array(discoveryMissionSchema).max(20),
    stopReason: z.strictObject({
      code: reasonCodeSchema,
      summary: persistedTextSchema,
    }),
    budgetUsed: missionBudgetSchema,
    traversalHopsUsed: z.number().int().nonnegative(),
    resultItemsUsed: z.number().int().nonnegative(),
  })
  .superRefine((result, context) => {
    const claimIds = result.claims.map(({ id }) => id)
    if (new Set(claimIds).size !== claimIds.length) {
      context.addIssue({ code: "custom", message: "Claim IDs must be unique" })
    }
    const pathKeys = result.paths.map(({ key }) => key)
    if (new Set(pathKeys).size !== pathKeys.length) {
      context.addIssue({ code: "custom", message: "Path keys must be unique" })
    }
  })

const codeExplorerToolSet = new Set<string>(codeExplorerToolNames)

export const codeExplorerMissionSchema = discoveryMissionSchema.superRefine(
  (mission, context) => {
    if (mission.agent !== "code") {
      context.addIssue({
        code: "custom",
        message: "Code Explorer requires a code mission",
        path: ["agent"],
      })
    }
    mission.scope.allowedTools.forEach((tool, index) => {
      if (!codeExplorerToolSet.has(tool)) {
        context.addIssue({
          code: "custom",
          message: `Tool ${tool} is not available to the Code Explorer`,
          path: ["scope", "allowedTools", index],
        })
      }
    })
  }
)

export type CodeExplorerToolName = z.infer<typeof codeExplorerToolNameSchema>
export type CodeExplorerMission = z.infer<typeof codeExplorerMissionSchema>
export type CodeSourceEvidence = z.infer<typeof codeSourceEvidenceSchema>
export type CodeExplorerEntity = z.infer<typeof codeExplorerEntitySchema>
export type CodeStructuralEdge = z.infer<typeof codeStructuralEdgeSchema>
export type CodeSourceSlice = z.infer<typeof codeSourceSliceSchema>
export type CodeUnresolvedBoundary = z.infer<
  typeof codeUnresolvedBoundarySchema
>
export type CodeToolObservation = z.infer<typeof codeToolObservationSchema>
export type SubmitCodeClaimInput = z.infer<typeof submitCodeClaimInputSchema>
export type CodeProposedClaim = z.infer<typeof codeProposedClaimSchema>
export type CodePathProposal = z.infer<typeof codePathProposalSchema>
export type CodeImplementationPath = z.infer<
  typeof codeImplementationPathSchema
>
export type FinishCodeMissionInput = z.infer<
  typeof finishCodeMissionInputSchema
>
export type CodeMissionResult = z.infer<typeof codeMissionResultSchema>
