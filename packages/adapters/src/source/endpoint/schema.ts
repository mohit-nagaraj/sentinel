import {
  apiEndpointFactSchema,
  apiEndpointIdSchema,
  applicationIdSchema,
  commitShaSchema,
  contentHashSchema,
  extractorIdentitySchema,
  httpMethodSchema,
  lineRangeSchema,
  normalizedPathSchema,
  repositoryIdentitySchema,
  repositoryPathSchema,
  sourceUriSchema,
  timestampSchema,
} from "@sentinel/contracts"
import { z } from "zod"

export const ENDPOINT_NORMALIZATION_VERSION = 1 as const

export const endpointSourceKindSchema = z.enum([
  "openapi",
  "frontend",
  "laravel",
  "browser",
  "route_list",
])

export const endpointTemplateSchema = z.strictObject({
  normalizationVersion: z.literal(ENDPOINT_NORMALIZATION_VERSION),
  id: apiEndpointIdSchema,
  applicationId: applicationIdSchema,
  method: httpMethodSchema,
  normalizedPath: normalizedPathSchema,
})

export const endpointProvenanceSchema = z.strictObject({
  sourceKind: endpointSourceKindSchema,
  extractor: extractorIdentitySchema,
  sourceHash: contentHashSchema,
  sourceUri: sourceUriSchema.optional(),
  repository: repositoryIdentitySchema.optional(),
  commitSha: commitShaSchema.optional(),
  filePath: repositoryPathSchema.optional(),
  range: lineRangeSchema.optional(),
  observedAt: timestampSchema.optional(),
})

export const endpointHandlerSchema = z.strictObject({
  qualifiedName: z.string().trim().min(1).max(4_096),
  method: z.string().trim().min(1).max(1_024).optional(),
  symbolId: z.string().trim().min(1).max(256).optional(),
})

export const endpointOperationMetadataSchema = apiEndpointFactSchema.pick({
  operationId: true,
  tags: true,
  requestSchemaRefs: true,
  responseSchemaRefs: true,
})

export const endpointEvidenceSchema = z.strictObject({
  endpoint: endpointTemplateSchema,
  sourceKind: endpointSourceKindSchema,
  provenance: endpointProvenanceSchema,
  operation: endpointOperationMetadataSchema.optional(),
  handler: endpointHandlerSchema.optional(),
})

export const unresolvedEndpointEvidenceSchema = z.strictObject({
  sourceKind: endpointSourceKindSchema,
  reason: z.enum([
    "dynamic_method",
    "dynamic_path",
    "unsupported_method",
    "unmatched_runtime_path",
  ]),
  provenance: endpointProvenanceSchema,
})

export type EndpointTemplate = z.infer<typeof endpointTemplateSchema>
export type EndpointProvenance = z.infer<typeof endpointProvenanceSchema>
export type EndpointOperationMetadata = z.infer<
  typeof endpointOperationMetadataSchema
>
export type EndpointHandler = z.infer<typeof endpointHandlerSchema>
export type EndpointEvidence = z.infer<typeof endpointEvidenceSchema>
export type UnresolvedEndpointEvidence = z.infer<
  typeof unresolvedEndpointEvidenceSchema
>
