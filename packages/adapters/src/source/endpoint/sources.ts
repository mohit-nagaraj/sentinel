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

export function endpointsFromLaravelRoute(
  input: LaravelEndpointInput
): EndpointSourceResult {
  const provenance = {
    sourceKind: "laravel" as const,
    extractor: {
      name: "php_laravel_indexer" as const,
      version: input.response.parser.version,
    },
    sourceHash: input.file.contentHash,
    repository: input.response.source.repository as RepositoryIdentity,
    commitSha: input.response.source.commitSha,
    filePath: input.file.path,
    range: {
      startLine: input.route.range.startLine,
      endLine: input.route.range.endLine,
    },
  }
  if (input.route.dynamic || input.route.path === null) {
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
    input.route.methods.flatMap((method) =>
      method === "ANY" ? anyRouteMethods : [method]
    )
  )
  const handler = input.route.action.dynamic
    ? undefined
    : {
        qualifiedName: input.route.action.resolvedName,
        ...(input.route.action.method === undefined
          ? {}
          : { method: input.route.action.method }),
        ...(input.route.action.targetSymbolId === undefined
          ? {}
          : { symbolId: input.route.action.targetSymbolId }),
      }
  return {
    endpoints: Object.freeze(
      [...methods].sort().map((method) =>
        endpointEvidenceSchema.parse({
          sourceKind: "laravel",
          endpoint: createEndpointTemplate({
            applicationId: input.response.source.applicationId,
            method,
            path: input.route.path ?? "/",
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
    ),
    unresolved: [],
  }
}
