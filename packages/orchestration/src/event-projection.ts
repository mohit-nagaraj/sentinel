import {
  createEventId,
  contentHashSchema,
  evidenceIdSchema,
  hashCanonical,
  agentKindSchema,
  missionIdSchema,
  parseRunEvent,
  reasonCodeSchema,
  runActivityDisplaySchema,
  runIdSchema,
  type RunEvent,
} from "@sentinel/contracts"
import { randomUUID } from "node:crypto"
import { z } from "zod"

import type { OrchestrationEvent, OrchestrationEventSink } from "./runtime.ts"

export type AppendRunEvent = (
  event: RunEvent,
  idempotencyKey: string
) => Promise<unknown>

const customProjectionSchema = z.strictObject({
  nodeName: z.string(),
  toolName: z.string().optional(),
  phase: z.enum(["started", "completed"]),
  activity: runActivityDisplaySchema.optional(),
})

export function projectLangGraphEmission(
  emission:
    | { readonly mode: "updates"; readonly data: unknown }
    | { readonly mode: "custom"; readonly data: unknown },
  context: {
    readonly runId: string
    readonly graphName: string
    readonly occurredAt: string
    readonly agent?: OrchestrationEvent["agent"]
    readonly missionId?: string
    readonly evidenceIds?: readonly string[]
  }
): OrchestrationEvent {
  const parsedContext = {
    runId: runIdSchema.parse(context.runId),
    graphName: reasonCodeSchema.parse(context.graphName),
    occurredAt: z.iso.datetime({ offset: true }).parse(context.occurredAt),
    ...(context.agent === undefined
      ? {}
      : { agent: agentKindSchema.parse(context.agent) }),
    ...(context.missionId === undefined
      ? {}
      : { missionId: missionIdSchema.parse(context.missionId) }),
    evidenceIds: (context.evidenceIds ?? []).map((id) =>
      evidenceIdSchema.parse(id)
    ),
  }
  if (emission.mode === "updates") {
    const data = z.record(z.string(), z.unknown()).parse(emission.data)
    const nodeNames = Object.keys(data)
    if (nodeNames.length !== 1) {
      throw new Error("LangGraph update projection requires one node")
    }
    const nodeName = reasonCodeSchema.parse(nodeNames[0])
    return {
      ...parsedContext,
      nodeName,
      kind: "node_completed",
      status: "completed",
      summary: "LangGraph state update committed",
      reasonCode: "state_update_committed",
    }
  }
  const custom = customProjectionSchema.parse(emission.data)
  return {
    ...parsedContext,
    nodeName: reasonCodeSchema.parse(custom.nodeName),
    ...(custom.toolName === undefined
      ? {}
      : { toolName: reasonCodeSchema.parse(custom.toolName) }),
    kind: custom.phase === "started" ? "tool_started" : "tool_completed",
    status: custom.phase,
    summary:
      custom.phase === "started"
        ? "Custom tool lifecycle started"
        : "Custom tool lifecycle completed",
    reasonCode:
      custom.phase === "started"
        ? "custom_tool_started"
        : "custom_tool_completed",
    ...(custom.activity === undefined ? {} : { activity: custom.activity }),
  }
}

export class DurableRunEventSink implements OrchestrationEventSink {
  private sequence = 0
  private readonly instanceId = randomUUID()

  constructor(private readonly appendRunEvent: AppendRunEvent) {}

  async append(
    event: OrchestrationEvent,
    options?: { readonly idempotencyKey?: string }
  ): Promise<void> {
    this.sequence += 1
    const runId = runIdSchema.parse(event.runId)
    const missionId = missionIdSchema.parse(
      `mission:v1:${hashCanonical({
        graphName: event.graphName,
        kind: "synthetic_runtime",
        runId,
      }).slice("sha256:".length)}`
    )
    const common = {
      schemaVersion: 1 as const,
      id: createEventId(runId, this.sequence),
      runId,
      sequence: this.sequence,
      occurredAt: event.occurredAt,
      graphName: event.graphName,
      nodeName: event.nodeName,
      summary: event.summary,
      reasonCode: event.reasonCode,
      ...(event.activity === undefined ? {} : { activity: event.activity }),
      evidenceIds: [...(event.evidenceIds ?? [])],
      ...(event.agent === undefined ? {} : { agent: event.agent }),
      ...(event.missionId === undefined ? {} : { missionId: event.missionId }),
      ...(event.budget !== undefined
        ? { budget: event.budget }
        : event.elapsedMs === undefined || event.elapsedLimitMs === undefined
          ? {}
          : {
              budget: {
                consumed: event.elapsedMs,
                limit: event.elapsedLimitMs,
                unit: "elapsed_ms" as const,
              },
            }),
    }
    const projected = (() => {
      switch (event.kind) {
        case "node_started":
          return { ...common, kind: event.kind, status: "started" as const }
        case "node_completed":
          return { ...common, kind: event.kind, status: "completed" as const }
        case "mission_started":
          return {
            ...common,
            kind: event.kind,
            status: "started" as const,
            agent: event.agent ?? ("system" as const),
            missionId: event.missionId ?? missionId,
          }
        case "mission_completed":
          return {
            ...common,
            kind: event.kind,
            status:
              event.status === "failed"
                ? ("failed" as const)
                : event.status === "blocked"
                  ? ("blocked" as const)
                  : ("completed" as const),
            agent: event.agent ?? ("system" as const),
            missionId: event.missionId ?? missionId,
          }
        case "tool_started":
          return {
            ...common,
            kind: event.kind,
            status: "started" as const,
            agent: event.agent ?? ("system" as const),
            missionId: event.missionId ?? missionId,
            toolName: event.toolName,
          }
        case "tool_completed":
          return {
            ...common,
            kind: event.kind,
            status: "completed" as const,
            agent: event.agent ?? ("system" as const),
            missionId: event.missionId ?? missionId,
            toolName: event.toolName,
          }
        case "evidence_gained":
          return {
            ...common,
            kind: event.kind,
            status: "completed" as const,
            agent: event.agent ?? ("system" as const),
            missionId: event.missionId ?? missionId,
          }
        case "budget_updated":
          return { ...common, kind: event.kind, status: "completed" as const }
        case "interrupt_requested":
          return { ...common, kind: event.kind, status: "blocked" as const }
        case "interrupt_resumed":
          return { ...common, kind: event.kind, status: "completed" as const }
        case "warning":
          return { ...common, kind: event.kind, status: "warning" as const }
        case "error":
          return {
            ...common,
            kind: event.kind,
            status: "failed" as const,
            error: {
              category: event.errorCategory ?? "unknown",
              code: event.reasonCode,
              message: event.summary,
              retryable: event.retryable ?? false,
            },
          }
      }
    })()
    const parsed = parseRunEvent(projected)
    const idempotencyKey =
      options?.idempotencyKey === undefined
        ? hashCanonical({
            kind: "unkeyed_orchestration_event",
            instanceId: this.instanceId,
            sequence: this.sequence,
            event: parsed,
          })
        : contentHashSchema.parse(options.idempotencyKey)
    await this.appendRunEvent(parsed, idempotencyKey)
  }
}
