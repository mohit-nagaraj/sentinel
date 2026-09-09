import { describe, expect, it, vi } from "vitest"

import {
  DurableRunEventSink,
  projectLangGraphEmission,
} from "./event-projection.ts"
import { InMemoryResumeCoordinator } from "./resume-coordinator.ts"
import {
  BudgetExhaustedError,
  CancelledOrchestrationError,
  CheckpointStateError,
  LeaseOwnershipError,
  wrapNode,
  type OrchestrationEvent,
  type RuntimeDependencies,
} from "./runtime.ts"
import { parseSyntheticState } from "./state.ts"
import { createSyntheticInitialState } from "./synthetic.ts"

const state = createSyntheticInitialState({
  runId: "run:11111111-1111-4111-8111-111111111111",
  applicationId:
    "application:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  budget: {
    toolCalls: 1,
    contentBytes: 1,
    documentBytes: 1,
    documentPages: 1,
    documentSections: 1,
    sourceLines: 1,
    repositoryBytes: 1,
    repositoryFiles: 1,
    browserActions: 1,
    modelCalls: 1,
    modelInputTokens: 1,
    modelOutputTokens: 1,
    reconciliationRounds: 1,
    elapsedMs: 1_000,
  },
})

describe("orchestration runtime boundaries", () => {
  it("checks cancellation before a node side effect", async () => {
    const sideEffect = vi.fn()
    const events: OrchestrationEvent[] = []
    const dependencies: RuntimeDependencies = {
      owner: "worker-a",
      control: {
        assertActive: async () => {
          throw new CancelledOrchestrationError()
        },
      },
      events: { append: async (event) => void events.push(event) },
      effects: { execute: sideEffect },
      resumeAuthorization: { authorize: async () => true },
      resumeCoordinator: new InMemoryResumeCoordinator(),
    }
    const node = wrapNode(
      "side_effect",
      dependencies,
      parseSyntheticState,
      async () => {
        await sideEffect()
        return {}
      }
    )

    await expect(node(state)).rejects.toBeInstanceOf(
      CancelledOrchestrationError
    )
    expect(sideEffect).not.toHaveBeenCalled()
    expect(events).toEqual([
      expect.objectContaining({
        kind: "error",
        errorCategory: "cancelled",
      }),
    ])
  })

  it("propagates a cooperative pause without recording a node failure", async () => {
    const events: OrchestrationEvent[] = []
    const sideEffect = vi.fn()
    const pause = new Error("Pause requested by worker control")
    pause.name = "PauseRequestedOrchestrationError"
    const dependencies: RuntimeDependencies = {
      owner: "worker-a",
      control: {
        assertActive: async () => {
          throw pause
        },
      },
      events: { append: async (event) => void events.push(event) },
      effects: { execute: sideEffect },
      resumeAuthorization: { authorize: async () => true },
      resumeCoordinator: new InMemoryResumeCoordinator(),
    }
    const node = wrapNode(
      "pause_boundary",
      dependencies,
      parseSyntheticState,
      async () => {
        await sideEffect()
        return {}
      }
    )
    await expect(node(state)).rejects.toBe(pause)
    expect(sideEffect).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it("projects typed lifecycle events without hidden details", async () => {
    const persisted: unknown[] = []
    const idempotencyKeys: (string | undefined)[] = []
    const sink = new DurableRunEventSink(async (event, idempotencyKey) => {
      persisted.push(event)
      idempotencyKeys.push(idempotencyKey)
    })
    await sink.append({
      runId: state.runId,
      graphName: state.graphName,
      nodeName: "model_tool",
      toolName: "synthetic_tool",
      kind: "tool_started",
      status: "started",
      summary: "Tool execution started",
      reasonCode: "tool_started",
      occurredAt: "2026-09-07T00:00:00.000Z",
    })
    const missionId = `mission:v1:${"c".repeat(64)}`
    const idempotencyKey = `sha256:${"d".repeat(64)}`
    await sink.append(
      {
        runId: state.runId,
        graphName: state.graphName,
        nodeName: "specialist_prepare",
        agent: "code",
        missionId,
        kind: "mission_started",
        status: "started",
        summary: "Specialist mission started",
        reasonCode: "mission_started",
        occurredAt: "2026-09-07T00:00:01.000Z",
      },
      { idempotencyKey }
    )
    await sink.append({
      runId: state.runId,
      graphName: state.graphName,
      nodeName: "specialist_model_decision",
      agent: "code",
      missionId,
      kind: "budget_updated",
      status: "completed",
      summary: "Specialist model budget updated",
      reasonCode: "model_budget_updated",
      evidenceIds: [],
      budget: { consumed: 1, limit: 4, unit: "model_calls" },
      activity: {
        category: "decision",
        coverageDelta: 1,
      },
      occurredAt: "2026-09-07T00:00:02.000Z",
    })

    expect(persisted).toHaveLength(3)
    expect(persisted[0]).toMatchObject({
      kind: "tool_started",
      agent: "system",
      toolName: "synthetic_tool",
      sequence: 1,
    })
    expect(persisted[1]).toMatchObject({
      kind: "mission_started",
      agent: "code",
      missionId,
      sequence: 2,
    })
    expect(persisted[2]).toMatchObject({
      activity: {
        category: "decision",
        coverageDelta: 1,
      },
    })
    expect(persisted[2]).toMatchObject({
      kind: "budget_updated",
      budget: { consumed: 1, limit: 4, unit: "model_calls" },
      sequence: 3,
    })
    expect(JSON.stringify(persisted)).not.toContain("reasoning")
    expect(idempotencyKeys).toContain(idempotencyKey)
  })

  it("gives unkeyed durable events restart-safe unique append keys", async () => {
    const keys: string[] = []
    const event: OrchestrationEvent = {
      runId: state.runId,
      graphName: state.graphName,
      nodeName: "model_tool",
      kind: "node_started",
      status: "started",
      summary: "Model tool started",
      reasonCode: "node_started",
      occurredAt: "2026-09-07T00:00:00.000Z",
    }
    for (const sink of [
      new DurableRunEventSink(async (_event, idempotencyKey) => {
        keys.push(idempotencyKey)
      }),
      new DurableRunEventSink(async (_event, idempotencyKey) => {
        keys.push(idempotencyKey)
      }),
    ]) {
      await sink.append(event)
    }

    expect(keys).toHaveLength(2)
    expect(keys[0]).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(keys[1]).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(keys[0]).not.toBe(keys[1])
  })

  it("rechecks lease ownership immediately before a side effect", async () => {
    let checks = 0
    const sideEffect = vi.fn()
    const dependencies: RuntimeDependencies = {
      owner: "worker-a",
      control: {
        assertActive: async () => {
          checks += 1
          if (checks === 2) throw new LeaseOwnershipError()
        },
      },
      events: { append: async () => undefined },
      effects: { execute: sideEffect },
      resumeAuthorization: { authorize: async () => true },
      resumeCoordinator: new InMemoryResumeCoordinator(),
    }
    const node = wrapNode(
      "tool_node",
      dependencies,
      parseSyntheticState,
      async (_state, runtime) => {
        await runtime.checkActive()
        await sideEffect()
        return {}
      }
    )
    await expect(node(state)).rejects.toBeInstanceOf(LeaseOwnershipError)
    expect(sideEffect).not.toHaveBeenCalled()
  })

  it("rechecks ownership after the handler before committing its update", async () => {
    let checks = 0
    const sideEffect = vi.fn()
    const events: OrchestrationEvent[] = []
    const dependencies: RuntimeDependencies = {
      owner: "worker-a",
      control: {
        assertActive: async () => {
          checks += 1
          if (checks === 2) throw new LeaseOwnershipError()
        },
      },
      events: { append: async (event) => void events.push(event) },
      effects: { execute: sideEffect },
      resumeAuthorization: { authorize: async () => true },
      resumeCoordinator: new InMemoryResumeCoordinator(),
    }
    const node = wrapNode(
      "long_node",
      dependencies,
      parseSyntheticState,
      async () => {
        await sideEffect()
        return { terminalStatus: "complete" }
      }
    )
    await expect(node(state)).rejects.toBeInstanceOf(LeaseOwnershipError)
    expect(sideEffect).toHaveBeenCalledOnce()
    expect(events.some((event) => event.kind === "node_completed")).toBe(false)
  })

  it("supports specialist state validators without synthetic-state coupling", async () => {
    const dependencies: RuntimeDependencies = {
      owner: "worker-a",
      control: { assertActive: async () => undefined },
      events: { append: async () => undefined },
      effects: { execute: async () => undefined },
      resumeAuthorization: { authorize: async () => true },
      resumeCoordinator: new InMemoryResumeCoordinator(),
    }
    const parseSpecialist = (input: unknown) => {
      const value = input as typeof state & { readonly missionId: string }
      if (typeof value.missionId !== "string") throw new Error("invalid")
      return value
    }
    const node = wrapNode(
      "specialist_node",
      dependencies,
      parseSpecialist,
      (specialistState) => ({ missionId: specialistState.missionId })
    )
    await expect(
      node({ ...state, missionId: "mission-reference" })
    ).resolves.toEqual({ missionId: "mission-reference" })
  })

  it("validates resolved runtime metadata and fixes specialist event identity", async () => {
    const events: OrchestrationEvent[] = []
    const dependencies: RuntimeDependencies = {
      owner: "worker-a",
      control: { assertActive: async () => undefined },
      events: { append: async (event) => void events.push(event) },
      effects: { execute: async () => undefined },
      resumeAuthorization: { authorize: async () => true },
      resumeCoordinator: new InMemoryResumeCoordinator(),
      now: () => new Date("2026-09-08T00:00:00.000Z"),
    }
    const missionId = `mission:v1:${"c".repeat(64)}`
    const specialistState = {
      mission: { id: missionId, runId: state.runId },
      kernel: {
        graphName: "code_specialist",
        startedAtMs: Date.parse("2026-09-08T00:00:00.000Z"),
      },
    }
    const node = wrapNode(
      "specialist_node",
      dependencies,
      (input) => input as typeof specialistState,
      async (_specialist, runtime) => {
        await runtime.emit({
          kind: "warning",
          status: "warning",
          summary: "Specialist warning",
          reasonCode: "specialist_warning",
          agent: "application",
          missionId: `mission:v1:${"d".repeat(64)}`,
        })
        return {}
      },
      {
        runtimeState: (specialist) => ({
          runId: specialist.mission.runId,
          graphName: specialist.kernel.graphName,
          startedAtMs: specialist.kernel.startedAtMs,
          budget: { elapsedMs: 1_000 },
        }),
        eventContext: () => ({ agent: "code", missionId }),
      }
    )

    await expect(node(specialistState)).resolves.toEqual({})
    expect(events.at(-1)).toMatchObject({ agent: "code", missionId })

    const invalid = wrapNode(
      "invalid_specialist",
      dependencies,
      (input) => input as typeof specialistState,
      async () => ({}),
      {
        runtimeState: (specialist) => ({
          runId: specialist.mission.runId,
          graphName: specialist.kernel.graphName,
          startedAtMs: -1,
          budget: { elapsedMs: 1_000 },
        }),
      }
    )
    await expect(invalid(specialistState)).rejects.toBeInstanceOf(
      CheckpointStateError
    )
  })

  it("actively aborts a handler when its remaining elapsed budget expires", async () => {
    let aborted = false
    const dependencies: RuntimeDependencies = {
      owner: "worker-a",
      control: { assertActive: async () => undefined },
      events: { append: async () => undefined },
      effects: { execute: async () => undefined },
      resumeAuthorization: { authorize: async () => true },
      resumeCoordinator: new InMemoryResumeCoordinator(),
    }
    const timedState = createSyntheticInitialState({
      runId: state.runId,
      applicationId: state.applicationId,
      budget: { ...state.budget, elapsedMs: 100 },
      startedAtMs: Date.now(),
    })
    const node = wrapNode(
      "timed_node",
      dependencies,
      parseSyntheticState,
      async (_state, runtime) =>
        new Promise<never>(() => {
          runtime.signal.addEventListener("abort", () => {
            aborted = true
          })
        })
    )
    await expect(node(timedState)).rejects.toBeInstanceOf(BudgetExhaustedError)
    expect(aborted).toBe(true)
  })

  it("bridges worker cancellation into active tool signals", async () => {
    const execution = new AbortController()
    let toolSignalAborted = false
    const dependencies: RuntimeDependencies = {
      owner: "worker-a",
      control: { assertActive: async () => undefined },
      events: { append: async () => undefined },
      effects: { execute: async () => undefined },
      resumeAuthorization: { authorize: async () => true },
      resumeCoordinator: new InMemoryResumeCoordinator(),
      executionSignal: execution.signal,
    }
    const node = wrapNode(
      "cancelled_tool_node",
      dependencies,
      parseSyntheticState,
      async (_state, runtime) =>
        new Promise<never>((_resolve, reject) => {
          runtime.signal.addEventListener(
            "abort",
            () => {
              toolSignalAborted = true
              reject(runtime.signal.reason)
            },
            { once: true }
          )
          execution.abort(new CancelledOrchestrationError())
        })
    )
    await expect(node(state)).rejects.toBeInstanceOf(
      CancelledOrchestrationError
    )
    expect(toolSignalAborted).toBe(true)
  })

  it("chunks elapsed deadlines above Node's maximum timer delay", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout")
    const dependencies: RuntimeDependencies = {
      owner: "worker-a",
      control: { assertActive: async () => undefined },
      events: { append: async () => undefined },
      effects: { execute: async () => undefined },
      resumeAuthorization: { authorize: async () => true },
      resumeCoordinator: new InMemoryResumeCoordinator(),
    }
    const longState = createSyntheticInitialState({
      runId: state.runId,
      applicationId: state.applicationId,
      budget: { ...state.budget, elapsedMs: 3_000_000_000 },
      startedAtMs: Date.now(),
    })
    try {
      const node = wrapNode(
        "long_budget_node",
        dependencies,
        parseSyntheticState,
        async () => ({})
      )
      await expect(node(longState)).resolves.toEqual({})
      expect(timer.mock.calls.some((call) => call[1] === 2_147_483_647)).toBe(
        true
      )
    } finally {
      timer.mockRestore()
    }
  })

  it("projects updates and custom emissions without checkpoint payloads", () => {
    const context = {
      runId: state.runId,
      graphName: state.graphName,
      occurredAt: "2026-09-07T00:00:00.000Z",
    }
    expect(
      projectLangGraphEmission(
        { mode: "updates", data: { model_tool: { rawDocument: "omitted" } } },
        context
      )
    ).toMatchObject({
      kind: "node_completed",
      nodeName: "model_tool",
      summary: "LangGraph state update committed",
    })
    expect(
      projectLangGraphEmission(
        {
          mode: "custom",
          data: {
            nodeName: "model_tool",
            toolName: "synthetic_tool",
            phase: "completed",
            activity: {
              category: "tool",
              detail: "Symbol lookup completed",
            },
          },
        },
        context
      )
    ).toMatchObject({
      kind: "tool_completed",
      toolName: "synthetic_tool",
      activity: { category: "tool" },
    })
  })
})
