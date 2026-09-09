import {
  finishDocumentMissionInputSchema,
  documentationMissionResultSchema,
} from "@sentinel/contracts"
import {
  InMemoryDocumentationExplorerSpecialistStoreForTesting,
  InMemoryResumeCoordinator,
  InMemorySpecialistToolExecutionCoordinator,
  createDocumentationExplorerSpecialist,
  createInMemorySpecialistCheckpointer,
  type DocumentationExplorerModelGateway,
  type OrchestrationEvent,
  type RuntimeDependencies,
} from "@sentinel/orchestration"
import { describe, expect, it } from "vitest"

import {
  createDocumentationExplorerFixture,
  type DocumentationExplorerFixture,
} from "../fixtures/documentation-explorer.ts"

type ModelDecision = Awaited<
  ReturnType<DocumentationExplorerModelGateway["decideTools"]>
>

class StableFixtureModel implements DocumentationExplorerModelGateway {
  readonly requests: Parameters<
    DocumentationExplorerModelGateway["decideTools"]
  >[0][] = []
  #cursor = 0

  constructor(private readonly fixture: DocumentationExplorerFixture) {}

  async decideTools(
    request: Parameters<DocumentationExplorerModelGateway["decideTools"]>[0]
  ): Promise<ModelDecision> {
    this.requests.push(request)
    const requirementId = this.fixture.requirementId(
      "checkout_email",
      "requirement"
    )
    const steps = [
      {
        name: "search_documentation",
        arguments: { query: "attendee valid email checkout", limit: 5 },
      },
      {
        name: "read_document_section",
        arguments: {
          sectionId: this.fixture.sections.checkout_email.fact.id,
        },
      },
      {
        name: "submit_requirement_claim",
        arguments: this.fixture.claim("checkout_email", {
          kind: "requirement",
          actor: "attendee",
          capability: "provide a valid email",
          expectedOutcome: "valid email before checkout",
        }),
      },
      {
        name: "finish_document_mission",
        arguments: finishDocumentMissionInputSchema.parse({
          status: "complete",
          selectedRequirementIds: [requirementId],
          questionDispositions: [
            {
              questionIndex: 0,
              question: this.fixture.mission.questions[0],
              status: "covered",
              requirementIds: [requirementId],
              evidenceIds: [this.fixture.citation("checkout_email").evidenceId],
              reasonCode: "cited_requirement",
              summary: "The indexed checkout section gives exact coverage.",
            },
          ],
          exclusions: [],
          suggestedFollowups: [],
          stopReason: {
            code: "criteria_met",
            summary: "The targeted question has exact cited coverage.",
          },
        }),
      },
    ] as const
    const step = steps[this.#cursor]
    this.#cursor += 1
    if (step === undefined) throw new Error("Stable fixture agenda exhausted")
    return {
      kind: "tool_calls",
      output: [
        {
          callId: `stable-provider-call-${this.#cursor}`,
          name: step.name,
          arguments: step.arguments,
        },
      ],
      model: "stable-documentation-fixture-v1",
      usage: { inputTokens: 25, outputTokens: 10, totalTokens: 35 },
    }
  }
}

function runtime() {
  const events: OrchestrationEvent[] = []
  const dependencies: RuntimeDependencies = {
    owner: "documentation-explorer-integration-test",
    control: { assertActive: async () => undefined },
    events: { append: async (event) => void events.push(event) },
    effects: { execute: async () => undefined },
    resumeAuthorization: { authorize: async () => true },
    resumeCoordinator: new InMemoryResumeCoordinator(),
    now: () => new Date("2026-09-08T00:00:00.000Z"),
  }
  return { dependencies, events }
}

interface StableProjection {
  readonly result: {
    readonly requirementId: string
    readonly citation: {
      readonly sourceId: string
      readonly pageId: string
      readonly sectionId: string
      readonly uri: string
      readonly headingPath: readonly string[]
      readonly quote: string
      readonly startOffset: number
      readonly endOffset: number
      readonly contentHash: string
      readonly evidenceId: string
    }
  }
  readonly trajectory: readonly {
    readonly sequence: number
    readonly toolName: string
    readonly argumentsHash: string
    readonly payloadHash: string
  }[]
}

async function executePreparedMapMission(): Promise<StableProjection> {
  const fixture = createDocumentationExplorerFixture({
    mode: "targeted_requirement_lookup",
    ordinal: 70,
  })
  const model = new StableFixtureModel(fixture)
  const store = new InMemoryDocumentationExplorerSpecialistStoreForTesting()
  const testRuntime = runtime()
  const result = await createDocumentationExplorerSpecialist({
    mission: fixture.mission,
    model,
    tools: fixture.tools,
    store,
    executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
    runtime: testRuntime.dependencies,
    checkpointer: createInMemorySpecialistCheckpointer(),
  }).service.start()

  expect(result.status).toBe("complete")
  const parsed = documentationMissionResultSchema.parse(
    result.documentationMission
  )
  expect(parsed.requirements).toHaveLength(1)
  expect(model.requests).toHaveLength(4)
  const requirement = parsed.requirements[0]!
  const mapSection = fixture.map.sections.find(
    ({ fact }) => fact.id === requirement.citation.sectionId
  )
  expect(mapSection).toBeDefined()
  const relativeStart =
    requirement.citation.startOffset - (mapSection?.startOffset ?? 0)
  const relativeEnd =
    requirement.citation.endOffset - (mapSection?.startOffset ?? 0)
  expect(mapSection?.sanitizedText.slice(relativeStart, relativeEnd)).toBe(
    requirement.citation.quote
  )
  expect(JSON.stringify(result.state)).not.toContain(requirement.citation.quote)
  expect(JSON.stringify(testRuntime.events)).not.toContain(
    requirement.citation.quote
  )

  return {
    result: {
      requirementId: requirement.requirement.id,
      citation: requirement.citation,
    },
    trajectory: (await store.listToolResults(fixture.mission.id)).map(
      ({ sequence, toolName, argumentsHash, payloadHash }) => ({
        sequence,
        toolName,
        argumentsHash,
        payloadHash,
      })
    ),
  }
}

describe("Documentation Explorer prepared-map integration", () => {
  it("keeps requirement, citation, and trajectory identity stable", async () => {
    const runs = [
      await executePreparedMapMission(),
      await executePreparedMapMission(),
      await executePreparedMapMission(),
    ]

    expect(runs[1]).toStrictEqual(runs[0])
    expect(runs[2]).toStrictEqual(runs[0])
    expect(runs[0]?.trajectory.map(({ toolName }) => toolName)).toStrictEqual([
      "search_documentation",
      "read_document_section",
      "submit_requirement_claim",
      "finish_document_mission",
    ])
  })
})
