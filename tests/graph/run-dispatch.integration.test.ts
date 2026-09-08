import {
  InMemoryResumeCoordinator,
  MemorySaver,
  SyntheticOrchestrationService,
  buildSyntheticGraph,
  createSyntheticInitialState,
  pendingReviewSchema,
  type RuntimeDependencies,
  type SyntheticRunResult,
} from "@sentinel/orchestration"
import {
  createRunDispatcher,
  createRunGraphRegistry,
  RunDispatchError,
  type CompiledRunGraph,
  type GraphExecutionResult,
  type RunExecutionContext,
} from "@sentinel/orchestration/run-dispatch"
import { describe, expect, it } from "vitest"

const applicationId = "22222222-2222-4222-8222-222222222222"
const stableApplicationId =
  "application:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const budget = {
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

function mapResult(result: SyntheticRunResult): GraphExecutionResult {
  if (result.status === "completed") return { status: "succeeded" }
  if (result.status === "cancelled") return { status: "cancelled" }
  if (result.status === "interrupted") {
    const pending = pendingReviewSchema.parse(result.interruptValues[0])
    return {
      status: "interrupted",
      decisionId: pending.decisionId,
      prompt: pending.question,
    }
  }
  throw new RunDispatchError("unknown", "synthetic_terminal_failure", false)
}

function syntheticAdapter(): CompiledRunGraph {
  let activeContext: RunExecutionContext | undefined
  const dependencies: RuntimeDependencies = {
    owner: "worker-graph-test",
    control: {
      assertActive: async () => activeContext?.assertActive(),
    },
    events: { append: async () => undefined },
    effects: { execute: async () => undefined },
    resumeAuthorization: { authorize: async () => true },
    resumeCoordinator: new InMemoryResumeCoordinator(),
  }
  const service = new SyntheticOrchestrationService(
    buildSyntheticGraph(dependencies, new MemorySaver()),
    dependencies
  )
  return {
    start: async (input, context) => {
      activeContext = context
      return mapResult(
        await service.start(
          createSyntheticInitialState({
            runId: `run:${input.runId}`,
            applicationId: stableApplicationId,
            budget: input.budget,
          })
        )
      )
    },
    continue: async (input, context) => {
      activeContext = context
      return mapResult(await service.continue(`run:${input.runId}`))
    },
    resume: async (input, decision, context) => {
      activeContext = context
      return mapResult(
        await service.resume({
          runId: `run:${input.runId}`,
          actorId: "operator-graph-test",
          decisionId: decision.decisionId,
          approved: decision.response.approved,
        })
      )
    },
  }
}

describe("run dispatcher with LangGraph checkpoint execution", () => {
  it("starts, interrupts, and resumes the same durable thread", async () => {
    const graph = syntheticAdapter()
    const dispatcher = createRunDispatcher(
      createRunGraphRegistry({
        inspect_application: graph,
        initialize_knowledge: graph,
        assess_pr: graph,
        verify_pr: graph,
        refresh_knowledge: graph,
        run_eval: graph,
      })
    )
    const context: RunExecutionContext = {
      signal: new AbortController().signal,
      assertActive: async () => undefined,
      registerCleanup: () => undefined,
    }
    const run = {
      id: "11111111-1111-4111-8111-111111111111",
      applicationId,
      runType: "initialize_knowledge" as const,
      budget,
      request: {},
      attemptCount: 1,
    }

    await expect(dispatcher.execute(run, null, context)).resolves.toEqual({
      status: "interrupted",
      decisionId: "synthetic_review",
      prompt: "Approve the synthetic workflow finalizer?",
    })
    await expect(
      dispatcher.execute(
        { ...run, attemptCount: 2 },
        {
          decisionId: "synthetic_review",
          response: { approved: true },
        },
        context
      )
    ).resolves.toEqual({ status: "succeeded" })
  })
})
