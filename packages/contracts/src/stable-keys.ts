import { z } from "zod"

import { hashCanonical } from "./identity.ts"
import {
  applicationIdSchema,
  commitShaSchema,
  contentHashSchema,
  documentPageIdSchema,
  documentSectionIdSchema,
  documentSourceIdSchema,
  httpMethodSchema,
  normalizedPathSchema,
  publicHttpUrlSchema,
  reasonCodeSchema,
  repositoryIdentitySchema,
  repositoryPathSchema,
  requirementIdSchema,
  runIdSchema,
  shortTextSchema,
  sourceUriSchema,
  stableEntityIdSchema,
  screenIdSchema,
  type StableEntityId,
  workflowIdSchema,
} from "./primitives.ts"

const applicationIdField = { applicationId: applicationIdSchema }

export const stableKeyInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("application"),
    deploymentUrl: publicHttpUrlSchema,
    repository: repositoryIdentitySchema,
  }),
  z.strictObject({
    kind: z.literal("document-source"),
    ...applicationIdField,
    rootUri: sourceUriSchema,
  }),
  z.strictObject({
    kind: z.literal("document-page"),
    ...applicationIdField,
    sourceId: documentSourceIdSchema,
    canonicalUri: sourceUriSchema,
    contentHash: contentHashSchema,
  }),
  z.strictObject({
    kind: z.literal("document-section"),
    ...applicationIdField,
    pageId: documentPageIdSchema,
    headingPath: z.array(shortTextSchema).min(1).max(20),
    contentHash: contentHashSchema,
  }),
  z.strictObject({
    kind: z.literal("requirement"),
    ...applicationIdField,
    sectionId: documentSectionIdSchema,
    statementFingerprint: contentHashSchema,
  }),
  z.strictObject({
    kind: z.literal("capability"),
    ...applicationIdField,
    normalizedName: shortTextSchema,
  }),
  z.strictObject({
    kind: z.literal("workflow"),
    ...applicationIdField,
    actor: shortTextSchema,
    normalizedName: shortTextSchema,
  }),
  z.strictObject({
    kind: z.literal("flow-step"),
    ...applicationIdField,
    workflowId: workflowIdSchema,
    ordinal: z.number().int().nonnegative(),
    actionType: reasonCodeSchema,
  }),
  z.strictObject({
    kind: z.literal("screen"),
    ...applicationIdField,
    normalizedRoute: normalizedPathSchema,
    stateFingerprint: contentHashSchema,
  }),
  z.strictObject({
    kind: z.literal("ui-element"),
    ...applicationIdField,
    screenId: screenIdSchema,
    role: reasonCodeSchema,
    accessibleName: shortTextSchema,
    contextFingerprint: contentHashSchema,
  }),
  z.strictObject({
    kind: z.literal("frontend-route"),
    ...applicationIdField,
    repository: repositoryIdentitySchema,
    commitSha: commitShaSchema,
    pathPattern: normalizedPathSchema,
  }),
  z.strictObject({
    kind: z.literal("code-file"),
    ...applicationIdField,
    repository: repositoryIdentitySchema,
    commitSha: commitShaSchema,
    path: repositoryPathSchema,
  }),
  z.strictObject({
    kind: z.literal("code-symbol"),
    ...applicationIdField,
    repository: repositoryIdentitySchema,
    commitSha: commitShaSchema,
    filePath: repositoryPathSchema,
    qualifiedName: z.string().trim().min(1).max(4_096),
    symbolKind: reasonCodeSchema,
  }),
  z.strictObject({
    kind: z.literal("api-endpoint"),
    ...applicationIdField,
    method: httpMethodSchema,
    normalizedPath: normalizedPathSchema,
  }),
  z.strictObject({
    kind: z.literal("domain-entity"),
    ...applicationIdField,
    normalizedName: shortTextSchema,
  }),
  z.strictObject({
    kind: z.literal("coverage-assessment"),
    ...applicationIdField,
    requirementId: requirementIdSchema,
    scopeFingerprint: contentHashSchema,
    runId: runIdSchema,
  }),
  z.strictObject({
    kind: z.literal("pull-request"),
    ...applicationIdField,
    repository: repositoryIdentitySchema,
    number: z.number().int().positive(),
    baseSha: commitShaSchema,
    headSha: commitShaSchema,
  }),
])

export type StableKeyInput = z.infer<typeof stableKeyInputSchema>

export function createStableKey(input: StableKeyInput): StableEntityId {
  const parsed = stableKeyInputSchema.parse(input)
  const digest = hashCanonical({
    identity: parsed,
    kind: parsed.kind,
    version: 1,
  }).slice("sha256:".length)
  return stableEntityIdSchema.parse(`${parsed.kind}:v1:${digest}`)
}
