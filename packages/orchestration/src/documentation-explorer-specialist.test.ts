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
  documentationToolObservationSchema,
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
  type StoredDocumentationExplorerToolResult,
} from "./documentation-explorer-specialist.ts"
import { InMemoryResumeCoordinator } from "./resume-coordinator.ts"
import { createInMemorySpecialistCheckpointer } from "./specialist/fake.ts"
import {
  InMemorySpecialistToolExecutionCoordinator,
  hashSpecialistToolRequest,
} from "./specialist/tools.ts"
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
const quote = "The attendee must provide a valid email before checkout."
const sectionContentHash = hashCanonical({ excerpt: quote })
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
      contentHash:
        selectedQuote === quote
          ? sectionContentHash
          : hashCanonical({ excerpt: selectedQuote }),
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

function claimCitationReference(
  citation: z.infer<typeof documentSectionObservationSchema>["citation"]
) {
  return {
    evidenceId: citation.evidenceId,
    sectionId: citation.sectionId,
    startOffset: citation.startOffset,
    endOffset: citation.endOffset,
    contentHash: citation.contentHash,
  }
}

const readArguments = readDocumentSectionInputSchema.parse({ sectionId })
const readCitation = readObservation().citation
const claimArguments = submitRequirementClaimInputSchema.parse({
  kind: "requirement",
  statement,
  actor: "attendee",
  capability: "provide a valid email",
  expectedOutcome: "valid email before checkout",
  testable: true,
  citation: claimCitationReference(readCitation),
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
    expect(model.requests[2]?.input).toContain(
      "BEGIN_UNTRUSTED_SUBMITTED_REQUIREMENTS"
    )
    expect(model.requests[2]?.input).not.toContain('"excerpt":')
    expect(JSON.stringify(result.state)).not.toContain(quote)
    expect(JSON.stringify(test.events)).not.toContain(quote)
    const checkpointHistory: string[] = []
    for await (const tuple of checkpointer.list({
      configurable: { thread_id: selectedMission.id },
    })) {
      checkpointHistory.push(JSON.stringify(tuple.checkpoint))
    }
    expect(checkpointHistory.length).toBeGreaterThan(3)
    expect(checkpointHistory.join("\n")).not.toContain(quote)
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
        endOffset:
          claimArguments.citation.startOffset +
          "The attendee must provide a phone number before checkout.".length,
      },
      statement: "The attendee must provide a phone number before checkout.",
      capability: "provide a phone number",
      expectedOutcome: "phone number before checkout",
    })
    const stale = submitRequirementClaimInputSchema.parse({
      ...claimArguments,
      citation: {
        ...claimArguments.citation,
        contentHash: `sha256:${"3".repeat(64)}`,
      },
    })
    const tools = new ScriptedDocumentationTools()
    const store = new InMemoryDocumentationExplorerSpecialistStoreForTesting()
    const composition = createDocumentationExplorerSpecialist({
      mission: mission(),
      model: new ScriptedDocumentationModel([
        decision(1, "read_document_section", readArguments),
        decision(2, "submit_requirement_claim", fabricated),
        decision(3, "submit_requirement_claim", stale),
        decision(4, "finish_document_mission", partialArguments),
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

  it("rejects a claim that drops source negation", async () => {
    const test = harness()
    const negativeQuote =
      "The checkout service must not publish payment details."
    const negativeObservation = readObservation(negativeQuote)
    const droppedNegation = submitRequirementClaimInputSchema.parse({
      kind: "requirement",
      statement: "The checkout service must publish payment details.",
      actor: "checkout service",
      capability: "publish payment details",
      expectedOutcome: "publish payment details",
      testable: true,
      citation: claimCitationReference(negativeObservation.citation),
    })
    const store = new InMemoryDocumentationExplorerSpecialistStoreForTesting()
    const composition = createDocumentationExplorerSpecialist({
      mission: mission(),
      model: new ScriptedDocumentationModel([
        decision(1, "read_document_section", readArguments),
        decision(2, "submit_requirement_claim", droppedNegation),
        decision(3, "finish_document_mission", partialArguments),
      ]),
      tools: new ScriptedDocumentationTools(negativeObservation),
      store,
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: test.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })

    const result = await composition.service.start()

    expect(result.status).toBe("partial")
    expect(result.documentationMission.requirements).toEqual([])
    expect(
      (await store.listToolResults(missionId)).map(({ toolName }) => toolName)
    ).toStrictEqual(["read_document_section", "finish_document_mission"])
  })

  it("rejects a role-reversed claim with the same words and polarity", async () => {
    const test = harness()
    const roleQuote = "Administrators must approve requests from users."
    const roleObservation = readObservation(roleQuote)
    const roleReversed = submitRequirementClaimInputSchema.parse({
      kind: "requirement",
      statement: "Users must approve requests from administrators.",
      actor: "users",
      capability: "approve requests from administrators",
      expectedOutcome: "requests from administrators approved",
      testable: true,
      citation: claimCitationReference(roleObservation.citation),
    })
    const store = new InMemoryDocumentationExplorerSpecialistStoreForTesting()
    const composition = createDocumentationExplorerSpecialist({
      mission: mission(),
      model: new ScriptedDocumentationModel([
        decision(1, "read_document_section", readArguments),
        decision(2, "submit_requirement_claim", roleReversed),
        decision(3, "finish_document_mission", partialArguments),
      ]),
      tools: new ScriptedDocumentationTools(roleObservation),
      store,
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: test.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })

    const result = await composition.service.start()

    expect(result.status).toBe("partial")
    expect(result.documentationMission.requirements).toEqual([])
    expect(
      (await store.listToolResults(missionId)).map(({ toolName }) => toolName)
    ).toStrictEqual(["read_document_section", "finish_document_mission"])
  })

  it("rejects vague and multi-action normative prose", async () => {
    const cases = [
      {
        quote: "The application should work well.",
        actor: "application",
        capability: "work well",
        expectedOutcome: "work well",
      },
      {
        quote: "The administrator must create and delete users.",
        actor: "administrator",
        capability: "create and delete users",
        expectedOutcome: "create and delete users",
      },
    ] as const
    for (const [index, selected] of cases.entries()) {
      const selectedMission = mission({
        id: missionIdSchema.parse(`mission:v1:${String(index + 4).repeat(64)}`),
      })
      const observation = readObservation(selected.quote)
      const claim = submitRequirementClaimInputSchema.parse({
        kind: "requirement",
        statement: selected.quote,
        actor: selected.actor,
        capability: selected.capability,
        expectedOutcome: selected.expectedOutcome,
        testable: true,
        citation: claimCitationReference(observation.citation),
      })
      const store = new InMemoryDocumentationExplorerSpecialistStoreForTesting()
      const composition = createDocumentationExplorerSpecialist({
        mission: selectedMission,
        model: new ScriptedDocumentationModel([
          decision(1, "read_document_section", readArguments),
          decision(2, "submit_requirement_claim", claim),
          decision(3, "finish_document_mission", partialArguments),
        ]),
        tools: new ScriptedDocumentationTools(observation),
        store,
        executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
        runtime: harness().runtime,
        checkpointer: createInMemorySpecialistCheckpointer(),
      })

      const result = await composition.service.start()

      expect(result.status).toBe("partial")
      expect(result.documentationMission.requirements).toEqual([])
      expect(
        (await store.listToolResults(selectedMission.id)).map(
          ({ toolName }) => toolName
        )
      ).toStrictEqual(["read_document_section", "finish_document_mission"])
    }
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

  it("does not checkpoint a source body returned as a tool summary", async () => {
    const test = harness()
    const checkpointer = createInMemorySpecialistCheckpointer()
    const base = readObservation()
    const maliciousSummary = documentSectionObservationSchema.parse({
      ...base,
      summary: quote,
    })
    const composition = createDocumentationExplorerSpecialist({
      mission: mission(),
      model: new ScriptedDocumentationModel([
        decision(1, "read_document_section", readArguments),
        decision(2, "finish_document_mission", partialArguments),
      ]),
      tools: new ScriptedDocumentationTools(maliciousSummary),
      store: new InMemoryDocumentationExplorerSpecialistStoreForTesting(),
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: test.runtime,
      checkpointer,
    })

    const result = await composition.service.start()

    expect(result.status).toBe("partial")
    expect(JSON.stringify(result.state)).not.toContain(quote)
    expect(JSON.stringify(test.events)).not.toContain(quote)
    const history: string[] = []
    for await (const tuple of checkpointer.list({
      configurable: { thread_id: missionId },
    })) {
      history.push(JSON.stringify(tuple.checkpoint))
    }
    expect(history.join("\n")).not.toContain(quote)
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

    const oneTokenMission = mission({
      id: missionIdSchema.parse(`mission:v1:${"9".repeat(64)}`),
      budget: {
        ...budget,
        modelInputTokens: 1,
        modelOutputTokens: 512,
      },
    })
    const oneTokenModel = new ScriptedDocumentationModel([
      decision(1, "read_document_section", readArguments),
    ])
    const oneTokenResult = await createDocumentationExplorerSpecialist({
      mission: oneTokenMission,
      model: oneTokenModel,
      tools: new ScriptedDocumentationTools(),
      store: new InMemoryDocumentationExplorerSpecialistStoreForTesting(),
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: harness().runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    }).service.start()
    expect(oneTokenResult.status).toBe("budget_exhausted")
    expect(oneTokenResult.mission.budgetUsed.modelInputTokens).toBe(0)
    expect(oneTokenModel.requests).toHaveLength(0)
  })

  it("returns schema-valid rich results for malformed-provider and recursion exits", async () => {
    const failedTest = harness()
    const malformed = createDocumentationExplorerSpecialist({
      mission: mission(),
      model: new ScriptedDocumentationModel([
        {
          kind: "final_text",
          output: "Free-form completion is not a valid tool decision.",
          model: "test-documentation-model",
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        },
      ]),
      tools: new ScriptedDocumentationTools(),
      store: new InMemoryDocumentationExplorerSpecialistStoreForTesting(),
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: failedTest.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })
    const failed = await malformed.service.start()
    expect(failed.status).toBe("failed")
    expect(failed.documentationMission).toMatchObject({
      status: "failed",
      stopReason: { code: "model_decision_invalid" },
      questionDispositions: [{ status: "unresolved" }],
    })

    const recursionTest = harness()
    const recursion = createDocumentationExplorerSpecialist({
      mission: mission(),
      model: new ScriptedDocumentationModel([
        decision(1, "read_document_section", readArguments),
      ]),
      tools: new ScriptedDocumentationTools(),
      store: new InMemoryDocumentationExplorerSpecialistStoreForTesting(),
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: recursionTest.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
      options: { maxIterations: 1 },
    })
    const exhausted = await recursion.service.start()
    expect(exhausted.status).toBe("budget_exhausted")
    expect(exhausted.documentationMission).toMatchObject({
      status: "budget_exhausted",
      stopReason: { code: "recursion_limit" },
      questionDispositions: [{ status: "unresolved" }],
    })
  })

  it("projects authorized human approval and rejection through rich results", async () => {
    const needsHuman = finishDocumentMissionInputSchema.parse({
      status: "needs_human",
      selectedRequirementIds: [],
      questionDispositions: [
        {
          questionIndex: 0,
          question: mission().questions[0],
          status: "unresolved",
          requirementIds: [],
          evidenceIds: [],
          reasonCode: "source_policy_review",
          summary: "A reviewer must decide whether to broaden source policy.",
        },
      ],
      exclusions: [{ category: "unsupported", summary: quote }],
      suggestedFollowups: [],
      stopReason: {
        code: "source_policy_review",
        summary: quote,
      },
    })
    const afterApproval = finishDocumentMissionInputSchema.parse({
      ...partialArguments,
      stopReason: {
        code: "human_scope_confirmed",
        summary: "The reviewer confirmed the bounded stopping point.",
      },
    })

    const approvedMission = mission({
      id: missionIdSchema.parse(`mission:v1:${"7".repeat(64)}`),
    })
    const approvedModel = new ScriptedDocumentationModel([
      decision(1, "read_document_section", readArguments),
      decision(2, "finish_document_mission", needsHuman),
      decision(3, "finish_document_mission", afterApproval),
    ])
    const approved = createDocumentationExplorerSpecialist({
      mission: approvedMission,
      model: approvedModel,
      tools: new ScriptedDocumentationTools(),
      store: new InMemoryDocumentationExplorerSpecialistStoreForTesting(),
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: harness().runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })
    const interrupted = await approved.service.start()
    expect(interrupted.status).toBe("interrupted")
    expect(interrupted.documentationMission.status).toBe("needs_human")
    const resumed = await approved.service.resume({
      decisionId: interrupted.interrupts[0]!.decisionId,
      actorId: "reviewer:documentation_specialist",
      approved: true,
    })
    expect(resumed.status).toBe("partial")
    expect(resumed.documentationMission.stopReason.code).toBe(
      "human_scope_confirmed"
    )
    expect(approvedModel.requests[2]?.input).toContain('"approved":true')
    expect(approvedModel.requests[2]?.input).toContain(
      "BEGIN_UNTRUSTED_PENDING_HUMAN_RESULT"
    )
    expect(approvedModel.requests[2]?.input).toContain(quote)

    const rejectedMission = mission({
      id: missionIdSchema.parse(`mission:v1:${"8".repeat(64)}`),
    })
    const rejectedModel = new ScriptedDocumentationModel([
      decision(1, "read_document_section", readArguments),
      decision(2, "finish_document_mission", needsHuman),
    ])
    const rejected = createDocumentationExplorerSpecialist({
      mission: rejectedMission,
      model: rejectedModel,
      tools: new ScriptedDocumentationTools(),
      store: new InMemoryDocumentationExplorerSpecialistStoreForTesting(),
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: harness().runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })
    const pending = await rejected.service.start()
    const blocked = await rejected.service.resume({
      decisionId: pending.interrupts[0]!.decisionId,
      actorId: "reviewer:reject_documentation_scope",
      approved: false,
    })
    expect(blocked.status).toBe("blocked")
    expect(blocked.documentationMission).toMatchObject({
      status: "blocked",
      stopReason: { code: "human_rejected" },
      questionDispositions: [{ status: "unresolved" }],
    })
    expect(rejectedModel.requests).toHaveLength(2)
  })

  it("does not publish orphan rich-store records absent from checkpoint state", async () => {
    const sourceTest = harness()
    const sourceStore =
      new InMemoryDocumentationExplorerSpecialistStoreForTesting()
    const source = createDocumentationExplorerSpecialist({
      mission: mission(),
      model: new ScriptedDocumentationModel([
        decision(1, "read_document_section", readArguments),
        decision(2, "submit_requirement_claim", claimArguments),
        decision(3, "finish_document_mission", completeArguments),
      ]),
      tools: new ScriptedDocumentationTools(),
      store: sourceStore,
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: sourceTest.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })
    await source.service.start()
    const claimRecord = (await sourceStore.listToolResults(missionId)).find(
      ({ toolName }) => toolName === "submit_requirement_claim"
    )!
    if (
      claimRecord.request.toolName !== "submit_requirement_claim" ||
      claimRecord.execution.kind !== "claim" ||
      claimRecord.claim === undefined
    ) {
      throw new Error("Expected a stored claim record")
    }
    const rewrittenInput = submitRequirementClaimInputSchema.parse({
      ...claimRecord.request.arguments,
      expectedOutcome: "email before checkout",
    })
    const rewrittenRequest = {
      toolName: "submit_requirement_claim" as const,
      arguments: rewrittenInput,
    }
    const rewrittenExecution = {
      kind: "claim" as const,
      input: rewrittenInput,
    }
    const rewrittenClaim = {
      ...claimRecord.claim,
      requirement: {
        ...claimRecord.claim.requirement,
        expectedOutcome: rewrittenInput.expectedOutcome,
      },
    }
    const rewrittenDraftId = hashCanonical({
      kind: "documentation_tool_draft",
      missionId,
      request: rewrittenRequest,
      version: 1,
    })
    const rewrittenRecord = {
      ...claimRecord,
      request: rewrittenRequest,
      argumentsHash: hashCanonical({
        toolName: "submit_requirement_claim",
        arguments: { draftId: rewrittenDraftId },
      }),
      execution: rewrittenExecution,
      claim: rewrittenClaim,
      payloadHash: hashCanonical({
        execution: rewrittenExecution,
        claim: rewrittenClaim,
      }),
    }
    await expect(
      new InMemoryDocumentationExplorerSpecialistStoreForTesting().putToolResult(
        rewrittenRecord
      )
    ).rejects.toThrow(/request hash is invalid/)
    const orphanStore =
      new InMemoryDocumentationExplorerSpecialistStoreForTesting()
    await orphanStore.putToolResult({ ...claimRecord, sequence: 1 })
    const selectedMission = mission({
      budget: { ...budget, modelOutputTokens: 0 },
    })
    const orphan = createDocumentationExplorerSpecialist({
      mission: selectedMission,
      model: new ScriptedDocumentationModel([]),
      tools: new ScriptedDocumentationTools(),
      store: orphanStore,
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: harness().runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })

    const result = await orphan.service.start()

    expect(result.state.completedCalls).toEqual([])
    expect(result.mission.claims).toEqual([])
    expect(result.documentationMission.requirements).toEqual([])
    expect(result.documentationMission.capabilityTerms).toEqual([])
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

  it("rejects a valid draft returned for the wrong mission and ID", async () => {
    class MisdirectingStore extends InMemoryDocumentationExplorerSpecialistStoreForTesting {
      override async getToolDraft(missionIdInput: string, draftId: string) {
        const draft = await super.getToolDraft(missionIdInput, draftId)
        if (draft === undefined) return undefined
        const wrongMissionId = missionIdSchema.parse(
          `mission:v1:${"a".repeat(64)}`
        )
        return {
          ...draft,
          missionId: wrongMissionId,
          draftId: hashCanonical({
            kind: "documentation_tool_draft",
            missionId: wrongMissionId,
            request: draft.request,
            version: 1,
          }),
        }
      }
    }
    const test = harness()
    const tools = new ScriptedDocumentationTools()
    const store = new MisdirectingStore()
    const composition = createDocumentationExplorerSpecialist({
      mission: mission(),
      model: new ScriptedDocumentationModel([
        decision(1, "finish_document_mission", partialArguments),
      ]),
      tools,
      store,
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: test.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })

    const result = await composition.service.start()

    expect(result.status).not.toBe("complete")
    expect(tools.execute).not.toHaveBeenCalled()
    expect(await store.listToolResults(missionId)).toEqual([])
  })

  it("rejects a self-hashed rich record that conflicts with checkpoint output", async () => {
    class TamperingStore extends InMemoryDocumentationExplorerSpecialistStoreForTesting {
      #tamper = false

      override async putToolResult(
        result: Parameters<
          InMemoryDocumentationExplorerSpecialistStoreForTesting["putToolResult"]
        >[0]
      ) {
        await super.putToolResult(result)
        this.#tamper = true
      }

      override async listToolResults(
        missionIdInput: string
      ): Promise<readonly StoredDocumentationExplorerToolResult[]> {
        const records = await super.listToolResults(missionIdInput)
        if (!this.#tamper) return records
        return records.map((record) => {
          if (
            record.execution.kind !== "observation" ||
            record.execution.observation.toolName !== "read_document_section"
          ) {
            return record
          }
          const execution: DocumentationExplorerToolExecution = {
            kind: "observation",
            observation: documentationToolObservationSchema.parse({
              ...record.execution.observation,
              citation: {
                ...record.execution.observation.citation,
                evidenceId: `evidence:v1:${"3".repeat(64)}`,
              },
            }),
          }
          return {
            ...record,
            execution,
            payloadHash: hashCanonical({ execution }),
          }
        })
      }
    }
    const test = harness()
    const model = new ScriptedDocumentationModel([
      decision(1, "read_document_section", readArguments),
      decision(2, "finish_document_mission", partialArguments),
    ])
    const composition = createDocumentationExplorerSpecialist({
      mission: mission(),
      model,
      tools: new ScriptedDocumentationTools(),
      store: new TamperingStore(),
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: test.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })

    await expect(composition.service.start()).rejects.toThrow(
      /conflicts with checkpoint state/
    )
    expect(model.requests).toHaveLength(1)
  })

  it("derives stable tool requests and rejects conflicting store revisions", async () => {
    const store = new InMemoryDocumentationExplorerSpecialistStoreForTesting()
    const record = {
      missionId,
      sequence: 1,
      callId: "call_one",
      decisionId: "decision_one",
      requestHash: hashSpecialistToolRequest({
        callId: "call_one",
        decisionId: "decision_one",
        missionId,
        agent: "documentation",
        toolName: "read_document_section",
        arguments: readArguments,
      }),
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
        usage: { ...record.usage, elapsedMs: 1 },
      })
    ).rejects.toThrow(/Conflicting Documentation Explorer tool result/)
  })
})
