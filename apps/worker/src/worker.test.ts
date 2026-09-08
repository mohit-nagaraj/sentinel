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
  configurationFingerprint: `sha256:${"a".repeat(64)}`,
  attemptCount: 1,
}

function harness(input: {
  result?: "succeeded" | "interrupted" | "cancelled"
  failure?: unknown
  states?: ("active" | "cancelled" | "lease_lost")[]
  resume?: { decisionId: string; response: { approved: boolean } } | null
  cleanup?: () => Promise<void>
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
        await input.cleanup?.()
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
        : input.result === "cancelled"
          ? { status: "cancelled" as const }
          : {
              status: "succeeded" as const,
              publication: {
                kind: "knowledge" as const,
                inputFingerprint: `sha256:${"a".repeat(64)}`,
                expectedGraphRevision: 0,
                indexedCommitSha: "a".repeat(40),
              },
            }
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
    expect(test.store.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        publication: expect.objectContaining({ kind: "knowledge" }),
      })
    )
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

  it("retries and reports cleanup failure instead of clean cancellation", async () => {
    let cleanupAttempts = 0
    const test = harness({
      states: ["active", "cancelled"],
      cleanup: async () => {
        cleanupAttempts += 1
        throw new Error("browser cleanup contained private details")
      },
    })
    await createWorker({
      owner: "worker-a",
      store: test.store,
      dispatcher: test.dispatcher,
      monitorIntervalMs: 2,
    }).runOnce()
    expect(cleanupAttempts).toBe(3)
    expect(test.store.finish).toHaveBeenCalledWith({
      runId: run.id,
      owner: "worker-a",
      status: "failed",
      errorCategory: "storage",
      errorCode: "cleanup_failed",
      retryable: false,
    })
    expect(
      JSON.stringify(vi.mocked(test.store.finish).mock.calls)
    ).not.toContain("private details")
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

  it("does not start newly claimed work when shutdown wins the claim race", async () => {
    const test = harness({ result: "succeeded" })
    let releaseClaim: ((value: typeof run) => void) | undefined
    vi.mocked(test.store.claim).mockImplementation(
      async () =>
        new Promise<typeof run>((resolve) => {
          releaseClaim = resolve
        })
    )
    const controller = new AbortController()
    const pending = createWorker({
      owner: "worker-a",
      store: test.store,
      dispatcher: test.dispatcher,
    }).runOnce(controller.signal)
    controller.abort()
    while (releaseClaim === undefined) await Promise.resolve()
    releaseClaim(run)
    await expect(pending).resolves.toBe(true)
    expect(test.dispatcher.execute).not.toHaveBeenCalled()
    expect(test.store.finish).not.toHaveBeenCalled()
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

  it("keeps the lease alive through cleanup and aborts on monitor errors", async () => {
    let heartbeatCount = () => 0
    const target = harness({
      cleanup: async () => {
        while (heartbeatCount() === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
      },
    })
    heartbeatCount = () => vi.mocked(target.store.heartbeat).mock.calls.length
    await createWorker({
      owner: "worker-a",
      store: target.store,
      dispatcher: target.dispatcher,
      heartbeatIntervalMs: 2,
      monitorIntervalMs: 1,
    }).runOnce()
    expect(target.calls).toEqual(["cleanup", "finish:succeeded"])

    const broken = harness({ states: ["active", "active"] })
    vi.mocked(broken.store.controlState)
      .mockResolvedValueOnce("active")
      .mockRejectedValueOnce(new Error("database offline"))
    await createWorker({
      owner: "worker-a",
      store: broken.store,
      dispatcher: broken.dispatcher,
      monitorIntervalMs: 1,
    }).runOnce()
    expect(broken.calls).toEqual(["cleanup"])
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

  it("leaves control-store read failures available for lease reclaim", async () => {
    const test = harness({ result: "succeeded" })
    vi.mocked(test.store.getResumeDecision).mockRejectedValue(
      Object.assign(new Error("storage_unavailable"), {
        name: "RunControlRepositoryError",
        code: "storage_unavailable",
      })
    )
    await createWorker({
      owner: "worker-a",
      store: test.store,
      dispatcher: test.dispatcher,
    }).runOnce()
    expect(test.dispatcher.execute).not.toHaveBeenCalled()
    expect(test.store.finish).not.toHaveBeenCalled()
  })

  it("terminates a stale publication as a non-retryable failure", async () => {
    const test = harness({ result: "succeeded" })
    vi.mocked(test.store.finish)
      .mockRejectedValueOnce(
        Object.assign(new Error("publication_conflict"), {
          name: "RunControlRepositoryError",
          code: "publication_conflict",
        })
      )
      .mockResolvedValueOnce(true)
    await createWorker({
      owner: "worker-a",
      store: test.store,
      dispatcher: test.dispatcher,
    }).runOnce()
    expect(test.store.finish).toHaveBeenLastCalledWith({
      runId: run.id,
      owner: "worker-a",
      status: "failed",
      errorCategory: "configuration",
      errorCode: "publication_conflict",
      retryable: false,
    })
  })
})
