import { persistedTextSchema, reasonCodeSchema } from "@sentinel/contracts"
import { z } from "zod"

import {
  assertCompactCheckpointState,
  parseSyntheticState,
  type SyntheticStateUpdate,
  type SyntheticStateValue,
} from "./state.ts"

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
  }): Promise<void>
}

export interface ResumeAuthorizationPort {
  authorize(input: {
    readonly runId: string
    readonly actorId: string
    readonly decisionId: string
  }): Promise<boolean>
}

export interface RuntimeDependencies {
  readonly owner: string
  readonly control: RunControlPort
  readonly events: OrchestrationEventSink
  readonly effects: SideEffectPort
  readonly resumeAuthorization: ResumeAuthorizationPort
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
    ...(input.errorCategory === undefined
      ? {}
      : {
          errorCategory: z
            .enum([
              "authorization",
              "cancelled",
              "provider",
              "storage",
              "unknown",
            ])
            .parse(input.errorCategory),
        }),
  }
}

async function emit(
  dependencies: RuntimeDependencies,
  event: Omit<OrchestrationEvent, "occurredAt">
): Promise<void> {
  await dependencies.events.append(
    safeEvent({
      ...event,
      occurredAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    })
  )
}

export interface NodeRuntime {
  checkActive(): Promise<void>
  emitTool(input: {
    readonly toolName: string
    readonly phase: "started" | "completed"
  }): Promise<void>
}

export function wrapNode(
  nodeNameInput: string,
  dependencies: RuntimeDependencies,
  handler: (
    state: SyntheticStateValue,
    runtime: NodeRuntime
  ) => Promise<SyntheticStateUpdate> | SyntheticStateUpdate
): (state: SyntheticStateValue) => Promise<SyntheticStateUpdate> {
  const nodeName = reasonCodeSchema.parse(nodeNameInput)
  return async (stateInput) => {
    const state = parseSyntheticState(stateInput)
    const started = (dependencies.now ?? (() => new Date()))().getTime()
    const checkActive = () =>
      dependencies.control.assertActive({
        runId: state.runId,
        owner: dependencies.owner,
      })
    const runtime: NodeRuntime = {
      checkActive,
      emitTool: async ({ toolName, phase }) => {
        const parsedToolName = reasonCodeSchema.parse(toolName)
        await emit(dependencies, {
          runId: state.runId,
          graphName: state.graphName,
          nodeName,
          toolName: parsedToolName,
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
    await checkActive()
    await emit(dependencies, {
      runId: state.runId,
      graphName: state.graphName,
      nodeName,
      kind: "node_started",
      status: "started",
      summary: "Node execution started",
      reasonCode: "node_started",
    })
    try {
      const update = await handler(state, runtime)
      assertCompactCheckpointState(update)
      await emit(dependencies, {
        runId: state.runId,
        graphName: state.graphName,
        nodeName,
        kind: "node_completed",
        status: "completed",
        summary: "Node execution completed",
        reasonCode: "node_completed",
        elapsedMs:
          (dependencies.now ?? (() => new Date()))().getTime() - started,
        elapsedLimitMs: state.budget.elapsedMs,
      })
      return { ...update, steps: 1 }
    } catch (error) {
      const retryable = error instanceof TransientOrchestrationError
      await emit(dependencies, {
        runId: state.runId,
        graphName: state.graphName,
        nodeName,
        kind: "error",
        status: "failed",
        summary: retryable
          ? "Transient node dependency failed"
          : error instanceof CancelledOrchestrationError
            ? "Run cancellation stopped node execution"
            : error instanceof LeaseOwnershipError
              ? "Run lease ownership was lost"
              : "Node execution failed",
        reasonCode: retryable ? "transient_failure" : "node_failure",
        retryable,
        errorCategory: retryable
          ? "provider"
          : error instanceof CancelledOrchestrationError
            ? "cancelled"
            : error instanceof LeaseOwnershipError
              ? "storage"
              : "unknown",
        elapsedMs:
          (dependencies.now ?? (() => new Date()))().getTime() - started,
        elapsedLimitMs: state.budget.elapsedMs,
      })
      throw error
    }
  }
}

export async function emitInterruptEvent(
  dependencies: RuntimeDependencies,
  state: SyntheticStateValue,
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
