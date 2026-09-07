import { persistedTextSchema, reasonCodeSchema } from "@sentinel/contracts"
import { isGraphInterrupt } from "@langchain/langgraph"
import { z } from "zod"

import { assertCompactCheckpointState } from "./state.ts"

export type OrchestrationEventKind =
  | "node_started"
  | "node_completed"
  | "tool_started"
  | "tool_completed"
  | "interrupt_requested"
  | "interrupt_resumed"
  | "warning"
  | "error"

export interface OrchestrationEvent {
  readonly runId: string
  readonly graphName: string
  readonly nodeName: string
  readonly toolName?: string
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
}

export interface OrchestrationEventSink {
  append(event: OrchestrationEvent): Promise<void>
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
    summary: persistedTextSchema.parse(input.summary),
    reasonCode: reasonCodeSchema.parse(input.reasonCode),
    occurredAt: z.iso.datetime({ offset: true }).parse(input.occurredAt),
  }
}

async function emit(
  dependencies: RuntimeDependencies,
  event: Omit<OrchestrationEvent, "occurredAt">
): Promise<void> {
  try {
    await dependencies.events.append(
      safeEvent({
        ...event,
        occurredAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      })
    )
  } catch {
    throw new EventPersistenceError()
  }
}

export interface NodeRuntime {
  readonly signal: AbortSignal
  checkActive(): Promise<void>
  emitTool(input: {
    readonly toolName: string
    readonly phase: "started" | "completed"
  }): Promise<void>
}

export interface RuntimeStateBase {
  readonly runId: string
  readonly graphName: string
  readonly startedAtMs: number
  readonly budget: { readonly elapsedMs: number }
}

export interface NodeWrapperOptions {
  readonly emitStarted?: boolean
  readonly lifecycleNodeName?: string
}

const MAX_TIMER_DELAY_MS = 2_147_483_647

function isSafeRuntimeError(error: unknown): error is Error {
  return (
    error instanceof TransientOrchestrationError ||
    error instanceof CancelledOrchestrationError ||
    error instanceof LeaseOwnershipError ||
    error instanceof ResumeAuthorizationError ||
    error instanceof ResumeConflictError ||
    error instanceof BudgetExhaustedError ||
    error instanceof CheckpointStateError ||
    error instanceof EventPersistenceError ||
    error instanceof SanitizedNodeError
  )
}

export function wrapNode<
  State extends RuntimeStateBase,
  Update extends Record<string, unknown>,
>(
  nodeNameInput: string,
  dependencies: RuntimeDependencies,
  parseState: (input: unknown) => State,
  handler: (state: State, runtime: NodeRuntime) => Promise<Update> | Update,
  options: NodeWrapperOptions = {}
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
    const started = now().getTime()
    const abortController = new AbortController()
    const elapsed = () => Math.max(0, now().getTime() - state.startedAtMs)
    const checkActive = async () => {
      if (
        abortController.signal.aborted ||
        elapsed() >= state.budget.elapsedMs
      ) {
        throw new BudgetExhaustedError()
      }
      await dependencies.control.assertActive({
        runId: state.runId,
        owner: dependencies.owner,
      })
    }
    const runtime: NodeRuntime = {
      signal: abortController.signal,
      checkActive,
      emitTool: async ({ toolName, phase }) => {
        await emit(dependencies, {
          runId: state.runId,
          graphName: state.graphName,
          nodeName: lifecycleNodeName,
          toolName: reasonCodeSchema.parse(toolName),
          kind: phase === "started" ? "tool_started" : "tool_completed",
          status: phase,
          summary:
            phase === "started"
              ? "Tool execution started"
              : "Tool execution completed",
          reasonCode: phase === "started" ? "tool_started" : "tool_completed",
        })
      },
    }
    try {
      await checkActive()
      if (options.emitStarted !== false) {
        await emit(dependencies, {
          runId: state.runId,
          graphName: state.graphName,
          nodeName: lifecycleNodeName,
          kind: "node_started",
          status: "started",
          summary: "Node execution started",
          reasonCode: "node_started",
        })
      }
      let timeout: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        const armTimeout = () => {
          const remainingMs = state.budget.elapsedMs - elapsed()
          if (remainingMs <= 0) {
            abortController.abort()
            reject(new BudgetExhaustedError())
            return
          }
          timeout = setTimeout(
            () => {
              if (elapsed() >= state.budget.elapsedMs) {
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
      assertCompactCheckpointState(update)
      await checkActive()
      return update
    } catch (error) {
      if (isGraphInterrupt(error)) throw error
      const retryable = error instanceof TransientOrchestrationError
      const safeError = isSafeRuntimeError(error)
        ? error
        : new SanitizedNodeError()
      await emit(dependencies, {
        runId: state.runId,
        graphName: state.graphName,
        nodeName: lifecycleNodeName,
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
        elapsedLimitMs: state.budget.elapsedMs,
      })
      throw safeError
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
