import {
  databaseApplicationIdSchema,
  databaseRunIdSchema,
  executionBudgetSchema,
  humanDecisionSchema,
  reasonCodeSchema,
  runCommandSchema,
  runTypeSchema,
  type HumanDecision,
  type MissionBudget,
  type RunCommand,
} from "@sentinel/contracts"
import { z } from "zod"

export interface DispatchableRun {
  readonly id: string
  readonly applicationId: string
  readonly runType: RunCommand["type"]
  readonly budget: MissionBudget
  readonly request: unknown
  readonly attemptCount: number
}

export interface RunExecutionContext {
  readonly signal: AbortSignal
  assertActive(): Promise<void>
  registerCleanup(cleanup: () => Promise<void>): void
}

export interface GraphRunInput {
  readonly runId: string
  readonly applicationId: string
  readonly budget: MissionBudget
  readonly payload: RunCommand["payload"]
}

export type GraphExecutionResult =
  | { readonly status: "succeeded" }
  | { readonly status: "cancelled" }
  | {
      readonly status: "interrupted"
      readonly decisionId: string
      readonly prompt: string
    }

export interface CompiledRunGraph {
  start(
    input: GraphRunInput,
    context: RunExecutionContext
  ): Promise<GraphExecutionResult>
  continue(
    input: GraphRunInput,
    context: RunExecutionContext
  ): Promise<GraphExecutionResult>
  resume(
    input: GraphRunInput,
    decision: { readonly decisionId: string; readonly response: HumanDecision },
    context: RunExecutionContext
  ): Promise<GraphExecutionResult>
}

export type RunGraphRegistry = Readonly<
  Record<RunCommand["type"], CompiledRunGraph>
>

export function createRunGraphRegistry(
  registry: RunGraphRegistry
): RunGraphRegistry {
  for (const runType of runTypeSchema.options) {
    const handler = registry[runType]
    if (
      handler === undefined ||
      typeof handler.start !== "function" ||
      typeof handler.continue !== "function" ||
      typeof handler.resume !== "function"
    ) {
      throw new RunDispatchError(
        "configuration",
        "graph_handler_missing",
        false
      )
    }
  }
  return Object.freeze({ ...registry })
}

export interface ResumeDecision {
  readonly decisionId: string
  readonly response: HumanDecision
}

export interface RunDispatcher {
  execute(
    run: DispatchableRun,
    decision: ResumeDecision | null,
    context: RunExecutionContext
  ): Promise<GraphExecutionResult>
}

export class RunDispatchError extends Error {
  constructor(
    readonly category:
      | "validation"
      | "configuration"
      | "authorization"
      | "rate_limit"
      | "timeout"
      | "provider"
      | "storage"
      | "cancelled"
      | "unknown",
    readonly code: string,
    readonly retryable: boolean
  ) {
    super(code)
    this.name = "RunDispatchError"
  }
}

function graphInput(run: DispatchableRun): GraphRunInput {
  const parsed = runCommandSchema.parse({
    schemaVersion: 1,
    applicationId: databaseApplicationIdSchema.parse(run.applicationId),
    type: runTypeSchema.parse(run.runType),
    idempotencyKey: "worker:persisted",
    budget: executionBudgetSchema.parse(run.budget),
    payload: run.request,
  })
  return {
    runId: databaseRunIdSchema.parse(run.id),
    applicationId: databaseApplicationIdSchema.parse(run.applicationId),
    budget: executionBudgetSchema.parse(run.budget),
    payload: parsed.payload,
  }
}

export function createRunDispatcher(
  registryInput: RunGraphRegistry
): RunDispatcher {
  const registry = createRunGraphRegistry(registryInput)
  return {
    execute: async (run, decision, context) => {
      await context.assertActive()
      const input = graphInput(run)
      const graph = registry[run.runType]
      if (decision !== null) {
        return graph.resume(
          input,
          {
            decisionId: reasonCodeSchema.parse(decision.decisionId),
            response: humanDecisionSchema.parse(decision.response),
          },
          context
        )
      }
      return run.attemptCount > 1
        ? graph.continue(input, context)
        : graph.start(input, context)
    },
  }
}

export function classifyRunExecutionError(error: unknown): RunDispatchError {
  if (error instanceof RunDispatchError) return error
  const name = error instanceof Error ? error.name : ""
  if (name === "CancelledOrchestrationError") {
    return new RunDispatchError("cancelled", "run_cancelled", false)
  }
  if (name === "LeaseOwnershipError") {
    return new RunDispatchError("storage", "lease_lost", true)
  }
  if (name === "BudgetExhaustedError") {
    return new RunDispatchError("timeout", "budget_exhausted", false)
  }
  if (name === "TransientOrchestrationError") {
    return new RunDispatchError("provider", "transient_failure", true)
  }
  if (name === "CheckpointStateError") {
    return new RunDispatchError("storage", "checkpoint_invalid", false)
  }
  if (name === "ResumeAuthorizationError" || name === "ResumeConflictError") {
    return new RunDispatchError("authorization", "resume_rejected", false)
  }
  if (name === "SanitizedNodeError") {
    return new RunDispatchError("unknown", "node_failure", false)
  }
  if (error instanceof z.ZodError) {
    return new RunDispatchError("configuration", "run_request_invalid", false)
  }
  return new RunDispatchError("unknown", "unhandled_failure", true)
}
