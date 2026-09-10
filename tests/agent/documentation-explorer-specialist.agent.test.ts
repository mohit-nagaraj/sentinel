import {
  createMissionId,
  discoveryMissionSchema,
  finishDocumentMissionInputSchema,
  type MissionBudget,
} from "@sentinel/contracts"
import {
  InMemoryDocumentationExplorerSpecialistStoreForTesting,
  InMemoryResumeCoordinator,
  InMemorySpecialistToolExecutionCoordinator,
  SpecialistOrchestrationService,
  createDocumentationExplorerSpecialist,
  createInMemorySpecialistCheckpointer,
  type DocumentationExplorerModelGateway,
  type DocumentationExplorerToolExecution,
  type DocumentationExplorerToolPort,
  type OrchestrationEvent,
  type RuntimeDependencies,
} from "@sentinel/orchestration"
import { describe, expect, it, vi } from "vitest"

import {
  createDocumentationExplorerFixture,
  type DocumentationExplorerFixture,
} from "../fixtures/documentation-explorer.ts"

type ModelDecision = Awaited<
  ReturnType<DocumentationExplorerModelGateway["decideTools"]>
>

interface AgendaStep {
  readonly name: string
  readonly arguments: unknown
}

class AgendaModel implements DocumentationExplorerModelGateway {
  readonly requests: Parameters<
    DocumentationExplorerModelGateway["decideTools"]
  >[0][] = []
  #cursor = 0

  constructor(
    private readonly agenda: readonly AgendaStep[],
    private readonly usage = {
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
    }
  ) {}

  async decideTools(
    request: Parameters<DocumentationExplorerModelGateway["decideTools"]>[0]
  ): Promise<ModelDecision> {
    this.requests.push(request)
    const step = this.agenda[this.#cursor]
    this.#cursor += 1
    if (step === undefined) throw new Error("Documentation agenda exhausted")
    return {
      kind: "tool_calls",
      output: [
        {
          callId: `agenda-${this.#cursor}`,
          name: step.name,
          arguments: step.arguments,
        },
      ],
      model: "documentation-agenda-v1",
      usage: this.usage,
    }
  }
}

class CountingDocumentationTools implements DocumentationExplorerToolPort {
  readonly sourceId: string
  readonly mapContentHash: string
  readonly definitions: DocumentationExplorerToolPort["definitions"]
  readonly execute = vi.fn(
    async (
      name: string,
      argumentsInput: unknown,
      signal?: AbortSignal
    ): Promise<DocumentationExplorerToolExecution> =>
      this.delegate.execute(name, argumentsInput, signal)
  )

  constructor(private readonly delegate: DocumentationExplorerToolPort) {
    this.sourceId = delegate.sourceId
    this.mapContentHash = delegate.mapContentHash
    this.definitions = delegate.definitions
  }
}

function runtime(append?: RuntimeDependencies["events"]["append"]): {
  readonly dependencies: RuntimeDependencies
  readonly events: OrchestrationEvent[]
} {
  const events: OrchestrationEvent[] = []
  return {
    events,
    dependencies: {
      owner: "documentation-specialist-agent-test",
      control: { assertActive: async () => undefined },
      events: {
        append: append ?? (async (event) => void events.push(event)),
      },
      effects: { execute: async () => undefined },
      resumeAuthorization: { authorize: async () => true },
      resumeCoordinator: new InMemoryResumeCoordinator(),
      now: () => new Date("2026-09-08T00:00:00.000Z"),
    },
  }
}

function checkoutClaim(fixture: DocumentationExplorerFixture) {
  return fixture.claim("checkout_email", {
    kind: "requirement",
    actor: "attendee",
    capability: "provide a valid email",
    expectedOutcome: "valid email before checkout",
  })
}

function confirmationClaim(fixture: DocumentationExplorerFixture) {
  return fixture.claim("checkout_confirmation", {
    kind: "acceptance_criterion",
    actor: "attendee",
    capability: "receives an order confirmation",
    expectedOutcome: "payment succeeds attendee receives order confirmation",
  })
}

function codeFollowup(
  fixture: DocumentationExplorerFixture,
  evidenceId: string
) {
  return discoveryMissionSchema.parse({
    schemaVersion: 1,
    id: createMissionId({
      applicationId: fixture.mission.applicationId,
      runId: fixture.mission.runId,
      agent: "code",
      mode: "implementation_trace",
      ordinal: 99,
    }),
    runId: fixture.mission.runId,
    applicationId: fixture.mission.applicationId,
    agent: "code",
    mode: "implementation_trace",
    goal: "Find the implementation of the cited checkout requirement.",
    seedEvidenceIds: [evidenceId],
    questions: ["Which source path implements the cited requirement?"],
    scope: {
      repositoryPaths: ["backend"],
      languages: ["php"],
      sourceUris: [],
      allowedHosts: [],
      allowedTools: ["finish_code_mission"],
    },
    budget: fixture.mission.budget,
    successCriteria: ["Return source-backed implementation evidence."],
  })
}

function refundClaim(fixture: DocumentationExplorerFixture, denied: boolean) {
  return fixture.claim(denied ? "refund_denied" : "refund_allowed", {
    kind: "requirement",
    actor: "organizer",
    capability: "refund a paid order",
    expectedOutcome: denied
      ? "cannot refund a paid order before the event starts"
      : "refund a paid order before the event starts",
  })
}

function baselineAgenda(fixture: DocumentationExplorerFixture): AgendaStep[] {
  const checkoutId = fixture.requirementId("checkout_email", "requirement")
  const confirmationId = fixture.requirementId(
    "checkout_confirmation",
    "acceptance_criterion"
  )
  return [
    { name: "list_document_tree", arguments: { limit: 10 } },
    {
      name: "inspect_linked_sections",
      arguments: { sectionId: fixture.sections.overview.fact.id, limit: 10 },
    },
    {
      name: "search_documentation",
      arguments: { query: "attendee valid email payment confirmation" },
    },
    {
      name: "read_document_section",
      arguments: { sectionId: fixture.sections.checkout_email.fact.id },
    },
    {
      name: "submit_requirement_claim",
      arguments: checkoutClaim(fixture),
    },
    {
      name: "read_document_section",
      arguments: {
        sectionId: fixture.sections.checkout_confirmation.fact.id,
      },
    },
    {
      name: "submit_requirement_claim",
      arguments: confirmationClaim(fixture),
    },
    {
      name: "finish_document_mission",
      arguments: finishDocumentMissionInputSchema.parse({
        status: "complete",
        selectedRequirementIds: [checkoutId, confirmationId],
        questionDispositions: [
          {
            questionIndex: 0,
            question: fixture.mission.questions[0],
            status: "covered",
            requirementIds: [checkoutId],
            evidenceIds: [fixture.citation("checkout_email").evidenceId],
            reasonCode: "cited_requirement",
            summary: "The required-email section gives exact coverage.",
          },
          {
            questionIndex: 1,
            question: fixture.mission.questions[1],
            status: "covered",
            requirementIds: [confirmationId],
            evidenceIds: [fixture.citation("checkout_confirmation").evidenceId],
            reasonCode: "cited_acceptance_criterion",
            summary: "The successful-payment criterion gives exact coverage.",
          },
        ],
        exclusions: [
          {
            category: "marketing",
            summary: "Marketing superlatives are not product requirements.",
            sectionId: fixture.sections.marketing.fact.id,
          },
          {
            category: "setup",
            summary: "Local installation steps are not product behavior.",
            sectionId: fixture.sections.setup.fact.id,
          },
        ],
        suggestedFollowups: [],
        stopReason: {
          code: "criteria_met",
          summary: "Both baseline questions have exact cited coverage.",
        },
      }),
    },
  ]
}

function createComposition(input: {
  readonly fixture: DocumentationExplorerFixture
  readonly model: DocumentationExplorerModelGateway
  readonly tools?: DocumentationExplorerToolPort
  readonly store?: InMemoryDocumentationExplorerSpecialistStoreForTesting
  readonly coordinator?: InMemorySpecialistToolExecutionCoordinator
  readonly checkpointer?: ReturnType<
    typeof createInMemorySpecialistCheckpointer
  >
  readonly dependencies?: RuntimeDependencies
}) {
  return createDocumentationExplorerSpecialist({
    mission: input.fixture.mission,
    model: input.model,
    tools: input.tools ?? input.fixture.tools,
    store:
      input.store ??
      new InMemoryDocumentationExplorerSpecialistStoreForTesting(),
    executionCoordinator:
      input.coordinator ?? new InMemorySpecialistToolExecutionCoordinator(),
    runtime: input.dependencies ?? runtime().dependencies,
    checkpointer: input.checkpointer ?? createInMemorySpecialistCheckpointer(),
  })
}

describe("Documentation Explorer shared-kernel agent trajectories", () => {
  it("discovers only golden linked sections and completes baseline coverage", async () => {
    const fixture = createDocumentationExplorerFixture({
      mode: "baseline_discovery",
      ordinal: 1,
    })
    const model = new AgendaModel(baselineAgenda(fixture))
    const tools = new CountingDocumentationTools(fixture.tools)
    const store = new InMemoryDocumentationExplorerSpecialistStoreForTesting()
    const coordinator = new InMemorySpecialistToolExecutionCoordinator()
    const checkpointer = createInMemorySpecialistCheckpointer()
    const testRuntime = runtime()
    const composition = createComposition({
      fixture,
      model,
      tools,
      store,
      coordinator,
      checkpointer,
      dependencies: testRuntime.dependencies,
    })

    const result = await composition.service.start()

    expect(result.status).toBe("complete")
    expect(result.documentationMission.requirements).toHaveLength(2)
    expect(result.documentationMission.questionDispositions).toEqual([
      expect.objectContaining({ questionIndex: 0, status: "covered" }),
      expect.objectContaining({ questionIndex: 1, status: "covered" }),
    ])
    expect(result.documentationMission.metrics).toMatchObject({
      treePagesVisited: 9,
      searchesPerformed: 1,
      sectionsRead: 2,
      linksInspected: 1,
      requirementsAccepted: 2,
    })
    expect(result.documentationMission.typedExclusions).toEqual([
      expect.objectContaining({ category: "marketing" }),
      expect.objectContaining({ category: "setup" }),
    ])
    const modelContext = model.requests.map(({ input }) => input).join("\n")
    expect(model.requests[1]?.input).toContain("Checkout")
    expect(modelContext).not.toContain(fixture.sections.marketing.sanitizedText)
    expect(modelContext).not.toContain(fixture.sections.setup.sanitizedText)
    expect(
      testRuntime.events.filter(({ kind }) => kind === "tool_completed")
    ).toHaveLength(8)

    const replayModel = new AgendaModel([])
    const replay = createComposition({
      fixture,
      model: replayModel,
      tools,
      store,
      coordinator,
      checkpointer,
      dependencies: testRuntime.dependencies,
    })
    const replayed = await replay.service.start()
    expect(replayed.idempotent).toBe(true)
    expect(replayModel.requests).toHaveLength(0)
    expect(tools.execute).toHaveBeenCalledTimes(8)
  }, 10_000)

  it("cannot complete baseline discovery while root pagination is truncated", async () => {
    const fixture = createDocumentationExplorerFixture({
      mode: "baseline_discovery",
      ordinal: 6,
    })
    const checkoutId = fixture.requirementId("checkout_email", "requirement")
    const confirmationId = fixture.requirementId(
      "checkout_confirmation",
      "acceptance_criterion"
    )
    const truncatedAgenda = baselineAgenda(fixture).map((step, index) =>
      index === 0
        ? { name: "list_document_tree", arguments: { limit: 1 } }
        : step
    )
    const store = new InMemoryDocumentationExplorerSpecialistStoreForTesting()
    const result = await createComposition({
      fixture,
      store,
      model: new AgendaModel(truncatedAgenda),
    }).service.start()

    expect(result.status).not.toBe("complete")
    expect(result.documentationMission.metrics.treePagesVisited).toBe(1)
    expect(
      result.documentationMission.requirements.map(
        ({ requirement }) => requirement.id
      )
    ).toEqual(expect.arrayContaining([checkoutId, confirmationId]))
    expect(
      (await store.listToolResults(fixture.mission.id)).some(
        ({ toolName }) => toolName === "finish_document_mission"
      )
    ).toBe(false)
  })

  it("groups exact cross-section duplicates deterministically", async () => {
    const fixture = createDocumentationExplorerFixture({
      mode: "targeted_requirement_lookup",
      ordinal: 2,
    })
    const firstId = fixture.requirementId("checkout_email", "requirement")
    const duplicateId = fixture.requirementId(
      "checkout_duplicate",
      "requirement"
    )
    const duplicateClaim = fixture.claim("checkout_duplicate", {
      kind: "requirement",
      actor: "attendee",
      capability: "provide a valid email",
      expectedOutcome: "valid email before checkout",
    })
    const finish = finishDocumentMissionInputSchema.parse({
      status: "complete",
      selectedRequirementIds: [duplicateId, firstId],
      questionDispositions: [
        {
          questionIndex: 0,
          question: fixture.mission.questions[0],
          status: "covered",
          requirementIds: [firstId, duplicateId],
          evidenceIds: [
            fixture.citation("checkout_email").evidenceId,
            fixture.citation("checkout_duplicate").evidenceId,
          ],
          reasonCode: "duplicate_cited_requirement",
          summary: "Two approved sections state the same requirement.",
        },
      ],
      exclusions: [],
      suggestedFollowups: [],
      stopReason: {
        code: "criteria_met",
        summary: "The targeted question has duplicate cited coverage.",
      },
    })
    const result = await createComposition({
      fixture,
      model: new AgendaModel([
        {
          name: "read_document_section",
          arguments: { sectionId: fixture.sections.checkout_email.fact.id },
        },
        { name: "submit_requirement_claim", arguments: checkoutClaim(fixture) },
        {
          name: "read_document_section",
          arguments: { sectionId: fixture.sections.checkout_duplicate.fact.id },
        },
        { name: "submit_requirement_claim", arguments: duplicateClaim },
        { name: "finish_document_mission", arguments: finish },
      ]),
    }).service.start()

    expect(result.status).toBe("complete")
    expect(result.documentationMission.duplicateGroups).toEqual([
      expect.objectContaining({
        status: "grouped",
        canonicalRequirementId: [firstId, duplicateId].sort()[0],
        duplicateRequirementIds: [[firstId, duplicateId].sort()[1]],
      }),
    ])
    expect(result.documentationMission.capabilityTerms).toEqual([
      expect.objectContaining({
        normalizedName: "provide a valid email",
        requirementIds: [firstId, duplicateId].sort(),
        authoritative: false,
      }),
    ])
  })

  it("allows follow-ups only from selected validated requirement evidence", async () => {
    const fixture = createDocumentationExplorerFixture({
      mode: "targeted_requirement_lookup",
      ordinal: 9,
    })
    const requirementId = fixture.requirementId("checkout_email", "requirement")
    const selectedEvidence = fixture.citation("checkout_email").evidenceId
    const sourceEchoFollowup = {
      ...codeFollowup(fixture, selectedEvidence),
      goal: fixture.sections.checkout_email.sanitizedText,
    }
    const finish = (followupEvidenceId: string) =>
      finishDocumentMissionInputSchema.parse({
        status: "complete",
        selectedRequirementIds: [requirementId],
        questionDispositions: [
          {
            questionIndex: 0,
            question: fixture.mission.questions[0],
            status: "covered",
            requirementIds: [requirementId],
            evidenceIds: [selectedEvidence],
            reasonCode: "cited_requirement",
            summary: "The checkout section gives exact cited coverage.",
          },
        ],
        exclusions: [],
        suggestedFollowups: [
          followupEvidenceId === selectedEvidence
            ? sourceEchoFollowup
            : codeFollowup(fixture, followupEvidenceId),
        ],
        stopReason: {
          code: "criteria_met",
          summary: "The targeted question has exact cited coverage.",
        },
      })
    const positiveCheckpointer = createInMemorySpecialistCheckpointer()
    const positive = await createComposition({
      fixture,
      checkpointer: positiveCheckpointer,
      model: new AgendaModel([
        {
          name: "read_document_section",
          arguments: { sectionId: fixture.sections.checkout_email.fact.id },
        },
        { name: "submit_requirement_claim", arguments: checkoutClaim(fixture) },
        {
          name: "finish_document_mission",
          arguments: finish(selectedEvidence),
        },
      ]),
    }).service.start()
    expect(positive.status).toBe("complete")
    expect(positive.documentationMission.suggestedFollowups).toEqual([
      expect.objectContaining({
        agent: "code",
        seedEvidenceIds: [selectedEvidence],
      }),
    ])
    expect(JSON.stringify(positive.state)).not.toContain(
      fixture.sections.checkout_email.sanitizedText
    )
    const positiveHistory: string[] = []
    for await (const tuple of positiveCheckpointer.list({
      configurable: { thread_id: fixture.mission.id },
    })) {
      positiveHistory.push(JSON.stringify(tuple.checkpoint))
    }
    expect(positiveHistory.join("\n")).not.toContain(
      fixture.sections.checkout_email.sanitizedText
    )

    const negativeFixture = createDocumentationExplorerFixture({
      mode: "targeted_requirement_lookup",
      ordinal: 10,
    })
    const negativeRequirementId = negativeFixture.requirementId(
      "checkout_email",
      "requirement"
    )
    const negativeSelectedEvidence =
      negativeFixture.citation("checkout_email").evidenceId
    const unrelatedEvidence = negativeFixture.citation(
      "checkout_confirmation"
    ).evidenceId
    const negativeFinish = finishDocumentMissionInputSchema.parse({
      status: "complete",
      selectedRequirementIds: [negativeRequirementId],
      questionDispositions: [
        {
          questionIndex: 0,
          question: negativeFixture.mission.questions[0],
          status: "covered",
          requirementIds: [negativeRequirementId],
          evidenceIds: [negativeSelectedEvidence],
          reasonCode: "cited_requirement",
          summary: "The checkout section gives exact cited coverage.",
        },
      ],
      exclusions: [],
      suggestedFollowups: [codeFollowup(negativeFixture, unrelatedEvidence)],
      stopReason: {
        code: "criteria_met",
        summary: "The targeted question has exact cited coverage.",
      },
    })
    const negativeStore =
      new InMemoryDocumentationExplorerSpecialistStoreForTesting()
    const negative = await createComposition({
      fixture: negativeFixture,
      store: negativeStore,
      model: new AgendaModel([
        {
          name: "read_document_section",
          arguments: {
            sectionId: negativeFixture.sections.checkout_email.fact.id,
          },
        },
        {
          name: "submit_requirement_claim",
          arguments: checkoutClaim(negativeFixture),
        },
        {
          name: "read_document_section",
          arguments: {
            sectionId: negativeFixture.sections.checkout_confirmation.fact.id,
          },
        },
        { name: "finish_document_mission", arguments: negativeFinish },
      ]),
    }).service.start()
    expect(negative.status).not.toBe("complete")
    expect(negative.documentationMission.suggestedFollowups).toEqual([])
    expect(
      (await negativeStore.listToolResults(negativeFixture.mission.id)).some(
        ({ toolName }) => toolName === "finish_document_mission"
      )
    ).toBe(false)
  })

  it("keeps opposite refund sources distinct and unresolved", async () => {
    const fixture = createDocumentationExplorerFixture({
      mode: "conflict_resolution",
      ordinal: 3,
    })
    const allowedId = fixture.requirementId("refund_allowed", "requirement")
    const deniedId = fixture.requirementId("refund_denied", "requirement")
    const finish = finishDocumentMissionInputSchema.parse({
      status: "partial",
      selectedRequirementIds: [allowedId, deniedId],
      questionDispositions: [
        {
          questionIndex: 0,
          question: fixture.mission.questions[0],
          status: "conflict",
          requirementIds: [allowedId, deniedId],
          evidenceIds: [
            fixture.citation("refund_allowed").evidenceId,
            fixture.citation("refund_denied").evidenceId,
          ],
          reasonCode: "contradictory_sources",
          summary: "Current and legacy refund sources disagree.",
        },
      ],
      exclusions: [],
      suggestedFollowups: [],
      stopReason: {
        code: "contradictory_sources",
        summary: "The refund policy remains explicitly unresolved.",
      },
    })
    const result = await createComposition({
      fixture,
      model: new AgendaModel([
        {
          name: "read_document_section",
          arguments: { sectionId: fixture.sections.refund_allowed.fact.id },
        },
        {
          name: "submit_requirement_claim",
          arguments: refundClaim(fixture, false),
        },
        {
          name: "read_document_section",
          arguments: { sectionId: fixture.sections.refund_denied.fact.id },
        },
        {
          name: "submit_requirement_claim",
          arguments: refundClaim(fixture, true),
        },
        { name: "finish_document_mission", arguments: finish },
      ]),
    }).service.start()

    expect(result.status).toBe("partial")
    expect(result.documentationMission.requirements).toHaveLength(2)
    expect(result.documentationMission.conflicts).toEqual([
      expect.objectContaining({
        status: "unresolved",
        kind: "contradictory_requirement",
        requirementIds: [allowedId, deniedId].sort(),
      }),
    ])
    expect(result.documentationMission.unresolved).toEqual([
      expect.objectContaining({ reasonCode: "contradictory_sources" }),
    ])
  })

  it("cannot complete by omitting one side of a known conflict", async () => {
    const fixture = createDocumentationExplorerFixture({
      mode: "conflict_resolution",
      ordinal: 12,
    })
    const allowedId = fixture.requirementId("refund_allowed", "requirement")
    const finish = finishDocumentMissionInputSchema.parse({
      status: "complete",
      selectedRequirementIds: [allowedId],
      questionDispositions: [
        {
          questionIndex: 0,
          question: fixture.mission.questions[0],
          status: "covered",
          requirementIds: [allowedId],
          evidenceIds: [fixture.citation("refund_allowed").evidenceId],
          reasonCode: "cited_requirement",
          summary: "Only one side was selected.",
        },
      ],
      exclusions: [],
      suggestedFollowups: [],
      stopReason: {
        code: "criteria_met",
        summary: "The model attempted to hide the contradictory source.",
      },
    })
    const store = new InMemoryDocumentationExplorerSpecialistStoreForTesting()
    const result = await createComposition({
      fixture,
      store,
      model: new AgendaModel([
        {
          name: "read_document_section",
          arguments: { sectionId: fixture.sections.refund_allowed.fact.id },
        },
        {
          name: "submit_requirement_claim",
          arguments: refundClaim(fixture, false),
        },
        {
          name: "read_document_section",
          arguments: { sectionId: fixture.sections.refund_denied.fact.id },
        },
        {
          name: "submit_requirement_claim",
          arguments: refundClaim(fixture, true),
        },
        { name: "finish_document_mission", arguments: finish },
      ]),
    }).service.start()

    expect(result.status).not.toBe("complete")
    expect(result.documentationMission.requirements).toHaveLength(2)
    expect(result.documentationMission.conflicts).toHaveLength(1)
    expect(
      (await store.listToolResults(fixture.mission.id)).some(
        ({ toolName }) => toolName === "finish_document_mission"
      )
    ).toBe(false)
  })

  it("rejects marketing, setup, architecture, and example prose as claims", async () => {
    const fixture = createDocumentationExplorerFixture({
      mode: "targeted_requirement_lookup",
      ordinal: 5,
    })
    const attemptedClaims = [
      fixture.claim("marketing", {
        kind: "requirement",
        capability: "ticketing platform",
      }),
      fixture.claim("setup", {
        kind: "requirement",
        actor: "developers",
        capability: "install the package",
        expectedOutcome: "install package before running development server",
      }),
      fixture.claim("architecture", {
        kind: "requirement",
        actor: "checkout service",
        capability: "publish payment events",
        expectedOutcome: "payment events through internal event bus",
      }),
      fixture.claim("example", {
        kind: "requirement",
        actor: "organizer",
        capability: "refund a sample order",
        expectedOutcome: "refund sample order during training",
      }),
    ]
    const sectionKeys = [
      "marketing",
      "setup",
      "architecture",
      "example",
    ] as const
    const agenda = sectionKeys.flatMap((key, index) => [
      {
        name: "read_document_section",
        arguments: { sectionId: fixture.sections[key].fact.id },
      },
      {
        name: "submit_requirement_claim",
        arguments: attemptedClaims[index],
      },
    ])
    const store = new InMemoryDocumentationExplorerSpecialistStoreForTesting()
    const result = await createComposition({
      fixture,
      store,
      model: new AgendaModel([
        ...agenda,
        {
          name: "finish_document_mission",
          arguments: partialArguments(fixture),
        },
      ]),
    }).service.start()

    expect(result.status).toBe("partial")
    expect(result.documentationMission.requirements).toEqual([])
    expect(
      (await store.listToolResults(fixture.mission.id)).map(
        ({ toolName }) => toolName
      )
    ).toStrictEqual([
      "read_document_section",
      "read_document_section",
      "read_document_section",
      "read_document_section",
      "finish_document_mission",
    ])
  })

  it.each([
    ["link inspection", "inspect_linked_sections", "linksInspected", 4],
    ["search", "search_documentation", "searchesPerformed", 7],
    ["section read", "read_document_section", "sectionsRead", 8],
  ] as const)(
    "detects repeated %s without repeating a read-only effect",
    async (_label, toolName, metric, ordinal) => {
      const fixture = createDocumentationExplorerFixture({
        mode: "targeted_requirement_lookup",
        ordinal,
      })
      const repeated = {
        name: toolName,
        arguments:
          toolName === "search_documentation"
            ? { query: "attendee checkout" }
            : {
                sectionId:
                  toolName === "read_document_section"
                    ? fixture.sections.checkout_email.fact.id
                    : fixture.sections.overview.fact.id,
                ...(toolName === "inspect_linked_sections"
                  ? { limit: 10 }
                  : {}),
              },
      }
      const tools = new CountingDocumentationTools(fixture.tools)
      const result = await createComposition({
        fixture,
        tools,
        model: new AgendaModel([repeated, repeated, repeated, repeated]),
      }).service.start()

      expect(result.status).toBe("partial")
      expect(result.mission.stopReason.code).toBe("no_progress")
      expect(result.documentationMission.metrics[metric]).toBe(1)
      expect(tools.execute).toHaveBeenCalledOnce()
    }
  )

  it("keeps a source-echoing search query out of checkpoint history", async () => {
    const fixture = createDocumentationExplorerFixture({
      mode: "targeted_requirement_lookup",
      ordinal: 11,
    })
    const checkpointer = createInMemorySpecialistCheckpointer()
    const echoedSource = fixture.sections.checkout_email.sanitizedText
    const echoedFinish = finishDocumentMissionInputSchema.parse({
      ...partialArguments(fixture),
      exclusions: [
        {
          category: "unsupported",
          summary: echoedSource,
        },
      ],
      stopReason: {
        code: "source_echo_rejected",
        summary: echoedSource,
      },
    })
    const result = await createComposition({
      fixture,
      checkpointer,
      model: new AgendaModel([
        {
          name: "read_document_section",
          arguments: { sectionId: fixture.sections.checkout_email.fact.id },
        },
        {
          name: "search_documentation",
          arguments: { query: echoedSource },
        },
        {
          name: "finish_document_mission",
          arguments: echoedFinish,
        },
      ]),
    }).service.start()
    expect(result.status).toBe("partial")

    const checkpointHistory: string[] = []
    for await (const tuple of checkpointer.list({
      configurable: { thread_id: fixture.mission.id },
    })) {
      checkpointHistory.push(JSON.stringify(tuple.checkpoint))
    }
    expect(checkpointHistory.length).toBeGreaterThan(3)
    expect(checkpointHistory.join("\n")).not.toContain(echoedSource)
  })

  it.each([
    ["toolCalls", "list_document_tree"],
    ["contentBytes", "list_document_tree"],
    ["documentPages", "list_document_tree"],
    ["documentSections", "list_document_tree"],
    ["documentBytes", "read_document_section"],
    ["modelCalls", "list_document_tree"],
    ["modelInputTokens", "list_document_tree"],
    ["modelOutputTokens", "list_document_tree"],
    ["elapsedMs", "list_document_tree"],
  ] as const)(
    "terminates safely when the %s budget is exhausted",
    async (budgetKey, toolName) => {
      const budgetOverride = { [budgetKey]: 0 } as Partial<MissionBudget>
      const fixture = createDocumentationExplorerFixture({
        mode: "targeted_requirement_lookup",
        ordinal:
          20 +
          [
            "toolCalls",
            "contentBytes",
            "documentPages",
            "documentSections",
            "documentBytes",
            "modelCalls",
            "modelInputTokens",
            "modelOutputTokens",
            "elapsedMs",
          ].indexOf(budgetKey),
        budget: budgetOverride,
      })
      const argumentsInput =
        toolName === "read_document_section"
          ? { sectionId: fixture.sections.checkout_email.fact.id }
          : {}
      const model = new AgendaModel([
        { name: toolName, arguments: argumentsInput },
      ])
      const result = await createComposition({ fixture, model }).service.start()

      expect(result.status).toBe("budget_exhausted")
      expect(result.documentationMission.status).toBe("budget_exhausted")
      expect(result.documentationMission.questionDispositions).toEqual([
        expect.objectContaining({ status: "unresolved" }),
      ])
    }
  )

  it("recovers a committed finish provider-free with no duplicate tool execution", async () => {
    const fixture = createDocumentationExplorerFixture({
      mode: "targeted_requirement_lookup",
      ordinal: 40,
      budget: {
        modelCalls: 5,
        modelInputTokens: 60_000,
        modelOutputTokens: 2_560,
      },
    })
    const requirementId = fixture.requirementId("checkout_email", "requirement")
    const finish = finishDocumentMissionInputSchema.parse({
      status: "complete",
      selectedRequirementIds: [requirementId],
      questionDispositions: [
        {
          questionIndex: 0,
          question: fixture.mission.questions[0],
          status: "covered",
          requirementIds: [requirementId],
          evidenceIds: [fixture.citation("checkout_email").evidenceId],
          reasonCode: "cited_requirement",
          summary: "The checkout section gives exact cited coverage.",
        },
      ],
      exclusions: [],
      suggestedFollowups: [],
      stopReason: {
        code: "criteria_met",
        summary: "The targeted question has exact cited coverage.",
      },
    })
    const tools = new CountingDocumentationTools(fixture.tools)
    const store = new InMemoryDocumentationExplorerSpecialistStoreForTesting()
    const coordinator = new InMemorySpecialistToolExecutionCoordinator()
    const checkpointer = createInMemorySpecialistCheckpointer()
    const firstRuntime = runtime()
    const firstEvents = firstRuntime.dependencies.events
    const crashDependencies: RuntimeDependencies = {
      ...firstRuntime.dependencies,
      events: {
        append: async (event, options) => {
          if (
            event.nodeName === "specialist_model_decision" &&
            tools.execute.mock.calls.length === 3
          ) {
            throw new Error("simulated worker loss after finish checkpoint")
          }
          await firstEvents.append(event, options)
        },
      },
    }
    const agenda = [
      {
        name: "read_document_section",
        arguments: { sectionId: fixture.sections.checkout_email.fact.id },
      },
      { name: "submit_requirement_claim", arguments: checkoutClaim(fixture) },
      { name: "finish_document_mission", arguments: finish },
    ]
    const first = createComposition({
      fixture,
      model: new AgendaModel(agenda, {
        inputTokens: 12_000,
        outputTokens: 512,
        totalTokens: 12_512,
      }),
      tools,
      store,
      coordinator,
      checkpointer,
      dependencies: crashDependencies,
    })
    await expect(first.service.start()).rejects.toThrow(
      /Orchestration event persistence failed/
    )
    expect(tools.execute).toHaveBeenCalledTimes(3)

    const recoveredModel = new AgendaModel([])
    const recovered = createComposition({
      fixture,
      model: recoveredModel,
      tools,
      store,
      coordinator,
      checkpointer,
      dependencies: runtime().dependencies,
    })
    const result = await recovered.service.continue()

    expect(result.status).toBe("complete")
    expect(result.mission.budgetUsed).toMatchObject({
      modelCalls: 3,
      modelInputTokens: 36_000,
      modelOutputTokens: 1_536,
    })
    expect(recoveredModel.requests).toHaveLength(0)
    expect(tools.execute).toHaveBeenCalledTimes(3)
  })

  it("denies cross-agent execution through the fixed documentation kernel", async () => {
    const fixture = createDocumentationExplorerFixture({
      mode: "targeted_requirement_lookup",
      ordinal: 50,
    })
    const testRuntime = runtime()
    const composition = createComposition({
      fixture,
      model: new AgendaModel([]),
      dependencies: testRuntime.dependencies,
    })
    const codeMission = discoveryMissionSchema.parse({
      ...fixture.mission,
      id: `mission:v1:${"9".repeat(64)}`,
      agent: "code",
      mode: "implementation_trace",
      scope: {
        repositoryPaths: ["backend"],
        sourceUris: [],
        allowedHosts: [],
        allowedTools: ["finish_code_mission"],
      },
    })

    await expect(
      new SpecialistOrchestrationService(
        composition.kernel,
        testRuntime.dependencies
      ).start(codeMission)
    ).rejects.toThrow()
  })
})

function partialArguments(fixture: DocumentationExplorerFixture) {
  return finishDocumentMissionInputSchema.parse({
    status: "partial",
    selectedRequirementIds: [],
    questionDispositions: [
      {
        questionIndex: 0,
        question: fixture.mission.questions[0],
        status: "unresolved",
        requirementIds: [],
        evidenceIds: [],
        reasonCode: "non_requirement_prose",
        summary: "The inspected prose did not support an atomic requirement.",
      },
    ],
    exclusions: [
      {
        category: "unsupported",
        summary: "Non-requirement documentation was rejected.",
      },
    ],
    suggestedFollowups: [],
    stopReason: {
      code: "non_requirement_prose",
      summary: "No atomic supported requirement was found.",
    },
  })
}
