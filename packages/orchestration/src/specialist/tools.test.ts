import {
  contentHashSchema,
  discoveryMissionSchema,
  evidenceIdSchema,
  missionResultSchema,
  type MissionBudget,
  type DiscoveryMission,
} from "@sentinel/contracts"
import { END, START, StateGraph } from "@langchain/langgraph"
import { describe, expect, expectTypeOf, it, vi } from "vitest"
import { z } from "zod"

import {
  EMPTY_BUDGET_LEDGER,
  EMPTY_BUDGET_USAGE,
  SpecialistState,
  createSpecialistInitialState,
  parseSpecialistState,
  reduceBudgetLedger,
  specialistDecisionSchema,
  type PendingToolCall,
  type SpecialistDecision,
  type SpecialistStateValue,
  specialistAgentSchema,
} from "./state.ts"
import {
  SpecialistToolDeniedError,
  SpecialistToolRegistry,
  authorizeSpecialistToolCall,
  defineSpecialistTool,
  executeSpecialistToolCall,
  getRemainingSpecialistBudget,
  hashSpecialistToolRequest,
  specialistToolOutputSchema,
  type SpecialistToolContext,
  type SpecialistToolRequest,
} from "./tools.ts"

const hash = (character: string) =>
  contentHashSchema.parse(`sha256:${character.repeat(64)}`)
const evidenceId = (character: string) =>
  evidenceIdSchema.parse(`evidence:v1:${character.repeat(64)}`)
const budget = (overrides: Partial<MissionBudget> = {}): MissionBudget => ({
  ...EMPTY_BUDGET_USAGE,
  ...overrides,
})

const baseMission = discoveryMissionSchema.parse({
  schemaVersion: 1,
  id: `mission:v1:${"a".repeat(64)}`,
  runId: "run:00000000-0000-4000-8000-000000000014",
  applicationId: `application:v1:${"b".repeat(64)}`,
  agent: "code",
  mode: "implementation_trace",
  goal: "Trace the implementation boundary.",
  seedEvidenceIds: [evidenceId("c")],
  questions: ["Which symbol implements the observed behavior?"],
  scope: {
    repositoryPaths: ["packages"],
    sourceUris: [],
    allowedHosts: [],
    allowedTools: ["read_symbol"],
  },
  budget: budget({
    toolCalls: 3,
    sourceLines: 300,
    modelCalls: 4,
    modelInputTokens: 4_000,
    modelOutputTokens: 1_000,
    elapsedMs: 30_000,
  }),
  successCriteria: ["A cited implementation path is proposed."],
})

const argsSchema = z.strictObject({
  path: z.string().min(1),
  maxLines: z.number().int().positive().max(200),
})
const outputSchema = specialistToolOutputSchema.superRefine(
  (value, context) => {
    if (value.usage.sourceLines > 200) {
      context.addIssue({ code: "custom", message: "Too many source lines" })
    }
  }
)

interface ToolOverrides {
  readonly agents?: readonly z.infer<typeof specialistAgentSchema>[]
  readonly modes?: readonly DiscoveryMission["mode"][]
  readonly estimate?: (
    arguments_: z.infer<typeof argsSchema>,
    context: SpecialistToolContext
  ) => Partial<MissionBudget>
}

function makeTool(
  overrides: ToolOverrides = {},
  execute: (
    arguments_: z.infer<typeof argsSchema>,
    context: SpecialistToolContext
  ) =>
    | z.input<typeof outputSchema>
    | Promise<z.input<typeof outputSchema>> = vi.fn(() => ({
    outcome: "succeeded" as const,
    summary: "Located a bounded implementation symbol.",
    evidenceIds: [evidenceId("d")],
    references: [
      {
        kind: "repository_path" as const,
        id: "packages/orchestration/src/state.ts",
      },
    ],
    usage: budget({ toolCalls: 1, sourceLines: 20, elapsedMs: 5 }),
  }))
) {
  return defineSpecialistTool({
    name: "read_symbol",
    description: "Read one bounded source symbol by repository path.",
    agents: ["code"],
    modes: ["implementation_trace"],
    argumentsSchema: argsSchema,
    outputSchema,
    validateScope: ({ path }, { mission }) =>
      mission.scope.repositoryPaths.some(
        (root) => path === root || path.startsWith(`${root}/`)
      ) || "Requested repository path is outside mission scope",
    estimate: ({ maxLines }) => ({
      toolCalls: 1,
      sourceLines: maxLines,
      elapsedMs: 100,
    }),
    execute,
    ...overrides,
  })
}

const decision = (
  callIds = ["call_01"],
  overrides: Partial<SpecialistDecision> = {}
): SpecialistDecision =>
  specialistDecisionSchema.parse({
    decisionId: "decision_01",
    missionId: baseMission.id,
    agent: baseMission.agent,
    stateFingerprint: hash("1"),
    decisionHash: hash("2"),
    kind: "tool_calls",
    callIds,
    ...overrides,
  })

const request = (
  overrides: Partial<SpecialistToolRequest> = {}
): SpecialistToolRequest => ({
  callId: "call_01",
  decisionId: "decision_01",
  missionId: baseMission.id,
  agent: baseMission.agent,
  toolName: "read_symbol",
  arguments: {
    path: "packages/orchestration/src/state.ts",
    maxLines: 100,
  },
  ...overrides,
})

function authorize(
  registry = SpecialistToolRegistry.forTesting([makeTool()]),
  state = createSpecialistInitialState(baseMission),
  decisionInput = decision(),
  requestInput = request()
) {
  return authorizeSpecialistToolCall({
    registry,
    state,
    decision: decisionInput,
    request: requestInput,
  })
}

function pendingState(
  registry = SpecialistToolRegistry.forTesting([makeTool()]),
  decisionInput = decision(),
  requestInput = request(),
  state = createSpecialistInitialState(baseMission)
): { state: SpecialistStateValue; call: PendingToolCall } {
  const authorization = authorize(registry, state, decisionInput, requestInput)
  if (authorization.kind !== "authorized") {
    throw new Error("Expected a newly authorized call")
  }
  const modelUsage = budget({ modelCalls: 1, modelInputTokens: 10 })
  return {
    call: authorization.pendingCall,
    state: parseSpecialistState({
      ...state,
      decisions: [decisionInput],
      pendingToolCalls: [authorization.pendingCall],
      budgetLedger: reduceBudgetLedger(EMPTY_BUDGET_LEDGER, {
        kind: "model_decision",
        decisionId: decisionInput.decisionId,
        missionId: state.mission.id,
        agent: state.agent,
        usage: modelUsage,
      }),
    }),
  }
}

function expectDenial(
  callback: () => unknown,
  code: SpecialistToolDeniedError["code"]
) {
  try {
    callback()
    throw new Error("Expected specialist tool denial")
  } catch (error) {
    expect(error).toBeInstanceOf(SpecialistToolDeniedError)
    expect((error as SpecialistToolDeniedError).code).toBe(code)
  }
}

async function executeDurableFailureAndReplay(
  registry: SpecialistToolRegistry,
  state: SpecialistStateValue,
  call: PendingToolCall,
  expectedKind: "executed" | "budget_violation" = "executed"
) {
  const failure = await executeSpecialistToolCall({ registry, state, call })
  expect(failure).toMatchObject({
    kind: expectedKind,
    observation: { outcome: "failed", evidenceIds: [], references: [] },
    completedCall: { outcome: "failed", usage: call.preflightUsage },
  })
  if (failure.kind === "replayed") throw new Error("Expected failed update")

  const graph = new StateGraph(SpecialistState)
    .addNode("persist-failure", () => failure.update)
    .addEdge(START, "persist-failure")
    .addEdge("persist-failure", END)
    .compile()
  const completedState = parseSpecialistState(await graph.invoke(state))
  const replay = await executeSpecialistToolCall({
    registry,
    state: completedState,
    call,
  })
  expect(replay).toMatchObject({
    kind: "replayed",
    observation: { outcome: "failed" },
  })
  return { failure, completedState }
}

describe("specialist deterministic tool registry", () => {
  it("registers typed immutable definitions and hashes canonical requests", () => {
    const tool = makeTool()
    const registry = SpecialistToolRegistry.forTesting([tool])
    const first = request()
    const reordered = {
      ...first,
      arguments: { maxLines: 100, path: "packages/orchestration/src/state.ts" },
    }

    expectTypeOf(tool).toMatchTypeOf<ReturnType<typeof defineSpecialistTool>>()
    expect(registry.names()).toEqual(["read_symbol"])
    expect(Object.isFrozen(registry.get("read_symbol"))).toBe(true)
    expect(Object.isFrozen(registry.get("read_symbol")?.agents)).toBe(true)
    expect(hashSpecialistToolRequest(first)).toBe(
      hashSpecialistToolRequest(reordered)
    )
    expect(() => SpecialistToolRegistry.forTesting([tool, tool])).toThrow(
      "Duplicate specialist tool definition"
    )
    expect(
      () => new SpecialistToolRegistry([tool], undefined as never)
    ).toThrow("require an execution coordinator")
    expect(() =>
      SpecialistToolRegistry.forTesting([makeTool({ agents: [] })])
    ).toThrow("requires fixed agent and mode permissions")
  })

  it("authorizes a correlated request with a full deterministic estimate", () => {
    const result = authorize()

    expect(result.kind).toBe("authorized")
    if (result.kind !== "authorized") return
    expect(result.pendingCall).toMatchObject({
      callId: "call_01",
      toolName: "read_symbol",
      requestHash: result.requestHash,
      preflightUsage: {
        toolCalls: 1,
        sourceLines: 100,
        elapsedMs: 100,
      },
    })
    expect(result.requestHash).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it("denies unknown, mission-disallowed, agent-disallowed, and mode-disallowed tools", () => {
    expectDenial(
      () =>
        authorize(
          undefined,
          undefined,
          decision(),
          request({ toolName: "missing" })
        ),
      "tool_denied"
    )

    const disallowedMission = discoveryMissionSchema.parse({
      ...baseMission,
      scope: { ...baseMission.scope, allowedTools: ["other_tool"] },
    })
    expectDenial(
      () =>
        authorize(undefined, createSpecialistInitialState(disallowedMission)),
      "tool_denied"
    )

    const applicationMission = discoveryMissionSchema.parse({
      ...baseMission,
      agent: "application",
      mode: "workflow_discovery",
    })
    expectDenial(
      () =>
        authorize(
          undefined,
          createSpecialistInitialState(applicationMission),
          decision(["call_01"], {
            missionId: applicationMission.id,
            agent: "application",
          }),
          request({ agent: "application" })
        ),
      "agent_denied"
    )

    const otherModeMission = discoveryMissionSchema.parse({
      ...baseMission,
      mode: "baseline_architecture_discovery",
    })
    expectDenial(
      () =>
        authorize(undefined, createSpecialistInitialState(otherModeMission)),
      "mode_denied"
    )
  })

  it("denies malformed request and argument schemas without field stripping", () => {
    expectDenial(
      () =>
        authorize(undefined, undefined, decision(), {
          ...request(),
          extra: true,
        } as SpecialistToolRequest),
      "schema_denied"
    )
    expectDenial(
      () =>
        authorize(
          undefined,
          undefined,
          decision(),
          request({
            arguments: {
              path: "packages/orchestration/src/state.ts",
              maxLines: 100,
              selector: "body",
            },
          })
        ),
      "schema_denied"
    )
    expectDenial(
      () =>
        authorize(
          undefined,
          undefined,
          decision(),
          request({ arguments: { path: "packages", maxLines: 0 } })
        ),
      "schema_denied"
    )
  })

  it("denies cross-identity, uncorrelated, out-of-scope, and terminal requests", () => {
    expectDenial(
      () =>
        authorize(
          undefined,
          undefined,
          decision(),
          request({ agent: "application" })
        ),
      "mission_denied"
    )
    expectDenial(
      () => authorize(undefined, undefined, decision(["call_02"])),
      "state_denied"
    )
    expectDenial(
      () =>
        authorize(
          undefined,
          undefined,
          decision(),
          request({ arguments: { path: "apps/web/page.tsx", maxLines: 10 } })
        ),
      "scope_denied"
    )

    const terminalResult = missionResultSchema.parse({
      schemaVersion: 1,
      missionId: baseMission.id,
      status: "complete",
      claims: [],
      unresolved: [],
      exclusions: [],
      suggestedFollowups: [],
      stopReason: { code: "mission_complete", summary: "Mission complete." },
      budgetUsed: EMPTY_BUDGET_USAGE,
    })
    const terminalState = parseSpecialistState({
      ...createSpecialistInitialState(baseMission),
      terminalResult,
    })
    expectDenial(() => authorize(undefined, terminalState), "state_denied")
  })

  it("denies invalid estimates, exhausted dimensions, and overcommitted reservations", () => {
    expectDenial(
      () =>
        authorize(
          SpecialistToolRegistry.forTesting([
            makeTool({ estimate: () => ({ toolCalls: 0 }) }),
          ])
        ),
      "budget_denied"
    )
    expectDenial(
      () =>
        authorize(
          SpecialistToolRegistry.forTesting([
            makeTool({ estimate: () => ({ toolCalls: 1, sourceLines: 301 }) }),
          ])
        ),
      "budget_denied"
    )

    const oneCallMission = discoveryMissionSchema.parse({
      ...baseMission,
      budget: budget({
        toolCalls: 1,
        sourceLines: 200,
        modelCalls: 2,
        modelInputTokens: 100,
        elapsedMs: 1_000,
      }),
    })
    const registry = SpecialistToolRegistry.forTesting([makeTool()])
    const firstDecision = decision(["call_01"])
    const first = authorize(
      registry,
      createSpecialistInitialState(oneCallMission),
      firstDecision
    )
    if (first.kind !== "authorized") throw new Error("Expected authorization")
    const reservedState = parseSpecialistState({
      ...createSpecialistInitialState(oneCallMission),
      decisions: [firstDecision],
      pendingToolCalls: [first.pendingCall],
      budgetLedger: reduceBudgetLedger(EMPTY_BUDGET_LEDGER, {
        kind: "model_decision",
        decisionId: firstDecision.decisionId,
        missionId: oneCallMission.id,
        agent: oneCallMission.agent,
        usage: budget({ modelCalls: 1, modelInputTokens: 10 }),
      }),
    })
    const secondDecision = decision(["call_02"], {
      decisionId: "decision_02",
      decisionHash: hash("3"),
    })
    expectDenial(
      () =>
        authorize(
          registry,
          reservedState,
          secondDecision,
          request({ callId: "call_02", decisionId: "decision_02" })
        ),
      "budget_denied"
    )
  })

  it("keeps identical pending calls idempotent and rejects conflicting call IDs", () => {
    const registry = SpecialistToolRegistry.forTesting([makeTool()])
    const { state } = pendingState(registry)
    expect(authorize(registry, state).kind).toBe("pending")
    expectDenial(
      () =>
        authorize(
          registry,
          state,
          decision(),
          request({ arguments: { path: "packages/other.ts", maxLines: 100 } })
        ),
      "duplicate_call"
    )
    expectDenial(
      () =>
        authorize(
          registry,
          state,
          decision(["call_01"], { decisionId: "decision_02" }),
          request({ decisionId: "decision_02" })
        ),
      "duplicate_call"
    )
  })

  it("executes once, records actual usage atomically, and replays from checkpoint", async () => {
    const execute = vi.fn(() => ({
      outcome: "succeeded" as const,
      summary: "Located a bounded implementation symbol.",
      evidenceIds: [evidenceId("d")],
      references: [
        {
          kind: "repository_path" as const,
          id: "packages/orchestration/src/state.ts",
        },
      ],
      usage: budget({ toolCalls: 1, sourceLines: 20, elapsedMs: 5 }),
    }))
    const registry = SpecialistToolRegistry.forTesting([makeTool({}, execute)])
    const exactBudgetMission = discoveryMissionSchema.parse({
      ...baseMission,
      budget: { ...baseMission.budget, toolCalls: 1, sourceLines: 100 },
    })
    const { state, call } = pendingState(
      registry,
      decision(),
      request(),
      createSpecialistInitialState(exactBudgetMission)
    )
    let executionResult:
      Awaited<ReturnType<typeof executeSpecialistToolCall>> | undefined
    const graph = new StateGraph(SpecialistState)
      .addNode("execute", async (current) => {
        executionResult = await executeSpecialistToolCall({
          registry,
          state: current,
          call,
        })
        return executionResult.kind === "executed" ? executionResult.update : {}
      })
      .addEdge(START, "execute")
      .addEdge("execute", END)
      .compile()
    const completedState = parseSpecialistState(await graph.invoke(state))

    expect(execute).toHaveBeenCalledTimes(1)
    expect(completedState.pendingToolCalls).toEqual([])
    expect(completedState.completedCalls[0]).toMatchObject({
      callId: "call_01",
      preflightUsage: call.preflightUsage,
      usage: { toolCalls: 1, sourceLines: 20, elapsedMs: 5 },
    })
    expect(completedState.budgetLedger.total).toMatchObject({
      modelCalls: 1,
      toolCalls: 1,
      sourceLines: 20,
      elapsedMs: 5,
    })
    expect(completedState.observations[0]?.summary).toBe(
      "Located a bounded implementation symbol."
    )

    const replay = await executeSpecialistToolCall({
      registry,
      state: completedState,
      call,
    })
    expect(replay.kind).toBe("replayed")
    expect(execute).toHaveBeenCalledTimes(1)
    expect(authorize(registry, completedState).kind).toBe("completed")
  })

  it("coordinates concurrent stale-state calls once and rejects conflicting hashes", async () => {
    const execute = vi.fn(async () => ({
      outcome: "succeeded" as const,
      summary: "Located the coordinated symbol.",
      evidenceIds: [evidenceId("d")],
      references: [],
      usage: budget({ toolCalls: 1, sourceLines: 20, elapsedMs: 5 }),
    }))
    const registry = SpecialistToolRegistry.forTesting([makeTool({}, execute)])
    const first = pendingState(registry)
    const conflicting = pendingState(
      registry,
      decision(),
      request({
        arguments: { path: "packages/other.ts", maxLines: 80 },
      })
    )

    const [left, right] = await Promise.all([
      executeSpecialistToolCall({
        registry,
        state: first.state,
        call: first.call,
      }),
      executeSpecialistToolCall({
        registry,
        state: first.state,
        call: first.call,
      }),
    ])

    expect(execute).toHaveBeenCalledTimes(1)
    expect(left).toMatchObject({ kind: "executed" })
    expect(right).toMatchObject({
      kind: "executed",
      observation: left.observation,
    })
    await expect(
      executeSpecialistToolCall({
        registry,
        state: conflicting.state,
        call: conflicting.call,
      })
    ).rejects.toMatchObject({ code: "duplicate_call" })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("turns executor exceptions into durable charged failures that replay", async () => {
    const execute = vi.fn(async () => {
      throw new Error("Authorization: Bearer unsafe-executor-detail")
    })
    const registry = SpecialistToolRegistry.forTesting([makeTool({}, execute)])
    const { state, call } = pendingState(registry)
    const { failure, completedState } = await executeDurableFailureAndReplay(
      registry,
      state,
      call
    )
    expect(failure.observation.summary).not.toContain("unsafe-executor-detail")
    expect(completedState.budgetLedger.total).toMatchObject({
      toolCalls: 1,
      sourceLines: 100,
      elapsedMs: 100,
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("records a durable failure when actual usage has zero tool calls", async () => {
    const execute = vi.fn(() => ({
      outcome: "succeeded" as const,
      summary: "Invalid zero-call usage.",
      evidenceIds: [],
      references: [],
      usage: budget({ sourceLines: 20, elapsedMs: 5 }),
    }))
    const registry = SpecialistToolRegistry.forTesting([makeTool({}, execute)])
    const { state, call } = pendingState(registry)

    const { failure } = await executeDurableFailureAndReplay(
      registry,
      state,
      call,
      "budget_violation"
    )
    expect(failure).toMatchObject({
      reportedUsageHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      exceededBudgetKeys: ["toolCalls"],
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("records a durable failure when actual usage exceeds the estimate", async () => {
    const execute = vi.fn(() => ({
      outcome: "succeeded" as const,
      summary: "Oversized result.",
      evidenceIds: [],
      references: [],
      usage: budget({ toolCalls: 1, sourceLines: 101, elapsedMs: 5 }),
    }))
    const registry = SpecialistToolRegistry.forTesting([makeTool({}, execute)])
    const { state, call } = pendingState(registry)

    const { failure } = await executeDurableFailureAndReplay(
      registry,
      state,
      call,
      "budget_violation"
    )
    expect(failure).toMatchObject({
      reportedUsageHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      exceededBudgetKeys: ["sourceLines"],
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("falls back durably when a successful aggregate update cannot validate", async () => {
    const references = Array.from({ length: 64 }, (_, index) => ({
      kind: "repository_path" as const,
      id: `packages/${index.toString().padStart(2, "0")}/${"x".repeat(500)}.ts`,
    }))
    const output = {
      outcome: "succeeded" as const,
      summary:
        "A schema-valid result whose references exceed checkpoint headroom.",
      evidenceIds: [],
      references,
      usage: budget({ toolCalls: 1, sourceLines: 20, elapsedMs: 5 }),
    }
    const execute = vi.fn(() => output)
    const registry = SpecialistToolRegistry.forTesting([makeTool({}, execute)])
    expect(() => registry.get("read_symbol")?.parseOutput(output)).not.toThrow()

    const nearLimitMission = discoveryMissionSchema.parse({
      ...baseMission,
      goal: "g".repeat(4_096),
      questions: Array.from(
        { length: 6 },
        (_, index) => `${index.toString().padStart(2, "0")}${"q".repeat(4_094)}`
      ),
      successCriteria: Array.from(
        { length: 4 },
        (_, index) => `${index.toString().padStart(2, "0")}${"s".repeat(4_094)}`
      ),
    })
    const { state, call } = pendingState(
      registry,
      decision(),
      request(),
      createSpecialistInitialState(nearLimitMission)
    )

    await executeDurableFailureAndReplay(registry, state, call)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["authority fields", { accepted: true }],
    ["evidence tiers", { evidenceTier: "verified" }],
    ["graph writes", { graphMutation: { operation: "merge" } }],
    ["raw source", { rawContent: "const secret = true" }],
    ["model authority", { confidence: 0.99 }],
  ])("rejects unsafe %s in tool output", async (_label, unsafe) => {
    const execute = vi.fn(() => ({
      outcome: "succeeded" as const,
      summary: "Unsafe result.",
      evidenceIds: [],
      references: [],
      usage: budget({ toolCalls: 1, sourceLines: 1 }),
      ...unsafe,
    }))
    const registry = SpecialistToolRegistry.forTesting([makeTool({}, execute)])
    const { state, call } = pendingState(registry)

    await executeDurableFailureAndReplay(registry, state, call)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("rejects unsafe or unbounded summaries and accepts typed failed observations", async () => {
    for (const summary of [
      "Authorization: Bearer very-secret-access-token-value",
      "x".repeat(513),
    ]) {
      const registry = SpecialistToolRegistry.forTesting([
        makeTool({}, () => ({
          outcome: "failed" as const,
          summary,
          evidenceIds: [],
          references: [],
          usage: budget({ toolCalls: 1, elapsedMs: 5 }),
        })),
      ])
      const { state, call } = pendingState(registry)
      await executeDurableFailureAndReplay(registry, state, call)
    }

    const failedRegistry = SpecialistToolRegistry.forTesting([
      makeTool({}, () => ({
        outcome: "failed" as const,
        summary: "The bounded lookup did not locate the symbol.",
        evidenceIds: [],
        references: [],
        usage: budget({ toolCalls: 1, elapsedMs: 5 }),
      })),
    ])
    const { state, call } = pendingState(failedRegistry)
    const result = await executeSpecialistToolCall({
      registry: failedRegistry,
      state,
      call,
    })
    expect(result).toMatchObject({
      kind: "executed",
      observation: { outcome: "failed" },
      completedCall: { outcome: "failed" },
    })
  })

  it("reports remaining durable budget after pending reservations", () => {
    const { state } = pendingState()
    expect(getRemainingSpecialistBudget(state)).toMatchObject({
      toolCalls: 2,
      sourceLines: 200,
      modelCalls: 3,
      modelInputTokens: 3_990,
    })
  })
})
