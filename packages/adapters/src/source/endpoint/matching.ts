import {
  contentHashSchema,
  hashCanonical,
  timestampSchema,
  type ApiEndpointId,
  type ContentHash,
} from "@sentinel/contracts"

import {
  EndpointNormalizationError,
  normalizeEndpointPath,
  normalizeHttpMethod,
  type NormalizeEndpointPathOptions,
} from "./normalize.ts"
import type {
  EndpointEvidence,
  EndpointProvenance,
  EndpointTemplate,
} from "./schema.ts"

export const ENDPOINT_MATCHER_VERSION = "1.0.0"

const canonicalPlaceholder = "{param}"

type TemplateComparison =
  | {
      readonly kind: "exact"
      readonly endpoint: EndpointTemplate
      readonly evidence: readonly [EndpointEvidence, EndpointEvidence]
    }
  | {
      readonly kind: "candidate"
      readonly reason: "static_dynamic_overlap"
      readonly evidence: readonly [EndpointEvidence, EndpointEvidence]
    }
  | {
      readonly kind: "conflict"
      readonly reason:
        "application_mismatch" | "method_mismatch" | "path_mismatch"
      readonly evidence: readonly [EndpointEvidence, EndpointEvidence]
    }

export interface RuntimeRequestInput extends NormalizeEndpointPathOptions {
  readonly applicationId: EndpointTemplate["applicationId"]
  readonly method: string
  readonly url: string
  readonly sourceHash: ContentHash
  readonly observedAt: string
  readonly headers?: Readonly<Record<string, string | readonly string[]>>
  readonly body?: unknown
}

export interface RuntimeRedactionSummary {
  readonly queryParameterCount: number
  readonly headerCount: number
  readonly bodyPresent: boolean
}

interface RuntimeMatchBase {
  readonly observation: {
    readonly sourceKind: "browser"
    readonly provenance: EndpointProvenance
  }
  readonly redaction: RuntimeRedactionSummary
}

export type RuntimeEndpointMatch =
  | (RuntimeMatchBase & {
      readonly kind: "exact"
      readonly endpoint: EndpointTemplate
      readonly evidence: readonly EndpointEvidence[]
    })
  | (RuntimeMatchBase & {
      readonly kind: "candidate"
      readonly reason: "ambiguous_path"
      readonly candidateEndpointIds: readonly ApiEndpointId[]
      readonly evidence: readonly EndpointEvidence[]
    })
  | (RuntimeMatchBase & {
      readonly kind: "conflict"
      readonly reason: "method_mismatch"
      readonly candidateEndpointIds: readonly ApiEndpointId[]
      readonly evidence: readonly EndpointEvidence[]
    })
  | (RuntimeMatchBase & {
      readonly kind: "unmatched"
      readonly reason: "unmatched_runtime_path" | "unsupported_method"
    })

function segments(path: string): readonly string[] {
  return path === "/" ? [] : path.slice(1).split("/")
}

function isParameter(segment: string): boolean {
  return segment.includes(canonicalPlaceholder)
}

function findLiteral(
  value: string,
  literal: string,
  fromIndex: number
): number {
  if (fromIndex > value.length) return -1
  if (literal.length === 0) return fromIndex

  const failure = new Uint32Array(literal.length)
  for (let index = 1, prefix = 0; index < literal.length; index += 1) {
    while (prefix > 0 && literal[index] !== literal[prefix]) {
      prefix = failure[prefix - 1] ?? 0
    }
    if (literal[index] === literal[prefix]) prefix += 1
    failure[index] = prefix
  }

  for (let index = fromIndex, matched = 0; index < value.length; index += 1) {
    while (matched > 0 && value[index] !== literal[matched]) {
      matched = failure[matched - 1] ?? 0
    }
    if (value[index] === literal[matched]) matched += 1
    if (matched === literal.length) return index - literal.length + 1
  }
  return -1
}

function matchesConcreteSegment(template: string, concrete: string): boolean {
  const literals = template.split(canonicalPlaceholder)
  if (literals.length === 1) return template === concrete

  const prefix = literals[0] ?? ""
  if (!concrete.startsWith(prefix)) return false
  let position = prefix.length
  for (let index = 1; index < literals.length - 1; index += 1) {
    const literal = literals[index] ?? ""
    const foundAt = findLiteral(concrete, literal, position + 1)
    if (foundAt === -1) return false
    position = foundAt + literal.length
  }

  const suffix = literals[literals.length - 1] ?? ""
  const suffixStart = concrete.length - suffix.length
  return suffixStart >= position + 1 && concrete.startsWith(suffix, suffixStart)
}

function segmentsOverlap(left: string, right: string): boolean {
  const leftDynamic = isParameter(left)
  const rightDynamic = isParameter(right)
  if (!leftDynamic)
    return rightDynamic ? matchesConcreteSegment(right, left) : left === right
  if (!rightDynamic) return matchesConcreteSegment(left, right)

  const leftPrefix = left.slice(0, left.indexOf(canonicalPlaceholder))
  const rightPrefix = right.slice(0, right.indexOf(canonicalPlaceholder))
  if (
    !leftPrefix.startsWith(rightPrefix) &&
    !rightPrefix.startsWith(leftPrefix)
  ) {
    return false
  }

  const leftSuffix = left.slice(
    left.lastIndexOf(canonicalPlaceholder) + canonicalPlaceholder.length
  )
  const rightSuffix = right.slice(
    right.lastIndexOf(canonicalPlaceholder) + canonicalPlaceholder.length
  )
  return leftSuffix.endsWith(rightSuffix) || rightSuffix.endsWith(leftSuffix)
}

function pathsOverlap(left: string, right: string): boolean {
  const leftSegments = segments(left)
  const rightSegments = segments(right)
  return (
    leftSegments.length === rightSegments.length &&
    leftSegments.every((segment, index) =>
      segmentsOverlap(segment, rightSegments[index] ?? "")
    )
  )
}

function matchesConcretePath(template: string, concrete: string): boolean {
  const templateSegments = segments(template)
  const concreteSegments = segments(concrete)
  return (
    templateSegments.length === concreteSegments.length &&
    templateSegments.every((segment, index) => {
      const concreteSegment = concreteSegments[index]
      if (concreteSegment === undefined) return false
      return matchesConcreteSegment(segment, concreteSegment)
    })
  )
}

function specificity(path: string): number {
  return segments(path).filter((segment) => !isParameter(segment)).length
}

function compareEvidence(
  left: EndpointEvidence,
  right: EndpointEvidence
): number {
  return (
    left.endpoint.id.localeCompare(right.endpoint.id) ||
    left.sourceKind.localeCompare(right.sourceKind) ||
    left.provenance.sourceHash.localeCompare(right.provenance.sourceHash)
  )
}

export function compareEndpointEvidence(
  left: EndpointEvidence,
  right: EndpointEvidence
): TemplateComparison {
  const evidence = [left, right] as const
  if (left.endpoint.applicationId !== right.endpoint.applicationId) {
    return { kind: "conflict", reason: "application_mismatch", evidence }
  }
  if (left.endpoint.method !== right.endpoint.method) {
    return { kind: "conflict", reason: "method_mismatch", evidence }
  }
  if (
    left.endpoint.id === right.endpoint.id &&
    left.endpoint.normalizedPath === right.endpoint.normalizedPath
  ) {
    return { kind: "exact", endpoint: left.endpoint, evidence }
  }
  if (
    pathsOverlap(left.endpoint.normalizedPath, right.endpoint.normalizedPath)
  ) {
    return { kind: "candidate", reason: "static_dynamic_overlap", evidence }
  }
  return { kind: "conflict", reason: "path_mismatch", evidence }
}

function runtimeUrl(value: string): URL {
  try {
    return new URL(value, "https://runtime.invalid")
  } catch {
    throw new EndpointNormalizationError("invalid_path")
  }
}

function runtimeSummary(input: RuntimeRequestInput): RuntimeRedactionSummary {
  const url = runtimeUrl(input.url)
  return Object.freeze({
    queryParameterCount: [...url.searchParams].length,
    headerCount: Object.keys(input.headers ?? {}).length,
    bodyPresent: input.body !== undefined,
  })
}

function runtimeProvenance(input: RuntimeRequestInput): EndpointProvenance {
  return Object.freeze({
    sourceKind: "browser",
    extractor: {
      name: "endpoint_matcher",
      version: ENDPOINT_MATCHER_VERSION,
    },
    sourceHash: contentHashSchema.parse(input.sourceHash),
    observedAt: timestampSchema.parse(input.observedAt),
  })
}

function uniqueEndpointIds(
  evidence: readonly EndpointEvidence[]
): readonly ApiEndpointId[] {
  return Object.freeze(
    [...new Set(evidence.map((item) => item.endpoint.id))].sort()
  )
}

export function matchRuntimeRequest(
  input: RuntimeRequestInput,
  catalog: readonly EndpointEvidence[]
): RuntimeEndpointMatch {
  const redaction = runtimeSummary(input)
  const provenance = runtimeProvenance(input)
  const observation = Object.freeze({
    sourceKind: "browser" as const,
    provenance,
  })
  let method: EndpointTemplate["method"]
  try {
    method = normalizeHttpMethod(input.method)
  } catch {
    return {
      kind: "unmatched",
      reason: "unsupported_method",
      observation,
      redaction,
    }
  }
  const concretePath = normalizeEndpointPath(input.url, {
    ...(input.basePath === undefined ? {} : { basePath: input.basePath }),
    ...(input.stripPrefixes === undefined
      ? {}
      : { stripPrefixes: input.stripPrefixes }),
    templateSyntax: false,
  })
  const sameApplication = catalog.filter(
    (item) => item.endpoint.applicationId === input.applicationId
  )
  const pathMatches = sameApplication.filter((item) =>
    matchesConcretePath(item.endpoint.normalizedPath, concretePath)
  )
  const sameMethod = pathMatches.filter(
    (item) => item.endpoint.method === method
  )
  if (sameMethod.length > 0) {
    const bestSpecificity = Math.max(
      ...sameMethod.map((item) => specificity(item.endpoint.normalizedPath))
    )
    const best = sameMethod
      .filter(
        (item) => specificity(item.endpoint.normalizedPath) === bestSpecificity
      )
      .sort(compareEvidence)
    const ids = uniqueEndpointIds(best)
    if (ids.length === 1) {
      const endpoint = best[0]?.endpoint
      if (endpoint === undefined) {
        throw new Error("Endpoint match invariant failed")
      }
      return {
        kind: "exact",
        endpoint,
        evidence: Object.freeze(best),
        observation,
        redaction,
      }
    }
    return {
      kind: "candidate",
      reason: "ambiguous_path",
      candidateEndpointIds: ids,
      evidence: Object.freeze(best),
      observation,
      redaction,
    }
  }

  const otherMethods = pathMatches.sort(compareEvidence)
  if (otherMethods.length > 0) {
    return {
      kind: "conflict",
      reason: "method_mismatch",
      candidateEndpointIds: uniqueEndpointIds(otherMethods),
      evidence: Object.freeze(otherMethods),
      observation,
      redaction,
    }
  }
  return {
    kind: "unmatched",
    reason: "unmatched_runtime_path",
    observation,
    redaction,
  }
}

export function sanitizedRuntimeRequestHash(
  input: Pick<RuntimeRequestInput, "method" | "headers" | "body" | "url">
): ContentHash {
  return hashCanonical({
    kind: "redacted_runtime_request",
    method: input.method.trim().toUpperCase(),
    url: input.url,
    headers: input.headers ?? {},
    body: input.body ?? null,
  })
}
