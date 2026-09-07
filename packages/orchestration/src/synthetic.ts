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
  BudgetExhaustedError,
  CancelledOrchestrationError,
  CheckpointStateError,
  LeaseOwnershipError,
  ResumeAuthorizationError,
  emitCommittedNodeEvent,
  emitInterruptEvent,
  transientRetryPolicy,
  wrapNode,
  type RuntimeDependencies,
} from "./runtime.ts"
import {
  SyntheticState,
  isBudgetAvailable,
  pendingReviewSchema,
  parseSyntheticGraphResultState,
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
  readonly startedAtMs?: number
}): SyntheticStateValue {
  return parseSyntheticState({
    runId: runIdSchema.parse(input.runId),
    applicationId: applicationIdSchema.parse(input.applicationId),
    graphName: "synthetic_foundation",
    startedAtMs: z
      .number()
      .int()
      .nonnegative()
      .parse(input.startedAtMs ?? Date.now()),
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
  const transientMaxAttempts = z
    .number()
    .int()
    .min(1)
    .max(10)
    .parse(options.transientMaxAttempts ?? 2)
  const initialize = wrapNode(
    "initialize",
    dependencies,
    parseSyntheticState,
    () => ({ steps: 1 })
  )
  const deterministicBranch = wrapNode(
    "deterministic_branch",
    dependencies,
    parseSyntheticState,
    async (state, runtime) => {
      await runtime.checkActive()
      await dependencies.effects.execute({
        runId: state.runId,
        effectId: "deterministic_branch",
      })
      return {
        branchResults: "deterministic_complete",
        effectIds: "deterministic_branch",
        steps: 1,
      }
    }
  )
  const transientBranch = wrapNode(
    "transient_branch",
    dependencies,
    parseSyntheticState,
    async (state, runtime) => {
      await runtime.checkActive()
      await dependencies.effects.execute({
        runId: state.runId,
        effectId: "transient_branch",
      })
      return {
        branchResults: "transient_complete",
        effectIds: "transient_branch",
        steps: 1,
      }
    }
  )
  const modelTool = wrapNode(
    "model_tool",
    dependencies,
    parseSyntheticState,
    async (state, runtime) => {
      if (
        !isBudgetAvailable(state, {
          toolCalls: 1,
          modelCalls: 1,
          reconciliationRounds: 1,
        })
      ) {
        return {
          terminalStatus: "budget_exhausted",
          stopReason: "model_tool_budget_exhausted",
          steps: 1,
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
        reconciliationRoundsUsed: state.reconciliationRoundsUsed + 1,
        effectIds: "model_tool",
        steps: 1,
      }
    }
  )
  const prepareReview = wrapNode(
    "prepare_review",
    dependencies,
    parseSyntheticState,
    async () => {
      const update = {
        pendingReview: pendingReviewSchema.parse({
          decisionId: "synthetic_review",
          question: "Approve the synthetic workflow finalizer?",
        }),
        terminalStatus: "needs_human" as const,
        stopReason: "review_required",
      }
      return { ...update, steps: 1 }
    }
  )
  const humanReview = wrapNode(
    "human_review",
    dependencies,
    parseSyntheticState,
    async (state) => {
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
      return {
        pendingReview: null,
        resumeDecisionId: decision.decisionId,
        resumeActorId: decision.actorId,
        approved: decision.approved,
        terminalStatus: decision.approved ? "partial" : "blocked",
        stopReason: decision.approved ? null : "review_rejected",
        steps: 1,
      }
    }
  )
  const finalize = wrapNode(
    "finalize",
    dependencies,
    parseSyntheticState,
    async (state, runtime) => {
      if (state.terminalStatus === "budget_exhausted") return { steps: 1 }
      if (state.approved !== true) {
        return {
          terminalStatus: "blocked",
          stopReason: "review_rejected",
          steps: 1,
        }
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
        steps: 1,
      }
    }
  )

  const committedNode =
    (
      nodeName: string,
      afterCommit?: (state: SyntheticStateValue) => Promise<void>
    ) =>
    async (stateInput: SyntheticStateValue) => {
      const state = parseSyntheticState(stateInput)
      await emitCommittedNodeEvent(dependencies, state, nodeName)
      await afterCommit?.(state)
      return {}
    }

  return new StateGraph(SyntheticState)
    .addNode("initialize", initialize)
    .addNode("initialize_committed", committedNode("initialize"))
    .addNode("deterministic_branch", deterministicBranch)
    .addNode(
      "deterministic_branch_committed",
      committedNode("deterministic_branch")
    )
    .addNode("transient_branch", transientBranch, {
      retryPolicy: {
        ...transientRetryPolicy,
        maxAttempts: transientMaxAttempts,
      },
    })
    .addNode("transient_branch_committed", committedNode("transient_branch"))
    .addNode("model_tool", modelTool)
    .addNode("model_tool_committed", committedNode("model_tool"))
    .addNode("prepare_review", prepareReview)
    .addNode(
      "prepare_review_committed",
      committedNode("prepare_review", (state) =>
        emitInterruptEvent(dependencies, state, "requested")
      )
    )
    .addNode("human_review", humanReview)
    .addNode(
      "human_review_committed",
      committedNode("human_review", (state) =>
        emitInterruptEvent(dependencies, state, "resumed")
      )
    )
    .addNode("finalize", finalize)
    .addNode("finalize_committed", committedNode("finalize"))
    .addEdge(START, "initialize")
    .addEdge("initialize", "initialize_committed")
    .addEdge("initialize_committed", "deterministic_branch")
    .addEdge("initialize_committed", "transient_branch")
    .addEdge("deterministic_branch", "deterministic_branch_committed")
    .addEdge("transient_branch", "transient_branch_committed")
    .addEdge(
      ["deterministic_branch_committed", "transient_branch_committed"],
      "model_tool"
    )
    .addEdge("model_tool", "model_tool_committed")
    .addConditionalEdges("model_tool_committed", (state) =>
      state.terminalStatus === "budget_exhausted"
        ? "finalize"
        : "prepare_review"
    )
    .addEdge("prepare_review", "prepare_review_committed")
    .addEdge("prepare_review_committed", "human_review")
    .addEdge("human_review", "human_review_committed")
    .addEdge("human_review_committed", "finalize")
    .addEdge("finalize", "finalize_committed")
    .addEdge("finalize_committed", END)
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
    const state = parseSyntheticGraphResultState(raw)
    const interruptValues = isInterrupted(raw)
      ? raw[INTERRUPT].map((entry) => pendingReviewSchema.parse(entry.value))
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
      if (
        error instanceof GraphRecursionError ||
        error instanceof BudgetExhaustedError
      ) {
        await this.graph.updateState(
          this.config(runId),
          {
            terminalStatus: "budget_exhausted",
            stopReason:
              error instanceof BudgetExhaustedError
                ? "elapsed_budget_exhausted"
                : "recursion_limit",
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

  async start(initialState: SyntheticStateValue): Promise<SyntheticRunResult> {
    let state: SyntheticStateValue
    try {
      state = parseSyntheticState(initialState)
    } catch {
      throw new CheckpointStateError()
    }
    return this.invoke(state, state.runId)
  }

  async continue(runId: string): Promise<SyntheticRunResult> {
    const id = runIdSchema.parse(runId)
    const snapshot = await this.graph.getState(this.config(id))
    let state: SyntheticStateValue
    try {
      state = parseSyntheticState(snapshot.values)
    } catch {
      throw new CheckpointStateError()
    }
    if (state.runId !== id) throw new CheckpointStateError()
    return this.invoke(null, id)
  }

  async resume(input: {
    readonly runId: string
    readonly actorId: string
    readonly decisionId: string
    readonly approved: boolean
  }): Promise<SyntheticRunResult> {
    const parsed = resumeInputSchema.parse(input)
    return this.dependencies.resumeCoordinator.runExclusive(
      { runId: parsed.runId, decisionId: parsed.decisionId },
      async () => {
        const config = this.config(parsed.runId)
        const snapshot = await this.graph.getState(config)
        let state: SyntheticStateValue
        try {
          state = parseSyntheticState(snapshot.values)
        } catch {
          throw new CheckpointStateError()
        }
        if (state.runId !== parsed.runId) throw new CheckpointStateError()
        let authorized: boolean
        try {
          authorized = await this.dependencies.resumeAuthorization.authorize({
            runId: state.runId,
            actorId: parsed.actorId,
            decisionId: parsed.decisionId,
          })
        } catch {
          throw new ResumeAuthorizationError()
        }
        if (!authorized) throw new ResumeAuthorizationError()
        if (state.resumeDecisionId === parsed.decisionId) {
          return this.toResult(state, true)
        }
        if (state.pendingReview?.decisionId !== parsed.decisionId) {
          throw new ResumeAuthorizationError()
        }
        return this.invoke(new Command({ resume: parsed }), parsed.runId)
      }
    )
  }
}
