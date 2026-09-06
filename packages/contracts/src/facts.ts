import { z } from "zod"

import {
  actionIdSchema,
  apiEndpointIdSchema,
  applicationIdSchema,
  artifactIdSchema,
  capabilityIdSchema,
  codeFileIdSchema,
  codeSymbolIdSchema,
  commitShaSchema,
  contentHashSchema,
  documentPageIdSchema,
  documentSectionIdSchema,
  documentSourceIdSchema,
  domainEntityIdSchema,
  evidenceIdSchema,
  extractorIdentitySchema,
  flowStepIdSchema,
  frontendRouteIdSchema,
  httpMethodSchema,
  languageSchema,
  lineRangeSchema,
  nonEmptyStringSchema,
  normalizedPathSchema,
  provenanceSchema,
  reasonCodeSchema,
  repositoryIdentitySchema,
  repositoryPathSchema,
  requirementIdSchema,
  runIdSchema,
  schemaVersionSchema,
  screenIdSchema,
  shortTextSchema,
  sourceUriSchema,
  timestampSchema,
  uiElementIdSchema,
  workflowIdSchema,
} from "./primitives.ts"

export const documentSourceFactSchema = z.strictObject({
  id: documentSourceIdSchema,
  applicationId: applicationIdSchema,
  kind: z.enum(["web", "repository"]),
  rootUri: sourceUriSchema,
  contentHash: contentHashSchema,
})

export const documentPageFactSchema = z.strictObject({
  id: documentPageIdSchema,
  applicationId: applicationIdSchema,
  sourceId: documentSourceIdSchema,
  canonicalUri: sourceUriSchema,
  title: shortTextSchema,
  contentHash: contentHashSchema,
  linkedPageIds: z.array(documentPageIdSchema).max(500),
})

export const documentSectionFactSchema = z.strictObject({
  id: documentSectionIdSchema,
  applicationId: applicationIdSchema,
  pageId: documentPageIdSchema,
  headingPath: z.array(shortTextSchema).min(1).max(20),
  excerpt: nonEmptyStringSchema,
  contentHash: contentHashSchema,
})

export const requirementCandidateSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: requirementIdSchema,
  applicationId: applicationIdSchema,
  statement: nonEmptyStringSchema,
  actor: shortTextSchema.optional(),
  capability: shortTextSchema,
  expectedOutcome: nonEmptyStringSchema.optional(),
  testable: z.boolean(),
  source: z.strictObject({
    sectionId: documentSectionIdSchema,
    uri: sourceUriSchema,
    heading: shortTextSchema,
    excerpt: nonEmptyStringSchema,
    contentHash: contentHashSchema,
  }),
})

export const capabilityFactSchema = z.strictObject({
  id: capabilityIdSchema,
  applicationId: applicationIdSchema,
  normalizedName: shortTextSchema,
})

export const workflowFactSchema = z.strictObject({
  id: workflowIdSchema,
  applicationId: applicationIdSchema,
  name: shortTextSchema,
  actor: shortTextSchema,
  sourceRunId: runIdSchema,
})

export const flowStepFactSchema = z.strictObject({
  id: flowStepIdSchema,
  applicationId: applicationIdSchema,
  workflowId: workflowIdSchema,
  ordinal: z.number().int().nonnegative(),
  actionType: reasonCodeSchema,
  expectedCheckpoint: nonEmptyStringSchema.optional(),
  sourceRunId: runIdSchema,
})

export const screenFactSchema = z.strictObject({
  id: screenIdSchema,
  applicationId: applicationIdSchema,
  normalizedRoute: normalizedPathSchema,
  title: shortTextSchema,
  stateFingerprint: contentHashSchema,
})

export const uiElementFactSchema = z.strictObject({
  id: uiElementIdSchema,
  applicationId: applicationIdSchema,
  screenId: screenIdSchema,
  role: reasonCodeSchema,
  accessibleName: shortTextSchema,
  selectorHint: z.string().trim().min(1).max(512).optional(),
  observedAt: timestampSchema,
  sourceRunId: runIdSchema,
})

export const codeFileFactSchema = z.strictObject({
  id: codeFileIdSchema,
  applicationId: applicationIdSchema,
  repository: repositoryIdentitySchema,
  commitSha: commitShaSchema,
  path: repositoryPathSchema,
  language: languageSchema,
  contentHash: contentHashSchema,
})

export const codeSymbolKindSchema = z.enum([
  "component",
  "function",
  "handler",
  "action",
  "controller",
  "service",
  "repository",
  "class",
  "method",
  "route",
  "module",
])

export const codeSymbolFactSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: codeSymbolIdSchema,
  applicationId: applicationIdSchema,
  repository: repositoryIdentitySchema,
  commitSha: commitShaSchema,
  language: languageSchema,
  kind: codeSymbolKindSchema,
  qualifiedName: nonEmptyStringSchema,
  filePath: repositoryPathSchema,
  range: lineRangeSchema,
})

export const codeReferenceFactSchema = z.strictObject({
  id: evidenceIdSchema,
  applicationId: applicationIdSchema,
  sourceSymbolId: codeSymbolIdSchema,
  targetSymbolId: codeSymbolIdSchema.optional(),
  unresolvedTarget: nonEmptyStringSchema.optional(),
  kind: z.enum(["import", "reference", "call"]),
  range: lineRangeSchema,
})

export const frontendRouteFactSchema = z.strictObject({
  id: frontendRouteIdSchema,
  applicationId: applicationIdSchema,
  repository: repositoryIdentitySchema,
  commitSha: commitShaSchema,
  pathPattern: normalizedPathSchema,
  componentSymbolIds: z.array(codeSymbolIdSchema).min(1).max(100),
  sourceRange: lineRangeSchema,
})

export const apiEndpointFactSchema = z.strictObject({
  id: apiEndpointIdSchema,
  applicationId: applicationIdSchema,
  method: httpMethodSchema,
  normalizedPath: normalizedPathSchema,
  operationId: shortTextSchema.optional(),
  sourceHash: contentHashSchema,
})

export const domainEntityFactSchema = z.strictObject({
  id: domainEntityIdSchema,
  applicationId: applicationIdSchema,
  normalizedName: shortTextSchema,
  sourceSymbolIds: z.array(codeSymbolIdSchema).min(1).max(100),
})

export const browserRequestSchema = z.strictObject({
  method: httpMethodSchema,
  normalizedPath: normalizedPathSchema,
  status: z.number().int().min(100).max(599).optional(),
})

export const browserElementObservationSchema = z.strictObject({
  elementId: uiElementIdSchema,
  role: reasonCodeSchema,
  accessibleName: shortTextSchema,
  disabled: z.boolean(),
})

export const browserScreenObservationSchema = z.strictObject({
  evidenceId: evidenceIdSchema,
  screenId: screenIdSchema,
  runId: runIdSchema,
  url: z.url({ protocol: /^https?$/ }),
  normalizedRoute: normalizedPathSchema,
  title: shortTextSchema,
  headings: z.array(shortTextSchema).max(50),
  elements: z.array(browserElementObservationSchema).max(500),
  screenshotArtifactId: artifactIdSchema.optional(),
  stateFingerprint: contentHashSchema,
  observedAt: timestampSchema,
})

export const browserActionSchema = z.strictObject({
  actionId: actionIdSchema,
  type: z.enum(["click", "fill", "select", "navigate", "reload", "back"]),
  elementRole: reasonCodeSchema.optional(),
  elementName: shortTextSchema.optional(),
  safeInputSlot: reasonCodeSchema.optional(),
})

export const browserTransitionSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  evidenceId: evidenceIdSchema,
  runId: runIdSchema,
  fromStateId: screenIdSchema,
  action: browserActionSchema,
  toStateId: screenIdSchema,
  requests: z.array(browserRequestSchema).max(200),
  screenshotArtifactId: artifactIdSchema.optional(),
  observedAt: timestampSchema,
})

const factEnvelopeBase = {
  schemaVersion: schemaVersionSchema,
  extractor: extractorIdentitySchema,
  provenance: provenanceSchema,
}

export const documentFactEnvelopeSchema = z.discriminatedUnion("factKind", [
  z.strictObject({
    ...factEnvelopeBase,
    factKind: z.literal("document_source"),
    fact: documentSourceFactSchema,
  }),
  z.strictObject({
    ...factEnvelopeBase,
    factKind: z.literal("document_page"),
    fact: documentPageFactSchema,
  }),
  z.strictObject({
    ...factEnvelopeBase,
    factKind: z.literal("document_section"),
    fact: documentSectionFactSchema,
  }),
])

export const codeFactEnvelopeSchema = z.discriminatedUnion("factKind", [
  z.strictObject({
    ...factEnvelopeBase,
    factKind: z.literal("code_file"),
    fact: codeFileFactSchema,
  }),
  z.strictObject({
    ...factEnvelopeBase,
    factKind: z.literal("code_symbol"),
    fact: codeSymbolFactSchema.omit({ schemaVersion: true }),
  }),
  z.strictObject({
    ...factEnvelopeBase,
    factKind: z.literal("code_reference"),
    fact: codeReferenceFactSchema,
  }),
  z.strictObject({
    ...factEnvelopeBase,
    factKind: z.literal("frontend_route"),
    fact: frontendRouteFactSchema,
  }),
  z.strictObject({
    ...factEnvelopeBase,
    factKind: z.literal("api_endpoint"),
    fact: apiEndpointFactSchema,
  }),
  z.strictObject({
    ...factEnvelopeBase,
    factKind: z.literal("domain_entity"),
    fact: domainEntityFactSchema,
  }),
])

export const browserFactEnvelopeSchema = z.discriminatedUnion("factKind", [
  z.strictObject({
    ...factEnvelopeBase,
    factKind: z.literal("screen_observation"),
    fact: browserScreenObservationSchema,
  }),
  z.strictObject({
    ...factEnvelopeBase,
    factKind: z.literal("transition"),
    fact: browserTransitionSchema.omit({ schemaVersion: true }),
  }),
])

export type DocumentSourceFact = z.infer<typeof documentSourceFactSchema>
export type DocumentPageFact = z.infer<typeof documentPageFactSchema>
export type DocumentSectionFact = z.infer<typeof documentSectionFactSchema>
export type RequirementCandidate = z.infer<typeof requirementCandidateSchema>
export type CodeSymbolFact = z.infer<typeof codeSymbolFactSchema>
export type BrowserScreenObservation = z.infer<
  typeof browserScreenObservationSchema
>
export type BrowserTransition = z.infer<typeof browserTransitionSchema>
export type DocumentFactEnvelope = z.infer<typeof documentFactEnvelopeSchema>
export type CodeFactEnvelope = z.infer<typeof codeFactEnvelopeSchema>
export type BrowserFactEnvelope = z.infer<typeof browserFactEnvelopeSchema>
