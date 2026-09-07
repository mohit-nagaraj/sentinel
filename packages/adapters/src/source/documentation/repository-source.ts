import { posix } from "node:path"

import type {
  CheckoutSnapshot,
  GitHubRepositoryIdentity,
} from "../github/index.ts"
import { DocumentationSourceError, documentationError } from "./errors.ts"
import { buildDocumentationMap } from "./map-builder.ts"
import { parseMarkdownDocument } from "./markdown-parser.ts"
import type {
  CrawlWarning,
  DocumentationMap,
  PreviousPageSnapshot,
  PreparedPage,
} from "./types.ts"

export interface RepositoryDocumentationOptions {
  readonly applicationId: string
  readonly repository: GitHubRepositoryIdentity
  readonly snapshot: CheckoutSnapshot
  readonly roots: readonly string[]
  readonly maxPages?: number
  readonly maxTotalBytes?: number
  readonly maxFileBytes?: number
  readonly timeoutMs?: number
  readonly minimumSuccessfulPages?: number
  readonly previousPages?: readonly PreviousPageSnapshot[]
}

function repositoryUri(
  repository: GitHubRepositoryIdentity,
  commitSha: string,
  path = ""
): string {
  const suffix = path.length === 0 ? "" : `/${path}`
  return `repository://${repository.host}/${repository.owner}/${repository.name}/commit/${commitSha}${suffix}`
}

function normalizeRoot(input: string): string {
  const normalized = posix
    .normalize(input.replace(/\\/g, "/"))
    .replace(/^\.\//, "")
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized.length === 0
  ) {
    throw new DocumentationSourceError(
      "invalid_input",
      "Repository documentation root must be a safe relative path"
    )
  }
  return normalized.replace(/\/$/, "")
}

function resolveRepositoryLink(
  currentPath: string,
  href: string,
  approvedPaths: ReadonlySet<string>,
  repository: GitHubRepositoryIdentity,
  commitSha: string
): string | undefined {
  const withoutFragment = href.split("#", 1)[0] ?? ""
  if (
    withoutFragment.length === 0 ||
    /^[a-z][a-z0-9+.-]*:/i.test(withoutFragment)
  ) {
    return undefined
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(withoutFragment)
  } catch {
    return undefined
  }
  const candidate = posix.normalize(
    posix.join(posix.dirname(currentPath), decoded)
  )
  if (candidate === ".." || candidate.startsWith("../")) return undefined
  const alternatives = [
    candidate,
    `${candidate}.md`,
    posix.join(candidate, "README.md"),
  ]
  const matched = alternatives.find((path) => approvedPaths.has(path))
  return matched === undefined
    ? undefined
    : repositoryUri(repository, commitSha, matched)
}

export async function prepareRepositoryDocumentation(
  options: RepositoryDocumentationOptions
): Promise<DocumentationMap> {
  const roots = [...new Set(options.roots.map(normalizeRoot))].sort()
  const maxPages = options.maxPages ?? 500
  const maxTotalBytes = options.maxTotalBytes ?? 32 * 1_024 * 1_024
  const maxFileBytes = options.maxFileBytes ?? 2 * 1_024 * 1_024
  const timeoutMs = options.timeoutMs ?? 60_000
  if (
    maxPages < 1 ||
    maxPages > 10_000 ||
    maxTotalBytes < 1 ||
    maxFileBytes < 1
  ) {
    throw new DocumentationSourceError(
      "invalid_input",
      "Repository documentation limits are invalid"
    )
  }
  const startedAt = Date.now()
  const entries = options.snapshot
    .enumerate()
    .filter(
      (entry) =>
        entry.kind === "file" &&
        /\.(?:md|mdx)$/i.test(entry.path) &&
        roots.some(
          (root) => entry.path === root || entry.path.startsWith(`${root}/`)
        )
    )
    .sort((left, right) => left.path.localeCompare(right.path))
  const approvedPaths = new Set(entries.map((entry) => entry.path))
  const prepared: PreparedPage[] = []
  const failedUris: string[] = []
  const warnings: CrawlWarning[] = []
  let fetchedBytes = 0

  for (const entry of entries) {
    const uri = repositoryUri(
      options.repository,
      options.snapshot.metadata.commitSha,
      entry.path
    )
    if (prepared.length + failedUris.length >= maxPages) {
      warnings.push({
        code: "page_limit_reached",
        message: "Repository page limit was reached",
      })
      break
    }
    if (Date.now() - startedAt >= timeoutMs) {
      warnings.push({
        code: "time_limit_reached",
        message: "Repository documentation time limit was reached",
      })
      break
    }
    if (
      entry.sizeBytes > maxFileBytes ||
      fetchedBytes + entry.sizeBytes > maxTotalBytes
    ) {
      failedUris.push(uri)
      warnings.push({
        code: "byte_limit_reached",
        message: "Repository documentation byte limit was reached",
        sourceUri: uri,
      })
      if (fetchedBytes + entry.sizeBytes > maxTotalBytes) break
      continue
    }
    try {
      const markdown = await options.snapshot.readText(entry.path, maxFileBytes)
      fetchedBytes += Buffer.byteLength(markdown, "utf8")
      const parsed = parseMarkdownDocument(markdown, uri)
      prepared.push({
        sourceUri: uri,
        canonicalUri: uri,
        mediaType: "text/markdown",
        document: {
          ...parsed,
          links: parsed.links
            .map((href) =>
              resolveRepositoryLink(
                entry.path,
                href,
                approvedPaths,
                options.repository,
                options.snapshot.metadata.commitSha
              )
            )
            .filter((link): link is string => link !== undefined),
        },
      })
    } catch (error) {
      failedUris.push(uri)
      const normalized = documentationError(error, "invalid_content")
      if (normalized.code === "aborted") throw normalized
    }
  }

  return buildDocumentationMap({
    applicationId: options.applicationId,
    kind: "repository",
    rootUri: repositoryUri(
      options.repository,
      options.snapshot.metadata.commitSha
    ),
    pages: prepared,
    failedUris,
    warnings,
    attemptedPages: prepared.length + failedUris.length,
    fetchedBytes,
    ...(options.minimumSuccessfulPages === undefined
      ? {}
      : { minimumSuccessfulPages: options.minimumSuccessfulPages }),
    ...(options.previousPages === undefined
      ? {}
      : { previousPages: options.previousPages }),
  })
}
