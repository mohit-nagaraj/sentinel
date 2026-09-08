import {
  databaseApplicationIdSchema,
  databaseRunIdSchema,
  executionBudgetSchema,
  humanDecisionSchema,
  persistedTextSchema,
  publicErrorSchema,
  reasonCodeSchema,
  runCommandSchema,
  runTerminalPublicationSchema,
  runTypeSchema,
  type HumanDecision,
  type MissionBudget,
  type RunCommand,
  type RunTerminalPublication,
} from "@sentinel/contracts"
import { z } from "zod"

export interface DispatchableRun {
  readonly id: string
  readonly applicationId: string
  readonly runType: RunCommand["type"]
  readonly budget: MissionBudget
  readonly request: unknown
  readonly configurationFingerprint: string | null
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
  readonly configurationFingerprint: string
}

export type GraphExecutionResult =
  | {
      readonly status: "succeeded"
      readonly publication: RunTerminalPublication
    }
  | { readonly status: "cancelled" }
  | {
      readonly status: "interrupted"
      readonly decisionId: string
      readonly prompt: string
    }

const graphExecutionResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("succeeded"),
    publication: runTerminalPublicationSchema,
  }),
  z.strictObject({ status: z.literal("cancelled") }),
  z.strictObject({
    status: z.literal("interrupted"),
    decisionId: reasonCodeSchema,
    prompt: persistedTextSchema.max(4_096),
  }),
])

export interface CompiledRunGraph {
  hasCheckpoint(input: GraphRunInput): Promise<boolean>
  hasPendingInterrupt(
    input: GraphRunInput,
    decisionId: string
  ): Promise<boolean>
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
      typeof handler.hasCheckpoint !== "function" ||
      typeof handler.hasPendingInterrupt !== "function" ||
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
  readonly category: z.infer<typeof publicErrorSchema>["category"]
  readonly code: string
  readonly retryable: boolean

  constructor(
    category:
      | "validation"
      | "configuration"
      | "authorization"
      | "rate_limit"
      | "timeout"
      | "provider"
      | "storage"
      | "cancelled"
      | "unknown",
    code: string,
    retryable: boolean
  ) {
    const parsedCategory = publicErrorSchema.shape.category.parse(category)
    const parsedCode = reasonCodeSchema.parse(code)
    super(parsedCode)
    this.name = "RunDispatchError"
    this.category = parsedCategory
    this.code = parsedCode
    this.retryable = retryable
    const policyRetryable = new Set([
      "rate_limit",
      "timeout",
      "provider",
      "storage",
      "unknown",
    ]).has(parsedCategory)
    if (retryable && !policyRetryable) {
      throw new TypeError("Run failure retryability must match its category")
    }
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
    configurationFingerprint: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .parse(run.configurationFingerprint),
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
      let rawResult: GraphExecutionResult
      if (decision !== null) {
        const decisionId = reasonCodeSchema.parse(decision.decisionId)
        await context.assertActive()
        const interruptPending = await graph.hasPendingInterrupt(
          input,
          decisionId
        )
        await context.assertActive()
        rawResult = interruptPending
          ? await graph.resume(
              input,
              {
                decisionId,
                response: humanDecisionSchema.parse(decision.response),
              },
              context
            )
          : await graph.continue(input, context)
      } else {
        const checkpointExists = await graph.hasCheckpoint(input)
        await context.assertActive()
        rawResult = checkpointExists
          ? await graph.continue(input, context)
          : await graph.start(input, context)
      }
      const result = graphExecutionResultSchema.parse(rawResult)
      if (result.status === "succeeded") {
        const expectedKind = {
          inspect_application: "inspection",
          initialize_knowledge: "knowledge",
          assess_pr: "assessment",
          verify_pr: "verification",
          refresh_knowledge: "knowledge",
          run_eval: "eval",
        } as const
        if (result.publication.kind !== expectedKind[run.runType]) {
          throw new RunDispatchError(
            "configuration",
            "terminal_publication_invalid",
            false
          )
        }
      }
      return result
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
