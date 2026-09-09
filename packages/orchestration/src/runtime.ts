import {
  agentKindSchema,
  contentHashSchema,
  evidenceIdSchema,
  missionIdSchema,
  persistedTextSchema,
  reasonCodeSchema,
  runActivityDisplaySchema,
  runIdSchema,
} from "@sentinel/contracts"
import { isGraphInterrupt } from "@langchain/langgraph"
import { z } from "zod"

import { assertCompactCheckpointState } from "./state.ts"

type AgentKind = z.infer<typeof agentKindSchema>

const orchestrationBudgetSchema = z.strictObject({
  consumed: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  unit: z.enum([
    "tool_calls",
    "content_bytes",
    "document_bytes",
    "document_pages",
    "document_sections",
    "source_lines",
    "repository_bytes",
    "repository_files",
    "browser_actions",
    "model_calls",
    "input_tokens",
    "output_tokens",
    "reconciliation_rounds",
    "elapsed_ms",
  ]),
})

export type OrchestrationEventKind =
  | "node_started"
  | "node_completed"
  | "mission_started"
  | "mission_completed"
  | "tool_started"
  | "tool_completed"
  | "evidence_gained"
  | "budget_updated"
  | "interrupt_requested"
  | "interrupt_resumed"
  | "warning"
  | "error"

export interface OrchestrationEvent {
  readonly runId: string
  readonly graphName: string
  readonly nodeName: string
  readonly agent?: AgentKind
  readonly missionId?: string
  readonly toolName?: string
  readonly evidenceIds?: readonly string[]
  readonly budget?: z.infer<typeof orchestrationBudgetSchema>
  readonly kind: OrchestrationEventKind
  readonly status: "started" | "completed" | "blocked" | "failed" | "warning"
  readonly summary: string
  readonly reasonCode: string
  readonly occurredAt: string
  readonly elapsedMs?: number
  readonly elapsedLimitMs?: number
  readonly retryable?: boolean
  readonly errorCategory?:
    "authorization" | "cancelled" | "provider" | "storage" | "unknown"
  readonly activity?: z.infer<typeof runActivityDisplaySchema>
}

export interface OrchestrationEventSink {
  append(
    event: OrchestrationEvent,
    options?: { readonly idempotencyKey?: string }
  ): Promise<void>
}

export interface RunControlPort {
  assertActive(input: {
    readonly runId: string
    readonly owner: string
  }): Promise<void>
}

export interface SideEffectPort {
  execute(input: {
    readonly runId: string
    readonly effectId: string
    readonly signal: AbortSignal
  }): Promise<void>
}

export interface ResumeAuthorizationPort {
  authorize(input: {
    readonly runId: string
    readonly actorId: string
    readonly decisionId: string
  }): Promise<boolean>
}

export interface ResumeCoordinator {
  runExclusive<Output>(
    input: { readonly runId: string; readonly decisionId: string },
    work: () => Promise<Output>
  ): Promise<Output>
}

export interface RuntimeDependencies {
  readonly owner: string
  readonly control: RunControlPort
  readonly events: OrchestrationEventSink
  readonly effects: SideEffectPort
  readonly resumeAuthorization: ResumeAuthorizationPort
  readonly resumeCoordinator: ResumeCoordinator
  readonly executionSignal?: AbortSignal | (() => AbortSignal | undefined)
  readonly now?: () => Date
}

export class TransientOrchestrationError extends Error {
  constructor() {
    super("Transient orchestration dependency failure")
    this.name = "TransientOrchestrationError"
  }
}

export class CancelledOrchestrationError extends Error {
  constructor() {
    super("Orchestration run is cancelled")
    this.name = "CancelledOrchestrationError"
  }
}

export class LeaseOwnershipError extends Error {
  constructor() {
    super("Orchestration lease ownership was lost")
    this.name = "LeaseOwnershipError"
  }
}

export class PauseRequestedOrchestrationError extends Error {
  constructor() {
    super("Orchestration pause was requested")
    this.name = "PauseRequestedOrchestrationError"
  }
}

export class ResumeAuthorizationError extends Error {
  constructor() {
    super("Resume authorization failed")
    this.name = "ResumeAuthorizationError"
  }
}

export class ResumeConflictError extends Error {
  constructor() {
    super("Resume decision conflicts with the committed decision")
    this.name = "ResumeConflictError"
  }
}

export class BudgetExhaustedError extends Error {
  constructor() {
    super("Orchestration elapsed budget exhausted")
    this.name = "BudgetExhaustedError"
  }
}

export class CheckpointStateError extends Error {
  constructor() {
    super("Orchestration checkpoint state is invalid")
    this.name = "CheckpointStateError"
  }
}

export class EventPersistenceError extends Error {
  constructor() {
    super("Orchestration event persistence failed")
    this.name = "EventPersistenceError"
  }
}

export class SanitizedNodeError extends Error {
  constructor() {
    super("Orchestration node failed")
    this.name = "SanitizedNodeError"
  }
}

export const transientRetryPolicy = {
  initialInterval: 1,
  backoffFactor: 1,
  maxInterval: 1,
  maxAttempts: 2,
  jitter: false,
  logWarning: false,
  retryOn: (error: unknown) => error instanceof TransientOrchestrationError,
} as const

function safeEvent(input: OrchestrationEvent): OrchestrationEvent {
  return {
    ...input,
    graphName: reasonCodeSchema.parse(input.graphName),
    nodeName: reasonCodeSchema.parse(input.nodeName),
    ...(input.toolName === undefined
      ? {}
      : { toolName: reasonCodeSchema.parse(input.toolName) }),
    ...(input.agent === undefined
      ? {}
      : { agent: agentKindSchema.parse(input.agent) }),
    ...(input.missionId === undefined
      ? {}
      : { missionId: missionIdSchema.parse(input.missionId) }),
    evidenceIds: z
      .array(evidenceIdSchema)
      .max(100)
      .parse(input.evidenceIds ?? []),
    ...(input.budget === undefined
      ? {}
      : { budget: orchestrationBudgetSchema.parse(input.budget) }),
    summary: persistedTextSchema.parse(input.summary),
    reasonCode: reasonCodeSchema.parse(input.reasonCode),
    ...(input.activity === undefined
      ? {}
      : { activity: runActivityDisplaySchema.parse(input.activity) }),
    occurredAt: z.iso.datetime({ offset: true }).parse(input.occurredAt),
  }
}

async function emit(
  dependencies: RuntimeDependencies,
  event: Omit<OrchestrationEvent, "occurredAt">,
  options?: { readonly idempotencyKey?: string }
): Promise<void> {
  try {
    await dependencies.events.append(
      safeEvent({
        ...event,
        occurredAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      }),
      options?.idempotencyKey === undefined
        ? undefined
        : {
            idempotencyKey: contentHashSchema.parse(options.idempotencyKey),
          }
    )
  } catch {
    throw new EventPersistenceError()
  }
}

export async function appendOrchestrationEvent(
  dependencies: RuntimeDependencies,
  event: Omit<OrchestrationEvent, "occurredAt">,
  options?: { readonly idempotencyKey?: string }
): Promise<void> {
  await emit(dependencies, event, options)
}

export interface NodeRuntime {
  readonly signal: AbortSignal
  checkActive(): Promise<void>
  emitTool(input: {
    readonly toolName: string
    readonly phase: "started" | "completed"
    readonly idempotencyKey?: string
    readonly activity?: OrchestrationEvent["activity"]
  }): Promise<void>
  emit(
    input: Omit<
      OrchestrationEvent,
      "runId" | "graphName" | "nodeName" | "occurredAt"
    >,
    options?: { readonly idempotencyKey?: string }
  ): Promise<void>
}

export interface RuntimeStateBase {
  readonly runId: string
  readonly graphName: string
  readonly startedAtMs: number
  readonly budget: { readonly elapsedMs: number }
}

const runtimeStateBaseSchema = z.object({
  runId: runIdSchema,
  graphName: reasonCodeSchema,
  startedAtMs: z.number().int().nonnegative(),
  budget: z.object({ elapsedMs: z.number().int().nonnegative() }),
})

export interface NodeEventContext {
  readonly agent?: AgentKind
  readonly missionId?: string
  readonly evidenceIds?: readonly string[]
}

export interface NodeWrapperOptions<State = RuntimeStateBase> {
  readonly emitStarted?: boolean
  readonly enforceElapsedBudget?: boolean
  readonly lifecycleNodeName?: string
  readonly runtimeState?: (state: State) => RuntimeStateBase
  readonly eventContext?: (state: State) => NodeEventContext
  readonly validateUpdate?: (update: Record<string, unknown>) => void
}

const MAX_TIMER_DELAY_MS = 2_147_483_647

function isSafeRuntimeError(error: unknown): error is Error {
  return (
    error instanceof TransientOrchestrationError ||
    error instanceof CancelledOrchestrationError ||
    error instanceof LeaseOwnershipError ||
    isPauseRequestedError(error) ||
    error instanceof ResumeAuthorizationError ||
    error instanceof ResumeConflictError ||
    error instanceof BudgetExhaustedError ||
    error instanceof CheckpointStateError ||
    error instanceof EventPersistenceError ||
    error instanceof SanitizedNodeError
  )
}

function isPauseRequestedError(error: unknown): error is Error {
  return (
    error instanceof PauseRequestedOrchestrationError ||
    (error instanceof Error &&
      error.name === "PauseRequestedOrchestrationError")
  )
}

export function wrapNode<State, Update extends Record<string, unknown>>(
  nodeNameInput: string,
  dependencies: RuntimeDependencies,
  parseState: (input: unknown) => State,
  handler: (state: State, runtime: NodeRuntime) => Promise<Update> | Update,
  options: NodeWrapperOptions<State> = {}
): (state: State) => Promise<Update> {
  const nodeName = reasonCodeSchema.parse(nodeNameInput)
  const lifecycleNodeName = reasonCodeSchema.parse(
    options.lifecycleNodeName ?? nodeName
  )
  return async (stateInput) => {
    let state: State
    try {
      state = parseState(stateInput)
    } catch {
      throw new CheckpointStateError()
    }
    const now = dependencies.now ?? (() => new Date())
    let runtimeState: RuntimeStateBase
    try {
      runtimeState = runtimeStateBaseSchema.parse(
        options.runtimeState?.(state) ?? state
      )
    } catch {
      throw new CheckpointStateError()
    }
    const eventContext = options.eventContext?.(state) ?? {}
    const started = now().getTime()
    const abortController = new AbortController()
    const executionSignal =
      typeof dependencies.executionSignal === "function"
        ? dependencies.executionSignal()
        : dependencies.executionSignal
    const abortFromExecution = () =>
      abortController.abort(executionSignal?.reason)
    if (executionSignal?.aborted === true) abortFromExecution()
    else
      executionSignal?.addEventListener("abort", abortFromExecution, {
        once: true,
      })
    const externalControlError = () =>
      executionSignal?.reason instanceof Error &&
      executionSignal.reason.name === "LeaseOwnershipError"
        ? new LeaseOwnershipError()
        : new CancelledOrchestrationError()
    const elapsed = () =>
      Math.max(0, now().getTime() - runtimeState.startedAtMs)
    const checkActive = async () => {
      if (executionSignal?.aborted === true) {
        throw externalControlError()
      }
      if (
        abortController.signal.aborted ||
        (options.enforceElapsedBudget !== false &&
          elapsed() >= runtimeState.budget.elapsedMs)
      ) {
        throw new BudgetExhaustedError()
      }
      await dependencies.control.assertActive({
        runId: runtimeState.runId,
        owner: dependencies.owner,
      })
    }
    const runtime: NodeRuntime = {
      signal: abortController.signal,
      checkActive,
      emitTool: async ({ toolName, phase, idempotencyKey, activity }) => {
        await checkActive()
        const parsedToolName = reasonCodeSchema.parse(toolName)
        const toolLabel = persistedTextSchema
          .max(512)
          .parse(parsedToolName.replaceAll("_", " "))
        await emit(
          dependencies,
          {
            runId: runtimeState.runId,
            graphName: runtimeState.graphName,
            nodeName: lifecycleNodeName,
            ...eventContext,
            toolName: parsedToolName,
            kind: phase === "started" ? "tool_started" : "tool_completed",
            status: phase,
            summary:
              phase === "started"
                ? "Tool execution started"
                : "Tool execution completed",
            reasonCode: phase === "started" ? "tool_started" : "tool_completed",
            activity: activity ?? {
              category: "tool",
              action: {
                kind: parsedToolName,
                label: toolLabel,
                status: phase === "started" ? "selected" : "completed",
              },
            },
          },
          idempotencyKey === undefined ? undefined : { idempotencyKey }
        )
      },
      emit: async (event, appendOptions) => {
        await checkActive()
        await emit(
          dependencies,
          {
            runId: runtimeState.runId,
            graphName: runtimeState.graphName,
            nodeName: lifecycleNodeName,
            ...event,
            ...(eventContext.agent === undefined
              ? {}
              : { agent: eventContext.agent }),
            ...(eventContext.missionId === undefined
              ? {}
              : { missionId: eventContext.missionId }),
            evidenceIds: event.evidenceIds ?? eventContext.evidenceIds ?? [],
          },
          appendOptions
        )
      },
    }
    try {
      await checkActive()
      if (options.emitStarted !== false) {
        await emit(dependencies, {
          runId: runtimeState.runId,
          graphName: runtimeState.graphName,
          nodeName: lifecycleNodeName,
          ...eventContext,
          kind: "node_started",
          status: "started",
          summary: "Node execution started",
          reasonCode: "node_started",
        })
      }
      let timeout: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise =
        options.enforceElapsedBudget === false
          ? new Promise<never>(() => undefined)
          : new Promise<never>((_resolve, reject) => {
              const armTimeout = () => {
                const remainingMs = runtimeState.budget.elapsedMs - elapsed()
                if (remainingMs <= 0) {
                  abortController.abort()
                  reject(new BudgetExhaustedError())
                  return
                }
                timeout = setTimeout(
                  () => {
                    if (elapsed() >= runtimeState.budget.elapsedMs) {
                      abortController.abort()
                      reject(new BudgetExhaustedError())
                    } else {
                      armTimeout()
                    }
                  },
                  Math.min(remainingMs, MAX_TIMER_DELAY_MS)
                )
              }
              armTimeout()
            })
      let update: Update
      try {
        update = await Promise.race([
          Promise.resolve(handler(state, runtime)),
          timeoutPromise,
        ])
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
      }
      ;(options.validateUpdate ?? assertCompactCheckpointState)(update)
      await checkActive()
      return update
    } catch (caught) {
      const error =
        executionSignal?.aborted === true ? externalControlError() : caught
      if (isGraphInterrupt(error) || isPauseRequestedError(error)) {
        throw error
      }
      const retryable = error instanceof TransientOrchestrationError
      const safeError = isSafeRuntimeError(error)
        ? error
        : new SanitizedNodeError()
      await emit(dependencies, {
        runId: runtimeState.runId,
        graphName: runtimeState.graphName,
        nodeName: lifecycleNodeName,
        ...eventContext,
        kind: "error",
        status: "failed",
        summary: retryable
          ? "Transient node dependency failed"
          : error instanceof CancelledOrchestrationError
            ? "Run cancellation stopped node execution"
            : error instanceof LeaseOwnershipError
              ? "Run lease ownership was lost"
              : error instanceof BudgetExhaustedError
                ? "Run elapsed budget was exhausted"
                : "Node execution failed",
        reasonCode: retryable
          ? "transient_failure"
          : error instanceof BudgetExhaustedError
            ? "budget_exhausted"
            : "node_failure",
        retryable,
        errorCategory: retryable
          ? "provider"
          : error instanceof CancelledOrchestrationError
            ? "cancelled"
            : error instanceof LeaseOwnershipError
              ? "storage"
              : "unknown",
        elapsedMs: Math.max(0, now().getTime() - started),
        elapsedLimitMs: runtimeState.budget.elapsedMs,
      })
      throw safeError
    } finally {
      executionSignal?.removeEventListener("abort", abortFromExecution)
    }
  }
}

export async function emitCommittedNodeEvent(
  dependencies: RuntimeDependencies,
  state: RuntimeStateBase,
  nodeNameInput: string
): Promise<void> {
  await emit(dependencies, {
    runId: state.runId,
    graphName: state.graphName,
    nodeName: reasonCodeSchema.parse(nodeNameInput),
    kind: "node_completed",
    status: "completed",
    summary: "Node state committed",
    reasonCode: "node_committed",
  })
}

export async function emitInterruptEvent(
  dependencies: RuntimeDependencies,
  state: RuntimeStateBase,
  phase: "requested" | "resumed"
): Promise<void> {
  await emit(dependencies, {
    runId: state.runId,
    graphName: state.graphName,
    nodeName: "human_review",
    kind: phase === "requested" ? "interrupt_requested" : "interrupt_resumed",
    status: phase === "requested" ? "blocked" : "completed",
    summary:
      phase === "requested" ? "Human review requested" : "Human review resumed",
    reasonCode: phase === "requested" ? "review_required" : "review_resumed",
  })
}
