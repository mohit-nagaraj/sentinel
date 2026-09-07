import { z } from "zod"

import { DocumentationSourceError } from "./errors.ts"
import type {
  DocumentMapBuildInput,
  DocumentPageRecord,
  DocumentSectionRecord,
  DocumentationMap,
} from "./types.ts"

const querySchema = z.string().trim().min(1).max(256)
const limitSchema = z.number().int().min(1).max(100)

function terms(value: string): readonly string[] {
  return value.toLocaleLowerCase("en-US").match(/[a-z0-9]+/g) ?? []
}

export interface DocumentationSearchResult {
  readonly section: DocumentSectionRecord
  readonly page: DocumentPageRecord
  readonly score: number
}

export interface DocumentationTreePage {
  readonly page: DocumentPageRecord
  readonly sections: readonly DocumentSectionRecord[]
}

export interface DocumentationSectionRead {
  readonly id: string
  readonly pageId: string
  readonly sourceUri: string
  readonly headingPath: readonly string[]
  readonly excerpt: string
  readonly startOffset: number
  readonly endOffset: number
  readonly fullEndOffset: number
  readonly fullContentHash: string
  readonly truncated: boolean
}

export class DocumentationMapIndex {
  private readonly pagesById: ReadonlyMap<string, DocumentPageRecord>
  private readonly sectionsById: ReadonlyMap<string, DocumentSectionRecord>
  private readonly sectionsByPage: ReadonlyMap<
    string,
    readonly DocumentSectionRecord[]
  >

  constructor(readonly map: DocumentationMap) {
    this.pagesById = new Map(map.pages.map((page) => [page.fact.id, page]))
    this.sectionsById = new Map(
      map.sections.map((section) => [section.fact.id, section])
    )
    const grouped = new Map<string, DocumentSectionRecord[]>()
    for (const section of map.sections) {
      const existing = grouped.get(section.fact.pageId) ?? []
      existing.push(section)
      grouped.set(section.fact.pageId, existing)
    }
    this.sectionsByPage = grouped
  }

  listPages(
    limit = 50,
    afterCanonicalUri?: string
  ): readonly DocumentPageRecord[] {
    const bounded = limitSchema.parse(limit)
    return this.map.pages
      .filter(
        (page) =>
          afterCanonicalUri === undefined ||
          page.fact.canonicalUri.localeCompare(afterCanonicalUri) > 0
      )
      .sort((left, right) =>
        left.fact.canonicalUri.localeCompare(right.fact.canonicalUri)
      )
      .slice(0, bounded)
  }

  listSections(pageId: string, limit = 50): readonly DocumentSectionRecord[] {
    const bounded = limitSchema.parse(limit)
    if (!this.pagesById.has(pageId)) {
      throw new DocumentationSourceError(
        "invalid_input",
        "Documentation page is outside the approved map"
      )
    }
    return (this.sectionsByPage.get(pageId) ?? []).slice(0, bounded)
  }

  tree(
    pageLimit = 50,
    sectionLimitPerPage = 100
  ): readonly DocumentationTreePage[] {
    const boundedPages = limitSchema.parse(pageLimit)
    const boundedSections = limitSchema.parse(sectionLimitPerPage)
    return this.listPages(boundedPages).map((page) => ({
      page,
      sections: (this.sectionsByPage.get(page.fact.id) ?? []).slice(
        0,
        boundedSections
      ),
    }))
  }

  readSection(
    sectionId: string,
    maxCharacters = 4_096
  ): DocumentationSectionRead {
    const bounded = z.number().int().min(1).max(4_096).parse(maxCharacters)
    const section = this.sectionsById.get(sectionId)
    if (section === undefined) {
      throw new DocumentationSourceError(
        "invalid_input",
        "Documentation section is outside the approved map"
      )
    }
    const excerpt = section.sanitizedText.slice(0, bounded)
    return {
      id: section.fact.id,
      pageId: section.fact.pageId,
      sourceUri: section.sourceUri,
      headingPath: section.fact.headingPath,
      excerpt,
      startOffset: section.startOffset,
      endOffset: section.startOffset + excerpt.length,
      fullEndOffset: section.endOffset,
      fullContentHash: section.fact.contentHash,
      truncated: excerpt.length < section.sanitizedText.length,
    }
  }

  linkedPages(pageId: string, limit = 50): readonly DocumentPageRecord[] {
    const page = this.pagesById.get(pageId)
    if (page === undefined) {
      throw new DocumentationSourceError(
        "invalid_input",
        "Documentation page is outside the approved map"
      )
    }
    return page.fact.linkedPageIds
      .slice(0, limitSchema.parse(limit))
      .map((id) => this.pagesById.get(id))
      .filter((linked): linked is DocumentPageRecord => linked !== undefined)
  }

  search(queryInput: string, limit = 20): readonly DocumentationSearchResult[] {
    const queryTerms = [...new Set(terms(querySchema.parse(queryInput)))]
    const bounded = z.number().int().min(1).max(50).parse(limit)
    const documentFrequency = new Map<string, number>()
    const sectionTerms = this.map.sections.map((section) => {
      const values = terms(
        `${section.fact.headingPath.join(" ")} ${section.sanitizedText}`
      )
      for (const term of new Set(values)) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
      }
      return values
    })
    return this.map.sections
      .map((section, index) => {
        const values = sectionTerms[index] ?? []
        const counts = new Map<string, number>()
        for (const value of values)
          counts.set(value, (counts.get(value) ?? 0) + 1)
        const heading = new Set(terms(section.fact.headingPath.join(" ")))
        const score = queryTerms.reduce((total, term) => {
          const frequency = counts.get(term) ?? 0
          if (frequency === 0) return total
          const inverseFrequency = Math.log(
            1 + this.map.sections.length / (documentFrequency.get(term) ?? 1)
          )
          return (
            total +
            (frequency / Math.max(1, values.length)) *
              inverseFrequency *
              (heading.has(term) ? 3 : 1)
          )
        }, 0)
        const page = this.pagesById.get(section.fact.pageId)
        return page === undefined || score === 0
          ? undefined
          : { section, page, score }
      })
      .filter(
        (result): result is DocumentationSearchResult => result !== undefined
      )
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.section.fact.id.localeCompare(right.section.fact.id)
      )
      .slice(0, bounded)
  }
}

export type { DocumentMapBuildInput }
