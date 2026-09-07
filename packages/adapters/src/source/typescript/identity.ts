import {
  codeFileIdSchema,
  codeSymbolIdSchema,
  createStableKey,
  frontendRouteIdSchema,
  hashCanonical,
  repositoryIdentitySchema,
  type ApplicationId,
  type CodeFileId,
  type CodeSymbolId,
  type CommitSha,
  type ContentHash,
  type FrontendRouteId,
} from "@sentinel/contracts"

/**
 * Bumped whenever extraction behaviour changes in a way that could alter emitted
 * facts. It is part of the index fingerprint, so consumers can tell a re-index
 * from a behaviour change.
 */
export const TYPESCRIPT_INDEXER_VERSION = "1.0.0"

export const TYPESCRIPT_INDEXER_NAME = "typescript_react_indexer"

export const typeScriptExtractorIdentity = Object.freeze({
  name: TYPESCRIPT_INDEXER_NAME,
  version: TYPESCRIPT_INDEXER_VERSION,
})

export type IndexRepositoryIdentity = ReturnType<
  typeof repositoryIdentitySchema.parse
>

export interface CommitScope {
  readonly applicationId: ApplicationId
  readonly repository: IndexRepositoryIdentity
  readonly commitSha: CommitSha
}

export function createCodeFileId(scope: CommitScope, path: string): CodeFileId {
  return codeFileIdSchema.parse(
    createStableKey({
      kind: "code-file",
      applicationId: scope.applicationId,
      repository: scope.repository,
      commitSha: scope.commitSha,
      path,
    })
  )
}

export function createCodeSymbolId(
  scope: CommitScope,
  filePath: string,
  qualifiedName: string,
  symbolKind: string
): CodeSymbolId {
  return codeSymbolIdSchema.parse(
    createStableKey({
      kind: "code-symbol",
      applicationId: scope.applicationId,
      repository: scope.repository,
      commitSha: scope.commitSha,
      filePath,
      qualifiedName,
      symbolKind,
    })
  )
}

export function createFrontendRouteId(
  scope: CommitScope,
  pathPattern: string
): FrontendRouteId {
  return frontendRouteIdSchema.parse(
    createStableKey({
      kind: "frontend-route",
      applicationId: scope.applicationId,
      repository: scope.repository,
      commitSha: scope.commitSha,
      pathPattern,
    })
  )
}

export function hashSourceText(text: string): ContentHash {
  return hashCanonical({ kind: "source_text", text })
}

/**
 * Deterministic string comparison that does not depend on host locale.
 * `String.prototype.localeCompare` is explicitly avoided because its ordering is
 * environment-dependent, which would make fact order non-reproducible.
 */
export function compareStrings(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function compareNumbers(left: number, right: number): number {
  return left - right
}

/**
 * Orders by a tuple of comparison results, taking the first non-zero.
 */
export function compareBy(...results: readonly number[]): number {
  return results.find((result) => result !== 0) ?? 0
}
