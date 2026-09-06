import { z } from "zod"

import {
  agentKindSchema,
  eventIdSchema,
  evidenceIdSchema,
  missionIdSchema,
  persistedTextSchema,
  reasonCodeSchema,
  runIdSchema,
  runStatusSchema,
  schemaVersionSchema,
  timestampSchema,
} from "./primitives.ts"

export const runEventKindSchema = z.enum([
  "run_status",
  "node_started",
  "node_completed",
  "mission_started",
  "mission_completed",
  "tool_started",
  "tool_completed",
  "evidence_gained",
  "budget_updated",
  "warning",
  "error",
  "interrupt_requested",
  "interrupt_resumed",
])

export const publicErrorSchema = z.strictObject({
  category: z.enum([
    "validation",
    "configuration",
    "authorization",
    "rate_limit",
    "timeout",
    "provider",
    "storage",
    "cancelled",
    "unknown",
  ]),
  code: reasonCodeSchema,
  message: persistedTextSchema,
  retryable: z.boolean(),
})

const budgetEventPayloadSchema = z.strictObject({
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

const runEventFields = {
  schemaVersion: schemaVersionSchema,
  id: eventIdSchema,
  runId: runIdSchema,
  sequence: z.number().int().positive(),
  occurredAt: timestampSchema,
  agent: agentKindSchema.optional(),
  missionId: missionIdSchema.optional(),
  graphName: reasonCodeSchema,
  nodeName: reasonCodeSchema.optional(),
  toolName: reasonCodeSchema.optional(),
  summary: persistedTextSchema,
  reasonCode: reasonCodeSchema,
  evidenceIds: z.array(evidenceIdSchema).max(100),
  budget: budgetEventPayloadSchema.optional(),
  error: publicErrorSchema.optional(),
}

const completionStatusSchema = z.enum(["completed", "failed", "blocked"])

export const runEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...runEventFields,
    kind: z.literal("run_status"),
    status: runStatusSchema,
  }),
  z.strictObject({
    ...runEventFields,
    kind: z.literal("node_started"),
    nodeName: reasonCodeSchema,
    status: z.literal("started"),
  }),
  z.strictObject({
    ...runEventFields,
    kind: z.literal("node_completed"),
    nodeName: reasonCodeSchema,
    status: completionStatusSchema,
  }),
  z.strictObject({
    ...runEventFields,
    kind: z.literal("mission_started"),
    agent: agentKindSchema,
    missionId: missionIdSchema,
    status: z.literal("started"),
  }),
  z.strictObject({
    ...runEventFields,
    kind: z.literal("mission_completed"),
    agent: agentKindSchema,
    missionId: missionIdSchema,
    status: completionStatusSchema,
  }),
  z.strictObject({
    ...runEventFields,
    kind: z.literal("tool_started"),
    agent: agentKindSchema,
    missionId: missionIdSchema,
    toolName: reasonCodeSchema,
    status: z.literal("started"),
  }),
  z.strictObject({
    ...runEventFields,
    kind: z.literal("tool_completed"),
    agent: agentKindSchema,
    missionId: missionIdSchema,
    toolName: reasonCodeSchema,
    status: completionStatusSchema,
  }),
  z.strictObject({
    ...runEventFields,
    kind: z.literal("evidence_gained"),
    status: z.literal("completed"),
    evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
  }),
  z.strictObject({
    ...runEventFields,
    kind: z.literal("budget_updated"),
    status: z.literal("completed"),
    budget: budgetEventPayloadSchema,
  }),
  z.strictObject({
    ...runEventFields,
    kind: z.literal("warning"),
    status: z.literal("warning"),
  }),
  z.strictObject({
    ...runEventFields,
    kind: z.literal("error"),
    status: z.literal("failed"),
    error: publicErrorSchema,
  }),
  z.strictObject({
    ...runEventFields,
    kind: z.literal("interrupt_requested"),
    status: z.literal("blocked"),
  }),
  z.strictObject({
    ...runEventFields,
    kind: z.literal("interrupt_resumed"),
    status: z.literal("completed"),
  }),
])

export type RunEvent = z.infer<typeof runEventSchema>
export type PublicError = z.infer<typeof publicErrorSchema>
