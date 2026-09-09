import {
  EVIDENCE_CURATOR_SCHEMA_VERSION,
  MAX_CURATOR_MISSIONS_PER_ROUND,
  applicationIdSchema,
  contentHashSchema,
  coverageMatrixInputSchema,
  coverageMatrixSchema,
  curatorAgentPolicySchema,
  curatorMissionProposalSchema,
  curatorMissionReceiptSchema,
  curatorMissionRejectionSchema,
  curatorModelOutputSchema,
  curatorModelRequestSchema,
  curatorReviewRecordSchema,
  discoveryMissionSchema,
  evidenceCandidateIdSchema,
  evidenceCuratorResultSchema,
  executionBudgetSchema,
  hashCanonical,
  missionBudgetSchema,
  missionResultSchema,
  persistedTextSchema,
  reasonCodeSchema,
  reconciliationEventSchema,
  runIdSchema,
  type CoverageGap,
  type CoverageMatrix,
  type CoverageMatrixInput,
  type CuratorAgentPolicy,
  type CuratorMissionProposal,
  type CuratorMissionReceipt,
  type CuratorMissionRejection,
  type CuratorModelRequest,
  type CuratorReviewRecord,
  type DiscoveryMission,
  type EvidenceCuratorResult,
  type EvidenceReviewDecision,
  type MissionBudget,
  type MissionResult,
  type ReconciliationEvent,
} from "@sentinel/contracts"
import {
  Command,
  END,
  INTERRUPT,
  ReducedValue,
  START,
  Send,
  StateGraph,
  StateSchema,
  interrupt,
  isInterrupted,
  type BaseCheckpointSaver,
} from "@langchain/langgraph"
import { z } from "zod"

import { buildCoverageMatrix } from "./coverage-matrix.ts"
import { CheckpointStateError, type ResumeCoordinator } from "./runtime.ts"
import { assertCompactCheckpointState } from "./state.ts"

export const EVIDENCE_CURATOR_GRAPH_NAME = "evidence_curator" as const
const EVIDENCE_CURATOR_EXECUTION_LOCK = "evidence_curator_execution" as const

const budgetKeys = [
  "toolCalls",
  "contentBytes",
  "documentBytes",
  "documentPages",
  "documentSections",
  "sourceLines",
  "repositoryBytes",
  "repositoryFiles",
  "browserActions",
  "modelCalls",
  "modelInputTokens",
  "modelOutputTokens",
  "reconciliationRounds",
  "elapsedMs",
] as const satisfies readonly (keyof MissionBudget)[]

const zeroBudget: MissionBudget = missionBudgetSchema.parse(
  Object.fromEntries(budgetKeys.map((key) => [key, 0]))
)

const curatorModelResponseSchema = z.strictObject({
  output: z.unknown(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
})

const curatorReviewResumeSchema = z.strictObject({
  runId: runIdSchema,
  decisionId: reasonCodeSchema,
  actorId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9:._-]+$/),
  approved: z.boolean(),
  reason: persistedTextSchema,
})

const workerInputSchema = z.strictObject({
  round: z.number().int().positive(),
  gapId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  mission: discoveryMissionSchema,
})

const pendingReviewSchema = curatorReviewRecordSchema.extend({
  status: z.literal("pending"),
})

const evidenceCuratorInterruptSchema = z.strictObject({
  schemaVersion: z.literal(EVIDENCE_CURATOR_SCHEMA_VERSION),
  decisionId: reasonCodeSchema,
  gapId: contentHashSchema,
  targetKind: z.enum(["candidate", "conflict"]),
  targetId: z.union([evidenceCandidateIdSchema, contentHashSchema]),
})

const curatorStatusSchema = z.enum([
  "running",
  "needs_human",
  "complete",
  "unresolved",
])

const curatorStopReasonOrNullSchema = z
  .enum([
    "evidence_sufficient",
    "no_material_evidence_gain",
    "maximum_rounds_reached",
    "global_budget_exhausted",
    "no_valid_missions",
    "human_review_rejected",
    "human_review_resolved",
  ])
  .nullable()

function mergeByIdentity<T>(
  current: readonly T[],
  additions: readonly T[],
  identity: (value: T) => string
): T[] {
  const merged = new Map(current.map((value) => [identity(value), value]))
  for (const addition of additions) {
    const id = identity(addition)
    const existing = merged.get(id)
    if (
      existing !== undefined &&
      hashCanonical(existing) !== hashCanonical(addition)
    ) {
      throw new Error(`Conflicting Curator reducer value for ${id}`)
    }
    merged.set(id, addition)
  }
  return [...merged.values()].sort((left, right) =>
    identity(left).localeCompare(identity(right))
  )
}

const receiptListSchema = z
  .array(curatorMissionReceiptSchema)
  .max(500)
  .default(() => [])
const rejectionListSchema = z
  .array(curatorMissionRejectionSchema)
  .max(500)
  .default(() => [])
const reviewListSchema = z
  .array(curatorReviewRecordSchema)
  .max(500)
  .default(() => [])

export const EvidenceCuratorState = new StateSchema({
  applicationId: applicationIdSchema,
  runId: runIdSchema,
  initialEvidenceStateId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  evidenceStateId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  matrix: coverageMatrixSchema.nullable().default(null),
  budget: missionBudgetSchema,
  budgetUsed: missionBudgetSchema.default(zeroBudget),
  round: z.number().int().nonnegative().default(0),
  noProgressRounds: z.number().int().nonnegative().default(0),
  lastEvidenceGain: z.number().int().nonnegative().default(0),
  activeMissions: z
    .array(curatorMissionProposalSchema)
    .max(MAX_CURATOR_MISSIONS_PER_ROUND)
    .default(() => []),
  missionReceipts: new ReducedValue(receiptListSchema, {
    inputSchema: z.union([curatorMissionReceiptSchema, receiptListSchema]),
    reducer: (current, next) =>
      mergeByIdentity(
        current,
        Array.isArray(next) ? next : [next],
        ({ missionId }) => missionId
      ),
  }),
  missionRejections: new ReducedValue(rejectionListSchema, {
    inputSchema: z.union([curatorMissionRejectionSchema, rejectionListSchema]),
    reducer: (current, next) =>
      mergeByIdentity(
        current,
        Array.isArray(next) ? next : [next],
        ({ id }) => id
      ),
  }),
  reviews: new ReducedValue(reviewListSchema, {
    inputSchema: z.union([curatorReviewRecordSchema, reviewListSchema]),
    reducer: (current, next) => {
      const merged = new Map(
        current.map((review) => [review.decisionId, review])
      )
      for (const review of Array.isArray(next) ? next : [next]) {
        merged.set(review.decisionId, review)
      }
      return [...merged.values()].sort((left, right) =>
        left.decisionId.localeCompare(right.decisionId)
      )
    },
  }),
  pendingReview: pendingReviewSchema.nullable().default(null),
  lastReviewDecisionId: reasonCodeSchema.nullable().default(null),
  status: curatorStatusSchema.default("running"),
  stopReason: curatorStopReasonOrNullSchema.default(null),
  result: evidenceCuratorResultSchema.nullable().default(null),
})

export type EvidenceCuratorStateValue = typeof EvidenceCuratorState.State

const evidenceCuratorStateSchema = z.strictObject({
  applicationId: applicationIdSchema,
  runId: runIdSchema,
  initialEvidenceStateId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  evidenceStateId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  matrix: coverageMatrixSchema.nullable(),
  budget: missionBudgetSchema,
  budgetUsed: missionBudgetSchema,
  round: z.number().int().nonnegative(),
  noProgressRounds: z.number().int().nonnegative(),
  lastEvidenceGain: z.number().int().nonnegative(),
  activeMissions: z
    .array(curatorMissionProposalSchema)
    .max(MAX_CURATOR_MISSIONS_PER_ROUND),
  missionReceipts: receiptListSchema,
  missionRejections: rejectionListSchema,
  reviews: reviewListSchema,
  pendingReview: pendingReviewSchema.nullable(),
  lastReviewDecisionId: reasonCodeSchema.nullable(),
  status: curatorStatusSchema,
  stopReason: curatorStopReasonOrNullSchema,
  result: evidenceCuratorResultSchema.nullable(),
})

export function parseEvidenceCuratorState(
  input: unknown
): EvidenceCuratorStateValue {
  const state = evidenceCuratorStateSchema.parse(input)
  assertCompactCheckpointState(state)
  return state
}

function addBudget(left: MissionBudget, right: MissionBudget): MissionBudget {
  return missionBudgetSchema.parse(
    Object.fromEntries(budgetKeys.map((key) => [key, left[key] + right[key]]))
  )
}

function subtractBudget(
  limit: MissionBudget,
  consumed: MissionBudget
): MissionBudget {
  return missionBudgetSchema.parse(
    Object.fromEntries(
      budgetKeys.map((key) => [key, Math.max(0, limit[key] - consumed[key])])
    )
  )
}

function fitsBudget(requested: MissionBudget, limit: MissionBudget): boolean {
  return budgetKeys.every((key) => requested[key] <= limit[key])
}

function usageBudget(input: {
  readonly modelCalls?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly reconciliationRounds?: number
}): MissionBudget {
  return missionBudgetSchema.parse({
    ...zeroBudget,
    modelCalls: input.modelCalls ?? 0,
    modelInputTokens: input.inputTokens ?? 0,
    modelOutputTokens: input.outputTokens ?? 0,
    reconciliationRounds: input.reconciliationRounds ?? 0,
  })
}

function budgetExhausted(state: EvidenceCuratorStateValue): boolean {
  const remaining = subtractBudget(state.budget, state.budgetUsed)
  return remaining.modelCalls < 1 || remaining.reconciliationRounds < 1
}

function pathWithin(candidate: string, allowed: readonly string[]): boolean {
  return allowed.some(
    (root) => candidate === root || candidate.startsWith(`${root}/`)
  )
}

function sourceWithin(candidate: string, allowed: readonly string[]): boolean {
  return allowed.some(
    (root) => candidate === root || candidate.startsWith(`${root}/`)
  )
}

function missionRejection(input: {
  readonly round: number
  readonly code: CuratorMissionRejection["code"]
  readonly summary: string
  readonly missionId?: string
  readonly gapId?: string
}): CuratorMissionRejection {
  return curatorMissionRejectionSchema.parse({
    id: hashCanonical({
      round: input.round,
      code: input.code,
      summary: input.summary,
      ...(input.missionId === undefined ? {} : { missionId: input.missionId }),
      ...(input.gapId === undefined ? {} : { gapId: input.gapId }),
    }),
    round: input.round,
    code: input.code,
    summary: input.summary,
    ...(input.missionId === undefined ? {} : { missionId: input.missionId }),
    ...(input.gapId === undefined ? {} : { gapId: input.gapId }),
  })
}

export function createCuratorMissionId(input: {
  readonly applicationId: string
  readonly runId: string
  readonly gapId: string
  readonly agent: "documentation" | "code" | "application"
  readonly mode: DiscoveryMission["mode"]
}) {
  return `mission:v1:${hashCanonical({
    applicationId: applicationIdSchema.parse(input.applicationId),
    runId: runIdSchema.parse(input.runId),
    gapId: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .parse(input.gapId),
    agent: input.agent,
    mode: input.mode,
    kind: "curator-mission",
    version: 1,
  }).slice("sha256:".length)}`
}

export interface CuratorModelPort {
  propose(
    request: CuratorModelRequest,
    signal?: AbortSignal
  ): Promise<{
    readonly output: unknown
    readonly inputTokens: number
    readonly outputTokens: number
  }>
}

export interface CuratorSpecialistDispatcher {
  dispatch(
    mission: DiscoveryMission,
    signal?: AbortSignal
  ): Promise<MissionResult>
}

export type CuratorSpecialistHandler = (
  mission: DiscoveryMission,
  signal?: AbortSignal
) => Promise<MissionResult>

export function createCuratorSpecialistDispatcher(handlers: {
  readonly documentation: CuratorSpecialistHandler
  readonly code: CuratorSpecialistHandler
  readonly application: CuratorSpecialistHandler
}): CuratorSpecialistDispatcher {
  return Object.freeze({
    dispatch: async (missionInput: DiscoveryMission, signal?: AbortSignal) => {
      const mission = discoveryMissionSchema.parse(missionInput)
      const result = missionResultSchema.parse(
        await handlers[mission.agent](mission, signal)
      )
      if (result.missionId !== mission.id) {
        throw new Error("Specialist result does not belong to its mission")
      }
      return result
    },
  })
}

export interface CuratorMissionResultStore {
  save(mission: DiscoveryMission, result: MissionResult): Promise<void>
  load(missionIds: readonly string[]): Promise<readonly MissionResult[]>
}

export class InMemoryCuratorMissionResultStore implements CuratorMissionResultStore {
  private readonly results = new Map<string, MissionResult>()

  async save(missionInput: DiscoveryMission, resultInput: MissionResult) {
    const mission = discoveryMissionSchema.parse(missionInput)
    const result = missionResultSchema.parse(resultInput)
    if (result.missionId !== mission.id) {
      throw new Error("Stored specialist result does not match its mission")
    }
    const existing = this.results.get(mission.id)
    if (
      existing !== undefined &&
      hashCanonical(existing) !== hashCanonical(result)
    ) {
      throw new Error("Conflicting specialist result replay")
    }
    this.results.set(mission.id, result)
  }

  async load(missionIds: readonly string[]) {
    return missionIds.map((missionId) => {
      const result = this.results.get(missionId)
      if (result === undefined) {
        throw new Error("Curator specialist result is missing")
      }
      return result
    })
  }
}

export interface CuratorEvidenceStatePort {
  load(
    evidenceStateId: string,
    signal?: AbortSignal
  ): Promise<CoverageMatrixInput>
  applyMissionResults(input: {
    readonly evidenceStateId: string
    readonly missions: readonly DiscoveryMission[]
    readonly results: readonly MissionResult[]
    readonly signal?: AbortSignal
  }): Promise<CoverageMatrixInput>
  applyReview(input: {
    readonly evidenceStateId: string
    readonly decision: EvidenceReviewDecision
    readonly signal?: AbortSignal
  }): Promise<CoverageMatrixInput>
}

export interface ReconciliationEventSink {
  append(event: ReconciliationEvent): Promise<void>
}

export interface EvidenceCuratorDependencies {
  readonly model: CuratorModelPort
  readonly dispatcher: CuratorSpecialistDispatcher
  readonly resultStore: CuratorMissionResultStore
  readonly evidenceState: CuratorEvidenceStatePort
  readonly events: ReconciliationEventSink
  readonly resumeCoordinator: ResumeCoordinator
  readonly policies: readonly CuratorAgentPolicy[]
  readonly signal?: AbortSignal | (() => AbortSignal | undefined)
  readonly now?: () => Date
}

export interface EvidenceCuratorOptions {
  readonly maxRounds?: number
  readonly maxNoProgressRounds?: number
  readonly recursionLimit?: number
}

function currentSignal(
  signal: EvidenceCuratorDependencies["signal"]
): AbortSignal | undefined {
  return typeof signal === "function" ? signal() : signal
}

function validatePolicies(
  input: readonly CuratorAgentPolicy[]
): readonly CuratorAgentPolicy[] {
  const policies = input.map((policy) => curatorAgentPolicySchema.parse(policy))
  if (new Set(policies.map(({ agent }) => agent)).size !== policies.length) {
    throw new Error("Curator agent policies must be unique")
  }
  return policies.sort((left, right) => left.agent.localeCompare(right.agent))
}

function eventId(input: {
  readonly runId: string
  readonly round: number
  readonly kind: ReconciliationEvent["kind"]
  readonly reasonCode: string
  readonly gapId?: string
  readonly missionId?: string
}) {
  return hashCanonical({ ...input, graphName: EVIDENCE_CURATOR_GRAPH_NAME })
}

interface ReconciliationEventDraft {
  readonly applicationId: string
  readonly runId: string
  readonly round: number
  readonly kind: ReconciliationEvent["kind"]
  readonly summary: string
  readonly reasonCode: string
  readonly gapId?: string
  readonly missionId?: string
  readonly agent?: "documentation" | "code" | "application"
  readonly evidenceGain?: number
}

async function emitEvent(
  dependencies: EvidenceCuratorDependencies,
  input: ReconciliationEventDraft
): Promise<void> {
  const event = reconciliationEventSchema.parse({
    schemaVersion: EVIDENCE_CURATOR_SCHEMA_VERSION,
    id: eventId({
      runId: input.runId,
      round: input.round,
      kind: input.kind,
      reasonCode: input.reasonCode,
      ...(input.gapId === undefined ? {} : { gapId: input.gapId }),
      ...(input.missionId === undefined ? {} : { missionId: input.missionId }),
    }),
    ...input,
    occurredAt: (dependencies.now ?? (() => new Date()))().toISOString(),
  })
  await dependencies.events.append(event)
}

function missionScopeAllowed(
  mission: DiscoveryMission,
  policy: CuratorAgentPolicy,
  gap: CoverageGap
): CuratorMissionRejection["code"] | undefined {
  if (
    mission.agent !== gap.recommendedAgent ||
    mission.agent !== policy.agent
  ) {
    return "agent_not_allowed"
  }
  if (
    !gap.allowedModes.includes(mission.mode) ||
    !policy.modes.includes(mission.mode)
  ) {
    return "mode_not_allowed"
  }
  if (
    mission.scope.repositoryPaths.some(
      (path) => !pathWithin(path, policy.allowedRepositoryPaths)
    ) ||
    mission.scope.sourceUris.some(
      (uri) => !sourceWithin(uri, policy.allowedSourceUris)
    ) ||
    mission.scope.allowedHosts.some(
      (host) => !policy.allowedHosts.includes(host)
    )
  ) {
    return "scope_not_allowed"
  }
  if (
    mission.scope.allowedTools.some(
      (tool) => !policy.allowedTools.includes(tool)
    )
  ) {
    return "tool_not_allowed"
  }
  const gapEvidence = new Set(gap.evidenceIds)
  if (mission.seedEvidenceIds.some((id) => !gapEvidence.has(id))) {
    return "scope_not_allowed"
  }
  if (!fitsBudget(mission.budget, policy.maxMissionBudget)) {
    return "mission_budget_exceeded"
  }
  return undefined
}

interface ValidatedPlan {
  readonly missions: CuratorMissionProposal[]
  readonly rejections: CuratorMissionRejection[]
}

export function validateCuratorMissionProposals(input: {
  readonly round: number
  readonly proposals: readonly CuratorMissionProposal[]
  readonly matrix: CoverageMatrix
  readonly policies: readonly CuratorAgentPolicy[]
  readonly remainingBudget: MissionBudget
  readonly previousReceipts: readonly CuratorMissionReceipt[]
  readonly priorMissionIds: readonly string[]
  readonly maxRoundsReached: boolean
}): ValidatedPlan {
  const gapById = new Map(input.matrix.gaps.map((gap) => [gap.id, gap]))
  const policyByAgent = new Map(
    input.policies.map((policy) => [policy.agent, policy])
  )
  const priorIds = new Set(input.priorMissionIds)
  const previousKeys = new Set(
    input.previousReceipts.map(
      (receipt) => `${receipt.gapId}:${receipt.agent}:${receipt.mode}`
    )
  )
  const perAgent = new Map<string, number>()
  let reserved = zeroBudget
  const missions: CuratorMissionProposal[] = []
  const rejections: CuratorMissionRejection[] = []

  for (const proposalInput of input.proposals) {
    const proposal = curatorMissionProposalSchema.parse(proposalInput)
    const mission = proposal.mission
    const reject = (code: CuratorMissionRejection["code"], summary: string) =>
      rejections.push(
        missionRejection({
          round: input.round,
          code,
          summary,
          missionId: mission.id,
          gapId: proposal.gapId,
        })
      )

    if (input.maxRoundsReached) {
      reject("round_limit_exceeded", "Maximum reconciliation rounds reached")
      continue
    }
    if (
      mission.applicationId !== input.matrix.applicationId ||
      mission.runId !== input.matrix.runId
    ) {
      reject("scope_not_allowed", "Mission crosses the Curator run boundary")
      continue
    }
    const gap = gapById.get(proposal.gapId)
    if (gap === undefined) {
      reject("unknown_gap", "Mission references an unknown coverage gap")
      continue
    }
    if (
      mission.id !==
      createCuratorMissionId({
        applicationId: mission.applicationId,
        runId: mission.runId,
        gapId: proposal.gapId,
        agent: mission.agent,
        mode: mission.mode,
      })
    ) {
      reject(
        "scope_not_allowed",
        "Mission identity does not match its parent-authorized gap and mode"
      )
      continue
    }
    if (gap.requiresHuman) {
      reject(
        "human_gap",
        "Human-review gaps cannot be dispatched to specialists"
      )
      continue
    }
    if (
      priorIds.has(mission.id) ||
      missions.some(({ mission: item }) => item.id === mission.id)
    ) {
      reject("duplicate_mission", "Mission identity was already used")
      continue
    }
    const policy = policyByAgent.get(mission.agent)
    if (policy === undefined) {
      reject("agent_not_allowed", "Mission agent has no parent policy")
      continue
    }
    const scopeFailure = missionScopeAllowed(mission, policy, gap)
    if (scopeFailure !== undefined) {
      reject(
        scopeFailure,
        `Mission violates parent ${scopeFailure.replaceAll("_", " ")} policy`
      )
      continue
    }
    const relevanceKey = `${proposal.gapId}:${mission.agent}:${mission.mode}`
    if (previousKeys.has(relevanceKey)) {
      reject(
        "redundant_mission",
        "Mission repeats completed work for the same gap"
      )
      continue
    }
    const count = perAgent.get(mission.agent) ?? 0
    if (count >= policy.maxMissionsPerRound) {
      reject("agent_not_allowed", "Mission exceeds the per-agent round limit")
      continue
    }
    const nextReserved = addBudget(reserved, mission.budget)
    if (!fitsBudget(nextReserved, input.remainingBudget)) {
      reject(
        "global_budget_exceeded",
        "Mission set exceeds remaining global budget"
      )
      continue
    }
    perAgent.set(mission.agent, count + 1)
    reserved = nextReserved
    priorIds.add(mission.id)
    missions.push(proposal)
  }

  return {
    missions: missions.sort((left, right) =>
      left.mission.id.localeCompare(right.mission.id)
    ),
    rejections: rejections.sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
  }
}

function materialEvidenceGain(
  before: CoverageMatrix,
  after: CoverageMatrix
): number {
  const linkGain = Math.max(
    0,
    after.stats.confidentLinkCount - before.stats.confidentLinkCount
  )
  const gapGain = Math.max(0, before.stats.gapCount - after.stats.gapCount)
  const strengthened =
    linkGain + gapGain === 0 &&
    before.evidenceFingerprint !== after.evidenceFingerprint
      ? 1
      : 0
  return linkGain + gapGain + strengthened
}

function reviewForGap(gap: CoverageGap): CuratorReviewRecord | undefined {
  const targetKind = gap.candidateIds.length > 0 ? "candidate" : "conflict"
  const targetId =
    targetKind === "candidate" ? gap.candidateIds[0] : gap.conflictIds[0]
  if (targetId === undefined) return undefined
  return curatorReviewRecordSchema.parse({
    schemaVersion: EVIDENCE_CURATOR_SCHEMA_VERSION,
    decisionId: `curator_review_${gap.id.slice("sha256:".length, 24)}`,
    gapId: gap.id,
    targetKind,
    targetId,
    status: "pending",
  })
}

function resultForState(
  state: EvidenceCuratorStateValue
): EvidenceCuratorResult {
  const matrix = state.matrix
  const stopReason = state.stopReason
  if (matrix === null || stopReason === null) {
    throw new Error("Curator cannot finalize without a matrix and stop reason")
  }
  return evidenceCuratorResultSchema.parse({
    schemaVersion: EVIDENCE_CURATOR_SCHEMA_VERSION,
    applicationId: state.applicationId,
    runId: state.runId,
    status:
      state.status === "unresolved"
        ? "unresolved"
        : matrix.publicationReady
          ? "complete"
          : "unresolved",
    stopReason,
    roundsUsed: state.round,
    budgetUsed: state.budgetUsed,
    matrix,
    missionReceipts: state.missionReceipts,
    missionRejections: state.missionRejections,
    reviews: state.reviews,
  })
}

function assertCoverageIdentity(
  coverage: CoverageMatrixInput,
  state: Pick<EvidenceCuratorStateValue, "applicationId" | "runId">
) {
  if (
    coverage.applicationId !== state.applicationId ||
    coverage.runId !== state.runId
  ) {
    throw new Error("Evidence state does not belong to the Curator run")
  }
}

export function createEvidenceCuratorInitialState(input: {
  readonly applicationId: string
  readonly runId: string
  readonly evidenceStateId: string
  readonly budget: MissionBudget
}): EvidenceCuratorStateValue {
  return parseEvidenceCuratorState({
    applicationId: applicationIdSchema.parse(input.applicationId),
    runId: runIdSchema.parse(input.runId),
    initialEvidenceStateId: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .parse(input.evidenceStateId),
    evidenceStateId: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .parse(input.evidenceStateId),
    matrix: null,
    budget: executionBudgetSchema.parse(input.budget),
    budgetUsed: zeroBudget,
    round: 0,
    noProgressRounds: 0,
    lastEvidenceGain: 0,
    activeMissions: [],
    missionReceipts: [],
    missionRejections: [],
    reviews: [],
    pendingReview: null,
    lastReviewDecisionId: null,
    status: "running",
    stopReason: null,
    result: null,
  })
}

export function buildEvidenceCuratorGraph(
  dependencies: EvidenceCuratorDependencies,
  checkpointer: BaseCheckpointSaver,
  options: EvidenceCuratorOptions = {}
) {
  if (checkpointer === undefined) {
    throw new Error("Evidence Curator requires a checkpointer")
  }
  const policies = validatePolicies(dependencies.policies)
  const maxRounds = z
    .number()
    .int()
    .positive()
    .max(20)
    .parse(options.maxRounds ?? 3)
  const maxNoProgressRounds = z
    .number()
    .int()
    .positive()
    .max(10)
    .parse(options.maxNoProgressRounds ?? 1)
  const signal = () => currentSignal(dependencies.signal)

  const buildMatrixNode = async (stateInput: EvidenceCuratorStateValue) => {
    const state = parseEvidenceCuratorState(stateInput)
    const source = coverageMatrixInputSchema.parse(
      await dependencies.evidenceState.load(state.evidenceStateId, signal())
    )
    assertCoverageIdentity(source, state)
    const matrix = buildCoverageMatrix(source)
    return { matrix, evidenceStateId: source.evidenceStateId }
  }

  const reportMatrixNode = async (stateInput: EvidenceCuratorStateValue) => {
    const state = parseEvidenceCuratorState(stateInput)
    const matrix = state.matrix
    if (matrix === null) throw new Error("Coverage matrix is missing")
    await emitEvent(dependencies, {
      applicationId: state.applicationId,
      runId: state.runId,
      round: state.round,
      kind: "coverage_built",
      summary: `Coverage matrix contains ${matrix.stats.gapCount} gaps`,
      reasonCode: matrix.readiness,
    })
    return {}
  }

  const assessNode = (stateInput: EvidenceCuratorStateValue) => {
    const state = parseEvidenceCuratorState(stateInput)
    const matrix = state.matrix
    if (matrix === null) throw new Error("Coverage matrix is missing")
    if (matrix.publicationReady) {
      return {
        status: "complete" as const,
        stopReason: "evidence_sufficient" as const,
      }
    }
    const hasHumanGap = matrix.gaps.some(({ requiresHuman }) => requiresHuman)
    if (state.noProgressRounds >= maxNoProgressRounds) {
      if (hasHumanGap) {
        return { status: "running" as const, stopReason: null }
      }
      return {
        status: "unresolved" as const,
        stopReason: "no_material_evidence_gain" as const,
      }
    }
    if (state.round >= maxRounds) {
      if (hasHumanGap) {
        return { status: "running" as const, stopReason: null }
      }
      return {
        status: "unresolved" as const,
        stopReason: "maximum_rounds_reached" as const,
      }
    }
    if (budgetExhausted(state)) {
      if (hasHumanGap) {
        return { status: "running" as const, stopReason: null }
      }
      return {
        status: "unresolved" as const,
        stopReason: "global_budget_exhausted" as const,
      }
    }
    return { status: "running" as const, stopReason: null }
  }

  const routeAfterAssess = (stateInput: EvidenceCuratorStateValue) => {
    const state = parseEvidenceCuratorState(stateInput)
    if (state.status === "complete" || state.status === "unresolved") {
      return "finalize"
    }
    const shouldReviewNow =
      state.matrix?.gaps.some(({ requiresHuman }) => requiresHuman) &&
      (state.noProgressRounds >= maxNoProgressRounds ||
        state.round >= maxRounds ||
        budgetExhausted(state))
    if (shouldReviewNow) return "prepare_review"
    const actionable = state.matrix?.gaps.some(
      ({ requiresHuman }) => !requiresHuman
    )
    return actionable ? "plan_missions" : "prepare_review"
  }

  const planMissionsNode = async (stateInput: EvidenceCuratorStateValue) => {
    const state = parseEvidenceCuratorState(stateInput)
    const matrix = state.matrix
    if (matrix === null) throw new Error("Coverage matrix is missing")
    const beforeCall = subtractBudget(state.budget, state.budgetUsed)
    if (beforeCall.modelCalls < 1 || beforeCall.reconciliationRounds < 1) {
      return {
        activeMissions: [],
        status: "unresolved" as const,
        stopReason: "global_budget_exhausted" as const,
      }
    }
    const round = state.round + 1
    const request = curatorModelRequestSchema.parse({
      schemaVersion: EVIDENCE_CURATOR_SCHEMA_VERSION,
      applicationId: state.applicationId,
      runId: state.runId,
      round,
      matrix,
      remainingBudget: beforeCall,
      policies,
      priorMissionIds: state.missionReceipts.map(({ missionId }) => missionId),
    })
    const response = curatorModelResponseSchema.parse(
      await dependencies.model.propose(request, signal())
    )
    const modelUsage = usageBudget({
      modelCalls: 1,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      reconciliationRounds: 1,
    })
    if (!fitsBudget(modelUsage, beforeCall)) {
      return {
        activeMissions: [],
        status: "unresolved" as const,
        stopReason: "global_budget_exhausted" as const,
      }
    }
    const budgetUsed = addBudget(state.budgetUsed, modelUsage)
    const parsed = curatorModelOutputSchema.safeParse(response.output)
    if (!parsed.success) {
      return {
        activeMissions: [],
        missionRejections: missionRejection({
          round,
          code: "model_output_invalid",
          summary: "Curator returned invalid structured mission output",
        }),
        budgetUsed,
        round,
        status: "unresolved" as const,
        stopReason: "no_valid_missions" as const,
      }
    }
    const validated = validateCuratorMissionProposals({
      round,
      proposals: parsed.data.missions,
      matrix,
      policies,
      remainingBudget: subtractBudget(state.budget, budgetUsed),
      previousReceipts: state.missionReceipts,
      priorMissionIds: state.missionReceipts.map(({ missionId }) => missionId),
      maxRoundsReached: round > maxRounds,
    })
    return {
      activeMissions: validated.missions,
      missionRejections: validated.rejections,
      budgetUsed,
      round,
      status:
        validated.missions.length === 0
          ? ("unresolved" as const)
          : ("running" as const),
      stopReason:
        validated.missions.length === 0 ? ("no_valid_missions" as const) : null,
    }
  }

  const reportPlanNode = async (stateInput: EvidenceCuratorStateValue) => {
    const state = parseEvidenceCuratorState(stateInput)
    for (const proposal of state.activeMissions) {
      await emitEvent(dependencies, {
        applicationId: state.applicationId,
        runId: state.runId,
        round: state.round,
        kind: "mission_proposed",
        summary: "Curator proposed a bounded specialist mission",
        reasonCode: "mission_proposed",
        gapId: proposal.gapId,
        missionId: proposal.mission.id,
        agent: proposal.mission.agent,
      })
    }
    for (const rejected of state.missionRejections.filter(
      ({ round }) => round === state.round
    )) {
      await emitEvent(dependencies, {
        applicationId: state.applicationId,
        runId: state.runId,
        round: state.round,
        kind: "mission_rejected",
        summary: rejected.summary,
        reasonCode: rejected.code,
        ...(rejected.gapId === undefined ? {} : { gapId: rejected.gapId }),
        ...(rejected.missionId === undefined
          ? {}
          : { missionId: rejected.missionId }),
      })
    }
    return {}
  }

  const routeMissions = (stateInput: EvidenceCuratorStateValue) => {
    const state = parseEvidenceCuratorState(stateInput)
    if (state.activeMissions.length === 0) {
      const hasHuman = state.matrix?.gaps.some(
        ({ requiresHuman }) => requiresHuman
      )
      return hasHuman ? "prepare_review" : "finalize"
    }
    return state.activeMissions.map(
      ({ gapId, mission }) =>
        new Send("execute_mission", { round: state.round, gapId, mission })
    )
  }

  const executeMissionNode = async (inputValue: unknown) => {
    const worker = workerInputSchema.parse(inputValue)
    const result = missionResultSchema.parse(
      await dependencies.dispatcher.dispatch(worker.mission, signal())
    )
    if (
      result.missionId !== worker.mission.id ||
      !fitsBudget(result.budgetUsed, worker.mission.budget)
    ) {
      throw new Error("Specialist result violates its validated mission")
    }
    await dependencies.resultStore.save(worker.mission, result)
    const receipt = curatorMissionReceiptSchema.parse({
      schemaVersion: EVIDENCE_CURATOR_SCHEMA_VERSION,
      round: worker.round,
      gapId: worker.gapId,
      missionId: worker.mission.id,
      agent: worker.mission.agent,
      mode: worker.mission.mode,
      status: result.status,
      resultFingerprint: hashCanonical(result),
      evidenceIds: sortedEvidenceIds(result),
      budgetUsed: result.budgetUsed,
    })
    return { missionReceipts: receipt }
  }

  const reconcileNode = async (stateInput: EvidenceCuratorStateValue) => {
    const state = parseEvidenceCuratorState(stateInput)
    const before = state.matrix
    if (before === null) throw new Error("Coverage matrix is missing")
    const activeIds = state.activeMissions.map(({ mission }) => mission.id)
    const receipts = state.missionReceipts.filter(
      (receipt) =>
        receipt.round === state.round && activeIds.includes(receipt.missionId)
    )
    if (receipts.length !== activeIds.length) {
      throw new Error("Parallel specialist fan-in lost a mission result")
    }
    const results = (await dependencies.resultStore.load(activeIds)).map(
      (result) => missionResultSchema.parse(result)
    )
    const missionById = new Map(
      state.activeMissions.map(({ mission }) => [mission.id, mission])
    )
    for (const result of results) {
      const mission = missionById.get(result.missionId)
      if (
        mission === undefined ||
        !fitsBudget(result.budgetUsed, mission.budget)
      ) {
        throw new Error("Stored specialist result violates its mission budget")
      }
    }
    for (const receipt of receipts) {
      const mission = missionById.get(receipt.missionId)
      const result = results.find(
        ({ missionId }) => missionId === receipt.missionId
      )
      if (mission === undefined || result === undefined) {
        throw new Error("Committed specialist receipt has no matching result")
      }
      await emitEvent(dependencies, {
        applicationId: state.applicationId,
        runId: state.runId,
        round: state.round,
        kind: "mission_dispatched",
        summary: "Parent graph dispatched a validated specialist mission",
        reasonCode: mission.mode,
        gapId: receipt.gapId,
        missionId: mission.id,
        agent: mission.agent,
      })
      await emitEvent(dependencies, {
        applicationId: state.applicationId,
        runId: state.runId,
        round: state.round,
        kind: "mission_completed",
        summary: "Specialist mission returned a validated terminal result",
        reasonCode: result.stopReason.code,
        gapId: receipt.gapId,
        missionId: mission.id,
        agent: mission.agent,
      })
    }
    const activeSignal = signal()
    const nextSource = coverageMatrixInputSchema.parse(
      await dependencies.evidenceState.applyMissionResults({
        evidenceStateId: state.evidenceStateId,
        missions: state.activeMissions.map(({ mission }) => mission),
        results,
        ...(activeSignal === undefined ? {} : { signal: activeSignal }),
      })
    )
    assertCoverageIdentity(nextSource, state)
    const matrix = buildCoverageMatrix(nextSource)
    const gain = materialEvidenceGain(before, matrix)
    const resultBudget = results.reduce(
      (total, result) => addBudget(total, result.budgetUsed),
      zeroBudget
    )
    const budgetUsed = addBudget(state.budgetUsed, resultBudget)
    if (!fitsBudget(budgetUsed, state.budget)) {
      throw new Error("Specialist results exceeded the global Curator budget")
    }
    return {
      evidenceStateId: nextSource.evidenceStateId,
      matrix,
      budgetUsed,
      noProgressRounds: gain > 0 ? 0 : state.noProgressRounds + 1,
      lastEvidenceGain: gain,
      activeMissions: [],
      status: "running" as const,
      stopReason: null,
    }
  }

  const reportReconciliationNode = async (
    stateInput: EvidenceCuratorStateValue
  ) => {
    const state = parseEvidenceCuratorState(stateInput)
    const gain = state.lastEvidenceGain
    await emitEvent(dependencies, {
      applicationId: state.applicationId,
      runId: state.runId,
      round: state.round,
      kind: "evidence_relinked",
      summary:
        gain > 0
          ? "Specialist results added material evidence"
          : "Specialist results added no material evidence",
      reasonCode: gain > 0 ? "material_evidence_gain" : "no_evidence_gain",
      evidenceGain: gain,
    })
    return {}
  }

  const prepareReviewNode = async (stateInput: EvidenceCuratorStateValue) => {
    const state = parseEvidenceCuratorState(stateInput)
    const humanGap = state.matrix?.gaps.find(
      ({ requiresHuman }) => requiresHuman
    )
    const pendingReview =
      humanGap === undefined ? undefined : reviewForGap(humanGap)
    if (pendingReview === undefined) {
      return {
        status: "unresolved" as const,
        stopReason: "no_valid_missions" as const,
      }
    }
    return {
      pendingReview,
      reviews: pendingReview,
      status: "needs_human" as const,
      stopReason: null,
    }
  }

  const reportReviewRequestedNode = async (
    stateInput: EvidenceCuratorStateValue
  ) => {
    const state = parseEvidenceCuratorState(stateInput)
    const pendingReview = state.pendingReview
    if (pendingReview === null)
      throw new Error("Curator review state is missing")
    await emitEvent(dependencies, {
      applicationId: state.applicationId,
      runId: state.runId,
      round: state.round,
      kind: "human_review_requested",
      summary: "Coverage gap requires an explicit human decision",
      reasonCode: "human_review_required",
      gapId: pendingReview.gapId,
    })
    return {}
  }

  const humanReviewNode = async (stateInput: EvidenceCuratorStateValue) => {
    const state = parseEvidenceCuratorState(stateInput)
    const pending = state.pendingReview
    if (pending === null) throw new Error("Curator review state is missing")
    const response = curatorReviewResumeSchema.parse(
      interrupt({
        schemaVersion: EVIDENCE_CURATOR_SCHEMA_VERSION,
        decisionId: pending.decisionId,
        gapId: pending.gapId,
        targetKind: pending.targetKind,
        targetId: pending.targetId,
      })
    )
    if (response.decisionId !== pending.decisionId) {
      throw new Error("Curator review decision does not match the interrupt")
    }
    if (response.runId !== state.runId) {
      throw new Error("Curator review decision does not match the run")
    }
    const decision: EvidenceReviewDecision = {
      targetKind: pending.targetKind,
      targetId: pending.targetId,
      approved: response.approved,
      reason: response.reason,
      actorId: response.actorId,
      decidedAt: (
        dependencies.now ?? (() => new Date())
      )().toISOString() as EvidenceReviewDecision["decidedAt"],
    }
    const activeSignal = signal()
    const nextSource = coverageMatrixInputSchema.parse(
      await dependencies.evidenceState.applyReview({
        evidenceStateId: state.evidenceStateId,
        decision,
        ...(activeSignal === undefined ? {} : { signal: activeSignal }),
      })
    )
    assertCoverageIdentity(nextSource, state)
    const matrix = buildCoverageMatrix(nextSource)
    const resolved = curatorReviewRecordSchema.parse({
      ...pending,
      status: response.approved ? "accepted" : "rejected",
      actorId: response.actorId,
      reason: response.reason,
    })
    return {
      evidenceStateId: nextSource.evidenceStateId,
      matrix,
      reviews: resolved,
      pendingReview: null,
      lastReviewDecisionId: resolved.decisionId,
      status: response.approved
        ? ("running" as const)
        : ("unresolved" as const),
      stopReason: response.approved ? null : ("human_review_rejected" as const),
    }
  }

  const reportReviewResumedNode = async (
    stateInput: EvidenceCuratorStateValue
  ) => {
    const state = parseEvidenceCuratorState(stateInput)
    const resolved = state.reviews.find(
      ({ decisionId }) => decisionId === state.lastReviewDecisionId
    )
    if (resolved === undefined) {
      throw new Error("Resolved Curator review is missing")
    }
    await emitEvent(dependencies, {
      applicationId: state.applicationId,
      runId: state.runId,
      round: state.round,
      kind: "human_review_resumed",
      summary: "Human review decision was applied to evidence state",
      reasonCode:
        resolved.status === "accepted"
          ? "human_review_accepted"
          : "human_review_rejected",
      gapId: resolved.gapId,
    })
    return {}
  }

  const routeAfterReview = (stateInput: EvidenceCuratorStateValue) => {
    const state = parseEvidenceCuratorState(stateInput)
    return state.status === "unresolved" ? "finalize" : "assess"
  }

  const finalizeNode = async (stateInput: EvidenceCuratorStateValue) => {
    const state = parseEvidenceCuratorState(stateInput)
    const result = resultForState(state)
    return { result }
  }

  const reportFinalizedNode = async (stateInput: EvidenceCuratorStateValue) => {
    const state = parseEvidenceCuratorState(stateInput)
    const result = state.result
    if (result === null) throw new Error("Curator result is missing")
    await emitEvent(dependencies, {
      applicationId: state.applicationId,
      runId: state.runId,
      round: state.round,
      kind: "reconciliation_stopped",
      summary:
        result.status === "complete"
          ? "Evidence matrix is ready for publication"
          : "Reconciliation stopped with explicit unresolved coverage",
      reasonCode: result.stopReason,
    })
    return {}
  }

  return new StateGraph(EvidenceCuratorState)
    .addNode("build_matrix", buildMatrixNode)
    .addNode("report_matrix", reportMatrixNode)
    .addNode("assess", assessNode)
    .addNode("plan_missions", planMissionsNode)
    .addNode("report_plan", reportPlanNode)
    .addNode("execute_mission", executeMissionNode)
    .addNode("reconcile", reconcileNode)
    .addNode("report_reconciliation", reportReconciliationNode)
    .addNode("prepare_review", prepareReviewNode)
    .addNode("report_review_requested", reportReviewRequestedNode)
    .addNode("human_review", humanReviewNode)
    .addNode("report_review_resumed", reportReviewResumedNode)
    .addNode("finalize", finalizeNode)
    .addNode("report_finalized", reportFinalizedNode)
    .addEdge(START, "build_matrix")
    .addEdge("build_matrix", "report_matrix")
    .addEdge("report_matrix", "assess")
    .addConditionalEdges("assess", routeAfterAssess, [
      "plan_missions",
      "prepare_review",
      "finalize",
    ])
    .addEdge("plan_missions", "report_plan")
    .addConditionalEdges("report_plan", routeMissions, [
      "execute_mission",
      "prepare_review",
      "finalize",
    ])
    .addEdge("execute_mission", "reconcile")
    .addEdge("reconcile", "report_reconciliation")
    .addEdge("report_reconciliation", "assess")
    .addEdge("prepare_review", "report_review_requested")
    .addEdge("report_review_requested", "human_review")
    .addEdge("human_review", "report_review_resumed")
    .addConditionalEdges("report_review_resumed", routeAfterReview, [
      "assess",
      "finalize",
    ])
    .addEdge("finalize", "report_finalized")
    .addEdge("report_finalized", END)
    .compile({
      checkpointer,
      interruptAfter: [],
    })
}

function sortedEvidenceIds(result: MissionResult) {
  return [
    ...new Set([
      ...result.claims.flatMap(({ evidenceIds }) => evidenceIds),
      ...result.unresolved.flatMap(({ evidenceIds }) => evidenceIds),
    ]),
  ]
    .sort()
    .slice(0, 100)
}

export type EvidenceCuratorGraph = ReturnType<typeof buildEvidenceCuratorGraph>

export interface EvidenceCuratorInterrupt {
  readonly schemaVersion: 1
  readonly decisionId: string
  readonly gapId: string
  readonly targetKind: "candidate" | "conflict"
  readonly targetId: string
}

export interface EvidenceCuratorRunResult {
  readonly status: "completed" | "interrupted"
  readonly state: EvidenceCuratorStateValue
  readonly result?: EvidenceCuratorResult
  readonly interrupts: readonly EvidenceCuratorInterrupt[]
}

export class EvidenceCuratorService {
  constructor(
    private readonly graph: EvidenceCuratorGraph,
    private readonly resumeCoordinator: ResumeCoordinator,
    private readonly recursionLimit = 200
  ) {}

  private config(runId: string) {
    const parsedRunId = runIdSchema.parse(runId)
    return {
      configurable: {
        thread_id: `${parsedRunId}:${EVIDENCE_CURATOR_GRAPH_NAME}`,
      },
      recursionLimit: this.recursionLimit,
    }
  }

  private async currentState(
    runId: string
  ): Promise<EvidenceCuratorStateValue> {
    const snapshot = await this.graph.getState(this.config(runId))
    return parseEvidenceCuratorState(snapshot.values)
  }

  private executionLock(runId: string) {
    return {
      runId: runIdSchema.parse(runId),
      decisionId: EVIDENCE_CURATOR_EXECUTION_LOCK,
    }
  }

  private assertMatchingStart(
    existing: EvidenceCuratorStateValue,
    requested: EvidenceCuratorStateValue
  ) {
    if (
      existing.applicationId !== requested.applicationId ||
      existing.runId !== requested.runId ||
      existing.initialEvidenceStateId !== requested.initialEvidenceStateId ||
      hashCanonical(existing.budget) !== hashCanonical(requested.budget)
    ) {
      throw new CheckpointStateError()
    }
  }

  private async toResult(
    runId: string,
    raw: unknown
  ): Promise<EvidenceCuratorRunResult> {
    const state = await this.currentState(runId)
    const interrupts = isInterrupted(raw)
      ? (
          (raw as Record<string, unknown>)[INTERRUPT] as readonly {
            value: unknown
          }[]
        ).map(({ value }) => evidenceCuratorInterruptSchema.parse(value))
      : []
    return {
      status: interrupts.length > 0 ? "interrupted" : "completed",
      state,
      ...(state.result === null ? {} : { result: state.result }),
      interrupts,
    }
  }

  async start(input: {
    readonly applicationId: string
    readonly runId: string
    readonly evidenceStateId: string
    readonly budget: MissionBudget
  }): Promise<EvidenceCuratorRunResult> {
    const state = createEvidenceCuratorInitialState(input)
    return this.resumeCoordinator.runExclusive(
      this.executionLock(state.runId),
      async () => {
        const config = this.config(state.runId)
        const snapshot = await this.graph.getState(config)
        const hasExistingState =
          snapshot.values !== null &&
          typeof snapshot.values === "object" &&
          Object.keys(snapshot.values).length > 0
        if (hasExistingState) {
          let existing: EvidenceCuratorStateValue
          try {
            existing = parseEvidenceCuratorState(snapshot.values)
          } catch {
            throw new CheckpointStateError()
          }
          this.assertMatchingStart(existing, state)
        }
        const raw = await this.graph.invoke(
          hasExistingState ? null : state,
          config
        )
        return this.toResult(state.runId, raw)
      }
    )
  }

  async continue(runId: string): Promise<EvidenceCuratorRunResult> {
    const parsedRunId = runIdSchema.parse(runId)
    return this.resumeCoordinator.runExclusive(
      this.executionLock(parsedRunId),
      async () => {
        const raw = await this.graph.invoke(null, this.config(parsedRunId))
        return this.toResult(parsedRunId, raw)
      }
    )
  }

  async resume(input: {
    readonly runId: string
    readonly decisionId: string
    readonly actorId: string
    readonly approved: boolean
    readonly reason: string
  }): Promise<EvidenceCuratorRunResult> {
    const parsed = curatorReviewResumeSchema.parse(input)
    return this.resumeCoordinator.runExclusive(
      this.executionLock(parsed.runId),
      async () => {
        const raw = await this.graph.invoke(
          new Command({ resume: parsed }),
          this.config(parsed.runId)
        )
        return this.toResult(parsed.runId, raw)
      }
    )
  }
}

export function createEvidenceCurator(input: {
  readonly dependencies: EvidenceCuratorDependencies
  readonly checkpointer: BaseCheckpointSaver
  readonly options?: EvidenceCuratorOptions
}) {
  const graph = buildEvidenceCuratorGraph(
    input.dependencies,
    input.checkpointer,
    input.options
  )
  const recursionLimit = z
    .number()
    .int()
    .min(20)
    .max(1_000)
    .parse(input.options?.recursionLimit ?? 200)
  return {
    graph,
    service: new EvidenceCuratorService(
      graph,
      input.dependencies.resumeCoordinator,
      recursionLimit
    ),
  }
}
