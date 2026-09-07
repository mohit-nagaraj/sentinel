import type {
  ContentHash,
  DocumentPageFact,
  DocumentPageId,
  DocumentSectionFact,
  DocumentSectionId,
  DocumentSourceFact,
} from "@sentinel/contracts"

export type PageChange = "added" | "changed" | "unchanged"

export interface DocumentSectionRecord {
  readonly fact: DocumentSectionFact
  readonly sourceUri: string
  readonly startOffset: number
  readonly endOffset: number
  readonly sanitizedText: string
}

export interface DocumentPageRecord {
  readonly fact: DocumentPageFact
  readonly sourceUri: string
  readonly mediaType: "text/html" | "text/markdown"
  readonly sanitizedText: string
  readonly sectionIds: readonly DocumentSectionId[]
  readonly outgoingUris: readonly string[]
  readonly change: PageChange
}

export interface DocumentLinkEdge {
  readonly fromPageId: DocumentPageId
  readonly toPageId: DocumentPageId
  readonly relation: "LINKS_TO"
}

export type CrawlWarningCode =
  | "byte_limit_reached"
  | "failed_page"
  | "link_limit_reached"
  | "minimum_source_not_met"
  | "page_limit_reached"
  | "time_limit_reached"

export interface CrawlWarning {
  readonly code: CrawlWarningCode
  readonly message: string
  readonly sourceUri?: string
}

export interface DocumentationCoverage {
  readonly attemptedPages: number
  readonly successfulPages: number
  readonly failedPages: number
  readonly duplicatePages: number
  readonly removedPages: number
  readonly fetchedBytes: number
  readonly complete: boolean
}

export interface DocumentationMap {
  readonly source: DocumentSourceFact
  readonly pages: readonly DocumentPageRecord[]
  readonly sections: readonly DocumentSectionRecord[]
  readonly links: readonly DocumentLinkEdge[]
  readonly failedUris: readonly string[]
  readonly warnings: readonly CrawlWarning[]
  readonly coverage: DocumentationCoverage
  readonly mapHash: ContentHash
}

export interface ParsedSection {
  readonly headingPath: readonly string[]
  readonly excerpt: string
  readonly startOffset: number
  readonly endOffset: number
}

export interface ParsedDocument {
  readonly title: string
  readonly sanitizedText: string
  readonly sections: readonly ParsedSection[]
  readonly links: readonly string[]
}

export interface PreparedPage {
  readonly sourceUri: string
  readonly canonicalUri: string
  readonly mediaType: "text/html" | "text/markdown"
  readonly document: ParsedDocument
}

export interface PreviousPageSnapshot {
  readonly canonicalUri: string
  readonly contentHash: ContentHash
}

export interface DocumentMapBuildInput {
  readonly applicationId: string
  readonly kind: "repository" | "web"
  readonly rootUri: string
  readonly pages: readonly PreparedPage[]
  readonly failedUris?: readonly string[]
  readonly warnings?: readonly CrawlWarning[]
  readonly attemptedPages?: number
  readonly fetchedBytes?: number
  readonly minimumSuccessfulPages?: number
  readonly previousPages?: readonly PreviousPageSnapshot[]
}
