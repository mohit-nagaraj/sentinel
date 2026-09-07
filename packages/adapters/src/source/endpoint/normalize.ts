import {
  createStableKey,
  httpMethodSchema,
  normalizedPathSchema,
  type ApplicationId,
} from "@sentinel/contracts"

import {
  ENDPOINT_NORMALIZATION_VERSION,
  endpointTemplateSchema,
  type EndpointTemplate,
} from "./schema.ts"

const MAX_ENDPOINT_INPUT_LENGTH = 8_192
const placeholderSegment =
  /^(?:\{[^{}\/]+\??\}|:[^/]+|\$\{[^{}]+\}|\*|\[\[?\.{3}[^\]]+\]?\]|\[[^\]]+\])$/
const percentEncoded = /%[0-9a-fA-F]{2}/g
const unreserved = /^[A-Za-z0-9._~-]$/

export type EndpointNormalizationErrorCode =
  "invalid_method" | "invalid_path" | "path_too_long"

export class EndpointNormalizationError extends Error {
  readonly code: EndpointNormalizationErrorCode

  constructor(code: EndpointNormalizationErrorCode) {
    const messages: Record<EndpointNormalizationErrorCode, string> = {
      invalid_method: "Endpoint method is unsupported",
      invalid_path: "Endpoint path is invalid",
      path_too_long: "Endpoint path exceeds the configured limit",
    }
    super(messages[code])
    this.name = "EndpointNormalizationError"
    this.code = code
  }
}

export interface NormalizeEndpointPathOptions {
  /** Prefix supplied by a source such as an OpenAPI Server URL or Axios base URL. */
  readonly basePath?: string
  /** Explicit source/deployment prefixes to remove, longest match first. */
  readonly stripPrefixes?: readonly string[]
}

function pathOnly(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new EndpointNormalizationError("invalid_path")
  if (trimmed.length > MAX_ENDPOINT_INPUT_LENGTH) {
    throw new EndpointNormalizationError("path_too_long")
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).pathname
    } catch {
      throw new EndpointNormalizationError("invalid_path")
    }
  }
  return trimmed.split(/[?#]/u, 1)[0] ?? ""
}

function normalizePercentEncoding(segment: string): string {
  return segment.replace(percentEncoded, (encoded) => {
    const character = String.fromCharCode(Number.parseInt(encoded.slice(1), 16))
    return unreserved.test(character) ? character : encoded.toUpperCase()
  })
}

function normalizeSegment(segment: string): string {
  if (placeholderSegment.test(segment)) return "{param}"
  const encodedTemplate = /^%7b[^%/]+%7d$/iu.exec(segment)
  if (encodedTemplate !== null) return "{param}"
  return normalizePercentEncoding(segment)
}

function normalizeBarePath(value: string): string {
  const path = pathOnly(value).replaceAll("\\", "/")
  if (/\p{Cc}/u.test(path)) throw new EndpointNormalizationError("invalid_path")
  const segments = path.split("/").filter(Boolean).map(normalizeSegment)
  return normalizedPathSchema.parse(
    segments.length === 0 ? "/" : `/${segments.join("/")}`
  )
}

function joinPaths(basePath: string | undefined, path: string): string {
  if (basePath === undefined) return path
  const normalizedBase = normalizeBarePath(basePath)
  if (normalizedBase === "/") return path
  if (path === "/") return normalizedBase
  return `${normalizedBase}${path}`
}

function stripConfiguredPrefix(
  path: string,
  prefixes: readonly string[] | undefined
): string {
  if (prefixes === undefined || prefixes.length === 0) return path
  const normalized = [...new Set(prefixes.map(normalizeBarePath))].sort(
    (left, right) => right.length - left.length || left.localeCompare(right)
  )
  for (const prefix of normalized) {
    if (prefix === "/") continue
    if (path === prefix) return "/"
    if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length)
  }
  return path
}

export function normalizeEndpointPath(
  value: string,
  options: NormalizeEndpointPathOptions = {}
): string {
  const withBase = joinPaths(options.basePath, normalizeBarePath(value))
  return normalizedPathSchema.parse(
    stripConfiguredPrefix(withBase, options.stripPrefixes)
  )
}

export function normalizeHttpMethod(value: string): EndpointTemplate["method"] {
  const parsed = httpMethodSchema.safeParse(value.trim().toUpperCase())
  if (!parsed.success) throw new EndpointNormalizationError("invalid_method")
  return parsed.data
}

export interface CreateEndpointTemplateInput extends NormalizeEndpointPathOptions {
  readonly applicationId: ApplicationId
  readonly method: string
  readonly path: string
}

export function createEndpointTemplate(
  input: CreateEndpointTemplateInput
): EndpointTemplate {
  const method = normalizeHttpMethod(input.method)
  const normalizedPath = normalizeEndpointPath(input.path, input)
  return endpointTemplateSchema.parse({
    normalizationVersion: ENDPOINT_NORMALIZATION_VERSION,
    id: createStableKey({
      kind: "api-endpoint",
      applicationId: input.applicationId,
      method,
      normalizedPath,
    }),
    applicationId: input.applicationId,
    method,
    normalizedPath,
  })
}
