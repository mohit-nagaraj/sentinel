import { contentHashSchema, repositoryPathSchema } from "@sentinel/contracts"
import { z } from "zod"

export const PHP_INDEXER_SCHEMA_VERSION = 1 as const

export const phpSourceRangeSchema = z
  .strictObject({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    startFilePos: z.number().int().nonnegative(),
    endFilePos: z.number().int().nonnegative(),
    startTokenPos: z.number().int().nonnegative(),
    endTokenPos: z.number().int().nonnegative(),
  })
  .superRefine((range, context) => {
    if (range.endLine < range.startLine) {
      context.addIssue({
        code: "custom",
        message: "Source range endLine precedes startLine",
      })
    }
    if (range.endFilePos < range.startFilePos) {
      context.addIssue({
        code: "custom",
        message: "Source range endFilePos precedes startFilePos",
      })
    }
    if (range.endTokenPos < range.startTokenPos) {
      context.addIssue({
        code: "custom",
        message: "Source range endTokenPos precedes startTokenPos",
      })
    }
  })

export const phpSymbolIdSchema = z
  .string()
  .regex(/^php-symbol:v1:[a-f0-9]{64}$/)
export const phpRelationshipIdSchema = z
  .string()
  .regex(/^php-relationship:v1:[a-f0-9]{64}$/)
export const phpRouteIdSchema = z.string().regex(/^php-route:v1:[a-f0-9]{64}$/)

export const phpSymbolKindSchema = z.enum([
  "namespace",
  "import",
  "class",
  "interface",
  "trait",
  "enum",
  "function",
  "method",
  "property",
])

export const phpSymbolRoleSchema = z.enum([
  "action",
  "controller",
  "handler",
  "service",
  "repository",
  "model",
  "form_request",
  "json_resource",
  "other",
])

export const phpNameEvidenceSchema = z.strictObject({
  originalName: z.string().min(1).max(4_096),
  resolvedName: z.string().min(1).max(4_096),
})

export const phpSymbolSchema = z.strictObject({
  id: phpSymbolIdSchema,
  kind: phpSymbolKindSchema,
  role: phpSymbolRoleSchema,
  name: z.string().min(1).max(1_024),
  qualifiedName: z.string().min(1).max(4_096),
  originalName: z.string().min(1).max(4_096),
  containerSymbolId: phpSymbolIdSchema.optional(),
  visibility: z.enum(["public", "protected", "private"]).optional(),
  static: z.boolean(),
  abstract: z.boolean(),
  final: z.boolean(),
  attributes: z.array(phpNameEvidenceSchema).max(100),
  range: phpSourceRangeSchema,
})

export const phpRelationshipKindSchema = z.enum([
  "extends",
  "implements",
  "uses_trait",
  "constructor_dependency",
  "parameter_type",
  "return_type",
  "property_type",
  "attribute",
  "calls",
  "static_calls",
  "instantiates",
  "references",
  "form_request",
  "json_resource",
  "domain_reference",
  "unresolved_dynamic",
])

export const phpRelationshipSchema = z
  .strictObject({
    id: phpRelationshipIdSchema,
    kind: phpRelationshipKindSchema,
    sourceSymbolId: phpSymbolIdSchema,
    targetSymbolId: phpSymbolIdSchema.optional(),
    originalTarget: z.string().min(1).max(4_096),
    resolvedTarget: z.string().min(1).max(4_096).optional(),
    memberName: z.string().min(1).max(1_024).optional(),
    dynamic: z.boolean(),
    range: phpSourceRangeSchema,
  })
  .refine(
    (relationship) =>
      relationship.dynamic || relationship.resolvedTarget !== undefined,
    { message: "Resolved relationships require a target identity" }
  )

export const phpRouteActionSchema = z.strictObject({
  originalName: z.string().min(1).max(4_096),
  resolvedName: z.string().min(1).max(4_096).optional(),
  method: z.string().min(1).max(1_024).optional(),
  dynamic: z.boolean(),
  targetSymbolId: phpSymbolIdSchema.optional(),
})

export const phpRouteSchema = z.strictObject({
  id: phpRouteIdSchema,
  methods: z
    .array(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "ANY"]))
    .min(1)
    .max(8),
  path: z
    .string()
    .regex(/^\/(?:[^\u0000-\u001f]*)$/)
    .max(2_048)
    .nullable(),
  name: z.string().min(1).max(1_024).optional(),
  middleware: z.array(z.string().min(1).max(1_024)).max(100),
  action: phpRouteActionSchema,
  dynamic: z.boolean(),
  range: phpSourceRangeSchema,
})

export const phpFileErrorSchema = z.strictObject({
  code: z.enum([
    "parse_error",
    "read_error",
    "extraction_error",
    "limit_exceeded",
  ]),
  message: z.string().min(1).max(1_024),
  line: z.number().int().positive().optional(),
})

export const phpIndexedFileSchema = z.strictObject({
  path: repositoryPathSchema,
  contentHash: contentHashSchema,
  symbols: z.array(phpSymbolSchema),
  relationships: z.array(phpRelationshipSchema),
  routes: z.array(phpRouteSchema),
  errors: z.array(phpFileErrorSchema).max(100),
})

export const phpIndexerResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(PHP_INDEXER_SCHEMA_VERSION),
    parser: z.strictObject({
      name: z.literal("nikic/php-parser"),
      version: z.string().regex(/^5\.[0-9]+\.[0-9]+$/),
    }),
    files: z.array(phpIndexedFileSchema),
    summary: z.strictObject({
      fileCount: z.number().int().nonnegative(),
      symbolCount: z.number().int().nonnegative(),
      relationshipCount: z.number().int().nonnegative(),
      routeCount: z.number().int().nonnegative(),
      errorCount: z.number().int().nonnegative(),
    }),
  })
  .superRefine((response, context) => {
    const symbolIds = new Set<string>()
    const relationshipIds = new Set<string>()
    const routeIds = new Set<string>()
    let symbolCount = 0
    let relationshipCount = 0
    let routeCount = 0
    let errorCount = 0
    for (const file of response.files) {
      symbolCount += file.symbols.length
      relationshipCount += file.relationships.length
      routeCount += file.routes.length
      errorCount += file.errors.length
      for (const symbol of file.symbols) {
        if (symbolIds.has(symbol.id)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate symbol ID ${symbol.id}`,
          })
        }
        symbolIds.add(symbol.id)
      }
      for (const relationship of file.relationships) {
        if (relationshipIds.has(relationship.id)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate relationship ID ${relationship.id}`,
          })
        }
        relationshipIds.add(relationship.id)
      }
      for (const route of file.routes) {
        if (routeIds.has(route.id)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate route ID ${route.id}`,
          })
        }
        routeIds.add(route.id)
      }
    }
    for (const file of response.files) {
      for (const relationship of file.relationships) {
        if (!symbolIds.has(relationship.sourceSymbolId)) {
          context.addIssue({
            code: "custom",
            message: `Unknown relationship source ${relationship.sourceSymbolId}`,
          })
        }
        if (
          relationship.targetSymbolId !== undefined &&
          !symbolIds.has(relationship.targetSymbolId)
        ) {
          context.addIssue({
            code: "custom",
            message: `Unknown relationship target ${relationship.targetSymbolId}`,
          })
        }
      }
    }
    const expected = {
      fileCount: response.files.length,
      symbolCount,
      relationshipCount,
      routeCount,
      errorCount,
    }
    for (const [key, value] of Object.entries(expected)) {
      if (response.summary[key as keyof typeof expected] !== value) {
        context.addIssue({
          code: "custom",
          message: `Summary ${key} is inconsistent`,
        })
      }
    }
  })

export const phpIndexerLimitsSchema = z.strictObject({
  maxFiles: z.number().int().positive().max(10_000),
  maxFileBytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1_024 * 1_024),
  maxTotalBytes: z
    .number()
    .int()
    .positive()
    .max(256 * 1_024 * 1_024),
  maxPathDepth: z.number().int().positive().max(128),
  maxFacts: z.number().int().positive().max(1_000_000),
  maxStringLength: z.number().int().positive().max(16_384),
  maxRequestBytes: z
    .number()
    .int()
    .positive()
    .max(4 * 1_024 * 1_024),
  maxOutputBytes: z
    .number()
    .int()
    .positive()
    .max(256 * 1_024 * 1_024),
  maxStderrBytes: z
    .number()
    .int()
    .positive()
    .max(1024 * 1_024),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(10 * 60_000),
})

export type PhpSourceRange = z.infer<typeof phpSourceRangeSchema>
export type PhpSymbol = z.infer<typeof phpSymbolSchema>
export type PhpRelationship = z.infer<typeof phpRelationshipSchema>
export type PhpRoute = z.infer<typeof phpRouteSchema>
export type PhpIndexedFile = z.infer<typeof phpIndexedFileSchema>
export type PhpIndexerResponse = z.infer<typeof phpIndexerResponseSchema>
export type PhpIndexerLimits = z.infer<typeof phpIndexerLimitsSchema>
