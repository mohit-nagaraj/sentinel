import {
  actionIdSchema,
  agentKindSchema,
  artifactIdSchema,
  claimIdSchema,
  contentHashSchema,
  discoveryMissionSchema,
  evidenceIdSchema,
  executionBudgetSchema,
  missionIdSchema,
  missionResultSchema,
  persistedTextSchema,
  reasonCodeSchema,
  redactPersistedText,
  repositoryPathSchema,
  sourceUriSchema,
  stableEntityIdSchema,
  type DiscoveryMission,
  type MissionBudget,
  type MissionResult,
} from "@sentinel/contracts"
import { Overwrite, ReducedValue, StateSchema } from "@langchain/langgraph"
import { z } from "zod"

import { assertCompactCheckpointState } from "../state.ts"

const MAX_DECISIONS = 64
const MAX_TOOL_CALLS = 128
const MAX_OBSERVATIONS = 128
const MAX_PROGRESS_EVALUATIONS = 128
const MAX_BUDGET_ENTRIES = MAX_DECISIONS + MAX_TOOL_CALLS
const MAX_ARGUMENT_BYTES = 8_192

export const specialistAgentSchema = agentKindSchema.exclude([
  "curator",
  "system",
])

export const specialistKernelIdentitySchema = z.strictObject({
  graphName: reasonCodeSchema,
  promptTemplateId: reasonCodeSchema,
  configurationFingerprint: contentHashSchema,
  startedAtMs: z.number().int().nonnegative(),
})

export const specialistCallIdSchema = reasonCodeSchema

const compactTextSchema = persistedTextSchema.refine(
  (value) => value.length <= 512,
  "Compact text cannot exceed 512 characters"
)

export type CompactToolValue =
  | null
  | boolean
  | number
  | string
  | CompactToolValue[]
  | { readonly [key: string]: CompactToolValue }

const compactToolValueSchema: z.ZodType<CompactToolValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z
      .string()
      .max(4_096)
      .refine((value) => redactPersistedText(value) === value, {
        message: "Tool arguments contain unsafe text",
      }),
    z.array(compactToolValueSchema).max(64),
    z
      .record(z.string().min(1).max(96), compactToolValueSchema)
      .refine((value) => Object.keys(value).length <= 32, {
        message: "Tool argument objects cannot exceed 32 fields",
      }),
  ])
)

export const compactToolArgumentsSchema = z
  .record(z.string().min(1).max(96), compactToolValueSchema)
  .refine((value) => Object.keys(value).length <= 32, {
    message: "Tool arguments cannot exceed 32 fields",
  })
  .superRefine((value, context) => {
    try {
      assertSafeSpecialistValue(value)
      const serialized = JSON.stringify(value)
      if (Buffer.byteLength(serialized, "utf8") > MAX_ARGUMENT_BYTES) {
        context.addIssue({
          code: "custom",
          message: `Tool arguments cannot exceed ${MAX_ARGUMENT_BYTES} bytes`,
        })
      }
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "Unsafe tool arguments",
      })
    }
  })

export const compactReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("evidence"), id: evidenceIdSchema }),
  z.strictObject({ kind: z.literal("claim"), id: claimIdSchema }),
  z.strictObject({ kind: z.literal("entity"), id: stableEntityIdSchema }),
  z.strictObject({ kind: z.literal("artifact"), id: artifactIdSchema }),
  z.strictObject({ kind: z.literal("action"), id: actionIdSchema }),
  z.strictObject({ kind: z.literal("content_hash"), id: contentHashSchema }),
  z.strictObject({ kind: z.literal("source_uri"), id: sourceUriSchema }),
  z.strictObject({
    kind: z.literal("repository_path"),
    id: repositoryPathSchema,
  }),
])

const specialistDecisionBase = {
  decisionId: specialistCallIdSchema,
  missionId: missionIdSchema,
  agent: specialistAgentSchema,
  stateFingerprint: contentHashSchema,
  decisionHash: contentHashSchema,
} as const

export const specialistDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...specialistDecisionBase,
    kind: z.literal("tool_calls"),
    callIds: z
      .array(specialistCallIdSchema)
      .min(1)
      .max(16)
      .transform((values) => [...new Set(values)].sort(compareStrings)),
  }),
  z.strictObject({
    ...specialistDecisionBase,
    kind: z.literal("continue"),
    progressFingerprint: contentHashSchema,
  }),
  z.strictObject({
    ...specialistDecisionBase,
    kind: z.literal("needs_human"),
    interruptFingerprint: contentHashSchema,
  }),
  z.strictObject({
    ...specialistDecisionBase,
    kind: z.literal("finish"),
    resultHash: contentHashSchema,
  }),
])

export const pendingToolCallSchema = z.strictObject({
  callId: specialistCallIdSchema,
  decisionId: specialistCallIdSchema,
  missionId: missionIdSchema,
  agent: specialistAgentSchema,
  toolName: reasonCodeSchema,
  requestHash: contentHashSchema,
  arguments: compactToolArgumentsSchema,
  preflightUsage: executionBudgetSchema,
})

const sortedEvidenceIdsSchema = z
  .array(evidenceIdSchema)
  .max(64)
  .transform((values) => [...new Set(values)].sort(compareStrings))

const sortedReferencesSchema = z
  .array(compactReferenceSchema)
  .max(64)
  .transform((values) =>
    dedupeCanonical(values).sort((left, right) =>
      compareStrings(canonicalStringify(left), canonicalStringify(right))
    )
  )

export const compactObservationSchema = z.strictObject({
  callId: specialistCallIdSchema,
  decisionId: specialistCallIdSchema,
  missionId: missionIdSchema,
  agent: specialistAgentSchema,
  toolName: reasonCodeSchema,
  requestHash: contentHashSchema,
  resultHash: contentHashSchema,
  outcome: z.enum(["succeeded", "failed"]),
  summary: compactTextSchema,
  evidenceIds: sortedEvidenceIdsSchema.default(() => []),
  references: sortedReferencesSchema.default(() => []),
})

export const completedToolCallSchema = z.strictObject({
  callId: specialistCallIdSchema,
  decisionId: specialistCallIdSchema,
  missionId: missionIdSchema,
  agent: specialistAgentSchema,
  toolName: reasonCodeSchema,
  requestHash: contentHashSchema,
  resultHash: contentHashSchema,
  outcome: z.enum(["succeeded", "failed"]),
  preflightUsage: executionBudgetSchema.optional(),
  usage: executionBudgetSchema,
})

export const progressEvaluationSchema = z.strictObject({
  sequence: z.number().int().nonnegative().max(10_000),
  decisionId: specialistCallIdSchema,
  fingerprint: contentHashSchema,
  madeProgress: z.boolean(),
})

export const specialistProgressSchema = z.strictObject({
  evaluations: z.array(progressEvaluationSchema).max(MAX_PROGRESS_EVALUATIONS),
  fingerprints: z.array(contentHashSchema).max(MAX_PROGRESS_EVALUATIONS),
  steps: z.number().int().nonnegative().max(MAX_PROGRESS_EVALUATIONS),
  totalNoProgress: z.number().int().nonnegative().max(MAX_PROGRESS_EVALUATIONS),
  consecutiveNoProgress: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_PROGRESS_EVALUATIONS),
  lastDecisionId: specialistCallIdSchema.nullable(),
  lastFingerprint: contentHashSchema.nullable(),
})

const humanInterruptBase = {
  decisionId: specialistCallIdSchema,
  missionId: missionIdSchema,
  agent: specialistAgentSchema,
  reasonCode: reasonCodeSchema,
  question: compactTextSchema,
  contextFingerprint: contentHashSchema,
} as const

export const humanInterruptStateSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...humanInterruptBase,
    status: z.literal("pending"),
  }),
  z.strictObject({
    ...humanInterruptBase,
    status: z.literal("resolved"),
    actorId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9:._-]+$/),
    approved: z.boolean(),
  }),
])

export const budgetUsageDeltaSchema = executionBudgetSchema.partial()

const budgetLedgerIdentity = {
  missionId: missionIdSchema,
  agent: specialistAgentSchema,
  usage: executionBudgetSchema,
} as const

export const budgetLedgerEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...budgetLedgerIdentity,
    kind: z.literal("model_decision"),
    decisionId: specialistCallIdSchema,
  }),
  z.strictObject({
    ...budgetLedgerIdentity,
    kind: z.literal("tool_call"),
    decisionId: specialistCallIdSchema,
    callId: specialistCallIdSchema,
  }),
])

export const budgetLedgerSchema = z.strictObject({
  entries: z.array(budgetLedgerEntrySchema).max(MAX_BUDGET_ENTRIES),
  total: executionBudgetSchema,
})

const decisionListSchema = z
  .array(specialistDecisionSchema)
  .max(MAX_DECISIONS)
  .default(() => [])
const pendingToolCallListSchema = z
  .array(pendingToolCallSchema)
  .max(MAX_TOOL_CALLS)
  .default(() => [])
const compactObservationListSchema = z
  .array(compactObservationSchema)
  .max(MAX_OBSERVATIONS)
  .default(() => [])
const completedToolCallListSchema = z
  .array(completedToolCallSchema)
  .max(MAX_TOOL_CALLS)
  .default(() => [])
const budgetLedgerUpdateSchema = z.union([
  budgetLedgerEntrySchema,
  z.array(budgetLedgerEntrySchema).max(MAX_BUDGET_ENTRIES),
  budgetLedgerSchema,
])

const decisionUpdateSchema = z.union([
  specialistDecisionSchema,
  z.array(specialistDecisionSchema).max(MAX_DECISIONS),
])
const pendingToolCallUpdateSchema = z.union([
  pendingToolCallSchema,
  z.array(pendingToolCallSchema).max(MAX_TOOL_CALLS),
  z
    .strictObject({
      upsert: z
        .array(pendingToolCallSchema)
        .max(MAX_TOOL_CALLS)
        .default(() => []),
      removeCallIds: z
        .array(specialistCallIdSchema)
        .max(MAX_TOOL_CALLS)
        .default(() => []),
    })
    .refine(
      ({ removeCallIds, upsert }) =>
        !upsert.some((call) => removeCallIds.includes(call.callId)),
      "A pending call cannot be upserted and removed in the same update"
    ),
])
const compactObservationUpdateSchema = z.union([
  compactObservationSchema,
  z.array(compactObservationSchema).max(MAX_OBSERVATIONS),
])
const completedToolCallUpdateSchema = z.union([
  completedToolCallSchema,
  z.array(completedToolCallSchema).max(MAX_TOOL_CALLS),
])
const progressUpdateSchema = z.union([
  progressEvaluationSchema,
  z.array(progressEvaluationSchema).max(MAX_PROGRESS_EVALUATIONS),
  specialistProgressSchema,
])

export const EMPTY_BUDGET_USAGE: MissionBudget = {
  toolCalls: 0,
  contentBytes: 0,
  documentBytes: 0,
  documentPages: 0,
  documentSections: 0,
  sourceLines: 0,
  repositoryBytes: 0,
  repositoryFiles: 0,
  browserActions: 0,
  modelCalls: 0,
  modelInputTokens: 0,
  modelOutputTokens: 0,
  reconciliationRounds: 0,
  elapsedMs: 0,
}

export const EMPTY_BUDGET_LEDGER: z.infer<typeof budgetLedgerSchema> = {
  entries: [],
  total: EMPTY_BUDGET_USAGE,
}

export const EMPTY_SPECIALIST_PROGRESS: z.infer<
  typeof specialistProgressSchema
> = {
  evaluations: [],
  fingerprints: [],
  steps: 0,
  totalNoProgress: 0,
  consecutiveNoProgress: 0,
  lastDecisionId: null,
  lastFingerprint: null,
}

export function reduceSpecialistDecisions(
  current: readonly z.infer<typeof specialistDecisionSchema>[],
  next: z.input<typeof decisionUpdateSchema>
) {
  const parsed = decisionUpdateSchema.parse(next)
  const decisions = mergeByIdentity(
    decisionListSchema.parse(current),
    Array.isArray(parsed) ? parsed : [parsed],
    (decision) => decision.decisionId,
    MAX_DECISIONS,
    "decision"
  )
  assertUniformSpecialistIdentity(decisions, "decision")
  assertUniqueCallOwnership(decisions)
  return assertSafeChannelValue(decisions)
}

export function reducePendingToolCalls(
  current: readonly z.infer<typeof pendingToolCallSchema>[],
  next: z.input<typeof pendingToolCallUpdateSchema>
) {
  const parsed = pendingToolCallUpdateSchema.parse(next)
  const update =
    Array.isArray(parsed) || "callId" in parsed
      ? { upsert: Array.isArray(parsed) ? parsed : [parsed], removeCallIds: [] }
      : parsed
  const removals = new Set(update.removeCallIds)
  const retained = pendingToolCallListSchema
    .parse(current)
    .filter((call) => !removals.has(call.callId))
  const calls = mergeByIdentity(
    retained,
    update.upsert,
    (call) => call.callId,
    MAX_TOOL_CALLS,
    "pending tool call"
  )
  assertUniformSpecialistIdentity(calls, "pending tool call")
  return assertSafeChannelValue(calls)
}

export function reduceCompactObservations(
  current: readonly z.infer<typeof compactObservationSchema>[],
  next: z.input<typeof compactObservationUpdateSchema>
) {
  const parsed = compactObservationUpdateSchema.parse(next)
  const observations = mergeByIdentity(
    compactObservationListSchema.parse(current),
    Array.isArray(parsed) ? parsed : [parsed],
    (observation) => observation.callId,
    MAX_OBSERVATIONS,
    "observation"
  )
  assertUniformSpecialistIdentity(observations, "observation")
  return assertSafeChannelValue(observations)
}

export function reduceCompletedToolCalls(
  current: readonly z.infer<typeof completedToolCallSchema>[],
  next: z.input<typeof completedToolCallUpdateSchema>
) {
  const parsed = completedToolCallUpdateSchema.parse(next)
  const calls = mergeByIdentity(
    completedToolCallListSchema.parse(current),
    Array.isArray(parsed) ? parsed : [parsed],
    (call) => call.callId,
    MAX_TOOL_CALLS,
    "completed tool call"
  )
  assertUniformSpecialistIdentity(calls, "completed tool call")
  return assertSafeChannelValue(calls)
}

const budgetKeys = Object.keys(EMPTY_BUDGET_USAGE) as (keyof MissionBudget)[]

export function reduceBudgetLedger(
  current: z.infer<typeof budgetLedgerSchema>,
  next: z.input<typeof budgetLedgerUpdateSchema>
) {
  const parsedCurrent = budgetLedgerSchema.parse(current)
  const parsed = budgetLedgerUpdateSchema.parse(next)
  const additions = Array.isArray(parsed)
    ? parsed
    : "entries" in parsed
      ? parsed.entries
      : [parsed]
  return deriveBudgetLedger([...parsedCurrent.entries, ...additions])
}

function deriveBudgetLedger(
  values: readonly z.infer<typeof budgetLedgerEntrySchema>[]
) {
  const entries = mergeByIdentity(
    [],
    values,
    budgetLedgerEntryKey,
    MAX_BUDGET_ENTRIES,
    "budget ledger entry"
  )
  assertUniformSpecialistIdentity(entries, "budget ledger entry")
  const total = entries.reduce<MissionBudget>(
    (current, entry) => addBudgetUsage(current, entry.usage),
    EMPTY_BUDGET_USAGE
  )
  return assertSafeChannelValue(budgetLedgerSchema.parse({ entries, total }))
}

function addBudgetUsage(
  current: MissionBudget,
  next: MissionBudget
): MissionBudget {
  const parsedCurrent = executionBudgetSchema.parse(current)
  const parsedNext = executionBudgetSchema.parse(next)
  return executionBudgetSchema.parse(
    Object.fromEntries(
      budgetKeys.map((key) => [key, parsedCurrent[key] + parsedNext[key]])
    )
  )
}

export function reduceSpecialistProgress(
  current: z.infer<typeof specialistProgressSchema>,
  next: z.input<typeof progressUpdateSchema>
) {
  const parsedCurrent = specialistProgressSchema.parse(current)
  const parsed = progressUpdateSchema.parse(next)
  const additions = Array.isArray(parsed)
    ? parsed
    : "evaluations" in parsed
      ? parsed.evaluations
      : [parsed]
  return deriveSpecialistProgress([...parsedCurrent.evaluations, ...additions])
}

function deriveSpecialistProgress(
  values: readonly z.infer<typeof progressEvaluationSchema>[]
) {
  const evaluations = mergeByIdentity(
    [],
    values,
    (evaluation) => evaluation.decisionId,
    MAX_PROGRESS_EVALUATIONS,
    "progress evaluation"
  ).sort(
    (left, right) =>
      left.sequence - right.sequence ||
      compareStrings(left.decisionId, right.decisionId)
  )

  for (let index = 1; index < evaluations.length; index += 1) {
    if (evaluations[index]?.sequence === evaluations[index - 1]?.sequence) {
      throw new Error("Progress evaluation sequence is already assigned")
    }
  }

  const fingerprints: z.infer<typeof contentHashSchema>[] = []
  let consecutiveNoProgress = 0
  let totalNoProgress = 0
  for (const evaluation of evaluations) {
    if (!fingerprints.includes(evaluation.fingerprint)) {
      fingerprints.push(evaluation.fingerprint)
    }
    if (evaluation.madeProgress) {
      consecutiveNoProgress = 0
    } else {
      consecutiveNoProgress += 1
      totalNoProgress += 1
    }
  }
  const last = evaluations.at(-1)
  return assertSafeChannelValue(
    specialistProgressSchema.parse({
      evaluations,
      fingerprints,
      steps: evaluations.length,
      totalNoProgress,
      consecutiveNoProgress,
      lastDecisionId: last?.decisionId ?? null,
      lastFingerprint: last?.fingerprint ?? null,
    })
  )
}

export function reduceHumanInterrupt(
  current: z.infer<typeof humanInterruptStateSchema> | null,
  next: z.input<typeof humanInterruptStateSchema> | null
) {
  const parsedCurrent = humanInterruptStateSchema.nullable().parse(current)
  const parsedNext = humanInterruptStateSchema.nullable().parse(next)
  if (parsedNext === null) {
    return assertSafeChannelValue(
      parsedCurrent?.status === "resolved" ? null : parsedCurrent
    )
  }
  if (parsedCurrent === null) return assertSafeChannelValue(parsedNext)
  if (parsedCurrent.status === "resolved" && parsedNext.status === "pending") {
    try {
      assertSameInterruptIdentity(parsedCurrent, parsedNext)
      return assertSafeChannelValue(parsedCurrent)
    } catch {
      return assertSafeChannelValue(parsedNext)
    }
  }
  assertSameInterruptIdentity(parsedCurrent, parsedNext)
  if (
    parsedCurrent.status === "resolved" &&
    parsedNext.status === "resolved" &&
    canonicalStringify(parsedCurrent) !== canonicalStringify(parsedNext)
  ) {
    throw new Error("Human interrupt resolution conflicts with durable state")
  }
  return assertSafeChannelValue(parsedNext)
}

export function reduceTerminalResult(
  current: MissionResult | null,
  next: MissionResult | null
): MissionResult | null {
  const parsedCurrent = missionResultSchema.nullable().parse(current)
  const parsedNext = missionResultSchema.nullable().parse(next)
  if (parsedNext === null) {
    return assertSafeChannelValue(
      parsedCurrent?.status === "needs_human" ? null : parsedCurrent
    )
  }
  if (parsedCurrent === null) return assertSafeChannelValue(parsedNext)
  if (
    parsedCurrent.status === "needs_human" &&
    parsedNext.status !== "needs_human" &&
    parsedCurrent.missionId === parsedNext.missionId
  ) {
    return assertSafeChannelValue(parsedNext)
  }
  if (canonicalStringify(parsedCurrent) !== canonicalStringify(parsedNext)) {
    throw new Error("Terminal result conflicts with durable state")
  }
  return assertSafeChannelValue(parsedCurrent)
}

export const SpecialistState = new StateSchema({
  mission: discoveryMissionSchema,
  agent: specialistAgentSchema,
  kernel: specialistKernelIdentitySchema,
  decisions: new ReducedValue(decisionListSchema, {
    inputSchema: decisionUpdateSchema,
    reducer: reduceSpecialistDecisions,
  }),
  pendingToolCalls: new ReducedValue(pendingToolCallListSchema, {
    inputSchema: pendingToolCallUpdateSchema,
    reducer: reducePendingToolCalls,
  }),
  observations: new ReducedValue(compactObservationListSchema, {
    inputSchema: compactObservationUpdateSchema,
    reducer: reduceCompactObservations,
  }),
  completedCalls: new ReducedValue(completedToolCallListSchema, {
    inputSchema: completedToolCallUpdateSchema,
    reducer: reduceCompletedToolCalls,
  }),
  budgetLedger: new ReducedValue(
    budgetLedgerSchema.default(() => ({
      entries: [],
      total: { ...EMPTY_BUDGET_USAGE },
    })),
    {
      inputSchema: budgetLedgerUpdateSchema,
      reducer: reduceBudgetLedger,
    }
  ),
  progress: new ReducedValue(
    specialistProgressSchema.default(() => ({
      ...EMPTY_SPECIALIST_PROGRESS,
      evaluations: [],
      fingerprints: [],
    })),
    {
      inputSchema: progressUpdateSchema,
      reducer: reduceSpecialistProgress,
    }
  ),
  humanInterrupt: new ReducedValue(
    humanInterruptStateSchema.nullable().default(null),
    {
      inputSchema: humanInterruptStateSchema.nullable(),
      reducer: reduceHumanInterrupt,
    }
  ),
  terminalResult: new ReducedValue(
    missionResultSchema.nullable().default(null),
    {
      inputSchema: missionResultSchema.nullable(),
      reducer: reduceTerminalResult,
    }
  ),
})

export type SpecialistDecision = z.infer<typeof specialistDecisionSchema>
export type SpecialistAgent = z.infer<typeof specialistAgentSchema>
export type PendingToolCall = z.infer<typeof pendingToolCallSchema>
export type CompactObservation = z.infer<typeof compactObservationSchema>
export type CompletedToolCall = z.infer<typeof completedToolCallSchema>
export type BudgetLedgerEntry = z.infer<typeof budgetLedgerEntrySchema>
export type BudgetLedger = z.infer<typeof budgetLedgerSchema>
export type SpecialistProgress = z.infer<typeof specialistProgressSchema>
export type HumanInterruptState = z.infer<typeof humanInterruptStateSchema>
export type SpecialistStateValue = typeof SpecialistState.State
export type SpecialistStateUpdate = typeof SpecialistState.Update

export const specialistStateValueSchema = z.strictObject({
  mission: discoveryMissionSchema,
  agent: specialistAgentSchema,
  kernel: specialistKernelIdentitySchema,
  decisions: decisionListSchema,
  pendingToolCalls: pendingToolCallListSchema,
  observations: compactObservationListSchema,
  completedCalls: completedToolCallListSchema,
  budgetLedger: budgetLedgerSchema,
  progress: specialistProgressSchema,
  humanInterrupt: humanInterruptStateSchema.nullable(),
  terminalResult: missionResultSchema.nullable(),
})

export const specialistUpdateSchema = z.strictObject({
  decisions: decisionUpdateSchema.optional(),
  pendingToolCalls: pendingToolCallUpdateSchema.optional(),
  observations: compactObservationUpdateSchema.optional(),
  completedCalls: completedToolCallUpdateSchema.optional(),
  budgetLedger: budgetLedgerUpdateSchema.optional(),
  progress: progressUpdateSchema.optional(),
  humanInterrupt: humanInterruptStateSchema.nullable().optional(),
  terminalResult: missionResultSchema.nullable().optional(),
})

export type SpecialistUpdate = z.input<typeof specialistUpdateSchema>

export function createSpecialistInitialState(
  mission: DiscoveryMission,
  kernel: z.input<typeof specialistKernelIdentitySchema> = {
    graphName: `${mission.agent}_specialist`,
    promptTemplateId: "default_specialist",
    configurationFingerprint: `sha256:${"0".repeat(64)}`,
    startedAtMs: 0,
  }
): SpecialistStateValue {
  return parseSpecialistState({
    mission,
    agent: mission.agent,
    kernel,
    decisions: [],
    pendingToolCalls: [],
    observations: [],
    completedCalls: [],
    budgetLedger: EMPTY_BUDGET_LEDGER,
    progress: EMPTY_SPECIALIST_PROGRESS,
    humanInterrupt: null,
    terminalResult: null,
  })
}

export function parseSpecialistState(input: unknown): SpecialistStateValue {
  const parsed = specialistStateValueSchema.parse(input)
  assertSafeSpecialistValue(parsed)
  assertCompactCheckpointState(parsed)
  assertSpecialistStateConsistency(parsed)
  return parsed
}

// StateSchema reducers are channel-local. Every specialist node must use this
// boundary so cross-channel identity and the aggregate checkpoint limit are
// checked before LangGraph receives an update to persist.
export function validateSpecialistUpdate(
  current: SpecialistStateValue,
  input: unknown
): SpecialistStateUpdate {
  const state = parseSpecialistState(current)
  const update = specialistUpdateSchema.parse(input)
  const next = parseSpecialistState({
    mission: state.mission,
    agent: state.agent,
    kernel: state.kernel,
    decisions:
      update.decisions === undefined
        ? state.decisions
        : reduceSpecialistDecisions(state.decisions, update.decisions),
    pendingToolCalls:
      update.pendingToolCalls === undefined
        ? state.pendingToolCalls
        : reducePendingToolCalls(
            state.pendingToolCalls,
            update.pendingToolCalls
          ),
    observations:
      update.observations === undefined
        ? state.observations
        : reduceCompactObservations(state.observations, update.observations),
    completedCalls:
      update.completedCalls === undefined
        ? state.completedCalls
        : reduceCompletedToolCalls(state.completedCalls, update.completedCalls),
    budgetLedger:
      update.budgetLedger === undefined
        ? state.budgetLedger
        : reduceBudgetLedger(state.budgetLedger, update.budgetLedger),
    progress:
      update.progress === undefined
        ? state.progress
        : reduceSpecialistProgress(state.progress, update.progress),
    humanInterrupt:
      update.humanInterrupt === undefined
        ? state.humanInterrupt
        : reduceHumanInterrupt(state.humanInterrupt, update.humanInterrupt),
    terminalResult:
      update.terminalResult === undefined
        ? state.terminalResult
        : reduceTerminalResult(state.terminalResult, update.terminalResult),
  })
  return {
    mission: next.mission,
    agent: next.agent,
    kernel: next.kernel,
    decisions: new Overwrite(next.decisions),
    pendingToolCalls: new Overwrite(next.pendingToolCalls),
    observations: new Overwrite(next.observations),
    completedCalls: new Overwrite(next.completedCalls),
    budgetLedger: new Overwrite(next.budgetLedger),
    progress: new Overwrite(next.progress),
    humanInterrupt: new Overwrite(next.humanInterrupt),
    terminalResult: new Overwrite(next.terminalResult),
  }
}

function assertSpecialistStateConsistency(
  state: z.infer<typeof specialistStateValueSchema>
): void {
  if (state.agent !== state.mission.agent) {
    throw new Error("Specialist state agent does not match the mission agent")
  }

  const identityRecords = [
    ...state.decisions,
    ...state.pendingToolCalls,
    ...state.observations,
    ...state.completedCalls,
    ...state.budgetLedger.entries,
    ...(state.humanInterrupt === null ? [] : [state.humanInterrupt]),
  ]
  for (const record of identityRecords) {
    if (record.missionId !== state.mission.id || record.agent !== state.agent) {
      throw new Error("Specialist state contains a cross-mission identity")
    }
  }

  assertCanonicalIdentityOrder(state.decisions, (item) => item.decisionId)
  assertCanonicalIdentityOrder(state.pendingToolCalls, (item) => item.callId)
  assertCanonicalIdentityOrder(state.observations, (item) => item.callId)
  assertCanonicalIdentityOrder(state.completedCalls, (item) => item.callId)
  assertCanonicalIdentityOrder(state.budgetLedger.entries, budgetLedgerEntryKey)
  assertUniqueCallOwnership(state.decisions)
  if (
    canonicalStringify(deriveBudgetLedger(state.budgetLedger.entries)) !==
    canonicalStringify(state.budgetLedger)
  ) {
    throw new Error("Specialist budget ledger is not deterministically derived")
  }
  const reservedBudget = state.pendingToolCalls.reduce<MissionBudget>(
    (total, call) => addBudgetUsage(total, call.preflightUsage),
    EMPTY_BUDGET_USAGE
  )
  if (
    budgetKeys.some(
      (key) =>
        state.budgetLedger.total[key] + reservedBudget[key] >
        state.mission.budget[key]
    )
  ) {
    throw new Error(
      "Specialist budget usage and reservations exceed the mission budget"
    )
  }
  if (
    canonicalStringify(deriveSpecialistProgress(state.progress.evaluations)) !==
    canonicalStringify(state.progress)
  ) {
    throw new Error(
      "Specialist progress state is not deterministically derived"
    )
  }

  const decisionsById = new Map(
    state.decisions.map((decision) => [decision.decisionId, decision])
  )
  const pendingIds = new Set(state.pendingToolCalls.map((call) => call.callId))
  const completedById = new Map(
    state.completedCalls.map((call) => [call.callId, call])
  )
  const modelUsageByDecision = new Map(
    state.budgetLedger.entries
      .filter((entry) => entry.kind === "model_decision")
      .map((entry) => [entry.decisionId, entry])
  )
  const toolUsageByCall = new Map(
    state.budgetLedger.entries
      .filter((entry) => entry.kind === "tool_call")
      .map((entry) => [entry.callId, entry])
  )

  for (const decision of state.decisions) {
    if (!modelUsageByDecision.has(decision.decisionId)) {
      throw new Error("Specialist decision is missing correlated model usage")
    }
  }
  for (const entry of modelUsageByDecision.values()) {
    if (!decisionsById.has(entry.decisionId)) {
      throw new Error(
        "Model usage is not correlated with a specialist decision"
      )
    }
  }

  for (const call of [...state.pendingToolCalls, ...state.completedCalls]) {
    const decision = decisionsById.get(call.decisionId)
    if (
      decision?.kind !== "tool_calls" ||
      !decision.callIds.includes(call.callId)
    ) {
      throw new Error(
        "Tool call is not correlated with its specialist decision"
      )
    }
  }
  for (const decision of state.decisions) {
    if (
      decision.kind === "tool_calls" &&
      decision.callIds.some(
        (callId) => !pendingIds.has(callId) && !completedById.has(callId)
      )
    ) {
      throw new Error("Specialist decision contains an unknown tool call")
    }
  }
  for (const callId of pendingIds) {
    if (completedById.has(callId)) {
      throw new Error("A completed tool call cannot remain pending")
    }
  }
  if (
    state.pendingToolCalls.some((call) => call.preflightUsage.toolCalls !== 1)
  ) {
    throw new Error("Pending tool estimates must contain exactly one tool call")
  }

  for (const observation of state.observations) {
    const completed = completedById.get(observation.callId)
    if (
      completed === undefined ||
      completed.decisionId !== observation.decisionId ||
      completed.toolName !== observation.toolName ||
      completed.requestHash !== observation.requestHash ||
      completed.resultHash !== observation.resultHash ||
      completed.outcome !== observation.outcome
    ) {
      throw new Error(
        "Observation is not correlated with its completed tool call"
      )
    }
  }

  for (const completed of state.completedCalls) {
    if (completed.usage.toolCalls !== 1) {
      throw new Error("Completed tool usage must contain exactly one tool call")
    }
    if (
      completed.preflightUsage !== undefined &&
      budgetKeys.some(
        (key) => completed.usage[key] > completed.preflightUsage![key]
      )
    ) {
      throw new Error("Completed tool usage exceeds its preflight estimate")
    }
    if (
      !state.observations.some(
        (observation) => observation.callId === completed.callId
      )
    ) {
      throw new Error("Completed tool call is missing its compact observation")
    }
    const entry = toolUsageByCall.get(completed.callId)
    if (
      entry === undefined ||
      entry.decisionId !== completed.decisionId ||
      canonicalStringify(entry.usage) !== canonicalStringify(completed.usage)
    ) {
      throw new Error("Completed tool call is missing correlated budget usage")
    }
  }
  for (const entry of toolUsageByCall.values()) {
    if (!completedById.has(entry.callId)) {
      throw new Error("Tool usage is not correlated with a completed tool call")
    }
  }

  if (state.humanInterrupt !== null) {
    const decision = decisionsById.get(state.humanInterrupt.decisionId)
    if (decision?.kind !== "needs_human") {
      throw new Error("Human interrupt is not correlated with its decision")
    }
  }

  const result = state.terminalResult
  if (result === null) return
  if (result.missionId !== state.mission.id) {
    throw new Error("Terminal result does not match the specialist mission")
  }
  if (
    canonicalStringify(result.budgetUsed) !==
    canonicalStringify(state.budgetLedger.total)
  ) {
    throw new Error("Terminal result budget does not match checkpoint usage")
  }
  if (
    result.status === "needs_human" &&
    state.humanInterrupt?.status !== "pending"
  ) {
    throw new Error("A needs-human result requires a pending interrupt")
  }
  if (
    result.status !== "needs_human" &&
    state.humanInterrupt?.status === "pending"
  ) {
    throw new Error("A terminal result cannot retain a pending interrupt")
  }

  const knownEvidenceIds = new Set([
    ...state.mission.seedEvidenceIds,
    ...state.observations.flatMap((observation) => observation.evidenceIds),
  ])
  for (const evidenceId of [
    ...result.claims.flatMap((claim) => claim.evidenceIds),
    ...result.unresolved.flatMap((question) => question.evidenceIds),
  ]) {
    if (!knownEvidenceIds.has(evidenceId)) {
      throw new Error(
        "Terminal result cites evidence absent from specialist state"
      )
    }
  }
  for (const followup of result.suggestedFollowups) {
    if (
      followup.runId !== state.mission.runId ||
      followup.applicationId !== state.mission.applicationId ||
      followup.agent !== state.agent
    ) {
      throw new Error(
        "Specialist follow-up crosses its run, application, or agent"
      )
    }
  }
}

function assertSameInterruptIdentity(
  current: z.infer<typeof humanInterruptStateSchema>,
  next: z.infer<typeof humanInterruptStateSchema>
): void {
  const identityFields = [
    "decisionId",
    "missionId",
    "agent",
    "reasonCode",
    "question",
    "contextFingerprint",
  ] as const
  if (identityFields.some((field) => current[field] !== next[field])) {
    throw new Error("Human interrupt conflicts with durable state")
  }
}

function budgetLedgerEntryKey(
  entry: z.infer<typeof budgetLedgerEntrySchema>
): string {
  return entry.kind === "model_decision"
    ? `model:${entry.decisionId}`
    : `tool:${entry.callId}`
}

function assertUniqueCallOwnership(
  decisions: readonly z.infer<typeof specialistDecisionSchema>[]
): void {
  const owners = new Map<string, string>()
  for (const decision of decisions) {
    if (decision.kind !== "tool_calls") continue
    for (const callId of decision.callIds) {
      const owner = owners.get(callId)
      if (owner !== undefined && owner !== decision.decisionId) {
        throw new Error(
          `Tool call ${callId} is owned by multiple specialist decisions`
        )
      }
      owners.set(callId, decision.decisionId)
    }
  }
}

function assertUniformSpecialistIdentity(
  records: readonly { readonly missionId: string; readonly agent: string }[],
  label: string
): void {
  const first = records[0]
  if (first === undefined) return
  if (
    records.some(
      (record) =>
        record.missionId !== first.missionId || record.agent !== first.agent
    )
  ) {
    throw new Error(`${label} channel contains a cross-mission identity`)
  }
}

function assertSafeChannelValue<T>(value: T): T {
  assertSafeSpecialistValue(value)
  return value
}

const forbiddenSpecialistFields = new Set([
  "accepted",
  "authority",
  "body",
  "confidence",
  "content",
  "credential",
  "credentials",
  "cypher",
  "dom",
  "evidencetier",
  "graphmutation",
  "graphmutations",
  "graphoperation",
  "graphpayload",
  "graphwrite",
  "graphwrites",
  "html",
  "mutation",
  "mutations",
  "neo4j",
  "output",
  "probability",
  "prompt",
  "prompts",
  "rawcontent",
  "rawdocument",
  "rawoutput",
  "rawsource",
  "reasoning",
  "responsebody",
  "sourcecode",
  "tooloutput",
])

export function assertSafeSpecialistValue(input: unknown): void {
  assertSpecialistFieldNames(input)
  assertCompactCheckpointState(input)
}

function assertSpecialistFieldNames(value: unknown, depth = 0): void {
  if (depth > 12) throw new Error("Specialist state exceeds maximum depth")
  if (Array.isArray(value)) {
    value.forEach((item) => assertSpecialistFieldNames(item, depth + 1))
    return
  }
  if (value === null || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase()
    if (forbiddenSpecialistFields.has(normalized)) {
      throw new Error(`Specialist state contains forbidden field ${key}`)
    }
    assertSpecialistFieldNames(child, depth + 1)
  }
}

function mergeByIdentity<T>(
  current: readonly T[],
  additions: readonly T[],
  identity: (item: T) => string,
  maximum: number,
  label: string
): T[] {
  const merged = new Map<string, T>()
  for (const item of [...current, ...additions]) {
    const id = identity(item)
    const previous = merged.get(id)
    if (
      previous !== undefined &&
      canonicalStringify(previous) !== canonicalStringify(item)
    ) {
      throw new Error(`Conflicting duplicate ${label} ${id}`)
    }
    merged.set(id, previous ?? item)
  }
  if (merged.size > maximum) {
    throw new Error(`Specialist state contains too many ${label} records`)
  }
  return [...merged.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, item]) => item)
}

function dedupeCanonical<T>(values: readonly T[]): T[] {
  const unique = new Map(
    values.map((value) => [canonicalStringify(value), value])
  )
  return [...unique.values()]
}

function assertCanonicalIdentityOrder<T>(
  values: readonly T[],
  identity: (item: T) => string
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (
      compareStrings(identity(values[index - 1]!), identity(values[index]!)) >=
      0
    ) {
      throw new Error("Specialist state records are not in canonical order")
    }
  }
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(
        ([key, child]) => `${JSON.stringify(key)}:${canonicalStringify(child)}`
      )
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
