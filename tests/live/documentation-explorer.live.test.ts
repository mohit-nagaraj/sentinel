import {
  DocumentationExplorerTools,
  DocumentationMapIndex,
  createAzureOpenAIModelGateway,
  crawlWebDocumentation,
  loadAzureOpenAIEnvironment,
} from "@sentinel/adapters"
import {
  applicationIdSchema,
  createMissionId,
  documentationExplorerMissionSchema,
  documentationExplorerToolNames,
  documentationMissionResultSchema,
  runIdSchema,
} from "@sentinel/contracts"
import {
  InMemoryDocumentationExplorerSpecialistStoreForTesting,
  InMemoryResumeCoordinator,
  InMemorySpecialistToolExecutionCoordinator,
  createDocumentationExplorerSpecialist,
  createInMemorySpecialistCheckpointer,
  type RuntimeDependencies,
} from "@sentinel/orchestration"
import { describe, expect, it } from "vitest"

const enabled = process.env["RUN_HIEVENTS_DOCUMENTATION_EXPLORER"] === "1"
const describeHiEvents = enabled ? describe : describe.skip
const applicationId = applicationIdSchema.parse(
  `application:v1:${"4".repeat(64)}`
)
const runId = runIdSchema.parse("run:15000000-0000-4000-8000-000000000099")

function runtime(): RuntimeDependencies {
  return {
    owner: "documentation-explorer-live-test",
    control: { assertActive: async () => undefined },
    events: { append: async () => undefined },
    effects: { execute: async () => undefined },
    resumeAuthorization: { authorize: async () => true },
    resumeCoordinator: new InMemoryResumeCoordinator(),
  }
}

describeHiEvents("Hi.Events Documentation Explorer mission evaluation", () => {
  it(
    "discovers only exact cited intent from an explicitly configured root",
    async () => {
      const configuredRoot = process.env["HIEVENTS_DOCUMENTATION_ROOT"]?.trim()
      if (configuredRoot === undefined || configuredRoot.length === 0) {
        throw new Error(
          "RUN_HIEVENTS_DOCUMENTATION_EXPLORER=1 requires HIEVENTS_DOCUMENTATION_ROOT"
        )
      }
      const root = new URL(configuredRoot).toString()
      const map = await crawlWebDocumentation({
        applicationId,
        roots: [root],
        maxPages: 25,
        maxTotalBytes: 4 * 1_024 * 1_024,
        maxPageBytes: 512 * 1_024,
        timeoutMs: 2 * 60_000,
        requestTimeoutMs: 20_000,
        maxRequestRetries: 1,
        minimumSuccessfulPages: 1,
      })
      expect(map.pages.length).toBeGreaterThan(0)
      expect(map.sections.length).toBeGreaterThan(0)
      const mission = documentationExplorerMissionSchema.parse({
        schemaVersion: 1,
        id: createMissionId({
          applicationId,
          runId,
          agent: "documentation",
          mode: "targeted_requirement_lookup",
          ordinal: 0,
        }),
        runId,
        applicationId,
        agent: "documentation",
        mode: "targeted_requirement_lookup",
        goal: "Discover exact cited Hi.Events ticket-checkout intent.",
        seedEvidenceIds: [],
        questions: [
          process.env["HIEVENTS_DOCUMENTATION_QUESTION"]?.trim() ||
            "What documented behavior governs ticket checkout?",
        ],
        scope: {
          repositoryPaths: [],
          sourceUris: [map.source.rootUri],
          allowedHosts: [new URL(map.source.rootUri).hostname],
          allowedTools: [...documentationExplorerToolNames],
        },
        budget: {
          toolCalls: 20,
          contentBytes: 500_000,
          documentBytes: 150_000,
          documentPages: 100,
          documentSections: 200,
          sourceLines: 0,
          repositoryBytes: 0,
          repositoryFiles: 0,
          browserActions: 0,
          modelCalls: 20,
          modelInputTokens: 100_000,
          modelOutputTokens: 8_000,
          reconciliationRounds: 0,
          elapsedMs: 2 * 60_000,
        },
        successCriteria: [
          "Return exact cited product intent or an explicit unresolved disposition.",
        ],
      })
      const tools = new DocumentationExplorerTools(
        new DocumentationMapIndex(map),
        mission
      )
      const gateway = createAzureOpenAIModelGateway(
        loadAzureOpenAIEnvironment(process.env),
        {
          maxInputCharacters: 16_000,
          maxOutputTokens: 1_024,
          maxTools: 6,
          maxToolCalls: 1,
          maxToolOutputCharacters: 32_768,
          timeoutMs: 30_000,
          maxRetries: 1,
        }
      )
      const result = await createDocumentationExplorerSpecialist({
        mission,
        model: gateway,
        tools,
        store: new InMemoryDocumentationExplorerSpecialistStoreForTesting(),
        executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
        runtime: runtime(),
        checkpointer: createInMemorySpecialistCheckpointer(),
        options: { maxIterations: 30, maxTotalResultItems: 1_000 },
      }).service.start()
      const rich = documentationMissionResultSchema.parse(
        result.documentationMission
      )
      expect([
        "complete",
        "partial",
        "budget_exhausted",
        "blocked",
        "needs_human",
      ]).toContain(rich.status)
      for (const claim of rich.requirements) {
        const section = map.sections.find(
          ({ fact }) => fact.id === claim.citation.sectionId
        )
        expect(section).toBeDefined()
        const start = claim.citation.startOffset - (section?.startOffset ?? 0)
        const end = claim.citation.endOffset - (section?.startOffset ?? 0)
        expect(section?.sanitizedText.slice(start, end)).toBe(
          claim.citation.quote
        )
        expect(claim.citation.sourceId).toBe(map.source.id)
        expect(claim.requirement.testable).toBe(true)
      }
      console.info(
        `[documentation-explorer-hi-events] ${JSON.stringify({
          status: rich.status,
          requirements: rich.requirements.length,
          duplicates: rich.duplicateGroups.length,
          conflicts: rich.conflicts.length,
          unresolved: rich.unresolved.length,
          toolCalls: rich.budgetUsed.toolCalls,
        })}`
      )
    },
    5 * 60_000
  )
})
