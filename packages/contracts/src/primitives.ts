import { z } from "zod"

export const WIRE_SCHEMA_VERSION = 1 as const

export const schemaVersionSchema = z.literal(WIRE_SCHEMA_VERSION)
export const nonEmptyStringSchema = z.string().trim().min(1).max(4_096)
export const shortTextSchema = z.string().trim().min(1).max(512)
const credentialLabels =
  "api[_-]?key|auth|client[_-]?secret|connect\\.sid|credential|laravel_session|password|phpsessid|private[_-]?key|secret|session(?:[_-]?id)?|sid|token"

export function redactPersistedText(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/gi, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[REDACTED]"
    )
    .replace(
      /(\b(?:authorization|proxy-authorization)\s*:\s*(?:basic|bearer)\s+)[^\r\n]*/gi,
      "$1[REDACTED]"
    )
    .replace(/(\b(?:cookie|set-cookie)\s*:\s*)[^\r\n]*/gi, "$1[REDACTED]")
    .replace(
      new RegExp(`(\\b(?:${credentialLabels})\\s*[:=]\\s*)[^\\r\\n]*`, "gi"),
      "$1[REDACTED]"
    )
}

// Credentials can be ordinary words, so assignment-like prose is ambiguous.
// Fail closed and require callers to redact or rephrase it before persistence.
export const persistedTextSchema = nonEmptyStringSchema
  .refine((value) => redactPersistedText(value) === value, {
    message:
      "Persisted text contains secret-shaped syntax; redact it or rephrase without credential assignment/header notation",
  })
  .brand<"PersistedText">()
export const reasonCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/)
  .max(96)
export const timestampSchema = z.iso.datetime({ offset: true })
export const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(
    (value) => value === "localhost" || z.hostname().safeParse(value).success,
    { message: "Invalid hostname" }
  )
export const commitShaSchema = z
  .string()
  .regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
  .brand<"CommitSha">()
export const contentHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .brand<"ContentHash">()
export const normalizedPathSchema = z.string().min(1).max(2_048).regex(/^\//)
export const repositoryPathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("\\") &&
      !/^[A-Za-z]:/.test(value) &&
      !value.includes("\\") &&
      !value.split("/").includes(".."),
    {
      message: "Repository paths must be relative and cannot traverse parents",
    }
  )
const sensitiveQueryKey =
  /^(?:access_token|api[_-]?key|auth|authorization|client[_-]?secret|code|connect\.sid|credential|id_token|key|laravel_session|oauth_token|password|phpsessid|private[_-]?key|refresh_token|secret|session(?:[_-]?id)?|sid|sig|signature|token|x-amz-.+|x-goog-.+)$/i

function normalizePublicUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return value
  }
  url.hash = ""
  url.searchParams.sort()
  return url.toString()
}

export const publicHttpUrlSchema = z
  .url({ protocol: /^https?$/ })
  .superRefine((value, context) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return
    }
    if (url.username.length > 0 || url.password.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Public URLs cannot contain credentials",
      })
    }

    for (const key of url.searchParams.keys()) {
      if (sensitiveQueryKey.test(key)) {
        context.addIssue({
          code: "custom",
          message: `Public URLs cannot contain sensitive query parameter ${key}`,
        })
      }
    }

    if (redactPersistedText(value) !== value) {
      context.addIssue({
        code: "custom",
        message: "Public URLs cannot contain credential or secret material",
      })
    }
  })
  .transform(normalizePublicUrl)

export const sourceUriSchema = z
  .string()
  .min(1)
  .max(4_096)
  .superRefine((value, context) => {
    if (value.startsWith("repository://")) {
      const path = value.slice("repository://".length)
      if (!/^[A-Za-z0-9._/-]+$/.test(path)) {
        context.addIssue({
          code: "custom",
          message: "Repository URIs contain an invalid path",
        })
      } else if (path.split("/").includes("..")) {
        context.addIssue({
          code: "custom",
          message: "Repository URIs cannot traverse parent paths",
        })
      }
      return
    }

    const result = publicHttpUrlSchema.safeParse(value)
    if (!result.success) {
      context.addIssue({
        code: "custom",
        message: result.error.issues[0]?.message ?? "Invalid source URI",
      })
    }
  })
  .transform((value) =>
    value.startsWith("repository://") ? value : publicHttpUrlSchema.parse(value)
  )

export const runIdSchema = z
  .string()
  .regex(
    /^run:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  )
  .brand<"RunId">()
export const missionIdSchema = z
  .string()
  .regex(/^mission:v1:[a-f0-9]{64}$/)
  .brand<"MissionId">()
export const claimIdSchema = z
  .string()
  .regex(/^claim:v1:[a-f0-9]{64}$/)
  .brand<"ClaimId">()
export const evidenceIdSchema = z
  .string()
  .regex(/^evidence:v1:[a-f0-9]{64}$/)
  .brand<"EvidenceId">()
export const artifactIdSchema = z
  .string()
  .regex(/^artifact:v1:[a-f0-9]{64}$/)
  .brand<"ArtifactId">()
export const eventIdSchema = z
  .string()
  .regex(/^event:v1:[a-f0-9]{64}$/)
  .brand<"EventId">()
export const actionIdSchema = z
  .string()
  .regex(/^action:v1:[a-f0-9]{64}$/)
  .brand<"ActionId">()
export const findingIdSchema = z
  .string()
  .regex(/^finding:v1:[a-f0-9]{64}$/)
  .brand<"FindingId">()
export const secretReferenceSchema = z
  .string()
  .regex(/^secret-ref:v1:[a-f0-9]{64}$/)
  .brand<"SecretReference">()

export const entityKindValues = [
  "application",
  "document-source",
  "document-page",
  "document-section",
  "requirement",
  "capability",
  "workflow",
  "flow-step",
  "screen",
  "ui-element",
  "frontend-route",
  "code-file",
  "code-symbol",
  "api-endpoint",
  "domain-entity",
  "coverage-assessment",
  "pull-request",
] as const

export const entityKindSchema = z.enum(entityKindValues)
export const stableEntityIdSchema = z
  .string()
  .regex(
    /^(?:application|document-source|document-page|document-section|requirement|capability|workflow|flow-step|screen|ui-element|frontend-route|code-file|code-symbol|api-endpoint|domain-entity|coverage-assessment|pull-request):v1:[a-f0-9]{64}$/
  )
  .brand<"StableEntityId">()

function createEntityIdSchema<Brand extends string>(kind: EntityKind) {
  return z
    .string()
    .regex(new RegExp(`^${kind}:v1:[a-f0-9]{64}$`))
    .brand<Brand>()
}

export const applicationIdSchema =
  createEntityIdSchema<"ApplicationId">("application")
export const documentSourceIdSchema =
  createEntityIdSchema<"DocumentSourceId">("document-source")
export const documentPageIdSchema =
  createEntityIdSchema<"DocumentPageId">("document-page")
export const documentSectionIdSchema =
  createEntityIdSchema<"DocumentSectionId">("document-section")
export const requirementIdSchema =
  createEntityIdSchema<"RequirementId">("requirement")
export const capabilityIdSchema =
  createEntityIdSchema<"CapabilityId">("capability")
export const workflowIdSchema = createEntityIdSchema<"WorkflowId">("workflow")
export const flowStepIdSchema = createEntityIdSchema<"FlowStepId">("flow-step")
export const screenIdSchema = createEntityIdSchema<"ScreenId">("screen")
export const uiElementIdSchema =
  createEntityIdSchema<"UiElementId">("ui-element")
export const frontendRouteIdSchema =
  createEntityIdSchema<"FrontendRouteId">("frontend-route")
export const codeFileIdSchema = createEntityIdSchema<"CodeFileId">("code-file")
export const codeSymbolIdSchema =
  createEntityIdSchema<"CodeSymbolId">("code-symbol")
export const apiEndpointIdSchema =
  createEntityIdSchema<"ApiEndpointId">("api-endpoint")
export const domainEntityIdSchema =
  createEntityIdSchema<"DomainEntityId">("domain-entity")
export const coverageAssessmentIdSchema =
  createEntityIdSchema<"CoverageAssessmentId">("coverage-assessment")
export const pullRequestIdSchema =
  createEntityIdSchema<"PullRequestId">("pull-request")

export const languageSchema = z.enum(["typescript", "tsx", "php"])
export const httpMethodSchema = z.enum([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
])
export const evidenceTierSchema = z.enum(["A", "B", "C", "D"])
export const evidenceStatusSchema = z.enum([
  "captured",
  "validated",
  "rejected",
  "expired",
])
export const claimStatusSchema = z.enum(["proposed", "superseded", "withdrawn"])
export const reviewStateSchema = z.enum([
  "not_required",
  "pending",
  "accepted",
  "rejected",
])
export const terminalStatusSchema = z.enum([
  "complete",
  "partial",
  "blocked",
  "budget_exhausted",
  "needs_human",
  "failed",
])
export const runStatusSchema = z.enum([
  "queued",
  "running",
  "interrupted",
  "cancelling",
  "cancelled",
  "succeeded",
  "failed",
])
export const runTypeSchema = z.enum([
  "inspect_application",
  "initialize_knowledge",
  "assess_pr",
  "verify_pr",
  "refresh_knowledge",
  "run_eval",
])
export const agentKindSchema = z.enum([
  "documentation",
  "code",
  "application",
  "curator",
  "system",
])

export const lineRangeSchema = z
  .strictObject({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .refine(({ endLine, startLine }) => endLine >= startLine, {
    message: "endLine must be greater than or equal to startLine",
    path: ["endLine"],
  })

export const repositoryIdentitySchema = z
  .strictObject({
    host: hostnameSchema,
    owner: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(100),
  })
  .transform((repository) =>
    repository.host === "github.com"
      ? {
          ...repository,
          owner: repository.owner.toLowerCase(),
          name: repository.name.toLowerCase(),
        }
      : repository
  )

export const extractorIdentitySchema = z.strictObject({
  name: reasonCodeSchema,
  version: z.string().trim().min(1).max(64),
})

export const provenanceSchema = z.discriminatedUnion("sourceKind", [
  z.strictObject({
    sourceKind: z.literal("document"),
    sourceUri: sourceUriSchema,
    contentHash: contentHashSchema,
    observedAt: timestampSchema.optional(),
  }),
  z.strictObject({
    sourceKind: z.literal("repository"),
    repository: repositoryIdentitySchema,
    commitSha: commitShaSchema,
    contentHash: contentHashSchema.optional(),
  }),
  z.strictObject({
    sourceKind: z.literal("browser"),
    sourceUri: publicHttpUrlSchema,
    observedAt: timestampSchema,
  }),
  z.strictObject({
    sourceKind: z.literal("openapi"),
    sourceUri: sourceUriSchema,
    contentHash: contentHashSchema,
    commitSha: commitShaSchema.optional(),
  }),
  z.strictObject({
    sourceKind: z.literal("system"),
    observedAt: timestampSchema,
  }),
])

export type RunId = z.infer<typeof runIdSchema>
export type MissionId = z.infer<typeof missionIdSchema>
export type ClaimId = z.infer<typeof claimIdSchema>
export type EvidenceId = z.infer<typeof evidenceIdSchema>
export type ArtifactId = z.infer<typeof artifactIdSchema>
export type EventId = z.infer<typeof eventIdSchema>
export type ActionId = z.infer<typeof actionIdSchema>
export type FindingId = z.infer<typeof findingIdSchema>
export type SecretReference = z.infer<typeof secretReferenceSchema>
export type StableEntityId = z.infer<typeof stableEntityIdSchema>
export type ApplicationId = z.infer<typeof applicationIdSchema>
export type DocumentSourceId = z.infer<typeof documentSourceIdSchema>
export type DocumentPageId = z.infer<typeof documentPageIdSchema>
export type DocumentSectionId = z.infer<typeof documentSectionIdSchema>
export type RequirementId = z.infer<typeof requirementIdSchema>
export type CapabilityId = z.infer<typeof capabilityIdSchema>
export type WorkflowId = z.infer<typeof workflowIdSchema>
export type FlowStepId = z.infer<typeof flowStepIdSchema>
export type ScreenId = z.infer<typeof screenIdSchema>
export type UiElementId = z.infer<typeof uiElementIdSchema>
export type FrontendRouteId = z.infer<typeof frontendRouteIdSchema>
export type CodeFileId = z.infer<typeof codeFileIdSchema>
export type CodeSymbolId = z.infer<typeof codeSymbolIdSchema>
export type ApiEndpointId = z.infer<typeof apiEndpointIdSchema>
export type DomainEntityId = z.infer<typeof domainEntityIdSchema>
export type CoverageAssessmentId = z.infer<typeof coverageAssessmentIdSchema>
export type PullRequestId = z.infer<typeof pullRequestIdSchema>
export type EntityKind = z.infer<typeof entityKindSchema>
export type ContentHash = z.infer<typeof contentHashSchema>
export type CommitSha = z.infer<typeof commitShaSchema>
export type TerminalStatus = z.infer<typeof terminalStatusSchema>
export type RunStatus = z.infer<typeof runStatusSchema>
export type EvidenceTier = z.infer<typeof evidenceTierSchema>
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>
export type ClaimStatus = z.infer<typeof claimStatusSchema>
