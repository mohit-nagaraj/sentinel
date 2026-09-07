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
      readonly reason: "method_mismatch" | "path_mismatch"
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
  return segment === "{param}"
}

function pathsOverlap(left: string, right: string): boolean {
  const leftSegments = segments(left)
  const rightSegments = segments(right)
  return (
    leftSegments.length === rightSegments.length &&
    leftSegments.every(
      (segment, index) =>
        isParameter(segment) ||
        isParameter(rightSegments[index] ?? "") ||
        segment === rightSegments[index]
    )
  )
}

function matchesConcretePath(template: string, concrete: string): boolean {
  const templateSegments = segments(template)
  const concreteSegments = segments(concrete)
  return (
    templateSegments.length === concreteSegments.length &&
    templateSegments.every(
      (segment, index) =>
        isParameter(segment) || segment === concreteSegments[index]
    )
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
  if (left.endpoint.id === right.endpoint.id) {
    return { kind: "exact", endpoint: left.endpoint, evidence }
  }
  if (left.endpoint.method !== right.endpoint.method) {
    return { kind: "conflict", reason: "method_mismatch", evidence }
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
  })
  const sameApplication = catalog.filter(
    (item) => item.endpoint.applicationId === input.applicationId
  )
  const sameMethod = sameApplication.filter(
    (item) =>
      item.endpoint.method === method &&
      matchesConcretePath(item.endpoint.normalizedPath, concretePath)
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

  const otherMethods = sameApplication
    .filter((item) =>
      matchesConcretePath(item.endpoint.normalizedPath, concretePath)
    )
    .sort(compareEvidence)
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
