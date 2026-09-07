import {
  applicationIdSchema,
  contentHashSchema,
  createStableKey,
  documentPageFactSchema,
  documentPageIdSchema,
  documentSectionFactSchema,
  documentSectionIdSchema,
  documentSourceFactSchema,
  documentSourceIdSchema,
  hashCanonical,
} from "@sentinel/contracts"

import { DocumentationSourceError } from "./errors.ts"
import type {
  CrawlWarning,
  DocumentLinkEdge,
  DocumentMapBuildInput,
  DocumentPageRecord,
  DocumentSectionRecord,
  DocumentationMap,
  ParsedSection,
  PreparedPage,
} from "./types.ts"

const MAX_EXCERPT_LENGTH = 4_000

function splitSection(section: ParsedSection): readonly ParsedSection[] {
  if (section.excerpt.length <= MAX_EXCERPT_LENGTH) return [section]
  const parts: ParsedSection[] = []
  let cursor = 0
  while (cursor < section.excerpt.length) {
    let end = Math.min(cursor + MAX_EXCERPT_LENGTH, section.excerpt.length)
    if (end < section.excerpt.length) {
      const newline = section.excerpt.lastIndexOf("\n", end)
      const space = section.excerpt.lastIndexOf(" ", end)
      const boundary = Math.max(newline, space)
      if (boundary > cursor + MAX_EXCERPT_LENGTH / 2) end = boundary
    }
    const excerpt = section.excerpt.slice(cursor, end).trim()
    const relativeStart = section.excerpt.indexOf(excerpt, cursor)
    const startOffset = section.startOffset + relativeStart
    parts.push({
      headingPath: [...section.headingPath, `Part ${parts.length + 1}`],
      excerpt,
      startOffset,
      endOffset: startOffset + excerpt.length,
    })
    cursor = end
    while (/\s/.test(section.excerpt[cursor] ?? "")) cursor += 1
  }
  return parts
}

function sourceIdentity(applicationId: string, rootUri: string) {
  const parsedApplicationId = applicationIdSchema.parse(applicationId)
  return documentSourceIdSchema.parse(
    createStableKey({
      kind: "document-source",
      applicationId: parsedApplicationId,
      rootUri,
    })
  )
}

function pageContentHash(page: PreparedPage) {
  return hashCanonical({
    mediaType: page.mediaType,
    sanitizedText: page.document.sanitizedText,
    title: page.document.title,
  })
}

export function buildDocumentationMap(
  input: DocumentMapBuildInput
): DocumentationMap {
  const applicationId = applicationIdSchema.parse(input.applicationId)
  const minimumSuccessfulPages = input.minimumSuccessfulPages ?? 1
  if (!Number.isInteger(minimumSuccessfulPages) || minimumSuccessfulPages < 1) {
    throw new DocumentationSourceError(
      "invalid_input",
      "Minimum successful documentation pages must be a positive integer"
    )
  }
  const sourceId = sourceIdentity(input.applicationId, input.rootUri)
  const previous = new Map(
    (input.previousPages ?? []).map((page) => [
      page.canonicalUri,
      page.contentHash,
    ])
  )

  const sorted = [...input.pages].sort((left, right) => {
    const canonicalOrder = left.canonicalUri.localeCompare(right.canonicalUri)
    if (canonicalOrder !== 0) return canonicalOrder
    const leftIsCanonical = left.sourceUri === left.canonicalUri ? 0 : 1
    const rightIsCanonical = right.sourceUri === right.canonicalUri ? 0 : 1
    return (
      leftIsCanonical - rightIsCanonical ||
      left.sourceUri.localeCompare(right.sourceUri)
    )
  })
  const unique: PreparedPage[] = []
  const aliasToCanonical = new Map<string, string>()
  const contentOwners = new Map<string, PreparedPage>()
  const canonicalOwners = new Map<string, PreparedPage>()
  let duplicatePages = 0
  for (const page of sorted) {
    const contentHash = pageContentHash(page)
    const owner =
      canonicalOwners.get(page.canonicalUri) ?? contentOwners.get(contentHash)
    if (owner !== undefined) {
      duplicatePages += 1
      aliasToCanonical.set(page.sourceUri, owner.canonicalUri)
      aliasToCanonical.set(page.canonicalUri, owner.canonicalUri)
      continue
    }
    unique.push(page)
    canonicalOwners.set(page.canonicalUri, page)
    contentOwners.set(contentHash, page)
    aliasToCanonical.set(page.sourceUri, page.canonicalUri)
    aliasToCanonical.set(page.canonicalUri, page.canonicalUri)
  }

  const pageIdentities = new Map<
    string,
    ReturnType<typeof documentPageIdSchema.parse>
  >()
  const pageHashes = new Map<
    string,
    ReturnType<typeof contentHashSchema.parse>
  >()
  for (const page of unique) {
    const contentHash = pageContentHash(page)
    pageHashes.set(page.canonicalUri, contentHash)
    pageIdentities.set(
      page.canonicalUri,
      documentPageIdSchema.parse(
        createStableKey({
          kind: "document-page",
          applicationId,
          sourceId,
          canonicalUri: page.canonicalUri,
          contentHash,
        })
      )
    )
  }

  const sectionRecords: DocumentSectionRecord[] = []
  const pageRecords: DocumentPageRecord[] = []
  const internalWarnings: CrawlWarning[] = []
  for (const page of unique) {
    const pageId = pageIdentities.get(page.canonicalUri)
    const contentHash = pageHashes.get(page.canonicalUri)
    if (pageId === undefined || contentHash === undefined) continue
    const allLinkedPageIds = [
      ...new Set(
        page.document.links.map((uri) => aliasToCanonical.get(uri) ?? uri)
      ),
    ]
      .map((uri) => pageIdentities.get(uri))
      .filter((id): id is NonNullable<typeof id> => id !== undefined)
      .filter((id) => id !== pageId)
      .sort()
    const linkedPageIds = allLinkedPageIds.slice(0, 500)
    if (allLinkedPageIds.length > linkedPageIds.length) {
      internalWarnings.push({
        code: "link_limit_reached",
        message:
          "A documentation page exceeded the durable outgoing-link limit",
        sourceUri: page.sourceUri,
      })
    }
    const sectionIds: ReturnType<typeof documentSectionIdSchema.parse>[] = []
    const seenSectionIds = new Set<string>()
    for (const section of page.document.sections.flatMap(splitSection)) {
      if (
        section.excerpt !==
        page.document.sanitizedText.slice(
          section.startOffset,
          section.endOffset
        )
      ) {
        throw new DocumentationSourceError(
          "invalid_content",
          "Documentation section offsets do not match the sanitized excerpt"
        )
      }
      const sectionHash = hashCanonical({ excerpt: section.excerpt })
      const sectionId = documentSectionIdSchema.parse(
        createStableKey({
          kind: "document-section",
          applicationId,
          pageId,
          headingPath: [...section.headingPath],
          contentHash: sectionHash,
        })
      )
      if (seenSectionIds.has(sectionId)) continue
      seenSectionIds.add(sectionId)
      sectionIds.push(sectionId)
      sectionRecords.push({
        fact: documentSectionFactSchema.parse({
          id: sectionId,
          applicationId,
          pageId,
          headingPath: [...section.headingPath],
          excerpt: section.excerpt,
          contentHash: sectionHash,
        }),
        sourceUri: page.sourceUri,
        startOffset: section.startOffset,
        endOffset: section.endOffset,
        sanitizedText: section.excerpt,
      })
    }
    const previousHash = previous.get(page.canonicalUri)
    pageRecords.push({
      fact: documentPageFactSchema.parse({
        id: pageId,
        applicationId,
        sourceId,
        canonicalUri: page.canonicalUri,
        title: page.document.title,
        contentHash,
        linkedPageIds,
      }),
      sourceUri: page.sourceUri,
      mediaType: page.mediaType,
      sanitizedText: page.document.sanitizedText,
      sectionIds,
      outgoingUris: [...new Set(page.document.links)].sort(),
      change:
        previousHash === undefined
          ? "added"
          : previousHash === contentHash
            ? "unchanged"
            : "changed",
    })
    previous.delete(page.canonicalUri)
  }

  const links: DocumentLinkEdge[] = pageRecords.flatMap((page) =>
    page.fact.linkedPageIds.map((toPageId) => ({
      fromPageId: page.fact.id,
      toPageId,
      relation: "LINKS_TO" as const,
    }))
  )
  const failedUris = Object.freeze([...(input.failedUris ?? [])].sort())
  const attemptedPages =
    input.attemptedPages ?? input.pages.length + failedUris.length
  const removalIsAuthoritative =
    failedUris.length === 0 &&
    !(input.warnings ?? []).some((warning) =>
      [
        "byte_limit_reached",
        "failed_page",
        "page_limit_reached",
        "time_limit_reached",
      ].includes(warning.code)
    )
  const removedPages = removalIsAuthoritative ? previous.size : 0
  const warningCandidates: CrawlWarning[] = [
    ...(input.warnings ?? []),
    ...internalWarnings,
  ]
  for (const sourceUri of failedUris.slice(0, 50)) {
    warningCandidates.push({
      code: "failed_page",
      message: "One approved documentation page could not be prepared",
      sourceUri,
    })
  }
  if (pageRecords.length < minimumSuccessfulPages) {
    warningCandidates.push({
      code: "minimum_source_not_met",
      message:
        "The documentation map did not meet its minimum successful-page requirement",
    })
  }
  const warnings = [
    ...new Map(
      warningCandidates.map((warning) => [
        `${warning.code}:${warning.sourceUri ?? ""}`,
        warning,
      ])
    ).values(),
  ].slice(0, 100)
  const coverage = {
    attemptedPages,
    successfulPages: pageRecords.length,
    failedPages: failedUris.length,
    duplicatePages,
    removedPages,
    fetchedBytes: input.fetchedBytes ?? 0,
    complete: warnings.length === 0 && failedUris.length === 0,
  }
  const mapHash = hashCanonical({
    coverage,
    failedUris,
    links,
    pages: pageRecords.map((page) => page.fact),
    sections: sectionRecords.map((section) => ({
      ...section.fact,
      endOffset: section.endOffset,
      sourceUri: section.sourceUri,
      startOffset: section.startOffset,
    })),
  })
  const source = documentSourceFactSchema.parse({
    id: sourceId,
    applicationId,
    kind: input.kind,
    rootUri: input.rootUri,
    contentHash: mapHash,
  })
  return Object.freeze({
    source,
    pages: Object.freeze(pageRecords),
    sections: Object.freeze(sectionRecords),
    links: Object.freeze(links),
    failedUris,
    warnings: Object.freeze(warnings),
    coverage: Object.freeze(coverage),
    mapHash,
  })
}
