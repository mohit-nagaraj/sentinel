import {
  applicationIdSchema,
  executionBudgetSchema,
  persistedTextSchema,
  reasonCodeSchema,
  redactPersistedText,
  runIdSchema,
  terminalStatusSchema,
} from "@sentinel/contracts"
import { ReducedValue, StateSchema } from "@langchain/langgraph"
import { z } from "zod"

export const pendingReviewSchema = z.strictObject({
  decisionId: reasonCodeSchema,
  question: persistedTextSchema,
})

const resultListSchema = z
  .array(reasonCodeSchema)
  .max(64)
  .default(() => [])

export const SyntheticState = new StateSchema({
  runId: runIdSchema,
  applicationId: applicationIdSchema,
  graphName: reasonCodeSchema,
  budget: executionBudgetSchema,
  toolCallsUsed: z.number().int().nonnegative().default(0),
  modelCallsUsed: z.number().int().nonnegative().default(0),
  reconciliationRoundsUsed: z.number().int().nonnegative().default(0),
  steps: new ReducedValue(z.number().int().nonnegative().default(0), {
    inputSchema: z.number().int().nonnegative(),
    reducer: (current, next) => current + next,
  }),
  branchResults: new ReducedValue(resultListSchema, {
    inputSchema: z.union([reasonCodeSchema, resultListSchema]),
    reducer: (current, next) => {
      const additions = Array.isArray(next) ? next : [next]
      return [...new Set([...current, ...additions])]
    },
  }),
  effectIds: new ReducedValue(resultListSchema, {
    inputSchema: z.union([reasonCodeSchema, resultListSchema]),
    reducer: (current, next) => {
      const additions = Array.isArray(next) ? next : [next]
      return [...new Set([...current, ...additions])]
    },
  }),
  pendingReview: pendingReviewSchema.nullable().default(null),
  resumeDecisionId: reasonCodeSchema.nullable().default(null),
  resumeActorId: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9:._-]+$/)
    .nullable()
    .default(null),
  approved: z.boolean().nullable().default(null),
  terminalStatus: terminalStatusSchema.default("partial"),
  stopReason: reasonCodeSchema.nullable().default(null),
})

export type SyntheticStateValue = typeof SyntheticState.State
export type SyntheticStateUpdate = typeof SyntheticState.Update

export interface BudgetConsumption {
  readonly toolCalls?: number
  readonly modelCalls?: number
  readonly reconciliationRounds?: number
}

export function isBudgetAvailable(
  state: Pick<
    SyntheticStateValue,
    "budget" | "toolCallsUsed" | "modelCallsUsed" | "reconciliationRoundsUsed"
  >,
  consumption: BudgetConsumption
): boolean {
  const toolCalls = z
    .number()
    .int()
    .nonnegative()
    .parse(consumption.toolCalls ?? 0)
  const modelCalls = z
    .number()
    .int()
    .nonnegative()
    .parse(consumption.modelCalls ?? 0)
  const reconciliationRounds = z
    .number()
    .int()
    .nonnegative()
    .parse(consumption.reconciliationRounds ?? 0)
  return (
    state.toolCallsUsed + toolCalls <= state.budget.toolCalls &&
    state.modelCallsUsed + modelCalls <= state.budget.modelCalls &&
    state.reconciliationRoundsUsed + reconciliationRounds <=
      state.budget.reconciliationRounds
  )
}

export const syntheticStateValueSchema = z.strictObject({
  runId: runIdSchema,
  applicationId: applicationIdSchema,
  graphName: reasonCodeSchema,
  budget: executionBudgetSchema,
  toolCallsUsed: z.number().int().nonnegative(),
  modelCallsUsed: z.number().int().nonnegative(),
  reconciliationRoundsUsed: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  branchResults: resultListSchema,
  effectIds: resultListSchema,
  pendingReview: pendingReviewSchema.nullable(),
  resumeDecisionId: reasonCodeSchema.nullable(),
  resumeActorId: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9:._-]+$/)
    .nullable(),
  approved: z.boolean().nullable(),
  terminalStatus: terminalStatusSchema,
  stopReason: reasonCodeSchema.nullable(),
})

const forbiddenStateFields = new Set([
  "ast",
  "browser",
  "browserpage",
  "client",
  "credential",
  "document",
  "documentcontent",
  "dom",
  "domtree",
  "driver",
  "html",
  "neo4jcontents",
  "pageobject",
  "password",
  "prompt",
  "rawdocument",
  "rawsource",
  "secret",
  "sourcecode",
])
const sensitiveStateSegments = new Set([
  "auth",
  "authorization",
  "cookie",
  "credential",
  "password",
  "secret",
  "session",
  "sid",
  "signature",
  "token",
])
const sensitiveStateFields = new Set([
  "accesskey",
  "accesskeyid",
  "apikey",
  "clientsecret",
  "privatekey",
  "sessionid",
])

function assertCompactValue(value: unknown, depth = 0): void {
  if (depth > 12) throw new Error("Checkpoint state exceeds maximum depth")
  if (typeof value === "string") {
    if (value.length > 4_096 || redactPersistedText(value) !== value) {
      throw new Error("Checkpoint state contains unsafe text")
    }
    return
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return
  }
  if (Array.isArray(value)) {
    if (value.length > 512) throw new Error("Checkpoint array is too large")
    value.forEach((item) => assertCompactValue(item, depth + 1))
    return
  }
  if (typeof value !== "object") {
    throw new Error("Checkpoint state contains a non-serializable value")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Checkpoint state contains a live runtime object")
  }
  const entries = Object.entries(value)
  if (entries.length > 128) throw new Error("Checkpoint object is too large")
  for (const [key, child] of entries) {
    const segments = key
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
    const normalized = segments.join("")
    const sensitiveKeyPair = segments.some(
      (segment, index) =>
        ["access", "api", "private"].includes(segment) &&
        segments[index + 1] === "key"
    )
    if (
      forbiddenStateFields.has(normalized) ||
      sensitiveStateFields.has(normalized) ||
      sensitiveKeyPair ||
      segments.some((segment) => sensitiveStateSegments.has(segment))
    ) {
      throw new Error("Checkpoint state contains a forbidden field")
    }
    assertCompactValue(child, depth + 1)
  }
}

export function assertCompactCheckpointState(input: unknown): void {
  assertCompactValue(input)
  let serialized: string
  try {
    serialized = JSON.stringify(input)
  } catch {
    throw new Error("Checkpoint state is not JSON serializable")
  }
  if (Buffer.byteLength(serialized, "utf8") > 65_536) {
    throw new Error("Checkpoint state exceeds 64 KiB")
  }
}

export function parseSyntheticState(input: unknown): SyntheticStateValue {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return syntheticStateValueSchema.parse(input)
  }
  const stateOnly = Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== "__interrupt__")
  )
  const parsed = syntheticStateValueSchema.parse(stateOnly)
  assertCompactCheckpointState(parsed)
  return parsed
}
