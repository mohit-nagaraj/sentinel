import { MemorySaver } from "@langchain/langgraph"
import { describe, expect, it } from "vitest"

import {
  CancelledOrchestrationError,
  CheckpointStateError,
  ResumeAuthorizationError,
  SanitizedNodeError,
  TransientOrchestrationError,
  type OrchestrationEvent,
  type RuntimeDependencies,
} from "./runtime.ts"
import { InMemoryResumeCoordinator } from "./resume-coordinator.ts"
import {
  SyntheticOrchestrationService,
  buildSyntheticGraph,
  createSyntheticInitialState,
} from "./synthetic.ts"

const runId = "run:11111111-1111-4111-8111-111111111111"
const applicationId =
  "application:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const normalBudget = {
  toolCalls: 2,
  contentBytes: 1_000,
  documentBytes: 1_000,
  documentPages: 1,
  documentSections: 1,
  sourceLines: 100,
  repositoryBytes: 1_000,
  repositoryFiles: 10,
  browserActions: 1,
  modelCalls: 2,
  modelInputTokens: 100,
  modelOutputTokens: 100,
  reconciliationRounds: 1,
  elapsedMs: 10_000,
}

function harness(options?: {
  readonly failTransient?: number
  readonly permanentTransientFailure?: boolean
  readonly authorize?: boolean
  readonly cancelAtCheck?: number
}) {
  const events: OrchestrationEvent[] = []
  const attempts = new Map<string, number>()
  const completed = new Set<string>()
  let remainingTransientFailures = options?.failTransient ?? 0
  let controlChecks = 0
  const dependencies: RuntimeDependencies = {
    owner: "worker-a",
    control: {
      assertActive: async () => {
        controlChecks += 1
        if (controlChecks === options?.cancelAtCheck) {
          throw new CancelledOrchestrationError()
        }
      },
    },
    events: { append: async (event) => void events.push(event) },
    effects: {
      execute: async ({ effectId }) => {
        attempts.set(effectId, (attempts.get(effectId) ?? 0) + 1)
        if (effectId === "transient_branch" && remainingTransientFailures > 0) {
          remainingTransientFailures -= 1
          await new Promise((resolve) => setTimeout(resolve, 10))
          throw new TransientOrchestrationError()
        }
        if (
          effectId === "transient_branch" &&
          options?.permanentTransientFailure
        ) {
          throw new Error("password=checkpoint-leak")
        }
        completed.add(effectId)
      },
    },
    resumeAuthorization: {
      authorize: async () => options?.authorize ?? true,
    },
    resumeCoordinator: new InMemoryResumeCoordinator(),
  }
  return { dependencies, events, attempts, completed }
}

describe("synthetic LangGraph runtime", () => {
  it("runs parallel branches, interrupts, resumes once, and finalizes", async () => {
    const memory = new MemorySaver()
    const test = harness({ failTransient: 1 })
    const graph = buildSyntheticGraph(test.dependencies, memory)
    const service = new SyntheticOrchestrationService(graph, test.dependencies)
    const initial = createSyntheticInitialState({
      runId,
      applicationId,
      budget: normalBudget,
    })

    const paused = await service.start(initial)
    expect(paused.status).toBe("interrupted")
    expect(paused.state.branchResults).toEqual([
      "deterministic_complete",
      "transient_complete",
    ])
    expect(test.attempts.get("deterministic_branch")).toBe(1)
    expect(test.attempts.get("transient_branch")).toBe(2)
    expect(paused.interruptValues).toEqual([
      expect.objectContaining({ decisionId: "synthetic_review" }),
    ])

    const resumeInput = {
      runId,
      actorId: "reviewer-1",
      decisionId: "synthetic_review",
      approved: true,
    } as const
    const [resumed, duplicate] = await Promise.all([
      service.resume(resumeInput),
      service.resume(resumeInput),
    ])
    expect(resumed.status).toBe("completed")
    expect(resumed.state.terminalStatus).toBe("complete")
    expect(test.attempts.get("finalize")).toBe(1)
    expect([resumed.idempotent, duplicate.idempotent].sort()).toEqual([
      false,
      true,
    ])
    expect(test.attempts.get("finalize")).toBe(1)
    expect(test.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["interrupt_requested", "interrupt_resumed"])
    )
    expect(
      test.events.some(
        (event) => event.nodeName === "human_review" && event.kind === "error"
      )
    ).toBe(false)
    expect(
      test.events.filter((event) => event.kind === "node_completed").length
    ).toBeGreaterThan(0)
  })

  it("recovers pending parallel writes with a fresh graph instance", async () => {
    const memory = new MemorySaver()
    const test = harness({ failTransient: 1 })
    const firstGraph = buildSyntheticGraph(test.dependencies, memory, {
      transientMaxAttempts: 1,
    })
    const first = new SyntheticOrchestrationService(
      firstGraph,
      test.dependencies
    )
    await expect(
      first.start(
        createSyntheticInitialState({
          runId,
          applicationId,
          budget: normalBudget,
        })
      )
    ).rejects.toBeInstanceOf(TransientOrchestrationError)
    expect(
      test.events.some(
        (event) =>
          event.nodeName === "deterministic_branch" &&
          event.kind === "node_completed"
      )
    ).toBe(false)

    const restartedGraph = buildSyntheticGraph(test.dependencies, memory, {
      transientMaxAttempts: 1,
    })
    const restarted = new SyntheticOrchestrationService(
      restartedGraph,
      test.dependencies
    )
    const result = await restarted.continue(runId)
    expect(result.status).toBe("interrupted")
    expect(test.attempts.get("deterministic_branch")).toBe(1)
    expect(test.attempts.get("transient_branch")).toBe(2)
    expect(
      test.events.some(
        (event) =>
          event.nodeName === "deterministic_branch" &&
          event.kind === "node_completed"
      )
    ).toBe(true)
  })

  it("rejects unauthorized resumes without final side effects", async () => {
    const memory = new MemorySaver()
    const test = harness({ authorize: false })
    const graph = buildSyntheticGraph(test.dependencies, memory)
    const service = new SyntheticOrchestrationService(graph, test.dependencies)
    await service.start(
      createSyntheticInitialState({
        runId,
        applicationId,
        budget: normalBudget,
      })
    )
    await expect(
      service.resume({
        runId,
        actorId: "untrusted",
        decisionId: "synthetic_review",
        approved: true,
      })
    ).rejects.toBeInstanceOf(ResumeAuthorizationError)
    expect(test.attempts.has("finalize")).toBe(false)
  })

  it("persists a rejected review as a blocked terminal result", async () => {
    const memory = new MemorySaver()
    const test = harness()
    const graph = buildSyntheticGraph(test.dependencies, memory)
    const service = new SyntheticOrchestrationService(graph, test.dependencies)
    await service.start(
      createSyntheticInitialState({
        runId,
        applicationId,
        budget: normalBudget,
      })
    )
    const result = await service.resume({
      runId,
      actorId: "reviewer-1",
      decisionId: "synthetic_review",
      approved: false,
    })
    expect(result.status).toBe("blocked")
    expect(result.state.stopReason).toBe("review_rejected")
    expect(test.attempts.has("finalize")).toBe(false)
  })

  it("returns cancelled before the first node side effect", async () => {
    const memory = new MemorySaver()
    const test = harness({ cancelAtCheck: 1 })
    const graph = buildSyntheticGraph(test.dependencies, memory)
    const service = new SyntheticOrchestrationService(graph, test.dependencies)
    const result = await service.start(
      createSyntheticInitialState({
        runId,
        applicationId,
        budget: normalBudget,
      })
    )
    expect(result.status).toBe("cancelled")
    expect(test.attempts.size).toBe(0)
  })

  it("does not retry permanent node failures", async () => {
    const memory = new MemorySaver()
    const test = harness({ permanentTransientFailure: true })
    const graph = buildSyntheticGraph(test.dependencies, memory, {
      transientMaxAttempts: 3,
    })
    const service = new SyntheticOrchestrationService(graph, test.dependencies)
    await expect(
      service.start(
        createSyntheticInitialState({
          runId,
          applicationId,
          budget: normalBudget,
        })
      )
    ).rejects.toBeInstanceOf(SanitizedNodeError)
    expect(test.attempts.get("transient_branch")).toBe(1)
    const snapshot = await graph.getState({
      configurable: { thread_id: runId },
    })
    expect(JSON.stringify(snapshot)).not.toContain("checkpoint-leak")
  })

  it("supports a seeded partial path from the initialize boundary", async () => {
    const memory = new MemorySaver()
    const test = harness()
    const graph = buildSyntheticGraph(test.dependencies, memory)
    const initial = createSyntheticInitialState({
      runId,
      applicationId,
      budget: normalBudget,
    })
    await graph.updateState(
      { configurable: { thread_id: runId } },
      initial,
      "initialize"
    )
    const service = new SyntheticOrchestrationService(graph, test.dependencies)
    const result = await service.continue(runId)
    expect(result.status).toBe("interrupted")
    expect(test.attempts.get("deterministic_branch")).toBe(1)
    expect(test.attempts.get("transient_branch")).toBe(1)
  })

  it("rejects mismatched checkpoint thread identity and retry limits", async () => {
    const memory = new MemorySaver()
    const test = harness()
    expect(() =>
      buildSyntheticGraph(test.dependencies, memory, {
        transientMaxAttempts: Number.NaN,
      })
    ).toThrow()

    const graph = buildSyntheticGraph(test.dependencies, memory)
    const otherRunId = "run:22222222-2222-4222-8222-222222222222"
    await graph.updateState(
      { configurable: { thread_id: runId } },
      createSyntheticInitialState({
        runId: otherRunId,
        applicationId,
        budget: normalBudget,
      }),
      "initialize"
    )
    const service = new SyntheticOrchestrationService(graph, test.dependencies)
    await expect(service.continue(runId)).rejects.toBeInstanceOf(
      CheckpointStateError
    )
  })

  it("returns a typed terminal result when model/tool budget is exhausted", async () => {
    const memory = new MemorySaver()
    const test = harness()
    const graph = buildSyntheticGraph(test.dependencies, memory)
    const service = new SyntheticOrchestrationService(graph, test.dependencies)
    const result = await service.start(
      createSyntheticInitialState({
        runId,
        applicationId,
        budget: { ...normalBudget, toolCalls: 0, modelCalls: 0 },
      })
    )
    expect(result.status).toBe("budget_exhausted")
    expect(result.state.stopReason).toBe("model_tool_budget_exhausted")
    expect(test.attempts.has("model_tool")).toBe(false)
    expect(test.attempts.has("finalize")).toBe(false)
  })

  it("enforces reconciliation and elapsed budgets as terminal results", async () => {
    const reconciliationMemory = new MemorySaver()
    const reconciliation = harness()
    const reconciliationService = new SyntheticOrchestrationService(
      buildSyntheticGraph(reconciliation.dependencies, reconciliationMemory),
      reconciliation.dependencies
    )
    const reconciliationResult = await reconciliationService.start(
      createSyntheticInitialState({
        runId,
        applicationId,
        budget: { ...normalBudget, reconciliationRounds: 0 },
      })
    )
    expect(reconciliationResult.status).toBe("budget_exhausted")
    expect(reconciliation.attempts.has("model_tool")).toBe(false)

    const elapsedMemory = new MemorySaver()
    const elapsed = harness()
    const elapsedDependencies: RuntimeDependencies = {
      ...elapsed.dependencies,
      now: () => new Date(1_000),
    }
    const elapsedService = new SyntheticOrchestrationService(
      buildSyntheticGraph(elapsedDependencies, elapsedMemory),
      elapsedDependencies
    )
    const elapsedResult = await elapsedService.start(
      createSyntheticInitialState({
        runId,
        applicationId,
        budget: { ...normalBudget, elapsedMs: 0 },
        startedAtMs: 0,
      })
    )
    expect(elapsedResult.status).toBe("budget_exhausted")
    expect(elapsedResult.state.stopReason).toBe("elapsed_budget_exhausted")
    expect(elapsed.attempts.size).toBe(0)
  })

  it("normalizes framework recursion exhaustion into terminal state", async () => {
    const memory = new MemorySaver()
    const test = harness()
    const graph = buildSyntheticGraph(test.dependencies, memory)
    const service = new SyntheticOrchestrationService(
      graph,
      test.dependencies,
      {
        recursionLimit: 2,
      }
    )
    const result = await service.start(
      createSyntheticInitialState({
        runId,
        applicationId,
        budget: normalBudget,
      })
    )
    expect(result.status).toBe("budget_exhausted")
    expect(result.state.stopReason).toBe("recursion_limit")
  })
})
