import { type MissionBudget } from "@sentinel/contracts"
import {
  RunDispatchError,
  type RunDispatcher,
} from "@sentinel/orchestration/run-dispatch"
import { describe, expect, it, vi } from "vitest"

import { createWorker, type WorkerRunStore } from "./worker.ts"

const budget: MissionBudget = {
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
  elapsedMs: 1,
}
const run = {
  id: "11111111-1111-4111-8111-111111111111",
  applicationId: "22222222-2222-4222-8222-222222222222",
  runType: "initialize_knowledge" as const,
  budget,
  request: {},
  attemptCount: 1,
}

function harness(input: {
  result?: "succeeded" | "interrupted" | "cancelled"
  failure?: unknown
  states?: ("active" | "cancelled" | "lease_lost")[]
  resume?: { decisionId: string; response: { approved: boolean } } | null
}) {
  const calls: string[] = []
  const states = [...(input.states ?? ["active"])]
  const store: WorkerRunStore = {
    claim: vi.fn().mockResolvedValue(run),
    heartbeat: vi.fn().mockResolvedValue(true),
    controlState: vi
      .fn()
      .mockImplementation(async () => states.shift() ?? "active"),
    getResumeDecision: vi.fn().mockResolvedValue(input.resume ?? null),
    recordInterrupt: vi
      .fn()
      .mockImplementation(async () => calls.push("interrupt")),
    finish: vi.fn().mockImplementation(async ({ status }) => {
      calls.push(`finish:${status}`)
      return true
    }),
  }
  const dispatcher: RunDispatcher = {
    execute: vi.fn().mockImplementation(async (_run, _decision, context) => {
      context.registerCleanup(async () => {
        calls.push("cleanup")
      })
      if (input.failure !== undefined) throw input.failure
      if ((input.states?.length ?? 0) > 1) {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), {
            once: true,
          })
        })
        return { status: "cancelled" as const }
      }
      return input.result === "interrupted"
        ? {
            status: "interrupted" as const,
            decisionId: "approve_scope",
            prompt: "Approve the proposed scope?",
          }
        : { status: input.result ?? "succeeded" }
    }),
  }
  return { store, dispatcher, calls }
}

describe("leased worker", () => {
  it("runs cleanup before terminal completion", async () => {
    const test = harness({ result: "succeeded" })
    const worker = createWorker({
      owner: "worker-a",
      store: test.store,
      dispatcher: test.dispatcher,
      monitorIntervalMs: 5,
    })
    await expect(worker.runOnce()).resolves.toBe(true)
    expect(test.calls).toEqual(["cleanup", "finish:succeeded"])
    expect(worker.health()).toEqual({ service: "worker", status: "ok" })
  })

  it("publishes interrupts after cleanup and forwards stored decisions", async () => {
    const paused = harness({ result: "interrupted" })
    await createWorker({
      owner: "worker-a",
      store: paused.store,
      dispatcher: paused.dispatcher,
    }).runOnce()
    expect(paused.calls).toEqual(["cleanup", "interrupt"])

    const decision = {
      decisionId: "approve_scope",
      response: { approved: true },
    }
    const resumed = harness({ resume: decision })
    await createWorker({
      owner: "worker-a",
      store: resumed.store,
      dispatcher: resumed.dispatcher,
    }).runOnce()
    expect(resumed.dispatcher.execute).toHaveBeenCalledWith(
      run,
      decision,
      expect.any(Object)
    )
  })

  it("cooperatively cancels and waits for cleanup", async () => {
    const test = harness({ states: ["active", "cancelled"] })
    await createWorker({
      owner: "worker-a",
      store: test.store,
      dispatcher: test.dispatcher,
      monitorIntervalMs: 2,
    }).runOnce()
    expect(test.calls).toEqual(["cleanup", "finish:cancelled"])
  })

  it("leaves lease loss and shutdown non-terminal for safe reclaim", async () => {
    const lost = harness({ states: ["active", "lease_lost"] })
    await createWorker({
      owner: "worker-a",
      store: lost.store,
      dispatcher: lost.dispatcher,
      monitorIntervalMs: 2,
    }).runOnce()
    expect(lost.calls).toEqual(["cleanup"])

    const shutdown = harness({ states: ["active", "active"] })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 2)
    await createWorker({
      owner: "worker-a",
      store: shutdown.store,
      dispatcher: shutdown.dispatcher,
      monitorIntervalMs: 20,
    }).runOnce(controller.signal)
    expect(shutdown.calls).toEqual(["cleanup"])
  })

  it("renews leases and aborts work when a heartbeat loses ownership", async () => {
    const test = harness({ states: ["active", "active"] })
    vi.mocked(test.store.heartbeat).mockResolvedValue(false)
    await createWorker({
      owner: "worker-a",
      store: test.store,
      dispatcher: test.dispatcher,
      heartbeatIntervalMs: 2,
      monitorIntervalMs: 1,
    }).runOnce()
    expect(test.store.heartbeat).toHaveBeenCalled()
    expect(test.calls).toEqual(["cleanup"])
  })

  it("persists only classified failure fields", async () => {
    const test = harness({
      failure: new RunDispatchError("provider", "provider_timeout", true),
    })
    await createWorker({
      owner: "worker-a",
      store: test.store,
      dispatcher: test.dispatcher,
    }).runOnce()
    expect(test.store.finish).toHaveBeenCalledWith({
      runId: run.id,
      owner: "worker-a",
      status: "failed",
      errorCategory: "provider",
      errorCode: "provider_timeout",
      retryable: true,
    })
  })
})
