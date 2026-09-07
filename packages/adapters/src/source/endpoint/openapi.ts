import { createHash } from "node:crypto"

import {
  applicationIdSchema,
  canonicalSerialize,
  commitShaSchema,
  contentHashSchema,
  parseCodeFactEnvelope,
  sourceUriSchema,
  type ApplicationId,
  type CodeFactEnvelope,
  type CommitSha,
  type ContentHash,
} from "@sentinel/contracts"
import { parseDocument } from "yaml"
import { z } from "zod"

import {
  createEndpointTemplate,
  type NormalizeEndpointPathOptions,
} from "./normalize.ts"
import {
  endpointEvidenceSchema,
  type EndpointEvidence,
  type EndpointOperationMetadata,
} from "./schema.ts"

export const OPENAPI_IMPORTER_VERSION = "1.0.0"

const openApiExtractor = Object.freeze({
  name: "openapi_importer" as const,
  version: OPENAPI_IMPORTER_VERSION,
})

const openApiLimitsSchema = z.strictObject({
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1_024 * 1_024),
  maxDocumentDepth: z.number().int().positive().max(256),
  maxNodes: z.number().int().positive().max(5_000_000),
  maxPaths: z.number().int().positive().max(100_000),
  maxOperations: z.number().int().positive().max(500_000),
  maxReferences: z.number().int().positive().max(1_000_000),
  maxReferenceDepth: z.number().int().positive().max(256),
  maxStringLength: z.number().int().positive().max(1_000_000),
  maxYamlAliases: z.number().int().nonnegative().max(10_000),
})

export type OpenApiImportLimits = z.infer<typeof openApiLimitsSchema>

export const defaultOpenApiImportLimits: Readonly<OpenApiImportLimits> =
  Object.freeze({
    maxBytes: 8 * 1_024 * 1_024,
    maxDocumentDepth: 80,
    maxNodes: 250_000,
    maxPaths: 20_000,
    maxOperations: 50_000,
    maxReferences: 100_000,
    maxReferenceDepth: 32,
    maxStringLength: 16_384,
    maxYamlAliases: 50,
  })

export type OpenApiImportErrorCode =
  | "byte_limit_exceeded"
  | "document_limit_exceeded"
  | "external_reference_denied"
  | "invalid_document"
  | "invalid_local_reference"
  | "operation_limit_exceeded"
  | "reference_cycle"
  | "reference_limit_exceeded"
  | "unsupported_openapi_version"

export class OpenApiImportError extends Error {
  readonly code: OpenApiImportErrorCode

  constructor(code: OpenApiImportErrorCode) {
    const messages: Record<OpenApiImportErrorCode, string> = {
      byte_limit_exceeded: "OpenAPI input exceeds the configured byte limit",
      document_limit_exceeded:
        "OpenAPI document exceeds a configured structural limit",
      external_reference_denied: "OpenAPI external references are not allowed",
      invalid_document: "OpenAPI document is malformed or unsupported",
      invalid_local_reference: "OpenAPI local reference is invalid",
      operation_limit_exceeded:
        "OpenAPI document exceeds the configured operation limit",
      reference_cycle: "OpenAPI local reference cycle is not supported",
      reference_limit_exceeded:
        "OpenAPI document exceeds the configured reference limit",
      unsupported_openapi_version: "Only OpenAPI 3.0 and 3.1 are supported",
    }
    super(messages[code])
    this.name = "OpenApiImportError"
    this.code = code
  }
}

export interface OpenApiImportRequest extends NormalizeEndpointPathOptions {
  readonly applicationId: ApplicationId
  readonly sourceUri: string
  readonly commitSha?: string
  readonly document: string | Uint8Array | Readonly<Record<string, unknown>>
  readonly limits?: Partial<OpenApiImportLimits>
}

export interface OpenApiImportWarning {
  readonly code: "unsupported_http_method"
  readonly location: string
}

export interface OpenApiImportResult {
  readonly importerVersion: typeof OPENAPI_IMPORTER_VERSION
  readonly openApiVersion: string
  readonly sourceHash: ContentHash
  readonly endpoints: readonly EndpointEvidence[]
  readonly facts: readonly CodeFactEnvelope[]
  readonly warnings: readonly OpenApiImportWarning[]
}

type JsonRecord = Record<string, unknown>

const operationMethods = [
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
] as const

const unsupportedOperationMethods = new Set(["trace", "query"])

function isRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function mergeLimits(
  overrides: Partial<OpenApiImportLimits> | undefined
): OpenApiImportLimits {
  return openApiLimitsSchema.parse({
    ...defaultOpenApiImportLimits,
    ...overrides,
  })
}

function hashBytes(value: string | Uint8Array): ContentHash {
  return contentHashSchema.parse(
    `sha256:${createHash("sha256").update(value).digest("hex")}`
  )
}

function parseInput(
  input: OpenApiImportRequest["document"],
  limits: OpenApiImportLimits
): { readonly root: JsonRecord; readonly sourceHash: ContentHash } {
  if (typeof input !== "string" && !(input instanceof Uint8Array)) {
    let serialized: string
    try {
      serialized = canonicalSerialize(input)
    } catch {
      throw new OpenApiImportError("invalid_document")
    }
    if (Buffer.byteLength(serialized, "utf8") > limits.maxBytes) {
      throw new OpenApiImportError("byte_limit_exceeded")
    }
    if (!isRecord(input)) throw new OpenApiImportError("invalid_document")
    return { root: input as JsonRecord, sourceHash: hashBytes(serialized) }
  }

  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input
  if (bytes.byteLength > limits.maxBytes) {
    throw new OpenApiImportError("byte_limit_exceeded")
  }
  const text = Buffer.from(bytes).toString("utf8")
  let value: unknown
  try {
    const document = parseDocument(text, {
      prettyErrors: false,
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
    })
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw new OpenApiImportError("invalid_document")
    }
    value = document.toJS({ maxAliasCount: limits.maxYamlAliases })
  } catch (error) {
    if (error instanceof OpenApiImportError) throw error
    throw new OpenApiImportError("invalid_document")
  }
  if (!isRecord(value)) throw new OpenApiImportError("invalid_document")
  return { root: value, sourceHash: hashBytes(bytes) }
}

function inspectDocument(root: JsonRecord, limits: OpenApiImportLimits): void {
  const ancestors = new WeakSet<object>()
  let nodes = 0
  let references = 0

  const inspect = (value: unknown, depth: number): void => {
    nodes += 1
    if (nodes > limits.maxNodes || depth > limits.maxDocumentDepth) {
      throw new OpenApiImportError("document_limit_exceeded")
    }
    if (typeof value === "string") {
      if (value.length > limits.maxStringLength) {
        throw new OpenApiImportError("document_limit_exceeded")
      }
      return
    }
    if (value === null || typeof value !== "object") return
    if (ancestors.has(value)) throw new OpenApiImportError("invalid_document")
    ancestors.add(value)
    const entries: readonly [string, unknown][] = Array.isArray(value)
      ? value.map((entry, index) => [String(index), entry])
      : isRecord(value)
        ? Object.entries(value)
        : (() => {
            throw new OpenApiImportError("invalid_document")
          })()
    for (const [key, entry] of entries) {
      if (key.length > limits.maxStringLength) {
        throw new OpenApiImportError("document_limit_exceeded")
      }
      if (key === "$ref") {
        references += 1
        if (references > limits.maxReferences) {
          throw new OpenApiImportError("reference_limit_exceeded")
        }
        if (typeof entry !== "string") {
          throw new OpenApiImportError("invalid_local_reference")
        }
        if (entry !== "#" && !entry.startsWith("#/")) {
          throw new OpenApiImportError("external_reference_denied")
        }
      }
      inspect(entry, depth + 1)
    }
    ancestors.delete(value)
  }

  inspect(root, 0)
}

function pointerSegment(value: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw new OpenApiImportError("invalid_local_reference")
  }
  if (/~(?:[^01]|$)/u.test(decoded)) {
    throw new OpenApiImportError("invalid_local_reference")
  }
  return decoded.replaceAll("~1", "/").replaceAll("~0", "~")
}

function valueAtPointer(root: JsonRecord, reference: string): unknown {
  if (reference === "#") return root
  let current: unknown = root
  for (const encoded of reference.slice(2).split("/")) {
    const segment = pointerSegment(encoded)
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) {
        throw new OpenApiImportError("invalid_local_reference")
      }
      current = current[Number(segment)]
    } else if (
      isRecord(current) &&
      Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      current = current[segment]
    } else {
      throw new OpenApiImportError("invalid_local_reference")
    }
    if (current === undefined) {
      throw new OpenApiImportError("invalid_local_reference")
    }
  }
  return current
}

function resolveLocal(
  root: JsonRecord,
  value: unknown,
  limits: OpenApiImportLimits,
  seen: ReadonlySet<string> = new Set(),
  depth = 0
): unknown {
  if (!isRecord(value) || typeof value["$ref"] !== "string") return value
  if (depth >= limits.maxReferenceDepth) {
    throw new OpenApiImportError("reference_limit_exceeded")
  }
  if (seen.has(value["$ref"])) {
    throw new OpenApiImportError("reference_cycle")
  }
  const nextSeen = new Set(seen)
  nextSeen.add(value["$ref"])
  return resolveLocal(
    root,
    valueAtPointer(root, value["$ref"]),
    limits,
    nextSeen,
    depth + 1
  )
}

function stringArray(value: unknown, limit: number): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > limit) {
    throw new OpenApiImportError("invalid_document")
  }
  const strings = value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new OpenApiImportError("invalid_document")
    }
    return entry.trim()
  })
  return Object.freeze([...new Set(strings)].sort())
}

function collectSchemaReferences(
  root: JsonRecord,
  value: unknown,
  limits: OpenApiImportLimits
): readonly string[] {
  const references = new Set<string>()
  const ancestors = new WeakSet<object>()

  const collect = (current: unknown, depth: number): void => {
    if (
      depth > limits.maxDocumentDepth ||
      references.size > limits.maxReferences
    ) {
      throw new OpenApiImportError("reference_limit_exceeded")
    }
    if (current === null || typeof current !== "object") return
    if (ancestors.has(current)) throw new OpenApiImportError("reference_cycle")
    ancestors.add(current)
    if (isRecord(current) && typeof current["$ref"] === "string") {
      references.add(current["$ref"])
      collect(resolveLocal(root, current, limits), depth + 1)
    } else {
      for (const child of Array.isArray(current)
        ? current
        : isRecord(current)
          ? Object.values(current)
          : []) {
        collect(child, depth + 1)
      }
    }
    ancestors.delete(current)
  }

  collect(value, 0)
  return Object.freeze([...references].sort())
}

function schemaReferencesFromContent(
  root: JsonRecord,
  value: unknown,
  limits: OpenApiImportLimits
): readonly string[] {
  const resolved = resolveLocal(root, value, limits)
  if (!isRecord(resolved)) throw new OpenApiImportError("invalid_document")
  const content = resolved["content"]
  if (content === undefined) return []
  if (!isRecord(content)) throw new OpenApiImportError("invalid_document")
  const references = new Set<string>()
  for (const mediaType of Object.values(content)) {
    const resolvedMedia = resolveLocal(root, mediaType, limits)
    if (!isRecord(resolvedMedia)) {
      throw new OpenApiImportError("invalid_document")
    }
    for (const reference of collectSchemaReferences(
      root,
      resolvedMedia["schema"],
      limits
    )) {
      references.add(reference)
    }
  }
  return Object.freeze([...references].sort())
}

function operationMetadata(
  root: JsonRecord,
  operation: JsonRecord,
  limits: OpenApiImportLimits
): EndpointOperationMetadata {
  const requestSchemaRefs =
    operation["requestBody"] === undefined
      ? []
      : schemaReferencesFromContent(root, operation["requestBody"], limits)
  if (!isRecord(operation["responses"])) {
    throw new OpenApiImportError("invalid_document")
  }
  const responseSchemaRefs = new Set<string>()
  for (const response of Object.values(operation["responses"])) {
    for (const reference of schemaReferencesFromContent(
      root,
      response,
      limits
    )) {
      responseSchemaRefs.add(reference)
    }
  }
  if (
    operation["operationId"] !== undefined &&
    (typeof operation["operationId"] !== "string" ||
      operation["operationId"].trim().length === 0)
  ) {
    throw new OpenApiImportError("invalid_document")
  }
  return {
    ...(typeof operation["operationId"] === "string"
      ? { operationId: operation["operationId"].trim() }
      : {}),
    tags: [...stringArray(operation["tags"], 100)],
    requestSchemaRefs: [...requestSchemaRefs],
    responseSchemaRefs: [...responseSchemaRefs].sort(),
  }
}

function serverBasePath(server: unknown): string | undefined {
  if (server === undefined) return undefined
  if (!isRecord(server) || typeof server["url"] !== "string") {
    throw new OpenApiImportError("invalid_document")
  }
  let url = server["url"]
  const variables = server["variables"]
  if (isRecord(variables)) {
    url = url.replace(/\{([^{}]+)\}/gu, (_match, name: string) => {
      const variable = variables[name]
      if (!isRecord(variable) || typeof variable["default"] !== "string") {
        throw new OpenApiImportError("invalid_document")
      }
      return variable["default"]
    })
  } else if (/\{[^{}]+\}/u.test(url)) {
    throw new OpenApiImportError("invalid_document")
  }
  return url
}

function firstServer(
  operation: JsonRecord,
  pathItem: JsonRecord,
  root: JsonRecord
): unknown {
  for (const candidate of [
    operation["servers"],
    pathItem["servers"],
    root["servers"],
  ]) {
    if (candidate === undefined) continue
    if (!Array.isArray(candidate) || candidate.length === 0) {
      throw new OpenApiImportError("invalid_document")
    }
    return candidate[0]
  }
  return undefined
}

export function importOpenApiDocument(
  request: OpenApiImportRequest
): OpenApiImportResult {
  const limits = mergeLimits(request.limits)
  const applicationId = applicationIdSchema.parse(request.applicationId)
  const sourceUri = sourceUriSchema.parse(request.sourceUri)
  const commitSha: CommitSha | undefined =
    request.commitSha === undefined
      ? undefined
      : commitShaSchema.parse(request.commitSha)
  const { root, sourceHash } = parseInput(request.document, limits)
  inspectDocument(root, limits)

  if (
    typeof root["openapi"] !== "string" ||
    !/^3\.(?:0|1)\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(root["openapi"])
  ) {
    throw new OpenApiImportError(
      typeof root["openapi"] === "string"
        ? "unsupported_openapi_version"
        : "invalid_document"
    )
  }
  if (!isRecord(root["info"]) || !isRecord(root["paths"])) {
    throw new OpenApiImportError("invalid_document")
  }
  const pathEntries = Object.entries(root["paths"])
  if (pathEntries.length > limits.maxPaths) {
    throw new OpenApiImportError("document_limit_exceeded")
  }

  const endpoints: EndpointEvidence[] = []
  const facts: CodeFactEnvelope[] = []
  const warnings: OpenApiImportWarning[] = []
  const operationIds = new Set<string>()

  for (const [path, unresolvedPathItem] of pathEntries.sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (!path.startsWith("/")) throw new OpenApiImportError("invalid_document")
    const pathItem = resolveLocal(root, unresolvedPathItem, limits)
    if (!isRecord(pathItem)) throw new OpenApiImportError("invalid_document")
    for (const method of unsupportedOperationMethods) {
      if (pathItem[method] !== undefined) {
        warnings.push({
          code: "unsupported_http_method",
          location: `#/paths/${path.replaceAll("~", "~0").replaceAll("/", "~1")}/${method}`,
        })
      }
    }
    for (const method of operationMethods) {
      if (pathItem[method] === undefined) continue
      if (endpoints.length >= limits.maxOperations) {
        throw new OpenApiImportError("operation_limit_exceeded")
      }
      const unresolvedOperation = pathItem[method]
      const operation = resolveLocal(root, unresolvedOperation, limits)
      if (!isRecord(operation)) throw new OpenApiImportError("invalid_document")
      const metadata = operationMetadata(root, operation, limits)
      if (metadata.operationId !== undefined) {
        if (operationIds.has(metadata.operationId)) {
          throw new OpenApiImportError("invalid_document")
        }
        operationIds.add(metadata.operationId)
      }
      const basePath = serverBasePath(firstServer(operation, pathItem, root))
      const endpoint = createEndpointTemplate({
        applicationId,
        method,
        path,
        ...(basePath === undefined ? {} : { basePath }),
        ...(request.stripPrefixes === undefined
          ? {}
          : { stripPrefixes: request.stripPrefixes }),
      })
      const provenance = {
        sourceKind: "openapi" as const,
        extractor: openApiExtractor,
        sourceHash,
        sourceUri,
        ...(commitSha === undefined ? {} : { commitSha }),
      }
      const evidence = endpointEvidenceSchema.parse({
        endpoint,
        sourceKind: "openapi",
        provenance,
        operation: metadata,
      })
      endpoints.push(evidence)
      facts.push(
        parseCodeFactEnvelope({
          schemaVersion: 1,
          extractor: openApiExtractor,
          provenance: {
            sourceKind: "openapi",
            sourceUri,
            contentHash: sourceHash,
            ...(commitSha === undefined ? {} : { commitSha }),
          },
          factKind: "api_endpoint",
          fact: {
            id: endpoint.id,
            applicationId: endpoint.applicationId,
            method: endpoint.method,
            normalizedPath: endpoint.normalizedPath,
            sourceHash,
            ...metadata,
          },
        })
      )
    }
  }

  return Object.freeze({
    importerVersion: OPENAPI_IMPORTER_VERSION,
    openApiVersion: root["openapi"],
    sourceHash,
    endpoints: Object.freeze(
      endpoints.sort((left, right) =>
        left.endpoint.id.localeCompare(right.endpoint.id)
      )
    ),
    facts: Object.freeze(facts),
    warnings: Object.freeze(warnings),
  })
}
