import {
  createDocumentationRequirementId,
  documentPageIdSchema,
  documentSourceIdSchema,
  documentationExplorerMissionSchema,
  documentationExplorerToolNames,
  hashCanonical,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import { buildDocumentationMap } from "../source/documentation/map-builder.ts"
import { DocumentationMapIndex } from "../source/documentation/map-index.ts"
import type { PreparedPage } from "../source/documentation/types.ts"
import {
  DocumentationExplorerToolError,
  DocumentationExplorerTools,
  getDocumentationExplorerToolDefinitions,
} from "./tools.ts"

const applicationId = `application:v1:${"a".repeat(64)}`
const runId = "run:00000000-0000-4000-8000-000000000001"
const missionId = `mission:v1:${"b".repeat(64)}`

function page(
  uri: string,
  title: string,
  text: string,
  links: readonly string[] = []
): PreparedPage {
  return {
    sourceUri: uri,
    canonicalUri: uri,
    mediaType: "text/html",
    document: {
      title,
      sanitizedText: text,
      sections: [
        {
          headingPath: [title],
          excerpt: text,
          startOffset: 0,
          endOffset: text.length,
        },
      ],
      links: [...links],
    },
  }
}

function fixture() {
  const root = "https://docs.example.com/docs"
  const checkout = `${root}/checkout`
  const refunds = `${root}/refunds`
  const marketing = `${root}/why-us`
  const map = buildDocumentationMap({
    applicationId,
    kind: "web",
    rootUri: root,
    pages: [
      page(root, "Overview", "Ticketing product documentation.", [
        checkout,
        refunds,
        marketing,
      ]),
      page(
        checkout,
        "Checkout",
        "The attendee must provide a valid email before checkout.",
        [root]
      ),
      page(
        refunds,
        "Refunds",
        "An organizer may refund a paid order before the event starts."
      ),
      page(marketing, "Why us", "The world's most delightful ticketing tool."),
    ],
  })
  const mission = documentationExplorerMissionSchema.parse({
    schemaVersion: 1,
    id: missionId,
    runId,
    applicationId,
    agent: "documentation",
    mode: "targeted_requirement_lookup",
    goal: "Establish cited checkout behavior.",
    seedEvidenceIds: [],
    questions: ["What information is required before checkout?"],
    scope: {
      repositoryPaths: [],
      sourceUris: [root],
      allowedHosts: ["docs.example.com"],
      allowedTools: [...documentationExplorerToolNames],
    },
    budget: {
      toolCalls: 20,
      contentBytes: 100_000,
      documentBytes: 100_000,
      documentPages: 20,
      documentSections: 40,
      sourceLines: 0,
      repositoryBytes: 0,
      repositoryFiles: 0,
      browserActions: 0,
      modelCalls: 10,
      modelInputTokens: 10_000,
      modelOutputTokens: 2_000,
      reconciliationRounds: 0,
      elapsedMs: 30_000,
    },
    successCriteria: ["Return an exact cited checkout requirement."],
  })
  return { map, mission, root, checkout }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof DocumentationExplorerToolError
    ? error.code
    : undefined
}

describe("DocumentationExplorerTools", () => {
  it("exposes exactly the six described strict tools", () => {
    expect(
      getDocumentationExplorerToolDefinitions().map(({ name }) => name)
    ).toStrictEqual(documentationExplorerToolNames)
    expect(
      getDocumentationExplorerToolDefinitions().every(
        ({ description, parameters }) =>
          description.length > 40 && parameters !== undefined
      )
    ).toBe(true)
  })

  it("returns bounded tree and search metadata without section bodies", async () => {
    const { map, mission } = fixture()
    const tools = new DocumentationExplorerTools(
      new DocumentationMapIndex(map),
      mission
    )
    const tree = await tools.execute("list_document_tree", { limit: 2 })
    expect(tree.kind).toBe("observation")
    if (tree.kind !== "observation") return
    expect(tree.observation.toolName).toBe("list_document_tree")
    expect(tree.observation.metrics.documentBytes).toBe(0)
    expect(JSON.stringify(tree)).not.toContain(
      "The attendee must provide a valid email"
    )
    expect("nextCursor" in tree.observation).toBe(true)

    const search = await tools.execute("search_documentation", {
      query: "valid email checkout",
      limit: 1,
    })
    expect(search.kind).toBe("observation")
    if (search.kind !== "observation") return
    expect(search.observation).toMatchObject({
      toolName: "search_documentation",
      hits: [
        {
          matchedTerms: expect.arrayContaining(["email", "checkout"]),
        },
      ],
    })
    expect(JSON.stringify(search)).not.toContain("The attendee must provide")
  })

  it("reads one full immutable section with stable run-scoped evidence", async () => {
    const { map, mission, checkout } = fixture()
    const section = map.sections.find(
      ({ sourceUri }) => sourceUri === checkout
    )!
    const tools = new DocumentationExplorerTools(
      new DocumentationMapIndex(map),
      mission
    )
    const first = await tools.execute("read_document_section", {
      sectionId: section.fact.id,
    })
    const second = await tools.execute("read_document_section", {
      sectionId: section.fact.id,
    })
    expect(first).toStrictEqual(second)
    expect(first.kind).toBe("observation")
    if (first.kind !== "observation") return
    expect(first.observation).toMatchObject({
      toolName: "read_document_section",
      fullSection: true,
      citation: {
        sourceId: map.source.id,
        sectionId: section.fact.id,
        quote: section.sanitizedText,
        startOffset: 0,
        endOffset: section.sanitizedText.length,
        contentHash: section.fact.contentHash,
      },
      metrics: { documentPages: 1, documentSections: 1 },
    })
  })

  it("preserves document-relative offsets for non-leading sections", async () => {
    const root = "https://docs.example.com/guide"
    const introduction = "Product guide."
    const requirement =
      "The attendee must provide a valid email before checkout."
    const separator = "\n\n"
    const text = `${introduction}${separator}${requirement}`
    const requirementStart = introduction.length + separator.length
    const map = buildDocumentationMap({
      applicationId,
      kind: "web",
      rootUri: root,
      pages: [
        {
          sourceUri: root,
          canonicalUri: root,
          mediaType: "text/markdown",
          document: {
            title: "Guide",
            sanitizedText: text,
            sections: [
              {
                headingPath: ["Guide"],
                excerpt: introduction,
                startOffset: 0,
                endOffset: introduction.length,
              },
              {
                headingPath: ["Guide", "Checkout"],
                excerpt: requirement,
                startOffset: requirementStart,
                endOffset: requirementStart + requirement.length,
              },
            ],
            links: [],
          },
        },
      ],
    })
    const { mission: fixtureMission } = fixture()
    const mission = documentationExplorerMissionSchema.parse({
      ...fixtureMission,
      scope: { ...fixtureMission.scope, sourceUris: [root] },
    })
    const section = map.sections.find(
      ({ fact }) => fact.headingPath.at(-1) === "Checkout"
    )!
    const tools = new DocumentationExplorerTools(
      new DocumentationMapIndex(map),
      mission
    )

    const read = await tools.execute("read_document_section", {
      sectionId: section.fact.id,
    })

    expect(read).toMatchObject({
      kind: "observation",
      observation: {
        citation: {
          quote: requirement,
          startOffset: requirementStart,
          endOffset: requirementStart + requirement.length,
        },
      },
    })
  })

  it("follows only prepared adjacent links and paginates deterministically", async () => {
    const { map, mission, root } = fixture()
    const rootSection = map.sections.find(
      ({ sourceUri }) => sourceUri === root
    )!
    const tools = new DocumentationExplorerTools(
      new DocumentationMapIndex(map),
      mission
    )
    const first = await tools.execute("inspect_linked_sections", {
      sectionId: rootSection.fact.id,
      limit: 2,
    })
    expect(first.kind).toBe("observation")
    if (first.kind !== "observation") return
    expect(first.observation.toolName).toBe("inspect_linked_sections")
    expect(first.observation.metrics.documentPages).toBe(2)
    expect(first.observation.metrics.documentBytes).toBe(0)
    expect("nextCursor" in first.observation).toBe(true)
  })

  it("strictly parses claim and finish actions without performing mutations", async () => {
    const { map, mission, checkout } = fixture()
    const section = map.sections.find(
      ({ sourceUri }) => sourceUri === checkout
    )!
    const tools = new DocumentationExplorerTools(
      new DocumentationMapIndex(map),
      mission
    )
    const read = await tools.execute("read_document_section", {
      sectionId: section.fact.id,
    })
    if (
      read.kind !== "observation" ||
      read.observation.toolName !== "read_document_section"
    ) {
      throw new Error("Expected a section read")
    }
    const { contentHash, endOffset, evidenceId, sectionId, startOffset } =
      read.observation.citation
    const claim = await tools.execute("submit_requirement_claim", {
      kind: "requirement",
      statement: "An attendee must provide a valid email before checkout.",
      actor: "attendee",
      capability: "ticket checkout",
      expectedOutcome: "A valid email exists before checkout.",
      testable: true,
      citation: {
        evidenceId,
        sectionId,
        startOffset,
        endOffset,
        contentHash,
      },
    })
    expect(claim).toMatchObject({ kind: "claim", input: { testable: true } })

    const requirementId = createDocumentationRequirementId({
      applicationId: mission.applicationId,
      sectionId: section.fact.id,
      kind: "requirement",
      statement: "An attendee must provide a valid email before checkout.",
    })
    const finish = await tools.execute("finish_document_mission", {
      status: "complete",
      selectedRequirementIds: [requirementId],
      questionDispositions: [
        {
          questionIndex: 0,
          question: mission.questions[0],
          status: "covered",
          requirementIds: [requirementId],
          evidenceIds: [read.observation.citation.evidenceId],
          reasonCode: "cited_requirement",
          summary: "The checkout section answers the mission question.",
        },
      ],
      exclusions: [],
      suggestedFollowups: [],
      stopReason: {
        code: "criteria_met",
        summary: "All mission questions have cited coverage.",
      },
    })
    expect(finish).toMatchObject({
      kind: "finish",
      input: { status: "complete" },
    })
  })

  it("rejects source mismatch, off-map IDs, unknown tools, and disallowed tools", async () => {
    const { map, mission } = fixture()
    expect(
      () =>
        new DocumentationExplorerTools(new DocumentationMapIndex(map), {
          ...mission,
          scope: {
            ...mission.scope,
            sourceUris: ["https://docs.example.com/other"],
          },
        })
    ).toThrowError(DocumentationExplorerToolError)

    const tools = new DocumentationExplorerTools(
      new DocumentationMapIndex(map),
      mission
    )
    await expect(
      tools.execute("read_document_section", {
        sectionId: `document-section:v1:${"f".repeat(64)}`,
      })
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "scope_denied")
    await expect(tools.execute("fetch_url", {})).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "tool_not_allowed"
    )

    const listOnlyMission = documentationExplorerMissionSchema.parse({
      ...mission,
      scope: {
        ...mission.scope,
        allowedTools: ["list_document_tree", "finish_document_mission"],
      },
    })
    const listOnly = new DocumentationExplorerTools(
      new DocumentationMapIndex(map),
      listOnlyMission
    )
    expect(listOnly.definitions.map(({ name }) => name)).toStrictEqual([
      "list_document_tree",
      "finish_document_mission",
    ])
    await expect(
      listOnly.execute("search_documentation", { query: "checkout" })
    ).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "tool_not_allowed"
    )
  })

  it("rejects a forged prepared map before exposing any tools", () => {
    const { map, mission } = fixture()
    const missingPageId = documentPageIdSchema.parse(
      `document-page:v1:${"f".repeat(64)}`
    )
    const forged = {
      ...map,
      pages: map.pages.map((page, index) =>
        index === 0
          ? {
              ...page,
              fact: { ...page.fact, linkedPageIds: [missingPageId] },
            }
          : page
      ),
    }

    expect(
      () =>
        new DocumentationExplorerTools(
          new DocumentationMapIndex(forged),
          mission
        )
    ).toThrowError(DocumentationExplorerToolError)

    const forgedSourceId = documentSourceIdSchema.parse(
      `document-source:v1:${"8".repeat(64)}`
    )
    const forgedSource = {
      ...map,
      source: { ...map.source, id: forgedSourceId },
      pages: map.pages.map((page) => ({
        ...page,
        fact: { ...page.fact, sourceId: forgedSourceId },
      })),
    }
    expect(
      () =>
        new DocumentationExplorerTools(
          new DocumentationMapIndex(forgedSource),
          mission
        )
    ).toThrowError(DocumentationExplorerToolError)

    const originalSection = map.sections[0]!
    const injectedText = `X${originalSection.sanitizedText.slice(1)}`
    const injectedHash = hashCanonical({ excerpt: injectedText })
    const injectedMap = {
      ...map,
      sections: map.sections.map((section, index) =>
        index === 0
          ? {
              ...section,
              sanitizedText: injectedText,
              fact: {
                ...section.fact,
                excerpt: injectedText,
                contentHash: injectedHash,
              },
            }
          : section
      ),
    }
    expect(
      () =>
        new DocumentationExplorerTools(
          new DocumentationMapIndex(injectedMap),
          mission
        )
    ).toThrowError(DocumentationExplorerToolError)
  })

  it("snapshots an admitted map against post-construction mutation", async () => {
    const { map, mission, checkout } = fixture()
    const externalSection = map.sections.find(
      ({ sourceUri }) => sourceUri === checkout
    )!
    const expectedText = externalSection.sanitizedText
    const tools = new DocumentationExplorerTools(
      new DocumentationMapIndex(map),
      mission
    )
    Object.defineProperty(externalSection, "sanitizedText", {
      configurable: true,
      value: `X${expectedText.slice(1)}`,
    })

    const read = await tools.execute("read_document_section", {
      sectionId: externalSection.fact.id,
    })

    expect(read).toMatchObject({
      kind: "observation",
      observation: { citation: { quote: expectedText } },
    })
  })

  it("fails closed on oversized sections, output limits, and cancellation", async () => {
    const { map, mission, checkout } = fixture()
    const section = map.sections.find(
      ({ sourceUri }) => sourceUri === checkout
    )!
    const tiny = new DocumentationExplorerTools(
      new DocumentationMapIndex(map),
      mission,
      {
        maxResultsPerTool: 25,
        maxSectionsPerPage: 25,
        maxSectionCharacters: 20,
        maxContentBytesPerTool: 65_536,
      }
    )
    await expect(
      tiny.execute("read_document_section", { sectionId: section.fact.id })
    ).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "result_limit_exceeded"
    )

    const controller = new AbortController()
    controller.abort()
    await expect(
      tiny.execute("list_document_tree", {}, controller.signal)
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "cancelled")
  })
})
