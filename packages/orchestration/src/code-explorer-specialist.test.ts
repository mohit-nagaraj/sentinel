import {
  codeExplorerMissionSchema,
  codeExplorerToolNames,
  codeMissionResultSchema,
  codeToolObservationSchema,
  createClaimId,
  discoveryMissionSchema,
  findEndpointHandlerInputSchema,
  finishCodeMissionInputSchema,
  hashCanonical,
  missionResultSchema,
  submitCodeClaimInputSchema,
  type CodeExplorerMission,
  type CodeToolObservation,
  type MissionBudget,
} from "@sentinel/contracts"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import {
  type CodeExplorerModelDecision,
  type CodeExplorerModelGateway,
  type CodeExplorerToolExecution,
  type CodeExplorerToolPort,
} from "./code-explorer.ts"
import {
  CODE_EXPLORER_SPECIALIST_COMPLETION_ID,
  CODE_EXPLORER_SPECIALIST_GRAPH_NAME,
  CODE_EXPLORER_SPECIALIST_INSTRUCTIONS,
  CODE_EXPLORER_SPECIALIST_MODEL_ID,
  CODE_EXPLORER_SPECIALIST_PROMPT_ID,
  CODE_EXPLORER_SPECIALIST_TOOLSET_ID,
  InMemoryCodeExplorerSpecialistStoreForTesting,
  createCodeExplorerSpecialist,
} from "./code-explorer-specialist.ts"
import { InMemoryResumeCoordinator } from "./resume-coordinator.ts"
import { createInMemorySpecialistCheckpointer } from "./specialist/fake.ts"
import { SpecialistOrchestrationService } from "./specialist/kernel.ts"
import { InMemorySpecialistToolExecutionCoordinator } from "./specialist/tools.ts"
import type { OrchestrationEvent, RuntimeDependencies } from "./runtime.ts"

const applicationId = `application:v1:${"a".repeat(64)}` as const
const runId = "run:00000000-0000-4000-8000-000000000116" as const
const missionId = `mission:v1:${"b".repeat(64)}` as const
const documentationMissionId = `mission:v1:${"1".repeat(64)}` as const
const applicationMissionId = `mission:v1:${"2".repeat(64)}` as const
const endpointId = `api-endpoint:v1:${"c".repeat(64)}` as const
const actionId = `code-symbol:v1:${"d".repeat(64)}` as const
const evidenceId = `evidence:v1:${"e".repeat(64)}` as const
const sourceText = "Route::post('orders', CreateOrderAction::class);"

const budget: MissionBudget = {
  toolCalls: 20,
  contentBytes: 100_000,
  documentBytes: 0,
  documentPages: 0,
  documentSections: 0,
  sourceLines: 500,
  repositoryBytes: 50_000,
  repositoryFiles: 100,
  browserActions: 0,
  modelCalls: 20,
  modelInputTokens: 20_000,
  modelOutputTokens: 5_000,
  reconciliationRounds: 0,
  elapsedMs: 30_000,
}

function mission(): CodeExplorerMission {
  return codeExplorerMissionSchema.parse({
    schemaVersion: 1,
    id: missionId,
    runId,
    applicationId,
    agent: "code",
    mode: "implementation_trace",
    goal: "Trace the order endpoint to its source-backed handler.",
    seedEvidenceIds: [],
    questions: ["Which handler implements order creation?"],
    scope: {
      repositoryPaths: ["backend"],
      languages: ["php"],
      sourceUris: [],
      allowedHosts: [],
      allowedTools: [...codeExplorerToolNames],
    },
    budget,
    successCriteria: ["Return a cited endpoint-to-handler path."],
  })
}

function observation(
  overrides: {
    readonly text?: string
    readonly resultItems?: number
    readonly evidenceIds?: readonly string[]
  } = {}
): CodeToolObservation {
  const text = overrides.text ?? sourceText
  const evidenceIds = overrides.evidenceIds ?? [evidenceId]
  return codeToolObservationSchema.parse({
    schemaVersion: 1,
    toolName: "find_endpoint_handler",
    summary: "Found one exact Laravel route handler edge.",
    entities: [
      {
        entityType: "endpoint",
        id: endpointId,
        method: "POST",
        normalizedPath: "/api/events/{param}/orders",
        sourceKinds: ["laravel"],
        handlerSymbolIds: [actionId],
      },
      {
        entityType: "symbol",
        id: actionId,
        qualifiedName: "Fixture\\Actions\\CreateOrderAction::__invoke",
        name: "__invoke",
        language: "php",
        kind: "action",
        filePath: "backend/app/Actions/CreateOrderAction.php",
        range: { startLine: 12, endLine: 20 },
      },
    ],
    edges: [
      {
        kind: "route_handler",
        sourceId: endpointId,
        targetId: actionId,
        evidenceIds,
      },
    ],
    sourceSlices: [
      {
        filePath: "backend/routes/api.php",
        language: "php",
        range: { startLine: 12, endLine: 12 },
        text,
        contentHash: hashCanonical(text),
        truncated: false,
        evidenceId,
      },
    ],
    evidence: evidenceIds.map((selectedEvidenceId) => ({
      evidenceId: selectedEvidenceId,
      kind: "route_handler",
      strength: "structural",
      filePath: "backend/routes/api.php",
      range: { startLine: 12, endLine: 12 },
      sourceEntityId: endpointId,
      targetEntityId: actionId,
    })),
    unresolved: [],
    metrics: {
      sourceLines: 1,
      contentBytes: Buffer.byteLength(text, "utf8"),
      resultItems: overrides.resultItems ?? 4,
      traversalHops: 1,
    },
  })
}

const endpointArguments = findEndpointHandlerInputSchema.parse({
  method: "POST",
  normalizedPath: "/api/events/{event}/orders",
})

const claimArguments = submitCodeClaimInputSchema.parse({
  subjectId: endpointId,
  predicate: "handled_by",
  objectId: actionId,
  evidenceIds: [evidenceId],
  explanation: "The normalized route structurally names this handler.",
})

const claimId = createClaimId({
  applicationId,
  missionId,
  subjectId: endpointId,
  predicate: "handled_by",
  objectId: actionId,
  ordinal: 0,
})

const completeArguments = finishCodeMissionInputSchema.parse({
  status: "complete",
  claimIds: [claimId],
  paths: [
    {
      nodes: [endpointId, actionId],
      edges: [
        {
          subjectId: endpointId,
          predicate: "handled_by",
          objectId: actionId,
          evidenceIds: [evidenceId],
        },
      ],
    },
  ],
  unresolved: [],
  exclusions: ["No runtime behavior was asserted."],
  suggestedFollowups: [
    {
      schemaVersion: 1,
      id: documentationMissionId,
      runId,
      applicationId,
      agent: "documentation",
      mode: "targeted_requirement_lookup",
      goal: "Corroborate the intent of the order creation endpoint.",
      seedEvidenceIds: [evidenceId],
      questions: ["What documented requirement explains order creation?"],
      scope: {
        repositoryPaths: [],
        sourceUris: [],
        allowedHosts: [],
        allowedTools: ["search_documentation"],
      },
      budget,
      successCriteria: ["Return an exact documentation citation."],
    },
    {
      schemaVersion: 1,
      id: applicationMissionId,
      runId,
      applicationId,
      agent: "application",
      mode: "targeted_requirement_observation",
      goal: "Observe the order creation workflow at runtime.",
      seedEvidenceIds: [evidenceId],
      questions: ["Which workflow triggers this endpoint?"],
      scope: {
        repositoryPaths: [],
        sourceUris: [],
        allowedHosts: ["app.example.test"],
        allowedTools: ["observe_page"],
      },
      budget,
      successCriteria: ["Return bounded runtime evidence."],
    },
  ],
  stopReason: {
    code: "criteria_met",
    summary: "The source-backed endpoint path was established.",
  },
})

const partialArguments = finishCodeMissionInputSchema.parse({
  status: "partial",
  claimIds: [],
  paths: [],
  unresolved: [],
  exclusions: ["The bounded trace remains partial."],
  suggestedFollowups: [],
  stopReason: {
    code: "bounded_trace_complete",
    summary: "The requested bounded trace was inspected.",
  },
})

function decision(
  index: number,
  name: string,
  argumentsInput: unknown
): CodeExplorerModelDecision {
  return {
    kind: "tool_calls",
    output: [
      {
        callId: `provider-call-${index}`,
        name,
        arguments: argumentsInput,
      },
    ],
    model: "test-code-model",
    usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
  }
}

class ScriptedCodeModel implements CodeExplorerModelGateway {
  readonly requests: Parameters<CodeExplorerModelGateway["decideTools"]>[0][] =
    []
  private cursor = 0

  constructor(
    private readonly decisions: readonly (CodeExplorerModelDecision | Error)[]
  ) {}

  async decideTools(
    request: Parameters<CodeExplorerModelGateway["decideTools"]>[0]
  ): Promise<CodeExplorerModelDecision> {
    this.requests.push(request)
    const selected = this.decisions[this.cursor]
    this.cursor += 1
    if (selected === undefined)
      throw new Error("No scripted code decision remains")
    if (selected instanceof Error) throw selected
    return selected
  }
}

class ScriptedCodeTools implements CodeExplorerToolPort {
  readonly signals: AbortSignal[] = []
  private observationCursor = 0
  readonly definitions = codeExplorerToolNames.map((name) => ({
    name,
    description: `Execute the bounded ${name} Code Explorer operation.`,
    parameters: z.strictObject({}),
  }))
  readonly execute = vi.fn(
    async (
      name: string,
      argumentsInput: unknown,
      _limits?: Parameters<CodeExplorerToolPort["execute"]>[2],
      signal?: AbortSignal
    ): Promise<CodeExplorerToolExecution> => {
      void _limits
      if (signal !== undefined) this.signals.push(signal)
      if (name === "find_endpoint_handler") {
        findEndpointHandlerInputSchema.parse(argumentsInput)
        const selected =
          this.observations[this.observationCursor] ?? observation()
        this.observationCursor += 1
        return { kind: "observation", observation: selected }
      }
      if (name === "submit_code_claim") {
        return {
          kind: "claim",
          input: submitCodeClaimInputSchema.parse(argumentsInput),
        }
      }
      if (name === "finish_code_mission") {
        return {
          kind: "finish",
          input: finishCodeMissionInputSchema.parse(argumentsInput),
        }
      }
      throw new Error(`Unexpected Code Explorer tool execution: ${name}`)
    }
  )

  constructor(
    private readonly observations: readonly CodeToolObservation[] = []
  ) {}
}

function harness() {
  const events: OrchestrationEvent[] = []
  const assertActive = vi.fn(async () => undefined)
  const runtime: RuntimeDependencies = {
    owner: "code-specialist-test-worker",
    control: { assertActive },
    events: { append: async (event) => void events.push(event) },
    effects: { execute: async () => undefined },
    resumeAuthorization: { authorize: async () => true },
    resumeCoordinator: new InMemoryResumeCoordinator(),
    now: () => new Date("2026-09-08T00:00:00.000Z"),
  }
  return { runtime, events, assertActive }
}

describe("Code Explorer shared specialist composition", () => {
  it("runs the real kernel with rich results outside compact checkpoint state", async () => {
    const test = harness()
    const selectedMission = mission()
    const model = new ScriptedCodeModel([
      decision(1, "find_endpoint_handler", endpointArguments),
      decision(2, "submit_code_claim", claimArguments),
      decision(3, "finish_code_mission", completeArguments),
    ])
    const tools = new ScriptedCodeTools()
    const store = new InMemoryCodeExplorerSpecialistStoreForTesting()
    const coordinator = new InMemorySpecialistToolExecutionCoordinator()
    const checkpointer = createInMemorySpecialistCheckpointer()
    const composition = createCodeExplorerSpecialist({
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
      JSON.stringify({ result: result.mission, state: result.state })
    ).toBe("complete")
    expect(missionResultSchema.parse(result.mission)).toEqual(result.mission)
    expect(codeMissionResultSchema.parse(result.codeMission)).toMatchObject({
      status: "complete",
      paths: [{ nodes: [endpointId, actionId] }],
      claims: [{ id: claimId, status: "proposed" }],
      traversalHopsUsed: 1,
      suggestedFollowups: [
        { id: documentationMissionId, agent: "documentation" },
        { id: applicationMissionId, agent: "application" },
      ],
    })
    expect(composition.kernel.config).toMatchObject({
      agent: "code",
      modes: expect.arrayContaining([
        "baseline_architecture_discovery",
        "implementation_trace",
        "pr_change_investigation",
        "unmapped_endpoint_resolution",
      ]),
      promptTemplateId: CODE_EXPLORER_SPECIALIST_PROMPT_ID,
      modelId: CODE_EXPLORER_SPECIALIST_MODEL_ID,
      toolsetId: CODE_EXPLORER_SPECIALIST_TOOLSET_ID,
      completionValidatorId: CODE_EXPLORER_SPECIALIST_COMPLETION_ID,
      graphName: CODE_EXPLORER_SPECIALIST_GRAPH_NAME,
    })
    expect(composition.tools.map(({ name }) => name).sort()).toStrictEqual(
      [...codeExplorerToolNames].sort()
    )
    expect(
      composition.tools.every(
        ({ agents, description, modes }) =>
          agents.length === 1 &&
          agents[0] === "code" &&
          description.length > 0 &&
          modes.length === 4
      )
    ).toBe(true)
    expect(tools.execute).toHaveBeenCalledTimes(3)
    expect(tools.signals.every((signal) => signal instanceof AbortSignal)).toBe(
      true
    )
    expect(
      model.requests.every(({ signal }) => signal instanceof AbortSignal)
    ).toBe(true)
    expect(result.mission.budgetUsed.modelCalls).toBe(3)
    expect(model.requests[1]?.input).toContain(sourceText)
    expect(JSON.stringify(result.state)).not.toContain(sourceText)
    expect(JSON.stringify(test.events)).not.toContain(sourceText)
    expect(
      test.events.some(
        (event) =>
          event.agent === "code" && event.missionId === selectedMission.id
      )
    ).toBe(true)
    expect(test.assertActive).toHaveBeenCalled()
    expect(
      (await store.listToolResults(selectedMission.id)).map(
        ({ sequence, toolName }) => ({ sequence, toolName })
      )
    ).toStrictEqual([
      { sequence: 1, toolName: "find_endpoint_handler" },
      { sequence: 2, toolName: "submit_code_claim" },
      { sequence: 3, toolName: "finish_code_mission" },
    ])

    const replayModel = new ScriptedCodeModel([])
    const replay = createCodeExplorerSpecialist({
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

  it("translates a needs-human finish through authorized kernel resume", async () => {
    const test = harness()
    const needsHuman = finishCodeMissionInputSchema.parse({
      status: "needs_human",
      claimIds: [],
      paths: [],
      unresolved: [],
      exclusions: [],
      suggestedFollowups: [],
      stopReason: {
        code: "dynamic_boundary",
        summary: "Confirm whether the dynamic call should be explored.",
      },
    })
    const partial = finishCodeMissionInputSchema.parse({
      status: "partial",
      claimIds: [],
      paths: [],
      unresolved: [],
      exclusions: ["The dynamic boundary remains excluded."],
      suggestedFollowups: [],
      stopReason: {
        code: "human_scope_confirmed",
        summary: "The reviewer confirmed the bounded stopping point.",
      },
    })
    const model = new ScriptedCodeModel([
      decision(1, "finish_code_mission", needsHuman),
      new Error("transient provider failure after approval"),
      decision(2, "finish_code_mission", partial),
    ])
    const composition = createCodeExplorerSpecialist({
      mission: mission(),
      model,
      tools: new ScriptedCodeTools(),
      store: new InMemoryCodeExplorerSpecialistStoreForTesting(),
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: test.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })

    const interrupted = await composition.service.start()
    expect(interrupted.status).toBe("interrupted")
    expect(interrupted.interrupts).toHaveLength(1)
    const resumed = await composition.service.resume({
      decisionId: interrupted.interrupts[0]!.decisionId,
      actorId: "reviewer:code_specialist",
      approved: true,
    })
    expect(resumed.status, JSON.stringify(resumed.mission)).toBe("partial")
    expect(resumed.codeMission?.stopReason.code).toBe("human_scope_confirmed")
    expect(resumed.state.humanInterrupt?.status).toBe("resolved")
    expect(model.requests[1]?.input).toContain('"approved":true')
    expect(model.requests[2]?.input).toContain('"approved":true')
  })

  it("projects an authorized human rejection as a typed blocked code result", async () => {
    const test = harness()
    const needsHuman = finishCodeMissionInputSchema.parse({
      status: "needs_human",
      claimIds: [],
      paths: [],
      unresolved: [
        {
          kind: "dependency_injection",
          question: "Which runtime binding selects the implementation?",
          reasonCode: "runtime_binding_unknown",
          evidenceIds: [],
          suggestedAgent: "application",
        },
      ],
      exclusions: ["No dependency-injection target was guessed."],
      suggestedFollowups: [],
      stopReason: {
        code: "runtime_binding_review",
        summary:
          "A reviewer must decide whether to inspect the runtime binding.",
      },
    })
    const model = new ScriptedCodeModel([
      decision(1, "finish_code_mission", needsHuman),
    ])
    const tools = new ScriptedCodeTools()
    const store = new InMemoryCodeExplorerSpecialistStoreForTesting()
    const composition = createCodeExplorerSpecialist({
      mission: mission(),
      model,
      tools,
      store,
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: test.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })

    const interrupted = await composition.service.start()
    const rejection = {
      decisionId: interrupted.interrupts[0]!.decisionId,
      actorId: "reviewer:reject_code_scope",
      approved: false,
    } as const
    const blocked = await composition.service.resume(rejection)
    expect(blocked.status).toBe("blocked")
    expect(blocked.mission.stopReason.code).toBe("human_rejected")
    expect(blocked.codeMission).toMatchObject({
      status: "blocked",
      stopReason: { code: "human_rejected" },
      exclusions: ["No dependency-injection target was guessed."],
      unresolvedBoundaries: [
        {
          kind: "dependency_injection",
          reasonCode: "runtime_binding_unknown",
          suggestedAgent: "application",
        },
      ],
      budgetUsed: blocked.mission.budgetUsed,
    })
    expect((await store.getMissionResult(missionId))?.status).toBe(
      "needs_human"
    )
    expect(model.requests).toHaveLength(1)
    expect(tools.execute).toHaveBeenCalledOnce()

    const duplicate = await composition.service.resume(rejection)
    expect(duplicate.status).toBe("blocked")
    expect(duplicate.idempotent).toBe(true)
    expect(duplicate.codeMission).toEqual(blocked.codeMission)
    expect(model.requests).toHaveLength(1)
    expect(tools.execute).toHaveBeenCalledOnce()
  })

  it("turns repeated semantic visits into kernel no-progress without rereads", async () => {
    const test = harness()
    const tools = new ScriptedCodeTools()
    const composition = createCodeExplorerSpecialist({
      mission: mission(),
      model: new ScriptedCodeModel([
        decision(1, "find_endpoint_handler", endpointArguments),
        decision(2, "find_endpoint_handler", endpointArguments),
        decision(3, "find_endpoint_handler", endpointArguments),
        decision(4, "find_endpoint_handler", endpointArguments),
      ]),
      tools,
      store: new InMemoryCodeExplorerSpecialistStoreForTesting(),
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: test.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })

    const result = await composition.service.start()
    expect(result.status, JSON.stringify(result.mission)).toBe("partial")
    expect(result.mission.stopReason.code).toBe("no_progress")
    expect(tools.execute).toHaveBeenCalledOnce()
  })

  it("orders rich observations by sequence and hydrates the latest source", async () => {
    const test = harness()
    const firstText = "// first bounded endpoint observation"
    const secondText = "// second and latest endpoint observation"
    const model = new ScriptedCodeModel([
      decision(1, "find_endpoint_handler", endpointArguments),
      decision(2, "find_endpoint_handler", {
        ...endpointArguments,
        normalizedPath: "/api/events/{event}/orders/latest",
      }),
      decision(3, "finish_code_mission", partialArguments),
    ])
    const store = new InMemoryCodeExplorerSpecialistStoreForTesting()
    const composition = createCodeExplorerSpecialist({
      mission: mission(),
      model,
      tools: new ScriptedCodeTools([
        observation({ text: firstText }),
        observation({ text: secondText }),
      ]),
      store,
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: test.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })

    const result = await composition.service.start()
    expect(result.status).toBe("partial")
    expect(model.requests[1]?.input).toContain(firstText)
    expect(model.requests[2]?.input).toContain(secondText)
    expect(
      (await store.listToolResults(missionId)).map(({ sequence }) => sequence)
    ).toStrictEqual([1, 2, 3])
  })

  it("reserves worst-case result slots and includes prior claims in totals", async () => {
    const tailTest = harness()
    const tailTools = new ScriptedCodeTools([observation({ resultItems: 981 })])
    const tail = createCodeExplorerSpecialist({
      mission: mission(),
      model: new ScriptedCodeModel([
        decision(1, "find_endpoint_handler", endpointArguments),
        decision(2, "find_endpoint_handler", {
          ...endpointArguments,
          normalizedPath: "/api/events/{event}/orders/tail",
        }),
      ]),
      tools: tailTools,
      store: new InMemoryCodeExplorerSpecialistStoreForTesting(),
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: tailTest.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
      options: { maxResultsPerTool: 50, maxTotalResultItems: 1_000 },
    })
    const tailResult = await tail.service.start()
    expect(tailResult.status).toBe("budget_exhausted")
    expect(tailTools.execute).toHaveBeenCalledOnce()

    const claimTest = harness()
    const claimTools = new ScriptedCodeTools([
      observation({ resultItems: 1_000 }),
    ])
    const claimOverflow = createCodeExplorerSpecialist({
      mission: mission(),
      model: new ScriptedCodeModel([
        decision(1, "find_endpoint_handler", endpointArguments),
        decision(2, "submit_code_claim", claimArguments),
      ]),
      tools: claimTools,
      store: new InMemoryCodeExplorerSpecialistStoreForTesting(),
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: claimTest.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
      options: { maxResultsPerTool: 50, maxTotalResultItems: 1_000 },
    })
    const claimResult = await claimOverflow.service.start()
    expect(claimResult.status).toBe("budget_exhausted")
    expect(claimTools.execute).toHaveBeenCalledOnce()
  })

  it("retains more than 64 claim-relevant evidence IDs compactly", async () => {
    const test = harness()
    const evidenceIds = Array.from(
      { length: 70 },
      (_, index) =>
        `evidence:v1:${index.toString(16).padStart(64, "0")}` as const
    )
    const finish = finishCodeMissionInputSchema.parse({
      ...partialArguments,
      unresolved: [
        {
          kind: "unresolved_reference",
          question: "Which dynamic targets remain unresolved?",
          reasonCode: "dynamic_targets_unresolved",
          evidenceIds,
        },
      ],
    })
    const model = new ScriptedCodeModel([
      decision(1, "find_endpoint_handler", endpointArguments),
      decision(2, "finish_code_mission", finish),
    ])
    const composition = createCodeExplorerSpecialist({
      mission: mission(),
      model,
      tools: new ScriptedCodeTools([observation({ evidenceIds })]),
      store: new InMemoryCodeExplorerSpecialistStoreForTesting(),
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: test.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })

    const result = await composition.service.start()
    expect(
      result.status,
      JSON.stringify({
        mission: result.mission,
        requests: model.requests.length,
      })
    ).toBe("partial")
    expect(result.state.observations[0]?.evidenceIds).toHaveLength(70)
    expect(
      result.codeMission?.unresolvedBoundaries[0]?.evidenceIds
    ).toHaveLength(70)
  })

  it("does not call the provider when no output-token budget remains", async () => {
    const test = harness()
    const selectedMission = codeExplorerMissionSchema.parse({
      ...mission(),
      budget: { ...budget, modelOutputTokens: 0 },
    })
    const model = new ScriptedCodeModel([])
    const composition = createCodeExplorerSpecialist({
      mission: selectedMission,
      model,
      tools: new ScriptedCodeTools(),
      store: new InMemoryCodeExplorerSpecialistStoreForTesting(),
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: test.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })

    const result = await composition.service.start()
    expect(result.status).toBe("budget_exhausted")
    expect(result.mission.stopReason.code).toBe("model_budget_exhausted")
    expect(model.requests).toHaveLength(0)
  })

  it("finalizes after reconstruction from a committed finish tool checkpoint", async () => {
    const selectedMission = codeExplorerMissionSchema.parse({
      ...mission(),
      budget: {
        ...budget,
        modelCalls: 3,
        modelInputTokens: 60,
        modelOutputTokens: 30,
      },
    })
    const tools = new ScriptedCodeTools()
    const store = new InMemoryCodeExplorerSpecialistStoreForTesting()
    const coordinator = new InMemorySpecialistToolExecutionCoordinator()
    const checkpointer = createInMemorySpecialistCheckpointer()
    const model = new ScriptedCodeModel([
      decision(1, "find_endpoint_handler", endpointArguments),
      decision(2, "submit_code_claim", claimArguments),
      decision(3, "finish_code_mission", completeArguments),
    ])
    const failing = harness()
    const events = failing.runtime.events
    const crashRuntime: RuntimeDependencies = {
      ...failing.runtime,
      events: {
        append: async (event, options) => {
          if (
            event.nodeName === "specialist_model_decision" &&
            tools.execute.mock.calls.length === 3
          ) {
            throw new Error("simulated worker loss after finish checkpoint")
          }
          await events.append(event, options)
        },
      },
    }
    const first = createCodeExplorerSpecialist({
      mission: selectedMission,
      model,
      tools,
      store,
      executionCoordinator: coordinator,
      runtime: crashRuntime,
      checkpointer,
    })
    await expect(first.service.start()).rejects.toThrow()
    expect(tools.execute).toHaveBeenCalledTimes(3)

    const recoveredHarness = harness()
    const recoveredModel = new ScriptedCodeModel([])
    const recovered = createCodeExplorerSpecialist({
      mission: selectedMission,
      model: recoveredModel,
      tools,
      store,
      executionCoordinator: coordinator,
      runtime: recoveredHarness.runtime,
      checkpointer,
    })
    const result = await recovered.service.continue()
    expect(result.status).toBe("complete")
    expect(result.mission.budgetUsed).toMatchObject({
      modelCalls: 3,
      modelInputTokens: 60,
      modelOutputTokens: 30,
    })
    expect(recoveredModel.requests).toHaveLength(0)
    expect(tools.execute).toHaveBeenCalledTimes(3)
  })

  it("rejects model-assigned budget status and cross-agent starts", async () => {
    const test = harness()
    const exhausted = finishCodeMissionInputSchema.parse({
      status: "budget_exhausted",
      claimIds: [],
      paths: [],
      unresolved: [],
      exclusions: [],
      suggestedFollowups: [],
      stopReason: {
        code: "model_claimed_budget",
        summary: "The model attempted to assign a deterministic status.",
      },
    })
    const selectedMission = mission()
    const composition = createCodeExplorerSpecialist({
      mission: selectedMission,
      model: new ScriptedCodeModel([
        decision(1, "finish_code_mission", exhausted),
      ]),
      tools: new ScriptedCodeTools(),
      store: new InMemoryCodeExplorerSpecialistStoreForTesting(),
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: test.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })

    const rejected = await composition.service.start()
    expect(rejected.status).toBe("failed")
    expect(rejected.mission.stopReason.code).toBe(
      "model_terminal_status_denied"
    )
    expect(rejected.codeMission?.status).toBe("failed")

    const applicationMission = discoveryMissionSchema.parse({
      ...selectedMission,
      id: `mission:v1:${"f".repeat(64)}`,
      agent: "application",
      mode: "workflow_discovery",
    })
    await expect(
      new SpecialistOrchestrationService(
        composition.kernel,
        test.runtime
      ).start(applicationMission)
    ).rejects.toThrow()
  })

  it("requires explicit durable boundaries and the complete described tool port", () => {
    const test = harness()
    const selectedMission = mission()
    const tools = new ScriptedCodeTools()
    expect(() =>
      createCodeExplorerSpecialist({
        mission: selectedMission,
        model: new ScriptedCodeModel([]),
        tools,
        store: new InMemoryCodeExplorerSpecialistStoreForTesting(),
        executionCoordinator: undefined,
        runtime: test.runtime,
        checkpointer: createInMemorySpecialistCheckpointer(),
      } as unknown as Parameters<typeof createCodeExplorerSpecialist>[0])
    ).toThrow(/durable store, execution coordinator, and checkpointer/)

    const incompleteTools = {
      ...tools,
      definitions: tools.definitions.slice(0, -1),
    }
    expect(() =>
      createCodeExplorerSpecialist({
        mission: selectedMission,
        model: new ScriptedCodeModel([]),
        tools: incompleteTools,
        store: new InMemoryCodeExplorerSpecialistStoreForTesting(),
        executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
        runtime: test.runtime,
        checkpointer: createInMemorySpecialistCheckpointer(),
      })
    ).toThrow(/uniquely describe every mission-allowed tool/)

    const narrowMission = codeExplorerMissionSchema.parse({
      ...selectedMission,
      scope: {
        ...selectedMission.scope,
        allowedTools: ["finish_code_mission"],
      },
    })
    const narrow = createCodeExplorerSpecialist({
      mission: narrowMission,
      model: new ScriptedCodeModel([]),
      tools: {
        definitions: tools.definitions.filter(
          ({ name }) => name === "finish_code_mission"
        ),
        execute: tools.execute,
      },
      store: new InMemoryCodeExplorerSpecialistStoreForTesting(),
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: test.runtime,
      checkpointer: createInMemorySpecialistCheckpointer(),
    })
    expect(narrow.tools).toHaveLength(13)
    expect(CODE_EXPLORER_SPECIALIST_INSTRUCTIONS).toContain(
      "tests corroborate implementation"
    )
  })
})
