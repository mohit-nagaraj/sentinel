import { z } from "zod"

import {
  agentKindSchema,
  eventIdSchema,
  evidenceIdSchema,
  missionIdSchema,
  nonEmptyStringSchema,
  reasonCodeSchema,
  runIdSchema,
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
  message: nonEmptyStringSchema,
  retryable: z.boolean(),
})

export const runEventSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: eventIdSchema,
  runId: runIdSchema,
  sequence: z.number().int().positive(),
  kind: runEventKindSchema,
  occurredAt: timestampSchema,
  agent: agentKindSchema.optional(),
  missionId: missionIdSchema.optional(),
  graphName: reasonCodeSchema,
  nodeName: reasonCodeSchema.optional(),
  toolName: reasonCodeSchema.optional(),
  status: z.enum(["started", "completed", "warning", "failed", "blocked"]),
  summary: nonEmptyStringSchema,
  reasonCode: reasonCodeSchema,
  evidenceIds: z.array(evidenceIdSchema).max(100),
  budget: z
    .strictObject({
      consumed: z.number().int().nonnegative(),
      limit: z.number().int().nonnegative(),
      unit: z.enum([
        "tool_calls",
        "content_bytes",
        "source_lines",
        "browser_actions",
        "model_calls",
        "input_tokens",
        "output_tokens",
        "elapsed_ms",
      ]),
    })
    .optional(),
  error: publicErrorSchema.optional(),
})

export type RunEvent = z.infer<typeof runEventSchema>
export type PublicError = z.infer<typeof publicErrorSchema>
