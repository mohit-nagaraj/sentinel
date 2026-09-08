import {
  applicationIdSchema,
  contentHashSchema,
  createDocumentationRequirementId,
  createRunScopedEvidenceId,
  documentPageIdSchema,
  documentSectionIdSchema,
  documentSectionObservationSchema,
  documentSourceIdSchema,
  documentationExplorerMissionSchema,
  documentationExplorerToolNames,
  finishDocumentMissionInputSchema,
  hashCanonical,
  missionIdSchema,
  missionResultSchema,
  readDocumentSectionInputSchema,
  runIdSchema,
  submitRequirementClaimInputSchema,
  type DocumentationExplorerMission,
  type MissionBudget,
} from "@sentinel/contracts"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import {
  DOCUMENTATION_EXPLORER_SPECIALIST_COMPLETION_ID,
  DOCUMENTATION_EXPLORER_SPECIALIST_GRAPH_NAME,
  DOCUMENTATION_EXPLORER_SPECIALIST_INSTRUCTIONS,
  DOCUMENTATION_EXPLORER_SPECIALIST_MODEL_ID,
  DOCUMENTATION_EXPLORER_SPECIALIST_PROMPT_ID,
  DOCUMENTATION_EXPLORER_SPECIALIST_TOOLSET_ID,
  InMemoryDocumentationExplorerSpecialistStoreForTesting,
  createDocumentationExplorerSpecialist,
  type DocumentationExplorerModelGateway,
  type DocumentationExplorerToolExecution,
  type DocumentationExplorerToolPort,
} from "./documentation-explorer-specialist.ts"
import { InMemoryResumeCoordinator } from "./resume-coordinator.ts"
import { createInMemorySpecialistCheckpointer } from "./specialist/fake.ts"
import { InMemorySpecialistToolExecutionCoordinator } from "./specialist/tools.ts"
import type { OrchestrationEvent, RuntimeDependencies } from "./runtime.ts"

const applicationId = applicationIdSchema.parse(
  `application:v1:${"a".repeat(64)}`
)
const runId = runIdSchema.parse("run:00000000-0000-4000-8000-000000000115")
const missionId = missionIdSchema.parse(`mission:v1:${"b".repeat(64)}`)
const sourceId = documentSourceIdSchema.parse(
  `document-source:v1:${"c".repeat(64)}`
)
const pageId = documentPageIdSchema.parse(`document-page:v1:${"d".repeat(64)}`)
const sectionId = documentSectionIdSchema.parse(
  `document-section:v1:${"e".repeat(64)}`
)
const mapContentHash = contentHashSchema.parse(`sha256:${"1".repeat(64)}`)
const sectionContentHash = contentHashSchema.parse(`sha256:${"2".repeat(64)}`)
const quote = "The attendee must provide a valid email before checkout."
const statement = "The attendee must provide a valid email before checkout."

const budget: MissionBudget = {
  toolCalls: 20,
  contentBytes: 100_000,
  documentBytes: 100_000,
  documentPages: 20,
  documentSections: 40,
  sourceLines: 0,
  repositoryBytes: 0,
  repositoryFiles: 0,
  browserActions: 0,
  modelCalls: 20,
  modelInputTokens: 30_000,
  modelOutputTokens: 5_000,
  reconciliationRounds: 0,
  elapsedMs: 30_000,
}

function mission(
  overrides: Partial<DocumentationExplorerMission> = {}
): DocumentationExplorerMission {
  return documentationExplorerMissionSchema.parse({
    schemaVersion: 1,
    id: missionId,
    runId,
    applicationId,
    agent: "documentation",
    mode: "targeted_requirement_lookup",
    goal: "Establish the exact documented checkout requirement.",
    seedEvidenceIds: [],
    questions: ["What must an attendee provide before checkout?"],
    scope: {
      repositoryPaths: [],
      sourceUris: ["https://docs.example.test/docs"],
      allowedHosts: ["docs.example.test"],
      allowedTools: [...documentationExplorerToolNames],
    },
    budget,
    successCriteria: ["Return one exact cited atomic requirement."],
    ...overrides,
  })
}

const evidenceId = createRunScopedEvidenceId({
  applicationId,
  runId,
  sourceId: sectionId,
  kind: "documentation_excerpt",
  ordinal: 0,
})

function readObservation(
  selectedQuote = quote
): z.infer<typeof documentSectionObservationSchema> {
  return documentSectionObservationSchema.parse({
    schemaVersion: 1,
    toolName: "read_document_section",
    summary: "Read one complete approved immutable documentation section.",
    fullSection: true,
    citation: {
      evidenceId,
      sourceId,
      pageId,
      sectionId,
      uri: "https://docs.example.test/docs/checkout",
      headingPath: ["Ticket checkout"],
      quote: selectedQuote,
      startOffset: 20,
      endOffset: 20 + selectedQuote.length,
      contentHash: sectionContentHash,
    },
    metrics: {
      contentBytes: Buffer.byteLength(selectedQuote, "utf8") + 512,
      documentBytes: Buffer.byteLength(selectedQuote, "utf8"),
      documentPages: 1,
      documentSections: 1,
      resultItems: 1,
    },
  })
}

const readArguments = readDocumentSectionInputSchema.parse({ sectionId })
const claimArguments = submitRequirementClaimInputSchema.parse({
  kind: "requirement",
  statement,
  actor: "attendee",
  capability: "provide a valid email",
  expectedOutcome: "valid email before checkout",
  testable: true,
  citation: readObservation().citation,
})
const requirementId = createDocumentationRequirementId({
  applicationId,
  sectionId,
  kind: "requirement",
  statement,
})
const completeArguments = finishDocumentMissionInputSchema.parse({
  status: "complete",
  selectedRequirementIds: [requirementId],
  questionDispositions: [
    {
      questionIndex: 0,
      question: "What must an attendee provide before checkout?",
      status: "covered",
      requirementIds: [requirementId],
      evidenceIds: [evidenceId],
      reasonCode: "cited_requirement",
      summary: "The checkout section gives exact cited coverage.",
    },
  ],
  exclusions: [],
  suggestedFollowups: [],
  stopReason: {
    code: "criteria_met",
    summary: "Every mission question has exact cited coverage.",
  },
})
const partialArguments = finishDocumentMissionInputSchema.parse({
  status: "partial",
  selectedRequirementIds: [],
  questionDispositions: [
    {
      questionIndex: 0,
      question: "What must an attendee provide before checkout?",
      status: "unresolved",
      requirementIds: [],
      evidenceIds: [],
      reasonCode: "supported_claim_rejected",
      summary: "No valid exact-cited requirement was accepted.",
    },
  ],
  exclusions: [
    {
      category: "unsupported",
      summary: "The proposed statement was not supported by its exact quote.",
    },
  ],
  suggestedFollowups: [],
  stopReason: {
    code: "bounded_search_complete",
    summary: "The bounded lookup ended without a supported claim.",
  },
})

type ModelDecision = Awaited<
  ReturnType<DocumentationExplorerModelGateway["decideTools"]>
>

function decision(
  index: number,
  name: string,
  argumentsInput: unknown
): ModelDecision {
  return {
    kind: "tool_calls",
    output: [
      {
        callId: `provider-call-${index}`,
        name,
        arguments: argumentsInput,
      },
    ],
    model: "test-documentation-model",
    usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
  }
}

class ScriptedDocumentationModel implements DocumentationExplorerModelGateway {
  readonly requests: Parameters<
    DocumentationExplorerModelGateway["decideTools"]
  >[0][] = []
  private cursor = 0

  constructor(private readonly decisions: readonly (ModelDecision | Error)[]) {}

  async decideTools(
    request: Parameters<DocumentationExplorerModelGateway["decideTools"]>[0]
  ): Promise<ModelDecision> {
    this.requests.push(request)
    const selected = this.decisions[this.cursor]
    this.cursor += 1
    if (selected === undefined) {
      throw new Error("No scripted documentation decision remains")
    }
    if (selected instanceof Error) throw selected
    return selected
  }
}

class ScriptedDocumentationTools implements DocumentationExplorerToolPort {
  readonly sourceId = sourceId
  readonly mapContentHash = mapContentHash
  readonly signals: AbortSignal[] = []
  readonly definitions = documentationExplorerToolNames.map((name) => ({
    name,
    description: `Execute the bounded ${name} Documentation Explorer operation.`,
    parameters: z.strictObject({}),
  }))
  readonly execute = vi.fn(
    async (
      name: string,
      argumentsInput: unknown,
      signal?: AbortSignal
    ): Promise<DocumentationExplorerToolExecution> => {
      if (signal !== undefined) this.signals.push(signal)
      if (name === "read_document_section") {
        expect(argumentsInput).toStrictEqual(readArguments)
        return { kind: "observation", observation: this.observation }
      }
      if (name === "submit_requirement_claim") {
        return {
          kind: "claim",
          input: submitRequirementClaimInputSchema.parse(argumentsInput),
        }
      }
      if (name === "finish_document_mission") {
        return {
          kind: "finish",
          input: finishDocumentMissionInputSchema.parse(argumentsInput),
        }
      }
      throw new Error(`Unexpected documentation tool execution: ${name}`)
    }
  )

  constructor(
    private readonly observation: z.infer<
      typeof documentSectionObservationSchema
    > = readObservation()
  ) {}
}

function harness() {
  const events: OrchestrationEvent[] = []
  const assertActive = vi.fn(async () => undefined)
  const runtime: RuntimeDependencies = {
    owner: "documentation-specialist-test-worker",
    control: { assertActive },
    events: { append: async (event) => void events.push(event) },
    effects: { execute: async () => undefined },
    resumeAuthorization: { authorize: async () => true },
    resumeCoordinator: new InMemoryResumeCoordinator(),
    now: () => new Date("2026-09-08T00:00:00.000Z"),
  }
  return { runtime, events, assertActive }
}

describe("Documentation Explorer shared specialist composition", () => {
  it("runs a cited mission while keeping document bodies outside checkpoint state", async () => {
    const test = harness()
    const selectedMission = mission()
    const model = new ScriptedDocumentationModel([
      decision(1, "read_document_section", readArguments),
      decision(2, "submit_requirement_claim", claimArguments),
      decision(3, "finish_document_mission", completeArguments),
    ])
    const tools = new ScriptedDocumentationTools()
    const store = new InMemoryDocumentationExplorerSpecialistStoreForTesting()
    const coordinator = new InMemorySpecialistToolExecutionCoordinator()
    const checkpointer = createInMemorySpecialistCheckpointer()
    const composition = createDocumentationExplorerSpecialist({
      mission: selectedMission,
      model,
      tools,
      store,
      executionCoordinator: coordinator,
      runtime: test.runtime,
      checkpointer,
    })

    const result = await composition.service.start()

    expect(
      result.status,
      JSON.stringify({ mission: result.mission, state: result.state })
    ).toBe("complete")
    expect(missionResultSchema.parse(result.mission)).toEqual(result.mission)
    expect(result.documentationMission).toMatchObject({
      status: "complete",
      sourceId,
      mapContentHash,
      requirements: [
        {
          requirement: { id: requirementId, statement },
          citation: { evidenceId, quote },
        },
      ],
      questionDispositions: [{ status: "covered" }],
      capabilityTerms: [
        {
          normalizedName: "provide a valid email",
          status: "proposed",
          authoritative: false,
        },
      ],
    })
    expect(composition.kernel.config).toMatchObject({
      agent: "documentation",
      modes: expect.arrayContaining([
        "baseline_discovery",
        "targeted_requirement_lookup",
        "conflict_resolution",
      ]),
      promptTemplateId: DOCUMENTATION_EXPLORER_SPECIALIST_PROMPT_ID,
      modelId: DOCUMENTATION_EXPLORER_SPECIALIST_MODEL_ID,
      toolsetId: DOCUMENTATION_EXPLORER_SPECIALIST_TOOLSET_ID,
      completionValidatorId: DOCUMENTATION_EXPLORER_SPECIALIST_COMPLETION_ID,
      graphName: DOCUMENTATION_EXPLORER_SPECIALIST_GRAPH_NAME,
    })
    expect(composition.tools.map(({ name }) => name).sort()).toStrictEqual(
      [...documentationExplorerToolNames].sort()
    )
    expect(
      composition.tools.every(
        ({ agents, description, modes }) =>
          agents.length === 1 &&
          agents[0] === "documentation" &&
          description.length > 0 &&
          modes.length === 3
      )
    ).toBe(true)
    expect(model.requests[1]?.input).toContain(
      "BEGIN_UNTRUSTED_DOCUMENTATION_EXCERPT"
    )
    expect(model.requests[1]?.input).toContain(quote)
    expect(JSON.stringify(result.state)).not.toContain(quote)
    expect(JSON.stringify(test.events)).not.toContain(quote)
    expect(tools.signals.every((signal) => signal instanceof AbortSignal)).toBe(
      true
    )
    expect(
      model.requests.every(({ signal }) => signal instanceof AbortSignal)
    ).toBe(true)
    expect(test.assertActive).toHaveBeenCalled()
    expect(
      (await store.listToolResults(selectedMission.id)).map(
        ({ sequence, toolName }) => ({ sequence, toolName })
      )
    ).toStrictEqual([
      { sequence: 1, toolName: "read_document_section" },
      { sequence: 2, toolName: "submit_requirement_claim" },
      { sequence: 3, toolName: "finish_document_mission" },
    ])

    const replayModel = new ScriptedDocumentationModel([])
    const replay = createDocumentationExplorerSpecialist({
      mission: selectedMission,
      model: replayModel,
      tools,
      store,
      executionCoordinator: coordinator,
      runtime: test.runtime,
      checkpointer,
    })
    const replayed = await replay.service.start()
    expect(replayed.idempotent).toBe(true)
    expect(replayModel.requests).toHaveLength(0)
    expect(tools.execute).toHaveBeenCalledTimes(3)
  })

  it("rejects a fabricated citation and finishes with explicit unresolved coverage", async () => {
    const test = harness()
    const fabricated = submitRequirementClaimInputSchema.parse({
      ...claimArguments,
      citation: {
        ...claimArguments.citation,
        quote: "The attendee must provide a phone number before checkout.",
        endOffset:
          claimArguments.citation.startOffset +
          "The attendee must provide a phone number before checkout.".length,
      },
      statement: "The attendee must provide a phone number before checkout.",
      capability: "provide a phone number",
      expectedOutcome: "phone number before checkout",
    })
    const tools = new ScriptedDocumentationTools()
    const store = new InMemoryDocumentationExplorerSpecialistStoreForTesting()
    const composition = createDocumentationExplorerSpecialist({
      mission: mission(),
      model: new ScriptedDocumentationModel([
        decision(1, "read_document_section", readArguments),
        decision(2, "submit_requirement_claim", fabricated),
        decision(3, "finish_document_mission", partialArguments),
      ]),
      tools,
      store,
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: test.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })

    const result = await composition.service.start()

    expect(result.status).toBe("partial")
    expect(result.documentationMission).toMatchObject({
      requirements: [],
      questionDispositions: [{ status: "unresolved" }],
      typedExclusions: [{ category: "unsupported" }],
    })
    expect(
      (await store.listToolResults(missionId)).map(({ toolName }) => toolName)
    ).toStrictEqual(["read_document_section", "finish_document_mission"])
  })

  it("redacts secret-shaped document data before model context", async () => {
    const test = harness()
    const unsafeQuote =
      "The attendee must provide an email. authorization: bearer secret-value"
    const model = new ScriptedDocumentationModel([
      decision(1, "read_document_section", readArguments),
      decision(2, "finish_document_mission", partialArguments),
    ])
    const composition = createDocumentationExplorerSpecialist({
      mission: mission(),
      model,
      tools: new ScriptedDocumentationTools(readObservation(unsafeQuote)),
      store: new InMemoryDocumentationExplorerSpecialistStoreForTesting(),
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: test.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })

    const result = await composition.service.start()

    expect(result.status).toBe("partial")
    expect(model.requests[1]?.input).toContain("[REDACTED]")
    expect(model.requests[1]?.input).not.toContain("secret-value")
    expect(JSON.stringify(result.state)).not.toContain("secret-value")
    expect(JSON.stringify(test.events)).not.toContain("secret-value")
  })

  it("returns a schema-valid rich budget result without calling the provider", async () => {
    const test = harness()
    const selectedMission = mission({
      budget: { ...budget, modelOutputTokens: 0 },
    })
    const model = new ScriptedDocumentationModel([])
    const composition = createDocumentationExplorerSpecialist({
      mission: selectedMission,
      model,
      tools: new ScriptedDocumentationTools(),
      store: new InMemoryDocumentationExplorerSpecialistStoreForTesting(),
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: test.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })

    const result = await composition.service.start()

    expect(result.status).toBe("budget_exhausted")
    expect(result.documentationMission).toMatchObject({
      status: "budget_exhausted",
      requirements: [],
      questionDispositions: [{ status: "unresolved" }],
      stopReason: { code: "model_budget_exhausted" },
    })
    expect(model.requests).toHaveLength(0)
  })

  it("requires the durable boundaries and every mission-allowed described tool", () => {
    const test = harness()
    const selectedMission = mission()
    const tools = new ScriptedDocumentationTools()
    expect(() =>
      createDocumentationExplorerSpecialist({
        mission: selectedMission,
        model: new ScriptedDocumentationModel([]),
        tools,
        store: new InMemoryDocumentationExplorerSpecialistStoreForTesting(),
        executionCoordinator: undefined,
        runtime: test.runtime,
        checkpointer: createInMemorySpecialistCheckpointer(),
      } as unknown as Parameters<
        typeof createDocumentationExplorerSpecialist
      >[0])
    ).toThrow(/durable store, execution coordinator, and checkpointer/)

    expect(() =>
      createDocumentationExplorerSpecialist({
        mission: selectedMission,
        model: new ScriptedDocumentationModel([]),
        tools: { ...tools, definitions: tools.definitions.slice(0, -1) },
        store: new InMemoryDocumentationExplorerSpecialistStoreForTesting(),
        executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
        runtime: test.runtime,
        checkpointer: createInMemorySpecialistCheckpointer(),
      })
    ).toThrow(/uniquely describe every mission-allowed tool/)
    expect(DOCUMENTATION_EXPLORER_SPECIALIST_INSTRUCTIONS).toContain(
      "untrusted evidence data"
    )
    expect(DOCUMENTATION_EXPLORER_SPECIALIST_INSTRUCTIONS).toContain(
      "marketing, setup steps, examples, architecture prose"
    )
  })

  it("derives stable tool requests and rejects conflicting store revisions", async () => {
    const store = new InMemoryDocumentationExplorerSpecialistStoreForTesting()
    const record = {
      missionId,
      sequence: 1,
      callId: "call_one",
      decisionId: "decision_one",
      requestHash: hashCanonical({ request: 1 }),
      argumentsHash: hashCanonical({
        toolName: "read_document_section",
        arguments: readArguments,
      }),
      toolName: "read_document_section" as const,
      request: {
        toolName: "read_document_section" as const,
        arguments: readArguments,
      },
      payloadHash: hashCanonical({
        execution: {
          kind: "observation",
          observation: readObservation(),
        },
      }),
      execution: {
        kind: "observation" as const,
        observation: readObservation(),
      },
      usage: {
        ...budget,
        toolCalls: 1,
        modelCalls: 0,
        modelInputTokens: 0,
        modelOutputTokens: 0,
        contentBytes: readObservation().metrics.contentBytes,
        documentBytes: readObservation().metrics.documentBytes,
        documentPages: 1,
        documentSections: 1,
        elapsedMs: 0,
      },
    }
    await store.putToolResult(record)
    await store.putToolResult(record)
    await expect(
      store.putToolResult({
        ...record,
        requestHash: hashCanonical({ request: 2 }),
      })
    ).rejects.toThrow(/Conflicting Documentation Explorer tool result/)
  })
})
