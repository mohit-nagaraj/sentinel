import {
  applicationIdSchema,
  commitShaSchema,
  contentHashSchema,
  repositoryIdentitySchema,
  type ApplicationId,
  type ContentHash,
} from "@sentinel/contracts"
import type { z } from "zod"

import type {
  PhpIndexedFile,
  PhpIndexerResponse,
  PhpRoute,
} from "../../php-laravel/schema.ts"
import type { ApiCallCandidateRecord } from "../typescript/indexer.ts"
import type { IndexRepositoryIdentity } from "../typescript/identity.ts"
import {
  createEndpointTemplate,
  type NormalizeEndpointPathOptions,
} from "./normalize.ts"
import {
  endpointEvidenceSchema,
  unresolvedEndpointEvidenceSchema,
  type EndpointEvidence,
  type UnresolvedEndpointEvidence,
} from "./schema.ts"

type RepositoryIdentity = z.infer<typeof repositoryIdentitySchema>

export interface EndpointSourceResult {
  readonly endpoints: readonly EndpointEvidence[]
  readonly unresolved: readonly UnresolvedEndpointEvidence[]
}

export interface FrontendEndpointInput extends NormalizeEndpointPathOptions {
  readonly applicationId: ApplicationId
  readonly repository: IndexRepositoryIdentity
  readonly commitSha: string
  readonly indexerVersion: string
  readonly contentHash: ContentHash
  readonly candidate: ApiCallCandidateRecord
}

export function endpointFromFrontendCandidate(
  input: FrontendEndpointInput
): EndpointSourceResult {
  const provenance = {
    sourceKind: "frontend" as const,
    extractor: {
      name: "typescript_indexer" as const,
      version: input.indexerVersion,
    },
    sourceHash: contentHashSchema.parse(input.contentHash),
    repository: repositoryIdentitySchema.parse(input.repository),
    commitSha: commitShaSchema.parse(input.commitSha),
    filePath: input.candidate.filePath,
    range: input.candidate.range,
  }
  if (input.candidate.method === undefined) {
    return {
      endpoints: [],
      unresolved: [
        unresolvedEndpointEvidenceSchema.parse({
          sourceKind: "frontend",
          reason: "dynamic_method",
          provenance,
        }),
      ],
    }
  }
  if (input.candidate.pathTemplate === undefined) {
    return {
      endpoints: [],
      unresolved: [
        unresolvedEndpointEvidenceSchema.parse({
          sourceKind: "frontend",
          reason: "dynamic_path",
          provenance,
        }),
      ],
    }
  }
  return {
    endpoints: [
      endpointEvidenceSchema.parse({
        sourceKind: "frontend",
        endpoint: createEndpointTemplate({
          applicationId: applicationIdSchema.parse(input.applicationId),
          method: input.candidate.method,
          path: input.candidate.pathTemplate,
          ...(input.basePath === undefined ? {} : { basePath: input.basePath }),
          ...(input.stripPrefixes === undefined
            ? {}
            : { stripPrefixes: input.stripPrefixes }),
        }),
        provenance,
      }),
    ],
    unresolved: [],
  }
}

export interface LaravelEndpointInput extends NormalizeEndpointPathOptions {
  readonly response: PhpIndexerResponse
  readonly file: PhpIndexedFile
  readonly route: PhpRoute
}

const anyRouteMethods = [
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
] as const

function expandOptionalRoutePaths(path: string): readonly string[] | undefined {
  const segments = path.split("/").filter(Boolean)
  const firstOptional = segments.findIndex((segment) =>
    /^\{[^{}\/?]+\?\}$/u.test(segment)
  )
  if (firstOptional === -1) return [path]
  const optional = segments.slice(firstOptional)
  if (
    optional.length > 8 ||
    optional.some((segment) => !/^\{[^{}\/?]+\?\}$/u.test(segment))
  ) {
    return undefined
  }
  const required = segments.slice(0, firstOptional)
  return Object.freeze(
    Array.from({ length: optional.length + 1 }, (_, included) => {
      const includedOptional = optional
        .slice(0, included)
        .map((segment) => segment.replace(/\?\}$/u, "}"))
      const variant = [...required, ...includedOptional]
      return variant.length === 0 ? "/" : `/${variant.join("/")}`
    })
  )
}

export function endpointsFromLaravelRoute(
  input: LaravelEndpointInput
): EndpointSourceResult {
  const file = input.response.files.find(
    (candidate) =>
      candidate.path === input.file.path &&
      candidate.contentHash === input.file.contentHash
  )
  const route = file?.routes.find(
    (candidate) => candidate.id === input.route.id
  )
  if (file === undefined || route === undefined) {
    throw new Error("Laravel route is not indexed by the supplied response")
  }
  const provenance = {
    sourceKind: "laravel" as const,
    extractor: {
      name: "php_laravel_indexer" as const,
      version: input.response.parser.version,
    },
    sourceHash: file.contentHash,
    repository: input.response.source.repository as RepositoryIdentity,
    commitSha: input.response.source.commitSha,
    filePath: file.path,
    range: {
      startLine: route.range.startLine,
      endLine: route.range.endLine,
    },
  }
  if (route.dynamic || route.path === null) {
    return {
      endpoints: [],
      unresolved: [
        unresolvedEndpointEvidenceSchema.parse({
          sourceKind: "laravel",
          reason: "dynamic_path",
          provenance,
        }),
      ],
    }
  }
  const routePaths = expandOptionalRoutePaths(route.path)
  if (routePaths === undefined) {
    return {
      endpoints: [],
      unresolved: [
        unresolvedEndpointEvidenceSchema.parse({
          sourceKind: "laravel",
          reason: "dynamic_path",
          provenance,
        }),
      ],
    }
  }
  const methods = new Set(
    route.methods.flatMap((method) =>
      method === "ANY" ? anyRouteMethods : [method]
    )
  )
  const handler = route.action.dynamic
    ? undefined
    : {
        qualifiedName: route.action.resolvedName,
        ...(route.action.method === undefined
          ? {}
          : { method: route.action.method }),
        ...(route.action.targetSymbolId === undefined
          ? {}
          : { symbolId: route.action.targetSymbolId }),
      }
  return {
    endpoints: Object.freeze(
      [...methods].sort().flatMap((method) =>
        routePaths.map((path) =>
          endpointEvidenceSchema.parse({
            sourceKind: "laravel",
            endpoint: createEndpointTemplate({
              applicationId: input.response.source.applicationId,
              method,
              path,
              ...(input.basePath === undefined
                ? {}
                : { basePath: input.basePath }),
              ...(input.stripPrefixes === undefined
                ? {}
                : { stripPrefixes: input.stripPrefixes }),
            }),
            provenance,
            ...(handler === undefined ? {} : { handler }),
          })
        )
      )
    ),
    unresolved: [],
  }
}
