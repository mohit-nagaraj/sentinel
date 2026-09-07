import type { DocumentationMap } from "./types.ts"

export function documentMapPersistenceView(map: DocumentationMap) {
  return {
    source: map.source,
    pages: map.pages.map((page) => ({
      id: page.fact.id,
      canonicalUri: page.fact.canonicalUri,
      sourceUri: page.sourceUri,
      title: page.fact.title,
      mediaType: page.mediaType,
      contentHash: page.fact.contentHash,
      sanitizedText: page.sanitizedText,
      change: page.change,
    })),
    sections: map.sections.map((section) => ({
      id: section.fact.id,
      pageId: section.fact.pageId,
      sourceUri: section.sourceUri,
      headingPath: section.fact.headingPath,
      excerpt: section.fact.excerpt,
      startOffset: section.startOffset,
      endOffset: section.endOffset,
      contentHash: section.fact.contentHash,
    })),
    links: map.links,
    coverage: map.coverage,
    warnings: map.warnings,
  }
}
