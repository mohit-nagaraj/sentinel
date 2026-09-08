import { runTypeSchema, type MissionBudget } from "@sentinel/contracts"
import { describe, expect, it, vi } from "vitest"

import { TransientOrchestrationError } from "./runtime.ts"
import {
  classifyRunExecutionError,
  createRunDispatcher,
  createRunGraphRegistry,
  RunDispatchError,
  type CompiledRunGraph,
  type RunExecutionContext,
} from "./run-dispatch.ts"

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
function graph(): CompiledRunGraph {
  return {
    hasCheckpoint: vi.fn().mockResolvedValue(false),
    hasPendingInterrupt: vi.fn().mockResolvedValue(false),
    start: vi.fn().mockResolvedValue({ status: "cancelled" }),
    continue: vi.fn().mockResolvedValue({ status: "cancelled" }),
    resume: vi.fn().mockResolvedValue({ status: "cancelled" }),
  }
}

function registry() {
  return createRunGraphRegistry({
    inspect_application: graph(),
    initialize_knowledge: graph(),
    assess_pr: graph(),
    verify_pr: graph(),
    refresh_knowledge: graph(),
    run_eval: graph(),
  })
}

const context: RunExecutionContext = {
  signal: new AbortController().signal,
  assertActive: vi.fn().mockResolvedValue(undefined),
  registerCleanup: vi.fn(),
}

describe("run graph dispatcher", () => {
  it("requires and maps all six graph entry points", async () => {
    const handlers = registry()
    expect(Object.keys(handlers).sort()).toEqual(
      [...runTypeSchema.options].sort()
    )
    const dispatcher = createRunDispatcher(handlers)
    for (const runType of runTypeSchema.options) {
      const payload =
        runType === "assess_pr"
          ? {
              pullRequestNumber: 1,
              baseSha: "a".repeat(40),
              headSha: "b".repeat(40),
            }
          : runType === "verify_pr"
            ? { assessmentId: "22222222-2222-4222-8222-222222222222" }
            : runType === "run_eval"
              ? { fixtureKey: "smoke" }
              : {}
      await dispatcher.execute(
        {
          id: "11111111-1111-4111-8111-111111111111",
          applicationId: "22222222-2222-4222-8222-222222222222",
          runType,
          budget,
          request: payload,
          configurationFingerprint: `sha256:${"a".repeat(64)}`,
          attemptCount: 1,
        },
        null,
        context
      )
      expect(handlers[runType].start).toHaveBeenCalledOnce()
    }
  })

  it("selects checkpoint continuation and one-time human resume", async () => {
    const handlers = registry()
    const dispatcher = createRunDispatcher(handlers)
    const run = {
      id: "11111111-1111-4111-8111-111111111111",
      applicationId: "22222222-2222-4222-8222-222222222222",
      runType: "initialize_knowledge" as const,
      budget,
      request: {},
      configurationFingerprint: `sha256:${"a".repeat(64)}`,
      attemptCount: 2,
    }
    await dispatcher.execute(run, null, context)
    expect(handlers.initialize_knowledge.start).toHaveBeenCalledOnce()
    vi.mocked(handlers.initialize_knowledge.hasCheckpoint).mockResolvedValue(
      true
    )
    await dispatcher.execute(run, null, context)
    vi.mocked(
      handlers.initialize_knowledge.hasPendingInterrupt
    ).mockResolvedValue(true)
    await dispatcher.execute(
      run,
      { decisionId: "approve_scope", response: { approved: true } },
      context
    )
    expect(handlers.initialize_knowledge.continue).toHaveBeenCalledOnce()
    expect(handlers.initialize_knowledge.resume).toHaveBeenCalledOnce()
    vi.mocked(
      handlers.initialize_knowledge.hasPendingInterrupt
    ).mockResolvedValue(false)
    await dispatcher.execute(
      run,
      { decisionId: "approve_scope", response: { approved: true } },
      context
    )
    expect(handlers.initialize_knowledge.continue).toHaveBeenCalledTimes(2)
    expect(handlers.initialize_knowledge.resume).toHaveBeenCalledOnce()
  })

  it("rejects malformed persisted work and classifies errors without details", async () => {
    const dispatcher = createRunDispatcher(registry())
    await expect(
      dispatcher.execute(
        {
          id: "11111111-1111-4111-8111-111111111111",
          applicationId: "22222222-2222-4222-8222-222222222222",
          runType: "run_eval",
          budget,
          request: { token: "private" },
          configurationFingerprint: `sha256:${"a".repeat(64)}`,
          attemptCount: 1,
        },
        null,
        context
      )
    ).rejects.toThrow()
    expect(
      classifyRunExecutionError(new TransientOrchestrationError())
    ).toEqual(new RunDispatchError("provider", "transient_failure", true))
    const unknown = classifyRunExecutionError(new Error("Bearer private"))
    expect(unknown.message).toBe("unhandled_failure")
    expect(unknown.message).not.toContain("private")
    expect(
      () =>
        new RunDispatchError("provider", "Authorization: Bearer private", true)
    ).toThrow()
  })
})
