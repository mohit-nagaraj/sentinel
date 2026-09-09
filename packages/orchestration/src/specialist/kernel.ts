import {
  discoveryMissionSchema,
  contentHashSchema,
  executionBudgetSchema,
  hashCanonical,
  missionIdSchema,
  missionResultSchema,
  reasonCodeSchema,
  runIdSchema,
  type DiscoveryMission,
  type MissionBudget,
  type MissionResult,
} from "@sentinel/contracts"
import {
  Command,
  END,
  GraphRecursionError,
  INTERRUPT,
  START,
  StateGraph,
  interrupt,
  isInterrupted,
  type BaseCheckpointSaver,
} from "@langchain/langgraph"
import { z } from "zod"

import {
  BudgetExhaustedError,
  CheckpointStateError,
  ResumeAuthorizationError,
  ResumeConflictError,
  appendOrchestrationEvent,
  type RuntimeDependencies,
  wrapNode,
} from "../runtime.ts"
import {
  EMPTY_BUDGET_USAGE,
  SpecialistState,
  compactToolArgumentsSchema,
  createSpecialistInitialState,
  humanInterruptStateSchema,
  parseSpecialistState,
  reduceSpecialistProgress,
  specialistAgentSchema,
  specialistCallIdSchema,
  specialistDecisionSchema,
  validateSpecialistUpdate,
  type SpecialistDecision,
  type SpecialistStateUpdate,
  type SpecialistStateValue,
} from "./state.ts"
import {
  SpecialistToolRegistry,
  SpecialistToolDeniedError,
  authorizeSpecialistToolCall,
  executeSpecialistToolCall,
  getRemainingSpecialistBudget,
  settlePendingSpecialistToolCall,
  specialistToolRequestSchema,
} from "./tools.ts"

const MAX_MODEL_TOOL_CALLS = 16
const SPECIALIST_START_LOCK_RUN_ID = runIdSchema.parse(
  "run:00000000-0000-4000-8000-000000000014"
)

function specialistStartLockDecisionId(missionIdInput: string): string {
  const missionId = missionIdSchema.parse(missionIdInput)
  return specialistCallIdSchema.parse(
    `mission_start_${missionId.slice("mission:v1:".length)}`
  )
}

const modelToolCallSchema = z.strictObject({
  callId: specialistCallIdSchema,
  toolName: reasonCodeSchema,
  arguments: compactToolArgumentsSchema,
})

const missionResultDraftSchema = missionResultSchema
  .omit({
    schemaVersion: true,
    missionId: true,
    budgetUsed: true,
  })
  .refine(
    (result) =>
      result.status !== "needs_human" && result.status !== "budget_exhausted",
    "Model finish decisions cannot assign deterministic terminal statuses"
  )

const modelActionSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("tool_calls"),
      calls: z.array(modelToolCallSchema).min(1).max(MAX_MODEL_TOOL_CALLS),
    })
    .superRefine(({ calls }, context) => {
      if (new Set(calls.map((call) => call.callId)).size !== calls.length) {
        context.addIssue({
          code: "custom",
          path: ["calls"],
          message: "Model tool call IDs must be unique",
        })
      }
    }),
  z.strictObject({ kind: z.literal("continue") }),
  z.strictObject({
    kind: z.literal("needs_human"),
    reasonCode: reasonCodeSchema,
    question: z.string().trim().min(1).max(512),
  }),
  z.strictObject({
    kind: z.literal("finish"),
    result: missionResultDraftSchema,
  }),
])

export const specialistModelDecisionSchema = z.strictObject({
  decisionId: specialistCallIdSchema,
  usage: executionBudgetSchema,
  action: modelActionSchema,
})

export type SpecialistModelDecision = z.infer<
  typeof specialistModelDecisionSchema
>

export interface SpecialistHumanResolution {
  readonly decisionId: string
  readonly reasonCode: string
  readonly approved: boolean
}

export interface SpecialistDecisionEstimate {
  readonly kind: "provider" | "deterministic"
  readonly usage: Partial<MissionBudget>
}

export interface SpecialistModelRequest {
  readonly mission: DiscoveryMission
  readonly promptTemplateId: string
  readonly stateFingerprint: string
  readonly observations: SpecialistStateValue["observations"]
  readonly completedCallIds: readonly string[]
  readonly executionKind: SpecialistDecisionEstimate["kind"]
  readonly humanResolution: SpecialistHumanResolution | null
  readonly remainingBudget: MissionBudget
  readonly signal: AbortSignal
}

export interface SpecialistDecisionModel {
  estimate(state: SpecialistStateValue): Partial<MissionBudget>
  estimateDecision?(
    state: SpecialistStateValue
  ): SpecialistDecisionEstimate | Promise<SpecialistDecisionEstimate>
  decide(request: SpecialistModelRequest): Promise<unknown>
}

export interface SpecialistCompletionValidatorInput {
  readonly mission: DiscoveryMission
  readonly state: SpecialistStateValue
  readonly proposed: MissionResult
}

export interface SpecialistKernelConfig {
  readonly agent: z.infer<typeof specialistAgentSchema>
  readonly modes: readonly DiscoveryMission["mode"][]
  readonly promptTemplateId: string
  readonly modelId: string
  readonly toolsetId: string
  readonly completionValidatorId: string
  readonly graphName?: string
  readonly tools: SpecialistToolRegistry
  readonly model: SpecialistDecisionModel
  readonly validateCompletion: (
    input: SpecialistCompletionValidatorInput
  ) => MissionResult
  readonly maxNoProgress?: number
  readonly recursionLimit?: number
}

export const specialistResumeInputSchema = z.strictObject({
  missionId: missionIdSchema,
  decisionId: specialistCallIdSchema,
  actorId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9:._-]+$/),
  approved: z.boolean(),
})

export type SpecialistResumeInput = z.infer<typeof specialistResumeInputSchema>

const specialistInterruptPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: runIdSchema,
  missionId: missionIdSchema,
  decisionId: specialistCallIdSchema,
  reasonCode: reasonCodeSchema,
  question: z.string().trim().min(1).max(512),
  contextFingerprint: contentHashSchema,
})

type SpecialistInterruptPayload = z.infer<
  typeof specialistInterruptPayloadSchema
>

export interface SpecialistRunResult {
  readonly status: MissionResult["status"] | "interrupted"
  readonly mission: MissionResult
  readonly state: SpecialistStateValue
  readonly interrupts: readonly SpecialistInterruptPayload[]
  readonly idempotent: boolean
}

const activeSpecialistRuns = new Map<
  string,
  {
    readonly identityFingerprint: string | null
    readonly result: Promise<SpecialistRunResult>
  }
>()

const budgetKeys = Object.keys(EMPTY_BUDGET_USAGE) as (keyof MissionBudget)[]

function addBudget(left: MissionBudget, right: MissionBudget): MissionBudget {
  return executionBudgetSchema.parse(
    Object.fromEntries(budgetKeys.map((key) => [key, left[key] + right[key]]))
  )
}

function normalizeBudget(input: Partial<MissionBudget>): MissionBudget {
  return executionBudgetSchema.parse({ ...EMPTY_BUDGET_USAGE, ...input })
}

function fitsBudget(usage: MissionBudget, remaining: MissionBudget): boolean {
  return budgetKeys.every((key) => usage[key] <= remaining[key])
}

function assertModelUsage(
  usage: MissionBudget,
  ceiling: MissionBudget,
  kind: SpecialistDecisionEstimate["kind"]
): void {
  if (kind === "deterministic") {
    if (budgetKeys.some((key) => usage[key] !== 0)) {
      throw new BudgetExhaustedError()
    }
    return
  }
  if (
    usage.modelCalls !== 1 ||
    usage.toolCalls !== 0 ||
    usage.browserActions !== 0 ||
    usage.documentPages !== 0 ||
    usage.documentSections !== 0 ||
    usage.sourceLines !== 0 ||
    usage.repositoryBytes !== 0 ||
    usage.repositoryFiles !== 0 ||
    usage.reconciliationRounds !== 0 ||
    !fitsBudget(usage, ceiling)
  ) {
    throw new BudgetExhaustedError()
  }
}

function stateFingerprint(state: SpecialistStateValue): string {
  const humanResolution =
    state.humanInterrupt?.status === "resolved"
      ? {
          decisionId: state.humanInterrupt.decisionId,
          reasonCode: state.humanInterrupt.reasonCode,
          approved: state.humanInterrupt.approved,
        }
      : null
  return hashCanonical({
    missionId: state.mission.id,
    completedCalls: state.completedCalls.map((call) => ({
      callId: call.callId,
      resultHash: call.resultHash,
    })),
    observations: state.observations.map((item) => item.resultHash),
    budget: state.budgetLedger.total,
    progress: state.progress.lastFingerprint,
    humanResolution,
  })
}

function specialistEventKey(
  state: SpecialistStateValue,
  phase: string,
  identity?: string
): string {
  return hashCanonical({
    kind: "specialist_committed_event",
    missionId: state.mission.id,
    configurationFingerprint: state.kernel.configurationFingerprint,
    phase,
    identity: identity ?? null,
  })
}

function progressFingerprint(
  state: SpecialistStateValue,
  decisionId: string,
  value: unknown
): string {
  return hashCanonical({
    decisionId,
    missionId: state.mission.id,
    state: stateFingerprint(state),
    value,
  })
}

function resultFor(
  state: SpecialistStateValue,
  status: MissionResult["status"],
  code: string,
  summary: string,
  budgetUsed = state.budgetLedger.total
): MissionResult {
  return missionResultSchema.parse({
    schemaVersion: 1,
    missionId: state.mission.id,
    status,
    claims: [],
    unresolved:
      status === "complete"
        ? []
        : state.mission.questions.map((question) => ({
            question,
            reasonCode: code,
            evidenceIds: [],
          })),
    exclusions: [],
    suggestedFollowups: [],
    stopReason: { code, summary },
    budgetUsed,
  })
}

function terminalEventStatus(
  result: MissionResult
): "completed" | "blocked" | "failed" {
  return result.status === "failed"
    ? "failed"
    : result.status === "blocked" || result.status === "needs_human"
      ? "blocked"
      : "completed"
}

function interruptFromState(
  state: SpecialistStateValue
): SpecialistInterruptPayload | undefined {
  const pending = state.humanInterrupt
  if (pending?.status !== "pending") return undefined
  return specialistInterruptPayloadSchema.parse({
    schemaVersion: 1,
    runId: state.mission.runId,
    missionId: state.mission.id,
    decisionId: pending.decisionId,
    reasonCode: pending.reasonCode,
    question: pending.question,
    contextFingerprint: pending.contextFingerprint,
  })
}

function runtimeOptions() {
  return {
    runtimeState: (state: SpecialistStateValue) => ({
      runId: state.mission.runId,
      graphName: state.kernel.graphName,
      startedAtMs: state.kernel.startedAtMs,
      budget: { elapsedMs: state.mission.budget.elapsedMs },
    }),
    eventContext: (state: SpecialistStateValue) => ({
      agent: state.agent,
      missionId: state.mission.id,
      evidenceIds: state.observations
        .flatMap((observation) => observation.evidenceIds)
        .slice(-100),
    }),
    validateUpdate: () => undefined,
  } as const
}

interface ValidatedKernelConfig extends Omit<
  SpecialistKernelConfig,
  | "agent"
  | "modes"
  | "promptTemplateId"
  | "graphName"
  | "maxNoProgress"
  | "recursionLimit"
> {
  readonly agent: z.infer<typeof specialistAgentSchema>
  readonly modes: readonly DiscoveryMission["mode"][]
  readonly promptTemplateId: string
  readonly graphName: string
  readonly modelId: string
  readonly toolsetId: string
  readonly completionValidatorId: string
  readonly configurationFingerprint: string
  readonly maxNoProgress: number
  readonly recursionLimit: number
}

function validateConfig(input: SpecialistKernelConfig): ValidatedKernelConfig {
  const agent = specialistAgentSchema.parse(input.agent)
  const modes = [...new Set(input.modes)].sort()
  if (modes.length === 0) throw new Error("Specialist kernel requires modes")
  const maxNoProgress = z
    .number()
    .int()
    .min(1)
    .max(32)
    .parse(input.maxNoProgress ?? 3)
  const recursionLimit = z
    .number()
    .int()
    .min(2)
    .max(1_000)
    .parse(input.recursionLimit ?? 100)
  const promptTemplateId = reasonCodeSchema.parse(input.promptTemplateId)
  const graphName = reasonCodeSchema.parse(
    input.graphName ?? `${agent}_specialist`
  )
  const modelId = reasonCodeSchema.parse(input.modelId)
  const toolsetId = reasonCodeSchema.parse(input.toolsetId)
  const completionValidatorId = reasonCodeSchema.parse(
    input.completionValidatorId
  )
  const configurationFingerprint = hashCanonical({
    agent,
    modes,
    promptTemplateId,
    graphName,
    modelId,
    toolsetId,
    completionValidatorId,
    maxNoProgress,
    recursionLimit,
    tools: input.tools.names().map((name) => {
      const tool = input.tools.get(name)
      if (tool === undefined)
        throw new Error("Specialist tool registry changed")
      return {
        name,
        description: tool.description,
        agents: tool.agents,
        modes: tool.modes,
      }
    }),
  })
  return {
    ...input,
    agent,
    modes,
    promptTemplateId,
    graphName,
    modelId,
    toolsetId,
    completionValidatorId,
    configurationFingerprint,
    maxNoProgress,
    recursionLimit,
  }
}

function makeDecision(
  state: SpecialistStateValue,
  response: SpecialistModelDecision
): SpecialistDecision {
  const common = {
    decisionId: response.decisionId,
    missionId: state.mission.id,
    agent: state.agent,
    stateFingerprint: stateFingerprint(state),
    decisionHash: hashCanonical(response.action),
  }
  switch (response.action.kind) {
    case "tool_calls":
      return specialistDecisionSchema.parse({
        ...common,
        kind: "tool_calls",
        callIds: response.action.calls.map((call) => call.callId),
      })
    case "continue":
      return specialistDecisionSchema.parse({
        ...common,
        kind: "continue",
        progressFingerprint: progressFingerprint(
          state,
          response.decisionId,
          response.action
        ),
      })
    case "needs_human":
      return specialistDecisionSchema.parse({
        ...common,
        kind: "needs_human",
        interruptFingerprint: progressFingerprint(
          state,
          response.decisionId,
          response.action
        ),
      })
    case "finish":
      return specialistDecisionSchema.parse({
        ...common,
        kind: "finish",
        resultHash: hashCanonical(response.action.result),
      })
  }
}

function modelLedgerEntry(
  state: SpecialistStateValue,
  decisionId: string,
  usage: MissionBudget
) {
  return {
    kind: "model_decision" as const,
    decisionId,
    missionId: state.mission.id,
    agent: state.agent,
    usage,
  }
}

function progressEntry(
  state: SpecialistStateValue,
  decisionId: string,
  fingerprint: string,
  madeProgress: boolean
) {
  return {
    sequence: state.progress.steps + 1,
    decisionId,
    fingerprint,
    madeProgress,
  }
}

function nextFailureDecisionId(state: SpecialistStateValue): string {
  const occupied = new Set([
    ...state.decisions.map((decision) => decision.decisionId),
    ...state.budgetLedger.entries
      .filter((entry) => entry.kind === "model_decision")
      .map((entry) => entry.decisionId),
  ])
  for (let sequence = 1; sequence <= 256; sequence += 1) {
    const candidate = `model_failure_${sequence}`
    if (!occupied.has(candidate)) return specialistCallIdSchema.parse(candidate)
  }
  throw new CheckpointStateError()
}

function failedModelUpdate(
  state: SpecialistStateValue,
  usage: MissionBudget,
  reasonCode: string,
  status: "budget_exhausted" | "failed" = "failed",
  summary = "Specialist model decision failed validation."
): SpecialistStateUpdate {
  const decisionId = nextFailureDecisionId(state)
  const failureProgress = hashCanonical({ decisionId, reasonCode })
  const decision = specialistDecisionSchema.parse({
    decisionId,
    missionId: state.mission.id,
    agent: state.agent,
    stateFingerprint: stateFingerprint(state),
    decisionHash: hashCanonical({ reasonCode }),
    kind: "continue",
    progressFingerprint: failureProgress,
  })
  const budgetUsed = addBudget(state.budgetLedger.total, usage)
  return validateSpecialistUpdate(state, {
    decisions: decision,
    pendingDecisionEventId: decision.decisionId,
    budgetLedger: modelLedgerEntry(state, decisionId, usage),
    progress: progressEntry(state, decisionId, failureProgress, false),
    terminalResult: resultFor(state, status, reasonCode, summary, budgetUsed),
  })
}

function failedDecisionUpdate(
  state: SpecialistStateValue,
  decision: SpecialistDecision,
  usage: MissionBudget,
  status: "budget_exhausted" | "failed",
  reasonCode: string,
  summary: string
): SpecialistStateUpdate {
  const parsedDecision =
    decision.kind === "continue"
      ? decision
      : specialistDecisionSchema.parse({
          decisionId: decision.decisionId,
          missionId: decision.missionId,
          agent: decision.agent,
          stateFingerprint: decision.stateFingerprint,
          decisionHash: decision.decisionHash,
          kind: "continue",
          progressFingerprint: decision.decisionHash,
        })
  if (parsedDecision.kind !== "continue") {
    throw new Error(
      "Failed specialist decisions must normalize to a continue decision."
    )
  }
  const recordedDecision = parsedDecision
  const budgetUsed = addBudget(state.budgetLedger.total, usage)
  return validateSpecialistUpdate(state, {
    decisions: recordedDecision,
    pendingDecisionEventId: recordedDecision.decisionId,
    budgetLedger: modelLedgerEntry(state, decision.decisionId, usage),
    progress: progressEntry(
      state,
      recordedDecision.decisionId,
      recordedDecision.progressFingerprint,
      false
    ),
    terminalResult: resultFor(state, status, reasonCode, summary, budgetUsed),
  })
}

function totalPendingUsage(
  state: SpecialistStateValue,
  calls: readonly {
    preflightUsage: MissionBudget
  }[]
): MissionBudget {
  return calls.reduce(
    (total, call) => addBudget(total, call.preflightUsage),
    EMPTY_BUDGET_USAGE
  )
}

function buildKernelGraph(
  config: ValidatedKernelConfig,
  dependencies: RuntimeDependencies,
  checkpointer?: BaseCheckpointSaver
) {
  const options = runtimeOptions()
  const prepare = wrapNode(
    "specialist_prepare",
    dependencies,
    parseSpecialistState,
    async (state, runtime) => {
      if (
        state.agent !== config.agent ||
        !config.modes.includes(state.mission.mode) ||
        state.kernel.graphName !== config.graphName ||
        state.kernel.promptTemplateId !== config.promptTemplateId ||
        state.kernel.configurationFingerprint !==
          config.configurationFingerprint ||
        state.mission.scope.allowedTools.some(
          (toolName) => !config.tools.names().includes(toolName)
        )
      ) {
        throw new CheckpointStateError()
      }
      await runtime.emit(
        {
          kind: "mission_started",
          status: "started",
          summary: "Specialist mission started",
          reasonCode: "mission_started",
        },
        { idempotencyKey: specialistEventKey(state, "mission_started") }
      )
      return validateSpecialistUpdate(state, {})
    },
    options
  )

  const decide = wrapNode(
    "specialist_model_decision",
    dependencies,
    parseSpecialistState,
    async (state, runtime) => {
      if (state.terminalResult !== null || state.pendingToolCalls.length > 0) {
        return validateSpecialistUpdate(state, {})
      }
      const remaining = getRemainingSpecialistBudget(state)
      let executionKind: SpecialistDecisionEstimate["kind"] = "provider"
      let estimate: MissionBudget
      try {
        const decisionEstimate =
          config.model.estimateDecision === undefined
            ? {
                kind: "provider" as const,
                usage: config.model.estimate(state),
              }
            : await config.model.estimateDecision(state)
        executionKind = z
          .enum(["provider", "deterministic"])
          .parse(decisionEstimate.kind)
        estimate = normalizeBudget(decisionEstimate.usage)
        assertModelUsage(estimate, remaining, executionKind)
      } catch {
        return validateSpecialistUpdate(state, {
          terminalResult: resultFor(
            state,
            "budget_exhausted",
            "model_budget_exhausted",
            "The remaining mission budget cannot fund another model decision."
          ),
        })
      }

      let parsed: SpecialistModelDecision
      try {
        const raw = await config.model.decide({
          mission: state.mission,
          promptTemplateId: state.kernel.promptTemplateId,
          stateFingerprint: stateFingerprint(state),
          observations: state.observations,
          completedCallIds: state.completedCalls.map((call) => call.callId),
          executionKind,
          humanResolution:
            state.humanInterrupt?.status === "resolved"
              ? {
                  decisionId: state.humanInterrupt.decisionId,
                  reasonCode: state.humanInterrupt.reasonCode,
                  approved: state.humanInterrupt.approved,
                }
              : null,
          remainingBudget: remaining,
          signal: runtime.signal,
        })
        parsed = specialistModelDecisionSchema.parse(raw)
      } catch {
        return failedModelUpdate(state, estimate, "model_decision_invalid")
      }
      try {
        assertModelUsage(parsed.usage, estimate, executionKind)
        assertModelUsage(parsed.usage, remaining, executionKind)
      } catch {
        return failedModelUpdate(
          state,
          parsed.usage,
          "model_usage_exceeded_preflight",
          "budget_exhausted",
          "The model reported actual usage outside its authorized budget reservation."
        )
      }

      if (
        state.decisions.some(
          (decision) => decision.decisionId === parsed.decisionId
        ) ||
        state.budgetLedger.entries.some(
          (entry) =>
            entry.kind === "model_decision" &&
            entry.decisionId === parsed.decisionId
        )
      ) {
        return failedModelUpdate(
          state,
          parsed.usage,
          "model_decision_duplicate"
        )
      }

      const decision = makeDecision(state, parsed)
      const nextBudget = addBudget(state.budgetLedger.total, parsed.usage)
      const commonUpdate = {
        decisions: decision,
        pendingDecisionEventId: decision.decisionId,
        budgetLedger: modelLedgerEntry(
          state,
          decision.decisionId,
          parsed.usage
        ),
      }

      switch (parsed.action.kind) {
        case "tool_calls": {
          try {
            const pending = parsed.action.calls.map((call) => {
              const request = specialistToolRequestSchema.parse({
                callId: call.callId,
                decisionId: decision.decisionId,
                missionId: state.mission.id,
                agent: state.agent,
                toolName: call.toolName,
                arguments: call.arguments,
              })
              const authorization = authorizeSpecialistToolCall({
                registry: config.tools,
                state,
                decision,
                request,
                signal: runtime.signal,
              })
              if (authorization.kind === "completed") {
                throw new ResumeConflictError()
              }
              return authorization.pendingCall
            })
            if (!fitsBudget(totalPendingUsage(state, pending), remaining)) {
              throw new BudgetExhaustedError()
            }
            return validateSpecialistUpdate(state, {
              ...commonUpdate,
              pendingToolCalls: pending,
            })
          } catch (error) {
            const exhausted =
              error instanceof BudgetExhaustedError ||
              (error instanceof SpecialistToolDeniedError &&
                error.code === "budget_denied")
            return failedDecisionUpdate(
              state,
              decision,
              parsed.usage,
              exhausted ? "budget_exhausted" : "failed",
              exhausted ? "tool_budget_exhausted" : "tool_request_denied",
              exhausted
                ? "The model requested tools outside the remaining mission budget."
                : "The model requested a tool call outside its authorized boundary."
            )
          }
        }
        case "continue": {
          const fingerprint = progressFingerprint(
            state,
            decision.decisionId,
            parsed.action
          )
          const evaluation = progressEntry(
            state,
            decision.decisionId,
            fingerprint,
            false
          )
          const nextProgress = reduceSpecialistProgress(
            state.progress,
            evaluation
          )
          return validateSpecialistUpdate(state, {
            ...commonUpdate,
            progress: evaluation,
            ...(nextProgress.consecutiveNoProgress >= config.maxNoProgress
              ? {
                  terminalResult: resultFor(
                    state,
                    "partial",
                    "no_progress",
                    "The specialist stopped after repeated no-progress decisions.",
                    nextBudget
                  ),
                }
              : {}),
          })
        }
        case "needs_human": {
          const fingerprint = progressFingerprint(
            state,
            decision.decisionId,
            parsed.action
          )
          const pending = humanInterruptStateSchema.parse({
            decisionId: decision.decisionId,
            missionId: state.mission.id,
            agent: state.agent,
            reasonCode: parsed.action.reasonCode,
            question: parsed.action.question,
            contextFingerprint: fingerprint,
            status: "pending",
          })
          return validateSpecialistUpdate(state, {
            ...commonUpdate,
            progress: progressEntry(
              state,
              decision.decisionId,
              fingerprint,
              true
            ),
            humanInterrupt: pending,
            terminalResult: resultFor(
              state,
              "needs_human",
              parsed.action.reasonCode,
              parsed.action.question,
              nextBudget
            ),
          })
        }
        case "finish": {
          try {
            const fingerprint = hashCanonical(parsed.action.result)
            const proposed = missionResultSchema.parse({
              schemaVersion: 1,
              missionId: state.mission.id,
              ...parsed.action.result,
              budgetUsed: nextBudget,
            })
            const result = missionResultSchema.parse(
              config.validateCompletion({
                mission: state.mission,
                state,
                proposed,
              })
            )
            if (
              result.missionId !== state.mission.id ||
              JSON.stringify(result.budgetUsed) !== JSON.stringify(nextBudget)
            ) {
              throw new CheckpointStateError()
            }
            return validateSpecialistUpdate(state, {
              ...commonUpdate,
              progress: progressEntry(
                state,
                decision.decisionId,
                fingerprint,
                true
              ),
              terminalResult: result,
            })
          } catch {
            return failedDecisionUpdate(
              state,
              decision,
              parsed.usage,
              "failed",
              "completion_validation_failed",
              "The proposed mission completion failed deterministic validation."
            )
          }
        }
      }
    },
    options
  )

  const validateDecision = wrapNode(
    "specialist_validate_decision",
    dependencies,
    parseSpecialistState,
    async (state, runtime) => {
      const decisionId = state.pendingDecisionEventId
      if (decisionId === null) return validateSpecialistUpdate(state, {})
      const decision = state.decisions.find(
        (candidate) => candidate.decisionId === decisionId
      )
      if (decision === undefined) throw new CheckpointStateError()
      await runtime.emit(
        {
          kind: "node_completed",
          status: "completed",
          summary: "Specialist decision committed",
          reasonCode: decision.kind,
        },
        {
          idempotencyKey: specialistEventKey(
            state,
            "decision_committed",
            decisionId
          ),
        }
      )
      await runtime.emit(
        {
          kind: "budget_updated",
          status: "completed",
          summary: "Specialist model budget committed",
          reasonCode: "model_budget_updated",
          budget: {
            consumed: state.budgetLedger.total.modelCalls,
            limit: state.mission.budget.modelCalls,
            unit: "model_calls",
          },
        },
        {
          idempotencyKey: specialistEventKey(
            state,
            "model_budget_committed",
            decisionId
          ),
        }
      )
      if (decision.kind === "needs_human") {
        const pending = state.humanInterrupt
        if (pending?.status !== "pending") throw new CheckpointStateError()
        await runtime.emit(
          {
            kind: "interrupt_requested",
            status: "blocked",
            summary: "Specialist human input committed",
            reasonCode: pending.reasonCode,
          },
          {
            idempotencyKey: specialistEventKey(
              state,
              "interrupt_requested",
              decisionId
            ),
          }
        )
      }
      return validateSpecialistUpdate(state, {
        pendingDecisionEventId: null,
      })
    },
    { ...options, emitStarted: false, enforceElapsedBudget: false }
  )

  const executeTool = wrapNode(
    "specialist_tool_execution",
    dependencies,
    parseSpecialistState,
    async (state, runtime) => {
      const call = state.pendingToolCalls[0]
      if (call === undefined) return validateSpecialistUpdate(state, {})
      await runtime.emitTool({
        toolName: call.toolName,
        phase: "started",
        idempotencyKey: specialistEventKey(state, "tool_started", call.callId),
      })
      let execution: Awaited<ReturnType<typeof executeSpecialistToolCall>>
      try {
        execution = await executeSpecialistToolCall({
          registry: config.tools,
          state,
          call,
          signal: runtime.signal,
        })
      } catch {
        return validateSpecialistUpdate(state, {
          terminalResult: resultFor(
            state,
            "failed",
            "tool_execution_denied",
            "The authorized tool call failed deterministic revalidation before execution."
          ),
        })
      }
      if (execution.kind === "replayed") {
        return validateSpecialistUpdate(state, {
          pendingToolCalls: { upsert: [], removeCallIds: [call.callId] },
          lastCommittedToolCallId: execution.completedCall.callId,
        })
      }
      const sameDecisionPending = state.pendingToolCalls.filter(
        (candidate) =>
          candidate.decisionId === call.decisionId &&
          candidate.callId !== call.callId
      )
      const isDecisionComplete = sameDecisionPending.length === 0
      const decisionObservations = [
        ...state.observations.filter(
          (observation) => observation.decisionId === call.decisionId
        ),
        execution.observation,
      ]
      const madeProgress = decisionObservations.some(
        (observation) =>
          observation.outcome === "succeeded" &&
          (observation.evidenceIds.length > 0 ||
            observation.references.length > 0)
      )
      const nextBudget = addBudget(
        state.budgetLedger.total,
        execution.completedCall.usage
      )
      const evaluation = progressEntry(
        state,
        call.decisionId,
        hashCanonical(
          decisionObservations.map((observation) => observation.resultHash)
        ),
        madeProgress
      )
      const nextProgress = isDecisionComplete
        ? reduceSpecialistProgress(state.progress, evaluation)
        : state.progress
      return validateSpecialistUpdate(state, {
        pendingToolCalls: { upsert: [], removeCallIds: [call.callId] },
        observations: execution.observation,
        completedCalls: execution.completedCall,
        lastCommittedToolCallId: execution.completedCall.callId,
        budgetLedger: {
          kind: "tool_call",
          decisionId: call.decisionId,
          callId: call.callId,
          missionId: call.missionId,
          agent: call.agent,
          usage: execution.completedCall.usage,
        },
        ...(isDecisionComplete ? { progress: evaluation } : {}),
        ...(execution.kind === "budget_violation"
          ? {
              terminalResult: resultFor(
                state,
                "budget_exhausted",
                "tool_usage_exceeded_preflight",
                `The tool reported usage outside its authorized budget reservation (${execution.exceededBudgetKeys.join(",")}; ${execution.reportedUsageHash}).`,
                nextBudget
              ),
            }
          : isDecisionComplete &&
              nextProgress.consecutiveNoProgress >= config.maxNoProgress
            ? {
                terminalResult: resultFor(
                  state,
                  "partial",
                  "no_progress",
                  "The specialist stopped after repeated tool results without new evidence.",
                  nextBudget
                ),
              }
            : {}),
      })
    },
    options
  )

  const toolCommitted = wrapNode(
    "specialist_tool_committed",
    dependencies,
    parseSpecialistState,
    async (state, runtime) => {
      const callId = state.lastCommittedToolCallId
      if (callId === null) throw new CheckpointStateError()
      const completed = state.completedCalls.find(
        (call) => call.callId === callId
      )
      const observation = state.observations.find(
        (candidate) => candidate.callId === callId
      )
      if (completed === undefined || observation === undefined) {
        throw new CheckpointStateError()
      }
      await runtime.emitTool({
        toolName: completed.toolName,
        phase: "completed",
        idempotencyKey: specialistEventKey(state, "tool_completed", callId),
      })
      if (observation.evidenceIds.length > 0) {
        await runtime.emit(
          {
            kind: "evidence_gained",
            status: "completed",
            summary: "Specialist tool evidence committed",
            reasonCode: "evidence_gained",
            evidenceIds: observation.evidenceIds,
          },
          {
            idempotencyKey: specialistEventKey(
              state,
              "tool_evidence_committed",
              callId
            ),
          }
        )
      }
      await runtime.emit(
        {
          kind: "budget_updated",
          status: "completed",
          summary: "Specialist tool budget committed",
          reasonCode: "tool_budget_updated",
          budget: {
            consumed: state.budgetLedger.total.toolCalls,
            limit: state.mission.budget.toolCalls,
            unit: "tool_calls",
          },
        },
        {
          idempotencyKey: specialistEventKey(
            state,
            "tool_budget_committed",
            callId
          ),
        }
      )
      return validateSpecialistUpdate(state, {
        lastCommittedToolCallId: null,
      })
    },
    { ...options, emitStarted: false, enforceElapsedBudget: false }
  )

  const humanInterrupt = wrapNode(
    "specialist_human_interrupt",
    dependencies,
    parseSpecialistState,
    async (state) => {
      const pending = state.humanInterrupt
      if (pending?.status !== "pending") throw new CheckpointStateError()
      const response = specialistResumeInputSchema.parse(
        interrupt(
          specialistInterruptPayloadSchema.parse({
            schemaVersion: 1,
            runId: state.mission.runId,
            missionId: state.mission.id,
            decisionId: pending.decisionId,
            reasonCode: pending.reasonCode,
            question: pending.question,
            contextFingerprint: pending.contextFingerprint,
          })
        )
      )
      if (
        response.missionId !== state.mission.id ||
        response.decisionId !== pending.decisionId
      ) {
        throw new ResumeAuthorizationError()
      }
      const resolved = humanInterruptStateSchema.parse({
        ...pending,
        status: "resolved",
        actorId: response.actorId,
        approved: response.approved,
      })
      return validateSpecialistUpdate(state, {
        humanInterrupt: resolved,
        terminalResult: response.approved
          ? null
          : resultFor(
              state,
              "blocked",
              "human_rejected",
              "The specialist mission was rejected by the authorized reviewer."
            ),
      })
    },
    { ...options, emitStarted: false }
  )

  const humanCommitted = wrapNode(
    "specialist_human_committed",
    dependencies,
    parseSpecialistState,
    async (state, runtime) => {
      const human = state.humanInterrupt
      if (human?.status !== "resolved") throw new CheckpointStateError()
      await runtime.emit(
        {
          kind: "interrupt_resumed",
          status: "completed",
          summary: "Specialist human input committed",
          reasonCode: human.approved ? "resume_approved" : "resume_rejected",
        },
        {
          idempotencyKey: specialistEventKey(
            state,
            "interrupt_resumed",
            human.decisionId
          ),
        }
      )
      return validateSpecialistUpdate(state, {})
    },
    { ...options, emitStarted: false, enforceElapsedBudget: false }
  )

  const finalize = wrapNode(
    "specialist_finalize",
    dependencies,
    parseSpecialistState,
    async (state, runtime) => {
      const result = state.terminalResult
      if (result === null) throw new CheckpointStateError()
      await runtime.emit(
        {
          kind: "mission_completed",
          status: terminalEventStatus(result),
          summary: "Specialist mission reached a terminal result",
          reasonCode: result.stopReason.code,
        },
        {
          idempotencyKey: specialistEventKey(
            state,
            "mission_completed",
            result.stopReason.code
          ),
        }
      )
      return validateSpecialistUpdate(state, { pendingTerminalEvent: false })
    },
    { ...options, enforceElapsedBudget: false }
  )

  const routeAfterDecision = (state: SpecialistStateValue) => {
    const parsed = parseSpecialistState(state)
    if (parsed.terminalResult?.status === "needs_human") {
      return "specialist_human_interrupt"
    }
    if (parsed.terminalResult !== null) return "specialist_finalize"
    if (parsed.pendingToolCalls.length > 0) return "specialist_tool_execution"
    return "specialist_model_decision"
  }

  const routeAfterToolExecution = (state: SpecialistStateValue) => {
    const parsed = parseSpecialistState(state)
    return parsed.lastCommittedToolCallId === null
      ? routeAfterDecision(parsed)
      : "specialist_tool_committed"
  }

  const graph = new StateGraph(SpecialistState)
    .addNode("specialist_prepare", prepare)
    .addNode("specialist_model_decision", decide)
    .addNode("specialist_validate_decision", validateDecision)
    .addNode("specialist_tool_execution", executeTool)
    .addNode("specialist_tool_committed", toolCommitted)
    .addNode("specialist_human_interrupt", humanInterrupt)
    .addNode("specialist_human_committed", humanCommitted)
    .addNode("specialist_finalize", finalize)
    .addEdge(START, "specialist_prepare")
    .addEdge("specialist_prepare", "specialist_model_decision")
    .addEdge("specialist_model_decision", "specialist_validate_decision")
    .addConditionalEdges("specialist_validate_decision", routeAfterDecision)
    .addConditionalEdges("specialist_tool_execution", routeAfterToolExecution)
    .addConditionalEdges("specialist_tool_committed", routeAfterDecision)
    .addEdge("specialist_human_interrupt", "specialist_human_committed")
    .addConditionalEdges("specialist_human_committed", routeAfterDecision)
    .addEdge("specialist_finalize", END)

  return checkpointer === undefined
    ? graph.compile()
    : graph.compile({ checkpointer })
}

export function createSpecialistKernel(
  configInput: SpecialistKernelConfig,
  dependencies: RuntimeDependencies,
  checkpointer?: BaseCheckpointSaver
) {
  const config = validateConfig(configInput)
  return {
    config,
    graph: buildKernelGraph(config, dependencies, checkpointer),
  }
}

export type SpecialistKernel = ReturnType<typeof createSpecialistKernel>
export type SpecialistGraph = SpecialistKernel["graph"]

export class SpecialistOrchestrationService {
  constructor(
    private readonly kernel: SpecialistKernel,
    private readonly dependencies: RuntimeDependencies
  ) {}

  private graphConfig(missionId: string) {
    return {
      configurable: { thread_id: missionIdSchema.parse(missionId) },
      recursionLimit: this.kernel.config.recursionLimit,
    }
  }

  private initialState(mission: DiscoveryMission): SpecialistStateValue {
    const now = this.dependencies.now ?? (() => new Date())
    return createSpecialistInitialState(mission, {
      graphName: this.kernel.config.graphName,
      promptTemplateId: this.kernel.config.promptTemplateId,
      configurationFingerprint: this.kernel.config.configurationFingerprint,
      startedAtMs: now().getTime(),
    })
  }

  private assertMatchingStart(
    existing: SpecialistStateValue,
    initial: SpecialistStateValue
  ): void {
    if (
      hashCanonical(existing.mission) !== hashCanonical(initial.mission) ||
      existing.kernel.configurationFingerprint !==
        initial.kernel.configurationFingerprint
    ) {
      throw new CheckpointStateError()
    }
  }

  private assertKernelState(state: SpecialistStateValue): void {
    if (
      state.agent !== this.kernel.config.agent ||
      !this.kernel.config.modes.includes(state.mission.mode) ||
      state.kernel.configurationFingerprint !==
        this.kernel.config.configurationFingerprint ||
      state.mission.scope.allowedTools.some(
        (toolName) => !this.kernel.config.tools.names().includes(toolName)
      )
    ) {
      throw new CheckpointStateError()
    }
  }

  private async claimStart(
    mission: DiscoveryMission
  ): Promise<"claimed" | "existing_terminal" | "resumable"> {
    const initial = this.initialState(mission)
    return this.dependencies.resumeCoordinator.runExclusive(
      {
        runId: SPECIALIST_START_LOCK_RUN_ID,
        decisionId: specialistStartLockDecisionId(mission.id),
      },
      async () => {
        const snapshot = await this.kernel.graph.getState(
          this.graphConfig(mission.id)
        )
        if (
          snapshot.values !== null &&
          typeof snapshot.values === "object" &&
          Object.keys(snapshot.values).length > 0
        ) {
          let existing: SpecialistStateValue
          try {
            existing = parseSpecialistState(snapshot.values)
          } catch {
            throw new CheckpointStateError()
          }
          this.assertMatchingStart(existing, initial)
          if (
            existing.terminalResult?.status === "needs_human" ||
            (existing.terminalResult !== null && snapshot.next.length === 0)
          ) {
            return "existing_terminal"
          }
          await this.dependencies.control.assertActive({
            runId: existing.mission.runId,
            owner: this.dependencies.owner,
          })
          return "resumable"
        }
        await this.dependencies.control.assertActive({
          runId: mission.runId,
          owner: this.dependencies.owner,
        })
        await this.kernel.graph.invoke(initial, {
          ...this.graphConfig(mission.id),
          interruptBefore: ["specialist_prepare"],
        })
        return "claimed"
      }
    )
  }

  private async startClaimedMission(
    mission: DiscoveryMission
  ): Promise<SpecialistRunResult> {
    const claim = await this.claimStart(mission)
    return claim === "existing_terminal"
      ? this.continueClaimedMission(mission.id)
      : this.invoke(mission.id, null)
  }

  private async continueClaimedMission(
    missionId: string
  ): Promise<SpecialistRunResult> {
    const claim = await this.dependencies.resumeCoordinator.runExclusive(
      {
        runId: SPECIALIST_START_LOCK_RUN_ID,
        decisionId: specialistStartLockDecisionId(missionId),
      },
      async () => {
        const snapshot = await this.currentSnapshot(missionId)
        const terminal = snapshot.state.terminalResult
        if (
          terminal?.status === "needs_human" ||
          (terminal !== null && snapshot.next.length === 0)
        ) {
          if (snapshot.state.pendingTerminalEvent) {
            return {
              kind: "terminal_event" as const,
              state: snapshot.state,
            }
          }
          return {
            kind: "terminal" as const,
            result: this.resultFromTerminalState(snapshot.state),
          }
        }
        await this.dependencies.control.assertActive({
          runId: snapshot.state.mission.runId,
          owner: this.dependencies.owner,
        })
        return { kind: "invoke" as const }
      }
    )
    if (claim.kind === "terminal") return claim.result
    if (claim.kind === "terminal_event") {
      return this.resultFromTerminalState(
        await this.flushPendingTerminalEvent(claim.state)
      )
    }
    return this.invoke(missionId, null, true)
  }

  private async currentSnapshot(missionId: string): Promise<{
    readonly state: SpecialistStateValue
    readonly next: readonly string[]
  }> {
    const snapshot = await this.kernel.graph.getState(
      this.graphConfig(missionId)
    )
    try {
      const state = parseSpecialistState(snapshot.values)
      this.assertKernelState(state)
      return {
        state,
        next: [...snapshot.next],
      }
    } catch {
      throw new CheckpointStateError()
    }
  }

  private async currentState(missionId: string): Promise<SpecialistStateValue> {
    return (await this.currentSnapshot(missionId)).state
  }

  private async flushPendingCommittedEvents(
    state: SpecialistStateValue
  ): Promise<SpecialistStateValue> {
    const decisionId = state.pendingDecisionEventId
    const toolCallIds = state.pendingTerminalToolCallIds
    if (decisionId === null && toolCallIds.length === 0) return state
    await this.dependencies.control.assertActive({
      runId: state.mission.runId,
      owner: this.dependencies.owner,
    })
    if (decisionId !== null) {
      const decision = state.decisions.find(
        (candidate) => candidate.decisionId === decisionId
      )
      if (decision === undefined) throw new CheckpointStateError()
      await appendOrchestrationEvent(
        this.dependencies,
        {
          runId: state.mission.runId,
          graphName: state.kernel.graphName,
          nodeName: "specialist_validate_decision",
          agent: state.agent,
          missionId: state.mission.id,
          evidenceIds: [],
          kind: "node_completed",
          status: "completed",
          summary: "Specialist decision committed",
          reasonCode: decision.kind,
        },
        {
          idempotencyKey: specialistEventKey(
            state,
            "decision_committed",
            decisionId
          ),
        }
      )
      await appendOrchestrationEvent(
        this.dependencies,
        {
          runId: state.mission.runId,
          graphName: state.kernel.graphName,
          nodeName: "specialist_validate_decision",
          agent: state.agent,
          missionId: state.mission.id,
          evidenceIds: [],
          kind: "budget_updated",
          status: "completed",
          summary: "Specialist model budget committed",
          reasonCode: "model_budget_updated",
          budget: {
            consumed: state.budgetLedger.total.modelCalls,
            limit: state.mission.budget.modelCalls,
            unit: "model_calls",
          },
        },
        {
          idempotencyKey: specialistEventKey(
            state,
            "model_budget_committed",
            decisionId
          ),
        }
      )
    }
    for (const callId of toolCallIds) {
      const completed = state.completedCalls.find(
        (call) => call.callId === callId
      )
      const observation = state.observations.find(
        (candidate) => candidate.callId === callId
      )
      if (completed === undefined || observation === undefined) {
        throw new CheckpointStateError()
      }
      await appendOrchestrationEvent(
        this.dependencies,
        {
          runId: state.mission.runId,
          graphName: state.kernel.graphName,
          nodeName: "specialist_tool_committed",
          agent: state.agent,
          missionId: state.mission.id,
          toolName: completed.toolName,
          evidenceIds: observation.evidenceIds,
          kind: "tool_completed",
          status: "completed",
          summary: "Specialist tool completion committed",
          reasonCode: "tool_completed",
        },
        {
          idempotencyKey: specialistEventKey(state, "tool_completed", callId),
        }
      )
      if (observation.evidenceIds.length > 0) {
        await appendOrchestrationEvent(
          this.dependencies,
          {
            runId: state.mission.runId,
            graphName: state.kernel.graphName,
            nodeName: "specialist_tool_committed",
            agent: state.agent,
            missionId: state.mission.id,
            evidenceIds: observation.evidenceIds,
            kind: "evidence_gained",
            status: "completed",
            summary: "Specialist tool evidence committed",
            reasonCode: "evidence_gained",
          },
          {
            idempotencyKey: specialistEventKey(
              state,
              "tool_evidence_committed",
              callId
            ),
          }
        )
      }
      await appendOrchestrationEvent(
        this.dependencies,
        {
          runId: state.mission.runId,
          graphName: state.kernel.graphName,
          nodeName: "specialist_tool_committed",
          agent: state.agent,
          missionId: state.mission.id,
          evidenceIds: [],
          kind: "budget_updated",
          status: "completed",
          summary: "Specialist tool budget committed",
          reasonCode: "tool_budget_updated",
          budget: {
            consumed: state.budgetLedger.total.toolCalls,
            limit: state.mission.budget.toolCalls,
            unit: "tool_calls",
          },
        },
        {
          idempotencyKey: specialistEventKey(
            state,
            "tool_budget_committed",
            callId
          ),
        }
      )
    }
    await this.kernel.graph.updateState(
      this.graphConfig(state.mission.id),
      validateSpecialistUpdate(state, {
        pendingDecisionEventId: null,
        lastCommittedToolCallId: null,
        pendingTerminalToolCallIds: [],
      }),
      "specialist_finalize"
    )
    return this.currentState(state.mission.id)
  }

  private async flushPendingTerminalEvent(
    state: SpecialistStateValue
  ): Promise<SpecialistStateValue> {
    state = await this.flushPendingCommittedEvents(state)
    const result = state.terminalResult
    if (!state.pendingTerminalEvent) return state
    if (result === null || result.status === "needs_human") {
      throw new CheckpointStateError()
    }
    await this.dependencies.control.assertActive({
      runId: state.mission.runId,
      owner: this.dependencies.owner,
    })
    await appendOrchestrationEvent(
      this.dependencies,
      {
        runId: state.mission.runId,
        graphName: state.kernel.graphName,
        nodeName: "specialist_finalize",
        agent: state.agent,
        missionId: state.mission.id,
        evidenceIds: state.observations
          .flatMap((observation) => observation.evidenceIds)
          .slice(-100),
        kind: "mission_completed",
        status: terminalEventStatus(result),
        summary: "Specialist mission terminalization committed",
        reasonCode: result.stopReason.code,
      },
      {
        idempotencyKey: specialistEventKey(
          state,
          "mission_completed",
          result.stopReason.code
        ),
      }
    )
    await this.kernel.graph.updateState(
      this.graphConfig(state.mission.id),
      validateSpecialistUpdate(state, { pendingTerminalEvent: false }),
      "specialist_finalize"
    )
    return this.currentState(state.mission.id)
  }

  private resultFromTerminalState(
    state: SpecialistStateValue,
    idempotent = true
  ): SpecialistRunResult {
    const terminal = state.terminalResult
    if (terminal === null) throw new CheckpointStateError()
    const pendingInterrupt = interruptFromState(state)
    return {
      status:
        terminal.status === "needs_human" ? "interrupted" : terminal.status,
      mission: terminal,
      state,
      interrupts: pendingInterrupt === undefined ? [] : [pendingInterrupt],
      idempotent,
    }
  }

  private async terminalize(
    missionId: string,
    status: "budget_exhausted" | "failed",
    code: string,
    summary: string
  ): Promise<SpecialistRunResult> {
    const state = await this.currentState(missionId)
    await this.dependencies.control.assertActive({
      runId: state.mission.runId,
      owner: this.dependencies.owner,
    })
    const settlements = state.pendingToolCalls.map((call) =>
      settlePendingSpecialistToolCall(state, call)
    )
    const budgetUsed = settlements.reduce(
      (total, settlement) => addBudget(total, settlement.completedCall.usage),
      state.budgetLedger.total
    )
    const result = resultFor(state, status, code, summary, budgetUsed)
    const update = validateSpecialistUpdate(state, {
      ...(settlements.length === 0
        ? {}
        : {
            pendingToolCalls: {
              upsert: [],
              removeCallIds: settlements.map(
                (settlement) => settlement.completedCall.callId
              ),
            },
            observations: settlements.map(
              (settlement) => settlement.observation
            ),
            completedCalls: settlements.map(
              (settlement) => settlement.completedCall
            ),
            budgetLedger: settlements.map((settlement) => ({
              kind: "tool_call" as const,
              decisionId: settlement.completedCall.decisionId,
              callId: settlement.completedCall.callId,
              missionId: settlement.completedCall.missionId,
              agent: settlement.completedCall.agent,
              usage: settlement.completedCall.usage,
            })),
          }),
      pendingDecisionEventId: state.pendingDecisionEventId,
      lastCommittedToolCallId: null,
      pendingTerminalToolCallIds: [
        ...(state.lastCommittedToolCallId === null
          ? []
          : [state.lastCommittedToolCallId]),
        ...settlements.map((settlement) => settlement.completedCall.callId),
      ],
      terminalResult: result,
    })
    await this.kernel.graph.updateState(
      this.graphConfig(missionId),
      update,
      "specialist_finalize"
    )
    const nextState = await this.flushPendingTerminalEvent(
      await this.currentState(missionId)
    )
    const persistedResult = nextState.terminalResult
    if (persistedResult === null) throw new CheckpointStateError()
    return {
      status: persistedResult.status,
      mission: persistedResult,
      state: nextState,
      interrupts: [],
      idempotent: false,
    }
  }

  private async toResult(
    missionId: string,
    raw: unknown,
    idempotent = false
  ): Promise<SpecialistRunResult> {
    const state = await this.currentState(missionId)
    const result = state.terminalResult
    if (result === null) throw new CheckpointStateError()
    const interrupts = isInterrupted(raw)
      ? (
          (raw as Record<string, unknown>)[INTERRUPT] as readonly {
            value: SpecialistInterruptPayload
          }[]
        ).map((item) => specialistInterruptPayloadSchema.parse(item.value))
      : []
    return {
      status: interrupts.length > 0 ? "interrupted" : result.status,
      mission: result,
      state,
      interrupts,
      idempotent,
    }
  }

  private async recoverCommittedTerminal(
    missionId: string,
    idempotent: boolean
  ): Promise<SpecialistRunResult | null> {
    const snapshot = await this.currentSnapshot(missionId)
    const terminal = snapshot.state.terminalResult
    if (terminal === null || terminal.status === "needs_human") return null
    if (snapshot.next.length > 0) {
      const raw = await this.kernel.graph.invoke(
        null,
        this.graphConfig(missionId)
      )
      return this.toResult(missionId, raw, idempotent)
    }
    return this.resultFromTerminalState(
      await this.flushPendingTerminalEvent(snapshot.state),
      idempotent
    )
  }

  private async invoke(
    missionId: string,
    input: unknown,
    idempotent = false
  ): Promise<SpecialistRunResult> {
    try {
      const raw = await this.kernel.graph.invoke(
        input as Parameters<SpecialistGraph["invoke"]>[0],
        this.graphConfig(missionId)
      )
      return await this.toResult(missionId, raw, idempotent)
    } catch (error) {
      if (error instanceof GraphRecursionError) {
        const committed = await this.recoverCommittedTerminal(
          missionId,
          idempotent
        )
        if (committed !== null) return committed
        return this.terminalize(
          missionId,
          "budget_exhausted",
          "recursion_limit",
          "The specialist graph reached its recursion limit."
        )
      }
      if (error instanceof BudgetExhaustedError) {
        const committed = await this.recoverCommittedTerminal(
          missionId,
          idempotent
        )
        if (committed !== null) return committed
        return this.terminalize(
          missionId,
          "budget_exhausted",
          "elapsed_budget_exhausted",
          "The specialist mission exhausted its elapsed budget."
        )
      }
      throw error
    }
  }

  async start(missionInput: DiscoveryMission): Promise<SpecialistRunResult> {
    const mission = discoveryMissionSchema.parse(missionInput)
    if (
      mission.agent !== this.kernel.config.agent ||
      !this.kernel.config.modes.includes(mission.mode)
    ) {
      throw new CheckpointStateError()
    }
    const identityFingerprint = hashCanonical({
      mission,
      configurationFingerprint: this.kernel.config.configurationFingerprint,
    })
    const activeKey = `${this.dependencies.owner}\u0000${mission.id}`
    const active = activeSpecialistRuns.get(activeKey)
    if (active !== undefined) {
      if (
        active.identityFingerprint !== null &&
        active.identityFingerprint !== identityFingerprint
      ) {
        throw new CheckpointStateError()
      }
      const result = await active.result
      this.assertMatchingStart(result.state, this.initialState(mission))
      return { ...result, idempotent: true }
    }
    const result = this.startClaimedMission(mission)
    const entry = { identityFingerprint, result }
    activeSpecialistRuns.set(activeKey, entry)
    try {
      return await result
    } finally {
      if (activeSpecialistRuns.get(activeKey) === entry) {
        activeSpecialistRuns.delete(activeKey)
      }
    }
  }

  async continue(missionIdInput: string): Promise<SpecialistRunResult> {
    const missionId = missionIdSchema.parse(missionIdInput)
    const activeKey = `${this.dependencies.owner}\u0000${missionId}`
    const active = activeSpecialistRuns.get(activeKey)
    if (active !== undefined) {
      const result = await active.result
      return { ...result, idempotent: true }
    }
    const result = this.continueClaimedMission(missionId)
    const entry = { identityFingerprint: null, result }
    activeSpecialistRuns.set(activeKey, entry)
    try {
      return await result
    } finally {
      if (activeSpecialistRuns.get(activeKey) === entry) {
        activeSpecialistRuns.delete(activeKey)
      }
    }
  }

  private async resumeClaimedMission(
    parsed: SpecialistResumeInput
  ): Promise<SpecialistRunResult> {
    const claim = await this.dependencies.resumeCoordinator.runExclusive(
      {
        runId: SPECIALIST_START_LOCK_RUN_ID,
        decisionId: specialistStartLockDecisionId(parsed.missionId),
      },
      async () => {
        const snapshot = await this.currentSnapshot(parsed.missionId)
        const state = snapshot.state
        const human = state.humanInterrupt
        if (human?.status === "resolved") {
          if (
            human.decisionId !== parsed.decisionId ||
            human.actorId !== parsed.actorId ||
            human.approved !== parsed.approved
          ) {
            throw new ResumeConflictError()
          }
          if (state.terminalResult !== null && snapshot.next.length === 0) {
            if (state.pendingTerminalEvent) {
              return { kind: "terminal_event" as const, state }
            }
            return {
              kind: "terminal" as const,
              result: this.resultFromTerminalState(state),
            }
          }
          await this.dependencies.control.assertActive({
            runId: state.mission.runId,
            owner: this.dependencies.owner,
          })
          return { kind: "invoke" as const, input: null, idempotent: true }
        }
        if (
          human?.status !== "pending" ||
          human.decisionId !== parsed.decisionId
        ) {
          throw new ResumeAuthorizationError()
        }
        if (
          !(await this.dependencies.resumeAuthorization.authorize({
            runId: state.mission.runId,
            actorId: parsed.actorId,
            decisionId: parsed.decisionId,
          }))
        ) {
          throw new ResumeAuthorizationError()
        }
        await this.dependencies.control.assertActive({
          runId: state.mission.runId,
          owner: this.dependencies.owner,
        })
        return {
          kind: "invoke" as const,
          input: new Command({ resume: parsed }),
          idempotent: false,
        }
      }
    )
    if (claim.kind === "terminal") return claim.result
    if (claim.kind === "terminal_event") {
      return this.resultFromTerminalState(
        await this.flushPendingTerminalEvent(claim.state)
      )
    }
    return this.invoke(parsed.missionId, claim.input, claim.idempotent)
  }

  async resume(input: SpecialistResumeInput): Promise<SpecialistRunResult> {
    const parsed = specialistResumeInputSchema.parse(input)
    const activeKey = `${this.dependencies.owner}\u0000${parsed.missionId}`
    const active = activeSpecialistRuns.get(activeKey)
    if (active !== undefined) {
      const result = await active.result
      const human = result.state.humanInterrupt
      if (
        human?.status === "resolved" &&
        human.decisionId === parsed.decisionId &&
        human.actorId === parsed.actorId &&
        human.approved === parsed.approved
      ) {
        return { ...result, idempotent: true }
      }
      throw new ResumeConflictError()
    }
    const result = this.resumeClaimedMission(parsed)
    const entry = { identityFingerprint: null, result }
    activeSpecialistRuns.set(activeKey, entry)
    try {
      return await result
    } finally {
      if (activeSpecialistRuns.get(activeKey) === entry) {
        activeSpecialistRuns.delete(activeKey)
      }
    }
  }
}
