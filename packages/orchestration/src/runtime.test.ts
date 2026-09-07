import { describe, expect, it, vi } from "vitest"

import {
  DurableRunEventSink,
  projectLangGraphEmission,
} from "./event-projection.ts"
import {
  CancelledOrchestrationError,
  LeaseOwnershipError,
  wrapNode,
  type OrchestrationEvent,
  type RuntimeDependencies,
} from "./runtime.ts"
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
    }
    const node = wrapNode("side_effect", dependencies, async () => {
      await sideEffect()
      return {}
    })

    await expect(node(state)).rejects.toBeInstanceOf(
      CancelledOrchestrationError
    )
    expect(sideEffect).not.toHaveBeenCalled()
    expect(events).toHaveLength(0)
  })

  it("projects typed lifecycle events without hidden details", async () => {
    const persisted: unknown[] = []
    const sink = new DurableRunEventSink(async (event) => {
      persisted.push(event)
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

    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      kind: "tool_started",
      agent: "system",
      toolName: "synthetic_tool",
      sequence: 1,
    })
    expect(JSON.stringify(persisted)).not.toContain("reasoning")
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
    }
    const node = wrapNode(
      "tool_node",
      dependencies,
      async (_state, runtime) => {
        await runtime.checkActive()
        await sideEffect()
        return {}
      }
    )
    await expect(node(state)).rejects.toBeInstanceOf(LeaseOwnershipError)
    expect(sideEffect).not.toHaveBeenCalled()
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
          },
        },
        context
      )
    ).toMatchObject({ kind: "tool_completed", toolName: "synthetic_tool" })
  })
})
