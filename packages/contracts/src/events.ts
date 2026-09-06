import { z } from "zod"

import {
  agentKindSchema,
  eventIdSchema,
  evidenceIdSchema,
  missionIdSchema,
  persistedTextSchema,
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
  message: persistedTextSchema,
  retryable: z.boolean(),
})

export const runEventSchema = z
  .strictObject({
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
    summary: persistedTextSchema,
    reasonCode: reasonCodeSchema,
    evidenceIds: z.array(evidenceIdSchema).max(100),
    budget: z
      .strictObject({
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
      .optional(),
    error: publicErrorSchema.optional(),
  })
  .superRefine(({ budget, kind }, context) => {
    if (kind === "budget_updated" && budget === undefined) {
      context.addIssue({
        code: "custom",
        message: "budget_updated events require a budget payload",
        path: ["budget"],
      })
    }
  })

export type RunEvent = z.infer<typeof runEventSchema>
export type PublicError = z.infer<typeof publicErrorSchema>
