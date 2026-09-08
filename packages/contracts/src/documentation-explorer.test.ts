import { describe, expect, it } from "vitest"

import { createClaimId, hashCanonical } from "./identity.ts"
import {
  applicationIdSchema,
  contentHashSchema,
  documentPageIdSchema,
  documentSectionIdSchema,
  documentSourceIdSchema,
  evidenceIdSchema,
  missionIdSchema,
  runIdSchema,
} from "./primitives.ts"
import {
  createDocumentationCapabilityId,
  createDocumentationRequirementId,
  documentationExplorerMissionSchema,
  documentationExplorerToolInputSchema,
  documentationExplorerToolNames,
  documentationExcerptCitationSchema,
  documentationMissionResultSchema,
  documentationQuestionDispositionSchema,
  documentationRequirementClaimSchema,
  documentSectionObservationSchema,
  normalizeRequirementStatement,
} from "./documentation-explorer.ts"

const applicationId = applicationIdSchema.parse(
  `application:v1:${"a".repeat(64)}`
)
const runId = runIdSchema.parse("run:00000000-0000-4000-8000-000000000001")
const missionId = missionIdSchema.parse(`mission:v1:${"b".repeat(64)}`)
const sourceId = documentSourceIdSchema.parse(
  `document-source:v1:${"c".repeat(64)}`
)
const pageId = documentPageIdSchema.parse(`document-page:v1:${"d".repeat(64)}`)
const sectionId = documentSectionIdSchema.parse(
  `document-section:v1:${"e".repeat(64)}`
)
const evidenceId = evidenceIdSchema.parse(`evidence:v1:${"f".repeat(64)}`)
const contentHash = contentHashSchema.parse(`sha256:${"1".repeat(64)}`)

const emptyBudget = {
  toolCalls: 0,
  contentBytes: 0,
  documentBytes: 0,
  documentPages: 0,
  documentSections: 0,
  sourceLines: 0,
  repositoryBytes: 0,
  repositoryFiles: 0,
  browserActions: 0,
  modelCalls: 0,
  modelInputTokens: 0,
  modelOutputTokens: 0,
  reconciliationRounds: 0,
  elapsedMs: 0,
}

const mission = {
  schemaVersion: 1,
  id: missionId,
  runId,
  applicationId,
  agent: "documentation",
  mode: "targeted_requirement_lookup",
  goal: "Establish cited ticket-purchase behavior.",
  seedEvidenceIds: [],
  questions: ["What must an attendee provide to purchase a ticket?"],
  scope: {
    repositoryPaths: [],
    sourceUris: ["https://example.com/docs/"],
    allowedHosts: ["example.com"],
    allowedTools: [...documentationExplorerToolNames],
  },
  budget: {
    ...emptyBudget,
    toolCalls: 20,
    documentBytes: 20_000,
    documentPages: 10,
    documentSections: 20,
  },
  successCriteria: ["Return one exact cited requirement."],
}

const quote = "The attendee must provide a valid email before checkout."
const citation = {
  evidenceId,
  sourceId,
  pageId,
  sectionId,
  uri: "https://example.com/docs/checkout",
  headingPath: ["Ticket checkout"],
  quote,
  startOffset: 0,
  endOffset: quote.length,
  contentHash,
}

const statement = "An attendee must provide a valid email before checkout."
const requirementId = createDocumentationRequirementId({
  applicationId,
  sectionId,
  kind: "requirement",
  statement,
})
const claimId = createClaimId({
  applicationId,
  missionId,
  subjectId: requirementId,
  predicate: "supported_by",
  objectId: sectionId,
  ordinal: 0,
})

const requirementClaim = {
  schemaVersion: 1,
  claimId,
  status: "proposed",
  kind: "requirement",
  requirement: {
    schemaVersion: 1,
    id: requirementId,
    applicationId,
    statement,
    actor: "attendee",
    capability: "ticket checkout",
    expectedOutcome: "A valid email exists before checkout.",
    testable: true,
    source: {
      sectionId,
      uri: citation.uri,
      heading: "Ticket checkout",
      excerpt: quote,
      contentHash,
    },
  },
  citation,
  evidenceIds: [evidenceId],
  statementFingerprint: hashCanonical(normalizeRequirementStatement(statement)),
}

describe("Documentation Explorer contracts", () => {
  it("defines the exact mission-bound tool surface", () => {
    expect(documentationExplorerToolNames).toStrictEqual([
      "list_document_tree",
      "search_documentation",
      "read_document_section",
      "inspect_linked_sections",
      "submit_requirement_claim",
      "finish_document_mission",
    ])
    expect(documentationExplorerMissionSchema.parse(mission)).toMatchObject({
      agent: "documentation",
      mode: "targeted_requirement_lookup",
    })
  })

  it("rejects cross-agent tools, code scope, and missions without sources", () => {
    expect(
      documentationExplorerMissionSchema.safeParse({
        ...mission,
        agent: "code",
      }).success
    ).toBe(false)
    expect(
      documentationExplorerMissionSchema.safeParse({
        ...mission,
        scope: { ...mission.scope, allowedTools: ["run_shell"] },
      }).success
    ).toBe(false)
    expect(
      documentationExplorerMissionSchema.safeParse({
        ...mission,
        scope: { ...mission.scope, repositoryPaths: ["src"] },
      }).success
    ).toBe(false)
    expect(
      documentationExplorerMissionSchema.safeParse({
        ...mission,
        scope: { ...mission.scope, sourceUris: [] },
      }).success
    ).toBe(false)
  })

  it("requires immutable full-section reads and exact citation offsets", () => {
    expect(documentationExcerptCitationSchema.parse(citation)).toStrictEqual(
      citation
    )
    expect(
      documentSectionObservationSchema.parse({
        schemaVersion: 1,
        toolName: "read_document_section",
        summary: "Read the approved checkout section.",
        fullSection: true,
        citation,
        metrics: {
          contentBytes: quote.length,
          documentBytes: quote.length,
          documentPages: 1,
          documentSections: 1,
          resultItems: 1,
        },
      })
    ).toMatchObject({ fullSection: true, citation: { sectionId } })
    expect(
      documentationExcerptCitationSchema.safeParse({
        ...citation,
        endOffset: quote.length - 1,
      }).success
    ).toBe(false)
    expect(
      documentSectionObservationSchema.safeParse({
        schemaVersion: 1,
        toolName: "read_document_section",
        summary: "A truncated read is invalid.",
        fullSection: true,
        citation: { ...citation, startOffset: 4, endOffset: quote.length + 4 },
        metrics: {
          contentBytes: quote.length,
          documentBytes: quote.length,
          documentPages: 1,
          documentSections: 1,
          resultItems: 1,
        },
      }).success
    ).toBe(false)
  })

  it("accepts only atomic testable submissions with a complete citation", () => {
    expect(
      documentationExplorerToolInputSchema.parse({
        toolName: "submit_requirement_claim",
        arguments: {
          kind: "requirement",
          statement,
          actor: "attendee",
          capability: "ticket checkout",
          expectedOutcome: "A valid email exists before checkout.",
          testable: true,
          citation,
        },
      })
    ).toMatchObject({ toolName: "submit_requirement_claim" })
    expect(
      documentationExplorerToolInputSchema.safeParse({
        toolName: "submit_requirement_claim",
        arguments: {
          kind: "marketing_claim",
          statement,
          capability: "ticket checkout",
          testable: true,
          citation,
        },
      }).success
    ).toBe(false)
    expect(
      documentationExplorerToolInputSchema.safeParse({
        toolName: "submit_requirement_claim",
        arguments: {
          kind: "requirement",
          statement,
          capability: "ticket checkout",
          testable: false,
          citation,
        },
      }).success
    ).toBe(false)
  })

  it("correlates the accepted requirement, exact citation, and fingerprint", () => {
    expect(
      documentationRequirementClaimSchema.parse(requirementClaim)
    ).toMatchObject({
      requirement: { id: requirementId },
      evidenceIds: [evidenceId],
    })
    expect(
      documentationRequirementClaimSchema.safeParse({
        ...requirementClaim,
        citation: { ...citation, uri: "https://example.com/docs/other" },
      }).success
    ).toBe(false)
    expect(
      documentationRequirementClaimSchema.safeParse({
        ...requirementClaim,
        statementFingerprint: `sha256:${"2".repeat(64)}`,
      }).success
    ).toBe(false)
  })

  it("requires typed question coverage and preserves unresolved conflicts", () => {
    expect(
      documentationQuestionDispositionSchema.safeParse({
        questionIndex: 0,
        question: mission.questions[0],
        status: "covered",
        requirementIds: [],
        evidenceIds: [],
        reasonCode: "cited_requirement",
        summary: "No citation was supplied.",
      }).success
    ).toBe(false)
    expect(
      documentationQuestionDispositionSchema.parse({
        questionIndex: 0,
        question: mission.questions[0],
        status: "conflict",
        requirementIds: [requirementId, `requirement:v1:${"2".repeat(64)}`],
        evidenceIds: [evidenceId, `evidence:v1:${"3".repeat(64)}`],
        reasonCode: "contradictory_sources",
        summary: "The approved sources disagree.",
      })
    ).toMatchObject({ status: "conflict" })
  })

  it("returns a strict MissionResult-compatible rich result", () => {
    const capabilityId = createDocumentationCapabilityId({
      applicationId,
      normalizedName: "ticket checkout",
    })
    const result = {
      schemaVersion: 1,
      missionId,
      applicationId,
      runId,
      sourceId,
      mapContentHash: contentHash,
      status: "complete",
      claims: [
        {
          id: claimId,
          status: "proposed",
          subjectId: requirementId,
          predicate: "supported_by",
          objectId: sectionId,
          evidenceIds: [evidenceId],
          explanation:
            "The exact documentation excerpt supports the requirement.",
        },
      ],
      requirements: [requirementClaim],
      questionDispositions: [
        {
          questionIndex: 0,
          question: mission.questions[0],
          status: "covered",
          requirementIds: [requirementId],
          evidenceIds: [evidenceId],
          reasonCode: "cited_requirement",
          summary: "The checkout section answers the mission question.",
        },
      ],
      duplicateGroups: [],
      conflicts: [],
      capabilityTerms: [
        {
          id: capabilityId,
          applicationId,
          normalizedName: "ticket checkout",
          requirementIds: [requirementId],
          status: "proposed",
          authoritative: false,
        },
      ],
      unresolved: [],
      exclusions: [],
      typedExclusions: [],
      suggestedFollowups: [],
      stopReason: {
        code: "criteria_met",
        summary: "Every mission question has exact cited coverage.",
      },
      budgetUsed: emptyBudget,
      metrics: {
        treePagesVisited: 1,
        searchesPerformed: 1,
        sectionsRead: 1,
        linksInspected: 0,
        requirementsAccepted: 1,
        duplicateRequirements: 0,
        conflictsFound: 0,
      },
    }
    expect(documentationMissionResultSchema.parse(result)).toStrictEqual(result)
    expect(
      documentationMissionResultSchema.safeParse({
        ...result,
        questionDispositions: [
          {
            ...result.questionDispositions[0],
            status: "unresolved",
            requirementIds: [],
          },
        ],
      }).success
    ).toBe(false)
    expect(
      documentationMissionResultSchema.safeParse({
        ...result,
        capabilityTerms: [
          { ...result.capabilityTerms[0], authoritative: true },
        ],
      }).success
    ).toBe(false)
    expect(
      documentationMissionResultSchema.safeParse({ ...result, accepted: true })
        .success
    ).toBe(false)
  })
})
