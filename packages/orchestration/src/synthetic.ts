import {
  applicationIdSchema,
  executionBudgetSchema,
  reasonCodeSchema,
  runIdSchema,
  type MissionBudget,
} from "@sentinel/contracts"
import {
  Command,
  END,
  GraphRecursionError,
  INTERRUPT,
  START,
  StateGraph,
  interrupt,
  isInterrupted,
  type BaseCheckpointSaver,
} from "@langchain/langgraph"
import { z } from "zod"

import {
  CancelledOrchestrationError,
  LeaseOwnershipError,
  ResumeAuthorizationError,
  emitInterruptEvent,
  transientRetryPolicy,
  wrapNode,
  type RuntimeDependencies,
} from "./runtime.ts"
import {
  SyntheticState,
  isBudgetAvailable,
  pendingReviewSchema,
  parseSyntheticState,
  type SyntheticStateValue,
} from "./state.ts"

const resumeInputSchema = z.strictObject({
  runId: runIdSchema,
  decisionId: reasonCodeSchema,
  actorId: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9:._-]+$/),
  approved: z.boolean(),
})

export interface SyntheticGraphOptions {
  readonly transientMaxAttempts?: number
  readonly recursionLimit?: number
}

export function createSyntheticInitialState(input: {
  readonly runId: string
  readonly applicationId: string
  readonly budget: MissionBudget
}): SyntheticStateValue {
  return parseSyntheticState({
    runId: runIdSchema.parse(input.runId),
    applicationId: applicationIdSchema.parse(input.applicationId),
    graphName: "synthetic_foundation",
    budget: executionBudgetSchema.parse(input.budget),
    toolCallsUsed: 0,
    modelCallsUsed: 0,
    reconciliationRoundsUsed: 0,
    steps: 0,
    branchResults: [],
    effectIds: [],
    pendingReview: null,
    resumeDecisionId: null,
    resumeActorId: null,
    approved: null,
    terminalStatus: "partial",
    stopReason: null,
  })
}

export function buildSyntheticGraph(
  dependencies: RuntimeDependencies,
  checkpointer: BaseCheckpointSaver,
  options: SyntheticGraphOptions = {}
) {
  const initialize = wrapNode("initialize", dependencies, () => ({}))
  const deterministicBranch = wrapNode(
    "deterministic_branch",
    dependencies,
    async (state, runtime) => {
      await runtime.checkActive()
      await dependencies.effects.execute({
        runId: state.runId,
        effectId: "deterministic_branch",
      })
      return {
        branchResults: "deterministic_complete",
        effectIds: "deterministic_branch",
      }
    }
  )
  const transientBranch = wrapNode(
    "transient_branch",
    dependencies,
    async (state, runtime) => {
      await runtime.checkActive()
      await dependencies.effects.execute({
        runId: state.runId,
        effectId: "transient_branch",
      })
      return {
        branchResults: "transient_complete",
        effectIds: "transient_branch",
      }
    }
  )
  const modelTool = wrapNode(
    "model_tool",
    dependencies,
    async (state, runtime) => {
      if (!isBudgetAvailable(state, { toolCalls: 1, modelCalls: 1 })) {
        return {
          terminalStatus: "budget_exhausted",
          stopReason: "model_tool_budget_exhausted",
        }
      }
      await runtime.checkActive()
      await runtime.emitTool({ toolName: "synthetic_tool", phase: "started" })
      await runtime.checkActive()
      await dependencies.effects.execute({
        runId: state.runId,
        effectId: "model_tool",
      })
      await runtime.emitTool({ toolName: "synthetic_tool", phase: "completed" })
      return {
        toolCallsUsed: state.toolCallsUsed + 1,
        modelCallsUsed: state.modelCallsUsed + 1,
        effectIds: "model_tool",
      }
    }
  )
  const prepareReview = wrapNode(
    "prepare_review",
    dependencies,
    async (state) => {
      const update = {
        pendingReview: pendingReviewSchema.parse({
          decisionId: "synthetic_review",
          question: "Approve the synthetic workflow finalizer?",
        }),
        terminalStatus: "needs_human" as const,
        stopReason: "review_required",
      }
      await emitInterruptEvent(
        dependencies,
        { ...state, ...update },
        "requested"
      )
      return update
    }
  )
  const humanReview = wrapNode("human_review", dependencies, async (state) => {
    const pending = state.pendingReview
    if (pending === null) {
      throw new Error("Synthetic review state is missing")
    }
    const decision = resumeInputSchema.parse(
      interrupt({
        decisionId: pending.decisionId,
        question: pending.question,
      })
    )
    if (decision.decisionId !== pending.decisionId) {
      throw new ResumeAuthorizationError()
    }
    await emitInterruptEvent(dependencies, state, "resumed")
    return {
      pendingReview: null,
      resumeDecisionId: decision.decisionId,
      resumeActorId: decision.actorId,
      approved: decision.approved,
      terminalStatus: decision.approved ? "partial" : "blocked",
      stopReason: decision.approved ? null : "review_rejected",
    }
  })
  const finalize = wrapNode(
    "finalize",
    dependencies,
    async (state, runtime) => {
      if (state.terminalStatus === "budget_exhausted") return {}
      if (state.approved !== true) {
        return { terminalStatus: "blocked", stopReason: "review_rejected" }
      }
      await runtime.checkActive()
      await dependencies.effects.execute({
        runId: state.runId,
        effectId: "finalize",
      })
      return {
        effectIds: "finalize",
        terminalStatus: "complete",
        stopReason: "synthetic_complete",
      }
    }
  )

  return new StateGraph(SyntheticState)
    .addNode("initialize", initialize)
    .addNode("deterministic_branch", deterministicBranch)
    .addNode("transient_branch", transientBranch, {
      retryPolicy: {
        ...transientRetryPolicy,
        maxAttempts: options.transientMaxAttempts ?? 2,
      },
    })
    .addNode("model_tool", modelTool)
    .addNode("prepare_review", prepareReview)
    .addNode("human_review", humanReview)
    .addNode("finalize", finalize)
    .addEdge(START, "initialize")
    .addEdge("initialize", "deterministic_branch")
    .addEdge("initialize", "transient_branch")
    .addEdge(["deterministic_branch", "transient_branch"], "model_tool")
    .addConditionalEdges("model_tool", (state) =>
      state.terminalStatus === "budget_exhausted"
        ? "finalize"
        : "prepare_review"
    )
    .addEdge("prepare_review", "human_review")
    .addEdge("human_review", "finalize")
    .addEdge("finalize", END)
    .compile({ checkpointer })
}

export type SyntheticGraph = ReturnType<typeof buildSyntheticGraph>

export interface SyntheticRunResult {
  readonly status:
    | "completed"
    | "interrupted"
    | "cancelled"
    | "lease_lost"
    | "blocked"
    | "budget_exhausted"
  readonly state: SyntheticStateValue
  readonly interruptValues: readonly unknown[]
  readonly idempotent: boolean
}

export class SyntheticOrchestrationService {
  private readonly recursionLimit: number

  constructor(
    private readonly graph: SyntheticGraph,
    private readonly dependencies: RuntimeDependencies,
    options: SyntheticGraphOptions = {}
  ) {
    this.recursionLimit = z
      .number()
      .int()
      .min(2)
      .max(1_000)
      .parse(options.recursionLimit ?? 64)
  }

  private config(runId: string) {
    return {
      configurable: { thread_id: runIdSchema.parse(runId) },
      recursionLimit: this.recursionLimit,
    }
  }

  private toResult(raw: unknown, idempotent = false): SyntheticRunResult {
    const state = parseSyntheticState(raw)
    const interruptValues = isInterrupted(raw)
      ? raw[INTERRUPT].map((entry) => entry.value)
      : []
    return {
      status:
        interruptValues.length > 0
          ? "interrupted"
          : state.terminalStatus === "budget_exhausted"
            ? "budget_exhausted"
            : state.terminalStatus === "blocked"
              ? "blocked"
              : "completed",
      state,
      interruptValues,
      idempotent,
    }
  }

  private async invoke(
    input: unknown,
    runId: string
  ): Promise<SyntheticRunResult> {
    try {
      let nextInput = input
      for (let iteration = 0; iteration < this.recursionLimit; iteration += 1) {
        const raw = await this.graph.invoke(
          nextInput as Parameters<SyntheticGraph["invoke"]>[0],
          this.config(runId)
        )
        if (isInterrupted(raw)) return this.toResult(raw)
        const snapshot = await this.graph.getState(this.config(runId))
        if (snapshot.next.length === 0) {
          const state = parseSyntheticState(raw)
          const repairedParallelStep =
            state.terminalStatus === "partial" &&
            state.branchResults.length === 2 &&
            !state.effectIds.includes("model_tool")
          if (!repairedParallelStep) return this.toResult(raw)
        }
        nextInput = null
      }
      await this.graph.updateState(
        this.config(runId),
        {
          terminalStatus: "budget_exhausted",
          stopReason: "recursion_limit",
        },
        "finalize"
      )
      const snapshot = await this.graph.getState(this.config(runId))
      return this.toResult(snapshot.values)
    } catch (error) {
      if (error instanceof GraphRecursionError) {
        await this.graph.updateState(
          this.config(runId),
          {
            terminalStatus: "budget_exhausted",
            stopReason: "recursion_limit",
          },
          "finalize"
        )
        const snapshot = await this.graph.getState(this.config(runId))
        return this.toResult(snapshot.values)
      }
      const snapshot = await this.graph.getState(this.config(runId))
      if (Object.keys(snapshot.values).length === 0) throw error
      const state = parseSyntheticState(snapshot.values)
      if (error instanceof CancelledOrchestrationError) {
        return {
          status: "cancelled",
          state,
          interruptValues: [],
          idempotent: false,
        }
      }
      if (error instanceof LeaseOwnershipError) {
        return {
          status: "lease_lost",
          state,
          interruptValues: [],
          idempotent: false,
        }
      }
      throw error
    }
  }

  start(initialState: SyntheticStateValue): Promise<SyntheticRunResult> {
    const state = parseSyntheticState(initialState)
    return this.invoke(state, state.runId)
  }

  async continue(runId: string): Promise<SyntheticRunResult> {
    const id = runIdSchema.parse(runId)
    const snapshot = await this.graph.getState(this.config(id))
    const state = parseSyntheticState(snapshot.values)
    return this.invoke(null, state.runId)
  }

  async resume(input: {
    readonly runId: string
    readonly actorId: string
    readonly decisionId: string
    readonly approved: boolean
  }): Promise<SyntheticRunResult> {
    const parsed = resumeInputSchema.parse(input)
    const config = this.config(input.runId)
    const snapshot = await this.graph.getState(config)
    const state = parseSyntheticState(snapshot.values)
    const authorized = await this.dependencies.resumeAuthorization.authorize({
      runId: state.runId,
      actorId: parsed.actorId,
      decisionId: parsed.decisionId,
    })
    if (!authorized) throw new ResumeAuthorizationError()
    if (state.resumeDecisionId === parsed.decisionId) {
      return this.toResult(state, true)
    }
    if (state.pendingReview?.decisionId !== parsed.decisionId) {
      throw new ResumeAuthorizationError()
    }
    return this.invoke(new Command({ resume: parsed }), state.runId)
  }
}
