import {
  documentSectionObservationSchema,
  documentationExplorerMissionSchema,
  documentationExplorerToolNameSchema,
  documentationSearchObservationSchema,
  documentationToolObservationSchema,
  documentTreeObservationSchema,
  finishDocumentMissionInputSchema,
  inspectLinkedSectionsInputSchema,
  linkedSectionsObservationSchema,
  listDocumentTreeInputSchema,
  readDocumentSectionInputSchema,
  searchDocumentationInputSchema,
  submitRequirementClaimInputSchema,
  type DocumentationExplorerMission,
  type DocumentationExplorerToolName,
  type DocumentationPageSummary,
  type DocumentationSectionSummary,
  type DocumentationToolObservation,
  type FinishDocumentMissionInput,
  type SubmitRequirementClaimInput,
  createRunScopedEvidenceId,
  hashCanonical,
} from "@sentinel/contracts"
import { z } from "zod"

import type { ModelToolDefinition } from "../model-gateway/contracts.ts"
import { DocumentationMapIndex } from "../source/documentation/map-index.ts"
import type {
  DocumentPageRecord,
  DocumentSectionRecord,
} from "../source/documentation/types.ts"

export const documentationExplorerLimitsSchema = z
  .strictObject({
    maxResultsPerTool: z.number().int().positive().max(100),
    maxSectionsPerPage: z.number().int().positive().max(100),
    maxSectionCharacters: z.number().int().positive().max(32_768),
    maxContentBytesPerTool: z.number().int().positive().max(262_144),
  })
  .refine(
    ({ maxResultsPerTool, maxSectionsPerPage }) =>
      maxResultsPerTool * maxSectionsPerPage <= 1_000,
    {
      message: "Tree result bounds cannot exceed 1,000 sections",
      path: ["maxSectionsPerPage"],
    }
  )

export type DocumentationExplorerLimits = z.infer<
  typeof documentationExplorerLimitsSchema
>

export const defaultDocumentationExplorerLimits: Readonly<DocumentationExplorerLimits> =
  Object.freeze({
    maxResultsPerTool: 25,
    maxSectionsPerPage: 25,
    maxSectionCharacters: 4_096,
    maxContentBytesPerTool: 65_536,
  })

export type DocumentationExplorerToolErrorCode =
  | "cancelled"
  | "invalid_arguments"
  | "result_limit_exceeded"
  | "scope_denied"
  | "source_mismatch"
  | "tool_not_allowed"

export class DocumentationExplorerToolError extends Error {
  constructor(readonly code: DocumentationExplorerToolErrorCode) {
    super(`Documentation Explorer tool request rejected: ${code}`)
    this.name = "DocumentationExplorerToolError"
  }
}

export type DocumentationExplorerToolExecution =
  | {
      readonly kind: "observation"
      readonly observation: DocumentationToolObservation
    }
  | {
      readonly kind: "claim"
      readonly input: SubmitRequirementClaimInput
    }
  | {
      readonly kind: "finish"
      readonly input: FinishDocumentMissionInput
    }

const toolDefinitions: readonly ModelToolDefinition[] = Object.freeze([
  {
    name: "list_document_tree",
    description:
      "List bounded approved documentation pages, titles, headings, hashes, and link counts without returning section bodies.",
    parameters: listDocumentTreeInputSchema,
  },
  {
    name: "search_documentation",
    description:
      "Search only the prepared approved documentation map and return bounded ranked section metadata without section bodies.",
    parameters: searchDocumentationInputSchema,
  },
  {
    name: "read_document_section",
    description:
      "Read one approved immutable section in full with its exact source URI, heading path, offsets, content hash, and excerpt evidence ID.",
    parameters: readDocumentSectionInputSchema,
  },
  {
    name: "inspect_linked_sections",
    description:
      "List bounded approved pages and headings linked from the page containing a previously identified section; does not fetch links.",
    parameters: inspectLinkedSectionsInputSchema,
  },
  {
    name: "submit_requirement_claim",
    description:
      "Propose one atomic testable requirement or acceptance criterion using an exact quote from a prior full section read; does not publish evidence.",
    parameters: submitRequirementClaimInputSchema,
  },
  {
    name: "finish_document_mission",
    description:
      "Finish or abstain with selected cited requirements, a disposition for every mission question, exclusions, follow-ups, and a typed stop reason.",
    parameters: finishDocumentMissionInputSchema,
  },
])

function parseArguments<Output>(
  schema: z.ZodType<Output>,
  input: unknown
): Output {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new DocumentationExplorerToolError("invalid_arguments")
  }
  return parsed.data
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function serializedByteLength(value: unknown): number {
  return byteLength(JSON.stringify(value))
}

function terms(value: string): readonly string[] {
  return value.toLocaleLowerCase("en-US").match(/[a-z0-9]+/g) ?? []
}

function isUriWithin(candidate: string, approvedRoot: string): boolean {
  if (
    candidate.startsWith("repository://") ||
    approvedRoot.startsWith("repository://")
  ) {
    if (
      !candidate.startsWith("repository://") ||
      !approvedRoot.startsWith("repository://")
    ) {
      return false
    }
    const candidatePath = candidate.slice("repository://".length)
    const rootPath = approvedRoot
      .slice("repository://".length)
      .replace(/\/$/, "")
    return (
      candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`)
    )
  }

  const candidateUrl = new URL(candidate)
  const rootUrl = new URL(approvedRoot)
  if (candidateUrl.origin !== rootUrl.origin) return false
  const rootPath = rootUrl.pathname.replace(/\/$/, "")
  return (
    candidateUrl.pathname === rootPath ||
    candidateUrl.pathname.startsWith(`${rootPath}/`)
  )
}

export class DocumentationExplorerTools {
  readonly definitions: readonly ModelToolDefinition[]
  readonly limits: DocumentationExplorerLimits
  readonly sourceId: string
  readonly mapContentHash: string

  private readonly allowedTools: ReadonlySet<DocumentationExplorerToolName>
  private readonly mission: DocumentationExplorerMission
  private readonly pagesById: ReadonlyMap<string, DocumentPageRecord>
  private readonly sectionsById: ReadonlyMap<string, DocumentSectionRecord>

  constructor(
    private readonly index: DocumentationMapIndex,
    missionInput: DocumentationExplorerMission,
    limitsInput: DocumentationExplorerLimits = defaultDocumentationExplorerLimits
  ) {
    this.mission = documentationExplorerMissionSchema.parse(missionInput)
    this.limits = documentationExplorerLimitsSchema.parse(limitsInput)
    this.allowedTools = new Set(
      this.mission.scope.allowedTools.map((tool) =>
        documentationExplorerToolNameSchema.parse(tool)
      )
    )
    this.sourceId = index.map.source.id
    this.mapContentHash = index.map.mapHash
    this.pagesById = new Map(
      index.map.pages.map((page) => [page.fact.id, page])
    )
    this.sectionsById = new Map(
      index.map.sections.map((section) => [section.fact.id, section])
    )
    this.assertPreparedMapScope()
    this.definitions = Object.freeze(
      toolDefinitions.filter(({ name }) =>
        this.allowedTools.has(documentationExplorerToolNameSchema.parse(name))
      )
    )
  }

  private assertPreparedMapScope(): void {
    const { map } = this.index
    if (
      map.source.applicationId !== this.mission.applicationId ||
      map.source.contentHash !== map.mapHash ||
      !this.mission.scope.sourceUris.includes(map.source.rootUri)
    ) {
      throw new DocumentationExplorerToolError("source_mismatch")
    }

    const isApprovedUri = (uri: string) =>
      this.mission.scope.sourceUris.some((root) => isUriWithin(uri, root))
    const isApprovedHost = (uri: string) => {
      if (uri.startsWith("repository://")) return true
      return this.mission.scope.allowedHosts.includes(new URL(uri).hostname)
    }
    const pageIds = new Set(map.pages.map(({ fact }) => fact.id))
    for (const page of map.pages) {
      if (
        page.fact.applicationId !== this.mission.applicationId ||
        page.fact.sourceId !== map.source.id ||
        !isApprovedUri(page.fact.canonicalUri) ||
        !isApprovedUri(page.sourceUri) ||
        !isApprovedHost(page.fact.canonicalUri) ||
        !isApprovedHost(page.sourceUri) ||
        page.fact.contentHash !==
          hashCanonical({
            mediaType: page.mediaType,
            sanitizedText: page.sanitizedText,
            title: page.fact.title,
          }) ||
        page.fact.linkedPageIds.some((pageId) => !pageIds.has(pageId)) ||
        new Set(page.sectionIds).size !== page.sectionIds.length
      ) {
        throw new DocumentationExplorerToolError("scope_denied")
      }
    }
    const referencedSectionIds = new Set<string>()
    for (const page of map.pages) {
      for (const sectionId of page.sectionIds) {
        const section = this.sectionsById.get(sectionId)
        if (
          section === undefined ||
          section.fact.pageId !== page.fact.id ||
          referencedSectionIds.has(sectionId)
        ) {
          throw new DocumentationExplorerToolError("scope_denied")
        }
        referencedSectionIds.add(sectionId)
      }
    }
    for (const section of map.sections) {
      if (
        section.fact.applicationId !== this.mission.applicationId ||
        !pageIds.has(section.fact.pageId) ||
        !referencedSectionIds.has(section.fact.id) ||
        !isApprovedUri(section.sourceUri) ||
        !isApprovedHost(section.sourceUri) ||
        section.sourceUri !==
          this.pagesById.get(section.fact.pageId)?.sourceUri ||
        section.startOffset < 0 ||
        section.endOffset - section.startOffset !==
          section.sanitizedText.length ||
        section.fact.excerpt !== section.sanitizedText ||
        section.fact.contentHash !==
          hashCanonical({ excerpt: section.sanitizedText })
      ) {
        throw new DocumentationExplorerToolError("scope_denied")
      }
    }
  }

  private assertAllowed(name: DocumentationExplorerToolName): void {
    if (!this.allowedTools.has(name)) {
      throw new DocumentationExplorerToolError("tool_not_allowed")
    }
  }

  private requestedLimit(value: number | undefined): number {
    return Math.min(
      value ?? this.limits.maxResultsPerTool,
      this.limits.maxResultsPerTool
    )
  }

  private pageSummary(page: DocumentPageRecord): DocumentationPageSummary {
    return {
      sourceId: this.index.map.source.id,
      pageId: page.fact.id,
      uri: page.fact.canonicalUri,
      title: page.fact.title,
      contentHash: page.fact.contentHash,
      sectionCount: page.sectionIds.length,
      linkedPageCount: page.fact.linkedPageIds.length,
    }
  }

  private sectionSummary(
    section: DocumentSectionRecord
  ): DocumentationSectionSummary {
    return {
      pageId: section.fact.pageId,
      sectionId: section.fact.id,
      headingPath: [...section.fact.headingPath],
      contentHash: section.fact.contentHash,
      contentBytes: byteLength(section.sanitizedText),
    }
  }

  private checked(
    observationInput: DocumentationToolObservation
  ): DocumentationExplorerToolExecution {
    const observation =
      documentationToolObservationSchema.parse(observationInput)
    if (
      observation.metrics.resultItems >
        this.limits.maxResultsPerTool * (this.limits.maxSectionsPerPage + 1) ||
      observation.metrics.contentBytes > this.limits.maxContentBytesPerTool
    ) {
      throw new DocumentationExplorerToolError("result_limit_exceeded")
    }
    return { kind: "observation", observation }
  }

  private listTree(
    argumentsInput: unknown
  ): DocumentationExplorerToolExecution {
    const input = parseArguments(listDocumentTreeInputSchema, argumentsInput)
    const cursor = input.cursor ?? 0
    const limit = this.requestedLimit(input.limit)

    if (input.pageId !== undefined) {
      const page = this.pagesById.get(input.pageId)
      if (page === undefined) {
        throw new DocumentationExplorerToolError("scope_denied")
      }
      const allSections = page.sectionIds.map((sectionId) => {
        const section = this.sectionsById.get(sectionId)
        if (section === undefined) {
          throw new DocumentationExplorerToolError("scope_denied")
        }
        return section
      })
      const sections = allSections
        .slice(cursor, cursor + limit)
        .map((section) => this.sectionSummary(section))
      const body = { pages: [this.pageSummary(page)], sections }
      return this.checked(
        documentTreeObservationSchema.parse({
          schemaVersion: 1,
          toolName: "list_document_tree",
          summary: `Listed approved headings for one documentation page from cursor ${cursor}.`,
          ...(cursor + sections.length < allSections.length
            ? { nextCursor: cursor + sections.length }
            : {}),
          ...body,
          metrics: {
            contentBytes: serializedByteLength(body),
            documentBytes: 0,
            documentPages: 1,
            documentSections: sections.length,
            resultItems: 1 + sections.length,
          },
        })
      )
    }

    const allPages = [...this.index.map.pages].sort((left, right) =>
      left.fact.canonicalUri.localeCompare(right.fact.canonicalUri)
    )
    const pages = allPages.slice(cursor, cursor + limit)
    const pageSummaries = pages.map((page) => this.pageSummary(page))
    const sections = pages.flatMap((page) =>
      page.sectionIds
        .slice(0, this.limits.maxSectionsPerPage)
        .map((sectionId) => this.sectionsById.get(sectionId))
        .filter(
          (section): section is DocumentSectionRecord => section !== undefined
        )
        .map((section) => this.sectionSummary(section))
    )
    const body = { pages: pageSummaries, sections }
    return this.checked(
      documentTreeObservationSchema.parse({
        schemaVersion: 1,
        toolName: "list_document_tree",
        summary: `Listed ${pages.length} approved documentation pages from cursor ${cursor}.`,
        ...(cursor + pages.length < allPages.length
          ? { nextCursor: cursor + pages.length }
          : {}),
        ...body,
        metrics: {
          contentBytes: serializedByteLength(body),
          documentBytes: 0,
          documentPages: pages.length,
          documentSections: sections.length,
          resultItems: pages.length + sections.length,
        },
      })
    )
  }

  private search(argumentsInput: unknown): DocumentationExplorerToolExecution {
    const input = parseArguments(searchDocumentationInputSchema, argumentsInput)
    const cursor = input.cursor ?? 0
    const limit = Math.min(this.requestedLimit(input.limit), 50)
    const allHits = this.index.search(input.query, 50)
    const queryTerms = [...new Set(terms(input.query))]
    const hits = allHits
      .slice(cursor, cursor + limit)
      .map(({ page, score, section }) => {
        const haystack = new Set(
          terms(
            `${section.fact.headingPath.join(" ")} ${section.sanitizedText}`
          )
        )
        return {
          page: this.pageSummary(page),
          section: this.sectionSummary(section),
          matchedTerms: queryTerms
            .filter((term) => haystack.has(term))
            .slice(0, 50),
          score: Math.min(
            1_000_000,
            Math.max(0, Math.round(score * 1_000_000))
          ),
        }
      })
    const body = { hits }
    return this.checked(
      documentationSearchObservationSchema.parse({
        schemaVersion: 1,
        toolName: "search_documentation",
        summary: `Found ${hits.length} approved section matches from cursor ${cursor}.`,
        ...(cursor + hits.length < allHits.length
          ? { nextCursor: cursor + hits.length }
          : {}),
        ...body,
        metrics: {
          contentBytes: serializedByteLength(body),
          documentBytes: 0,
          documentPages: new Set(hits.map(({ page }) => page.pageId)).size,
          documentSections: hits.length,
          resultItems: hits.length,
        },
      })
    )
  }

  private readSection(
    argumentsInput: unknown
  ): DocumentationExplorerToolExecution {
    const input = parseArguments(readDocumentSectionInputSchema, argumentsInput)
    const section = this.sectionsById.get(input.sectionId)
    if (section === undefined) {
      throw new DocumentationExplorerToolError("scope_denied")
    }
    if (section.sanitizedText.length > this.limits.maxSectionCharacters) {
      throw new DocumentationExplorerToolError("result_limit_exceeded")
    }
    const page = this.pagesById.get(section.fact.pageId)
    if (page === undefined) {
      throw new DocumentationExplorerToolError("scope_denied")
    }
    const citation = {
      evidenceId: createRunScopedEvidenceId({
        applicationId: this.mission.applicationId,
        runId: this.mission.runId,
        sourceId: section.fact.id,
        kind: "documentation_excerpt",
        ordinal: 0,
      }),
      sourceId: this.index.map.source.id,
      pageId: page.fact.id,
      sectionId: section.fact.id,
      uri: section.sourceUri,
      headingPath: [...section.fact.headingPath],
      quote: section.sanitizedText,
      startOffset: section.startOffset,
      endOffset: section.endOffset,
      contentHash: section.fact.contentHash,
    }
    const contentBytes = serializedByteLength(citation)
    return this.checked(
      documentSectionObservationSchema.parse({
        schemaVersion: 1,
        toolName: "read_document_section",
        summary: "Read one complete approved immutable documentation section.",
        fullSection: true,
        citation,
        metrics: {
          contentBytes,
          documentBytes: byteLength(section.sanitizedText),
          documentPages: 1,
          documentSections: 1,
          resultItems: 1,
        },
      })
    )
  }

  private inspectLinks(
    argumentsInput: unknown
  ): DocumentationExplorerToolExecution {
    const input = parseArguments(
      inspectLinkedSectionsInputSchema,
      argumentsInput
    )
    const section = this.sectionsById.get(input.sectionId)
    if (section === undefined) {
      throw new DocumentationExplorerToolError("scope_denied")
    }
    const cursor = input.cursor ?? 0
    const limit = this.requestedLimit(input.limit)
    const sourcePage = this.pagesById.get(section.fact.pageId)
    if (sourcePage === undefined) {
      throw new DocumentationExplorerToolError("scope_denied")
    }
    const allPages = sourcePage.fact.linkedPageIds.map((pageId) => {
      const page = this.pagesById.get(pageId)
      if (page === undefined) {
        throw new DocumentationExplorerToolError("scope_denied")
      }
      return page
    })
    const pages = allPages.slice(cursor, cursor + limit)
    const links = pages.map((page) => ({
      fromPageId: section.fact.pageId,
      page: this.pageSummary(page),
      sections: page.sectionIds
        .slice(0, this.limits.maxSectionsPerPage)
        .map((sectionId) => this.sectionsById.get(sectionId))
        .filter(
          (linkedSection): linkedSection is DocumentSectionRecord =>
            linkedSection !== undefined
        )
        .map((linkedSection) => this.sectionSummary(linkedSection)),
    }))
    const body = { links }
    return this.checked(
      linkedSectionsObservationSchema.parse({
        schemaVersion: 1,
        toolName: "inspect_linked_sections",
        summary: `Listed ${links.length} approved linked pages from cursor ${cursor}.`,
        ...(cursor + pages.length < allPages.length
          ? { nextCursor: cursor + pages.length }
          : {}),
        ...body,
        metrics: {
          contentBytes: serializedByteLength(body),
          documentBytes: 0,
          documentPages: links.length,
          documentSections: links.reduce(
            (total, link) => total + link.sections.length,
            0
          ),
          resultItems: links.reduce(
            (total, link) => total + 1 + link.sections.length,
            0
          ),
        },
      })
    )
  }

  async execute(
    nameInput: string,
    argumentsInput: unknown,
    signal?: AbortSignal
  ): Promise<DocumentationExplorerToolExecution> {
    if (signal?.aborted) {
      throw new DocumentationExplorerToolError("cancelled")
    }
    let name: DocumentationExplorerToolName
    try {
      name = documentationExplorerToolNameSchema.parse(nameInput)
    } catch {
      throw new DocumentationExplorerToolError("tool_not_allowed")
    }
    this.assertAllowed(name)

    const execution = (() => {
      switch (name) {
        case "list_document_tree":
          return this.listTree(argumentsInput)
        case "search_documentation":
          return this.search(argumentsInput)
        case "read_document_section":
          return this.readSection(argumentsInput)
        case "inspect_linked_sections":
          return this.inspectLinks(argumentsInput)
        case "submit_requirement_claim":
          return {
            kind: "claim" as const,
            input: parseArguments(
              submitRequirementClaimInputSchema,
              argumentsInput
            ),
          }
        case "finish_document_mission":
          return {
            kind: "finish" as const,
            input: parseArguments(
              finishDocumentMissionInputSchema,
              argumentsInput
            ),
          }
      }
    })()
    if (signal?.aborted) {
      throw new DocumentationExplorerToolError("cancelled")
    }
    return execution
  }
}

export function getDocumentationExplorerToolDefinitions(): readonly ModelToolDefinition[] {
  return toolDefinitions
}
