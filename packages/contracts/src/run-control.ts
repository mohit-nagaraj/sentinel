import { z } from "zod"

import { hashCanonical } from "./identity.ts"
import { publicErrorSchema } from "./events.ts"
import {
  commitShaSchema,
  contentHashSchema,
  persistedTextSchema,
  reasonCodeSchema,
  runStatusSchema,
  runTypeSchema,
  schemaVersionSchema,
  timestampSchema,
} from "./primitives.ts"
import { executionBudgetSchema } from "./operations.ts"

export const databaseApplicationIdSchema = z.uuid()
export const databaseRunIdSchema = z.uuid()
export const databaseInterruptIdSchema = z.uuid()

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9:._/-]+$/)

const emptyPayloadSchema = z.strictObject({})
const pullRequestPayloadSchema = z.strictObject({
  pullRequestNumber: z.number().int().positive(),
  baseSha: commitShaSchema,
  headSha: commitShaSchema,
})

export const runCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    applicationId: databaseApplicationIdSchema,
    type: z.literal("inspect_application"),
    idempotencyKey: idempotencyKeySchema,
    budget: executionBudgetSchema,
    payload: emptyPayloadSchema,
  }),
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    applicationId: databaseApplicationIdSchema,
    type: z.literal("initialize_knowledge"),
    idempotencyKey: idempotencyKeySchema,
    budget: executionBudgetSchema,
    payload: emptyPayloadSchema,
  }),
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    applicationId: databaseApplicationIdSchema,
    type: z.literal("refresh_knowledge"),
    idempotencyKey: idempotencyKeySchema,
    budget: executionBudgetSchema,
    payload: emptyPayloadSchema,
  }),
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    applicationId: databaseApplicationIdSchema,
    type: z.literal("assess_pr"),
    idempotencyKey: idempotencyKeySchema,
    budget: executionBudgetSchema,
    payload: pullRequestPayloadSchema,
  }),
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    applicationId: databaseApplicationIdSchema,
    type: z.literal("verify_pr"),
    idempotencyKey: idempotencyKeySchema,
    budget: executionBudgetSchema,
    payload: z.strictObject({ assessmentId: z.uuid() }),
  }),
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    applicationId: databaseApplicationIdSchema,
    type: z.literal("run_eval"),
    idempotencyKey: idempotencyKeySchema,
    budget: executionBudgetSchema,
    payload: z.strictObject({ fixtureKey: reasonCodeSchema }),
  }),
])

export const runRequestFingerprintSchema = contentHashSchema

export function createRunRequestFingerprint(input: unknown): string {
  const command = runCommandSchema.parse(input)
  return hashCanonical({
    applicationId: command.applicationId,
    budget: command.budget,
    payload: command.payload,
    type: command.type,
  })
}

export const publicRunSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: databaseRunIdSchema,
  applicationId: databaseApplicationIdSchema,
  type: runTypeSchema,
  status: runStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  retryOf: databaseRunIdSchema.optional(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional(),
  cancelRequestedAt: timestampSchema.optional(),
  error: publicErrorSchema.optional(),
})

export const runCursorSchema = z.strictObject({
  createdAt: timestampSchema,
  id: databaseRunIdSchema,
})
export const eventCursorSchema = z.number().int().nonnegative()
export const pageLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(100)
  .default(25)

export const runPageSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  items: z.array(publicRunSchema).max(100),
  nextCursor: runCursorSchema.optional(),
})

export const runEventPageItemSchema = z.strictObject({
  sequence: z.number().int().positive(),
  event: z.unknown(),
})
export const runEventPageSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  items: z.array(runEventPageItemSchema).max(100),
  nextCursor: eventCursorSchema.optional(),
})

export const humanDecisionSchema = z.strictObject({
  approved: z.boolean(),
  note: persistedTextSchema.max(4_096).optional(),
})

export const publicRunInterruptSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: databaseInterruptIdSchema,
  runId: databaseRunIdSchema,
  decisionId: reasonCodeSchema,
  prompt: persistedTextSchema.max(4_096),
  status: z.enum(["pending", "responded"]),
  createdAt: timestampSchema,
  respondedAt: timestampSchema.optional(),
})

export const retryRunCommandSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  runId: databaseRunIdSchema,
  idempotencyKey: idempotencyKeySchema,
})

export const interruptResponseCommandSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  runId: databaseRunIdSchema,
  decisionId: reasonCodeSchema,
  response: humanDecisionSchema,
})

export const controlMutationResultSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  run: publicRunSchema,
  idempotent: z.boolean(),
})

export const readinessDependencySchema = z.strictObject({
  name: z.enum(["storage", "worker", "model", "browser", "github"]),
  status: z.enum(["ready", "degraded", "unconfigured"]),
})
export const controlReadinessSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  service: z.literal("control-plane"),
  status: z.enum(["ready", "degraded"]),
  dependencies: z.array(readinessDependencySchema).min(1).max(5),
})

export type RunCommand = z.infer<typeof runCommandSchema>
export type PublicRun = z.infer<typeof publicRunSchema>
export type PublicRunInterrupt = z.infer<typeof publicRunInterruptSchema>
export type HumanDecision = z.infer<typeof humanDecisionSchema>
export type RunCursor = z.infer<typeof runCursorSchema>
