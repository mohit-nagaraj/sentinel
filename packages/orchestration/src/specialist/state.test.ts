import {
  contentHashSchema,
  discoveryMissionSchema,
  evidenceIdSchema,
  missionIdSchema,
  missionResultSchema,
  type DiscoveryMission,
  type MissionResult,
} from "@sentinel/contracts"
import { END, START, StateGraph } from "@langchain/langgraph"
import { describe, expect, expectTypeOf, it } from "vitest"

import {
  EMPTY_BUDGET_LEDGER,
  EMPTY_BUDGET_USAGE,
  EMPTY_SPECIALIST_PROGRESS,
  SpecialistState,
  assertSafeSpecialistValue,
  compactObservationSchema,
  compactToolArgumentsSchema,
  completedToolCallSchema,
  createSpecialistInitialState,
  humanInterruptStateSchema,
  parseSpecialistState,
  reduceBudgetLedger,
  reduceCompactObservations,
  reduceCompletedToolCalls,
  reduceHumanInterrupt,
  reducePendingToolCalls,
  reduceSpecialistDecisions,
  reduceSpecialistProgress,
  reduceTerminalResult,
  validateSpecialistUpdate,
  type BudgetLedgerEntry,
  type CompactObservation,
  type CompletedToolCall,
  type HumanInterruptState,
  type PendingToolCall,
  type SpecialistDecision,
} from "./state.ts"

const hash = (character: string) =>
  contentHashSchema.parse(`sha256:${character.repeat(64)}`)
const evidenceId = (character: string) =>
  evidenceIdSchema.parse(`evidence:v1:${character.repeat(64)}`)

const budget = (overrides: Partial<typeof EMPTY_BUDGET_USAGE> = {}) => ({
  ...EMPTY_BUDGET_USAGE,
  ...overrides,
})

const mission = discoveryMissionSchema.parse({
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
    toolCalls: 4,
    sourceLines: 500,
    modelCalls: 4,
    modelInputTokens: 4_000,
    modelOutputTokens: 1_000,
    elapsedMs: 30_000,
  }),
  successCriteria: ["A cited implementation path is proposed."],
})

const decision = (overrides: Partial<SpecialistDecision> = {}) =>
  ({
    decisionId: "decision_01",
    missionId: mission.id,
    agent: mission.agent,
    stateFingerprint: hash("1"),
    decisionHash: hash("2"),
    kind: "tool_calls",
    callIds: ["call_01"],
    ...overrides,
  }) as SpecialistDecision

const pendingCall = (overrides: Partial<PendingToolCall> = {}) => ({
  callId: "call_01",
  decisionId: "decision_01",
  missionId: mission.id,
  agent: mission.agent,
  toolName: "read_symbol",
  requestHash: hash("3"),
  arguments: { path: "packages/orchestration/src/state.ts", maxLines: 100 },
  preflightUsage: budget({ toolCalls: 1, sourceLines: 100 }),
  ...overrides,
})

const completedCall = (
  overrides: Partial<CompletedToolCall> = {}
): CompletedToolCall =>
  completedToolCallSchema.parse({
    callId: "call_01",
    decisionId: "decision_01",
    missionId: mission.id,
    agent: mission.agent,
    toolName: "read_symbol",
    requestHash: hash("3"),
    resultHash: hash("4"),
    outcome: "succeeded",
    usage: budget({ toolCalls: 1, sourceLines: 20 }),
    ...overrides,
  })

const observation = (
  overrides: Partial<CompactObservation> = {}
): CompactObservation =>
  compactObservationSchema.parse({
    callId: "call_01",
    decisionId: "decision_01",
    missionId: mission.id,
    agent: mission.agent,
    toolName: "read_symbol",
    requestHash: hash("3"),
    resultHash: hash("4"),
    outcome: "succeeded",
    summary: "Located the implementation symbol.",
    evidenceIds: [evidenceId("d")],
    references: [
      {
        kind: "repository_path",
        id: "packages/orchestration/src/state.ts",
      },
    ],
    ...overrides,
  })

const interrupt = (
  overrides: Partial<HumanInterruptState> = {}
): HumanInterruptState =>
  humanInterruptStateSchema.parse({
    decisionId: "decision_02",
    missionId: mission.id,
    agent: mission.agent,
    reasonCode: "scope_confirmation_required",
    question: "Approve inspection outside the current scope?",
    contextFingerprint: hash("5"),
    status: "pending",
    ...overrides,
  })

const modelUsage = (
  decisionId = "decision_01",
  usage = budget({ modelCalls: 1, modelInputTokens: 20 })
): BudgetLedgerEntry => ({
  kind: "model_decision",
  decisionId,
  missionId: mission.id,
  agent: mission.agent,
  usage,
})

const toolUsage = (
  overrides: Partial<Extract<BudgetLedgerEntry, { kind: "tool_call" }>> = {}
): BudgetLedgerEntry => ({
  kind: "tool_call",
  decisionId: "decision_01",
  callId: "call_01",
  missionId: mission.id,
  agent: mission.agent,
  usage: completedCall().usage,
  ...overrides,
})

describe("specialist checkpoint state", () => {
  it("reuses the public mission and result types and exposes LangGraph state", () => {
    const state = createSpecialistInitialState(mission)

    expectTypeOf(state.mission).toEqualTypeOf<DiscoveryMission>()
    expectTypeOf(state.terminalResult).toEqualTypeOf<MissionResult | null>()
    expect(SpecialistState.fields.mission).toBeDefined()
    expect(state).toMatchObject({
      mission,
      agent: "code",
      decisions: [],
      pendingToolCalls: [],
      observations: [],
      completedCalls: [],
      budgetLedger: EMPTY_BUDGET_LEDGER,
      progress: EMPTY_SPECIALIST_PROGRESS,
      humanInterrupt: null,
      terminalResult: null,
    })
  })

  it("accepts the full initial state through a real LangGraph invocation", async () => {
    const graph = new StateGraph(SpecialistState)
      .addNode("noop", () => ({}))
      .addEdge(START, "noop")
      .addEdge("noop", END)
      .compile()

    const result = await graph.invoke(createSpecialistInitialState(mission))

    expect(parseSpecialistState(result)).toMatchObject({
      mission,
      agent: "code",
      progress: EMPTY_SPECIALIST_PROGRESS,
    })
  })

  it("persists exactly the aggregate-validated state across graph nodes", async () => {
    const graph = new StateGraph(SpecialistState)
      .addNode("request", (state) =>
        validateSpecialistUpdate(state, {
          decisions: decision(),
          pendingToolCalls: pendingCall(),
          budgetLedger: modelUsage(),
        })
      )
      .addNode("complete", (state) =>
        validateSpecialistUpdate(state, {
          pendingToolCalls: { upsert: [], removeCallIds: ["call_01"] },
          completedCalls: completedCall(),
          observations: observation(),
          budgetLedger: toolUsage(),
        })
      )
      .addNode("replay", (state) =>
        validateSpecialistUpdate(state, {
          budgetLedger: [modelUsage(), toolUsage()],
        })
      )
      .addEdge(START, "request")
      .addEdge("request", "complete")
      .addEdge("complete", "replay")
      .addEdge("replay", END)
      .compile()

    const result = parseSpecialistState(
      await graph.invoke(createSpecialistInitialState(mission))
    )

    expect(result.pendingToolCalls).toEqual([])
    expect(result.completedCalls).toHaveLength(1)
    expect(result.budgetLedger.entries).toHaveLength(2)
    expect(result.budgetLedger.total).toMatchObject({
      modelCalls: 1,
      modelInputTokens: 20,
      toolCalls: 1,
      sourceLines: 20,
    })
  })

  it("rejects a cross-mission node update before LangGraph can persist it", async () => {
    const otherMissionId = missionIdSchema.parse(`mission:v1:${"9".repeat(64)}`)
    const graph = new StateGraph(SpecialistState)
      .addNode("invalid", (state) =>
        validateSpecialistUpdate(state, {
          decisions: decision({ missionId: otherMissionId }),
          budgetLedger: {
            ...modelUsage(),
            missionId: otherMissionId,
          },
        })
      )
      .addEdge(START, "invalid")
      .addEdge("invalid", END)
      .compile()

    await expect(
      graph.invoke(createSpecialistInitialState(mission))
    ).rejects.toThrow("cross-mission identity")

    const crossAgentGraph = new StateGraph(SpecialistState)
      .addNode("invalid", (state) =>
        validateSpecialistUpdate(state, {
          decisions: decision({ agent: "application" }),
          budgetLedger: { ...modelUsage(), agent: "application" },
        })
      )
      .addEdge(START, "invalid")
      .addEdge("invalid", END)
      .compile()
    await expect(
      crossAgentGraph.invoke(createSpecialistInitialState(mission))
    ).rejects.toThrow("cross-mission identity")
  })

  it("rejects an unsafe node update before LangGraph can persist it", async () => {
    const graph = new StateGraph(SpecialistState)
      .addNode("unsafe", (state) =>
        validateSpecialistUpdate(state, {
          pendingToolCalls: {
            ...pendingCall(),
            arguments: { rawContent: "unbounded source body" },
          },
        })
      )
      .addEdge(START, "unsafe")
      .addEdge("unsafe", END)
      .compile()

    await expect(
      graph.invoke(createSpecialistInitialState(mission))
    ).rejects.toThrow("forbidden field rawContent")
  })

  it("rejects an aggregate oversized node update before checkpointing", async () => {
    const largeMission = discoveryMissionSchema.parse({
      ...mission,
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
    const initial = createSpecialistInitialState(largeMission)
    const callIds = ["call_big_01", "call_big_02", "call_big_03"]
    const largeDecision = decision({
      decisionId: "decision_big",
      decisionHash: hash("6"),
      callIds,
    })
    const calls = callIds.map((callId, index) =>
      pendingCall({
        callId,
        decisionId: "decision_big",
        requestHash: hash(String(index + 6)),
        arguments: {
          queryPartA: `${index}${"x".repeat(3_799)}`,
          queryPartB: `${index}${"y".repeat(3_799)}`,
        },
      })
    )
    const graph = new StateGraph(SpecialistState)
      .addNode("oversized", (state) =>
        validateSpecialistUpdate(state, {
          decisions: largeDecision,
          pendingToolCalls: calls,
          budgetLedger: modelUsage("decision_big"),
        })
      )
      .addEdge(START, "oversized")
      .addEdge("oversized", END)
      .compile()

    await expect(graph.invoke(initial)).rejects.toThrow("exceeds 64 KiB")
  })

  it("deduplicates and orders decisions while failing closed on conflicts", () => {
    const second = decision({
      decisionId: "decision_02",
      decisionHash: hash("6"),
      callIds: ["call_02"],
    })
    const reduced = reduceSpecialistDecisions(
      [],
      [second, decision(), decision()]
    )

    expect(reduced.map((item) => item.decisionId)).toEqual([
      "decision_01",
      "decision_02",
    ])
    expect(() =>
      reduceSpecialistDecisions(reduced, decision({ decisionHash: hash("7") }))
    ).toThrow("Conflicting duplicate decision")
  })

  it("assigns every tool call ID to exactly one decision", () => {
    expect(() =>
      reduceSpecialistDecisions(
        [],
        [
          decision(),
          decision({
            decisionId: "decision_02",
            decisionHash: hash("8"),
            callIds: ["call_01"],
          }),
        ]
      )
    ).toThrow("owned by multiple specialist decisions")
  })

  it("applies replay-safe pending, completed, and observation reducers", () => {
    const pending = reducePendingToolCalls(
      [],
      [
        pendingCall({ callId: "call_02", requestHash: hash("8") }),
        pendingCall(),
        pendingCall(),
      ]
    )
    expect(pending.map((call) => call.callId)).toEqual(["call_01", "call_02"])

    expect(
      reducePendingToolCalls(pending, {
        upsert: [],
        removeCallIds: ["call_01"],
      })
    ).toHaveLength(1)
    expect(() =>
      reducePendingToolCalls(pending, pendingCall({ requestHash: hash("9") }))
    ).toThrow("Conflicting duplicate pending tool call")

    expect(
      reduceCompletedToolCalls([], [completedCall(), completedCall()])
    ).toHaveLength(1)
    expect(
      reduceCompactObservations([], [observation(), observation()])
    ).toHaveLength(1)
  })

  it("derives usage from a replay-idempotent correlated ledger", () => {
    const model = modelUsage()
    const tool = toolUsage()
    const first = reduceBudgetLedger(EMPTY_BUDGET_LEDGER, [model, tool])

    expect(first.total).toMatchObject({
      modelCalls: 1,
      modelInputTokens: 20,
      toolCalls: 1,
      sourceLines: 20,
    })
    expect(reduceBudgetLedger(first, [model, tool])).toEqual(first)
    expect(() =>
      reduceBudgetLedger(
        first,
        modelUsage("decision_01", budget({ modelCalls: 2 }))
      )
    ).toThrow("Conflicting duplicate budget ledger entry")
  })

  it("derives no-progress counters deterministically and ignores replays", () => {
    const later = {
      sequence: 2,
      decisionId: "decision_02",
      fingerprint: hash("b"),
      madeProgress: false,
    }
    const earlier = {
      sequence: 1,
      decisionId: "decision_01",
      fingerprint: hash("a"),
      madeProgress: true,
    }
    const progress = reduceSpecialistProgress(EMPTY_SPECIALIST_PROGRESS, [
      later,
      earlier,
      later,
    ])

    expect(progress).toMatchObject({
      evaluations: [earlier, later],
      fingerprints: [hash("a"), hash("b")],
      steps: 2,
      totalNoProgress: 1,
      consecutiveNoProgress: 1,
      lastDecisionId: "decision_02",
    })
    expect(reduceSpecialistProgress(progress, later)).toEqual(progress)
    expect(() =>
      reduceSpecialistProgress(progress, {
        ...later,
        decisionId: "decision_03",
      })
    ).toThrow("sequence is already assigned")
  })

  it("keeps interrupt resolution durable and rejects conflicting resumes", () => {
    const pending = reduceHumanInterrupt(null, interrupt())
    const resolved = reduceHumanInterrupt(pending, {
      ...interrupt(),
      status: "resolved",
      actorId: "user:reviewer",
      approved: true,
    })

    expect(resolved).toMatchObject({ status: "resolved", approved: true })
    expect(reduceHumanInterrupt(resolved, interrupt())).toEqual(resolved)
    expect(() =>
      reduceHumanInterrupt(resolved, {
        ...interrupt(),
        status: "resolved",
        actorId: "user:other",
        approved: true,
      })
    ).toThrow("resolution conflicts")
  })

  it("allows only an idempotent terminal result or a needs-human transition", () => {
    const needsHuman = missionResultSchema.parse({
      schemaVersion: 1,
      missionId: mission.id,
      status: "needs_human",
      claims: [],
      unresolved: [],
      exclusions: [],
      suggestedFollowups: [],
      stopReason: {
        code: "scope_confirmation_required",
        summary: "Human scope confirmation is required.",
      },
      budgetUsed: EMPTY_BUDGET_USAGE,
    })
    const complete = missionResultSchema.parse({
      ...needsHuman,
      status: "complete",
      stopReason: { code: "mission_complete", summary: "Mission complete." },
    })

    expect(reduceTerminalResult(null, needsHuman)).toEqual(needsHuman)
    expect(reduceTerminalResult(needsHuman, complete)).toEqual(complete)
    expect(() =>
      reduceTerminalResult(complete, { ...complete, status: "partial" })
    ).toThrow("conflicts with durable state")
  })

  it("validates call identity, observation correlation, and terminal evidence", () => {
    const used = budget({
      toolCalls: 1,
      sourceLines: 20,
      modelCalls: 1,
      modelInputTokens: 20,
    })
    const terminal = missionResultSchema.parse({
      schemaVersion: 1,
      missionId: mission.id,
      status: "complete",
      claims: [
        {
          id: `claim:v1:${"e".repeat(64)}`,
          status: "proposed",
          subjectId: `code-symbol:v1:${"f".repeat(64)}`,
          predicate: "implemented_by",
          objectId: `code-symbol:v1:${"1".repeat(64)}`,
          evidenceIds: [evidenceId("d")],
          explanation:
            "The observed implementation path supports this proposal.",
        },
      ],
      unresolved: [],
      exclusions: [],
      suggestedFollowups: [],
      stopReason: { code: "mission_complete", summary: "Mission complete." },
      budgetUsed: used,
    })
    const valid = {
      ...createSpecialistInitialState(mission),
      decisions: reduceSpecialistDecisions([], decision()),
      observations: reduceCompactObservations([], observation()),
      completedCalls: reduceCompletedToolCalls([], completedCall()),
      budgetLedger: reduceBudgetLedger(EMPTY_BUDGET_LEDGER, [
        modelUsage(),
        toolUsage(),
      ]),
      terminalResult: terminal,
    }

    expect(parseSpecialistState(valid).terminalResult).toEqual(terminal)
    expect(() =>
      parseSpecialistState({
        ...valid,
        observations: [observation({ resultHash: hash("9") })],
      })
    ).toThrow("Observation is not correlated")
    expect(() =>
      parseSpecialistState({
        ...valid,
        terminalResult: {
          ...terminal,
          claims: [
            {
              ...terminal.claims[0],
              evidenceIds: [evidenceId("9")],
            },
          ],
        },
      })
    ).toThrow("cites evidence absent")
  })

  it("rejects cross-agent identity and cross-boundary follow-ups", () => {
    expect(() =>
      parseSpecialistState({
        ...createSpecialistInitialState(mission),
        agent: "application",
      })
    ).toThrow("does not match the mission agent")

    const followup = discoveryMissionSchema.parse({
      ...mission,
      id: `mission:v1:${"9".repeat(64)}`,
      agent: "application",
      mode: "workflow_discovery",
    })
    expect(() =>
      parseSpecialistState({
        ...createSpecialistInitialState(mission),
        terminalResult: missionResultSchema.parse({
          schemaVersion: 1,
          missionId: mission.id,
          status: "partial",
          claims: [],
          unresolved: [],
          exclusions: [],
          suggestedFollowups: [followup],
          stopReason: {
            code: "followup_required",
            summary: "Follow-up required.",
          },
          budgetUsed: EMPTY_BUDGET_USAGE,
        }),
      })
    ).toThrow("crosses its run, application, or agent")
  })

  it("forbids raw, authoritative, graph-write, secret, and live values", () => {
    for (const forbidden of [
      { rawContent: "source body" },
      { prompt: "hidden prompt" },
      { reasoning: "hidden reasoning" },
      { authority: "accept" },
      { graphWrite: { node: "claim" } },
      { evidenceTier: "A" },
      { nested: { apiKey: "not-allowed" } },
    ]) {
      expect(() => compactToolArgumentsSchema.parse(forbidden)).toThrow()
    }
    expect(() => assertSafeSpecialistValue({ when: new Date() })).toThrow(
      "live runtime object"
    )
  })

  it("enforces argument and full-checkpoint byte limits", () => {
    expect(() =>
      compactToolArgumentsSchema.parse({ query: "x".repeat(8_193) })
    ).toThrow()

    const oversizedMission = discoveryMissionSchema.parse({
      ...mission,
      goal: "x".repeat(4_096),
      questions: Array.from(
        { length: 20 },
        (_, index) => `${index.toString().padStart(2, "0")}${"q".repeat(4_094)}`
      ),
      successCriteria: Array.from(
        { length: 20 },
        (_, index) => `${index.toString().padStart(2, "0")}${"s".repeat(4_094)}`
      ),
    })

    expect(() => createSpecialistInitialState(oversizedMission)).toThrow(
      "exceeds 64 KiB"
    )
  })
})
