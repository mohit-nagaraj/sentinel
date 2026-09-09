import {
  applicationIdSchema,
  commitShaSchema,
  contentHashSchema,
  createTargetedVerificationInputId,
  deploymentValidationResultSchema,
  hashCanonical,
  missionBudgetSchema,
  missionIdSchema,
  pullRequestIdSchema,
  runIdSchema,
  targetedVerificationResultSchema,
  targetedVerificationStartInputSchema,
  verificationGapFollowupSchema,
  verificationMissionEvidenceSchema,
  verificationMissionResultSchema,
  verificationSetupReceiptSchema,
  type DeploymentValidationRequest,
  type DeploymentValidationResult,
  type MissionBudget,
  type TargetedVerificationResult,
  type TargetedVerificationStartInput,
  type VerificationArtifactDecision,
  type VerificationGapFollowup,
  type VerificationMissionEvidence,
  type VerificationMissionPlan,
  type VerificationMissionResult,
  type VerificationSetupReceipt,
} from "@sentinel/contracts"
import {
  END,
  ReducedValue,
  START,
  StateGraph,
  StateSchema,
  type BaseCheckpointSaver,
} from "@langchain/langgraph"
import { z } from "zod"

import {
  buildBlockedSetupVerificationMission,
  buildNotRunVerificationMission,
  buildTargetedVerificationResult,
  evaluateVerificationMission,
} from "./verification-evaluator.ts"
import {
  CancelledOrchestrationError,
  CheckpointStateError,
  transientRetryPolicy,
  wrapNode,
  type ResumeCoordinator,
  type RuntimeDependencies,
} from "./runtime.ts"
import { assertCompactCheckpointState } from "./state.ts"
import type {
  CompiledRunGraph,
  GraphExecutionResult,
  GraphRunInput,
  RunExecutionContext,
} from "./run-dispatch.ts"

export const TARGETED_VERIFICATION_GRAPH_NAME = "verify_pull_request" as const

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

const zeroBudget = missionBudgetSchema.parse(
  Object.fromEntries(budgetKeys.map((key) => [key, 0]))
)

function addBudgets(...values: readonly MissionBudget[]): MissionBudget {
  return missionBudgetSchema.parse(
    Object.fromEntries(
      budgetKeys.map((key) => [
        key,
        values.reduce((total, value) => total + value[key], 0),
      ])
    )
  )
}

function fitsBudget(
  used: MissionBudget,
  requested: MissionBudget,
  limit: MissionBudget
): boolean {
  return budgetKeys.every((key) => used[key] + requested[key] <= limit[key])
}

function subtractBudget(
  limit: MissionBudget,
  used: MissionBudget
): MissionBudget {
  return missionBudgetSchema.parse(
    Object.fromEntries(
      budgetKeys.map((key) => [key, Math.max(0, limit[key] - used[key])])
    )
  )
}

const executionRecordSchema = z.strictObject({
  missionId: missionIdSchema,
  kind: z.enum(["affected", "control", "followup"]),
  setupReceiptId: contentHashSchema,
  headEvidenceId: contentHashSchema.optional(),
  baselineEvidenceId: contentHashSchema.optional(),
  resultId: contentHashSchema,
  budgetUsed: missionBudgetSchema,
})

type ExecutionRecord = z.infer<typeof executionRecordSchema>

function mergeExecutionRecords(
  current: readonly ExecutionRecord[],
  additions: readonly ExecutionRecord[]
): ExecutionRecord[] {
  const merged = new Map(
    current.map((record) => [`${record.kind}:${record.missionId}`, record])
  )
  for (const addition of additions) {
    const record = executionRecordSchema.parse(addition)
    const key = `${record.kind}:${record.missionId}`
    const existing = merged.get(key)
    if (
      existing !== undefined &&
      hashCanonical(existing) !== hashCanonical(record)
    ) {
      throw new Error("Conflicting targeted verification execution record")
    }
    merged.set(key, record)
  }
  return [...merged.values()].sort((left, right) =>
    `${left.kind}:${left.missionId}`.localeCompare(
      `${right.kind}:${right.missionId}`
    )
  )
}

const executionRecordListSchema = z
  .array(executionRecordSchema)
  .max(12)
  .default(() => [])

const graphStatusSchema = z.enum([
  "running",
  "verification_unavailable",
  "completed",
  "superseded",
])

const verificationBoundarySchema = z.strictObject({
  inputId: contentHashSchema,
  planId: contentHashSchema,
  applicationId: applicationIdSchema,
  runId: runIdSchema,
  assessmentId: z.uuid(),
  pullRequestId: pullRequestIdSchema,
  headSha: commitShaSchema,
  affectedMissionIds: z.array(missionIdSchema).max(10),
  controlMissionId: missionIdSchema.optional(),
  totalBudget: missionBudgetSchema,
  startedAtMs: z.number().int().nonnegative(),
})

export const TargetedVerificationState = new StateSchema({
  boundary: verificationBoundarySchema,
  graphName: z.literal(TARGETED_VERIFICATION_GRAPH_NAME),
  records: new ReducedValue(executionRecordListSchema, {
    inputSchema: z.union([executionRecordSchema, executionRecordListSchema]),
    reducer: (current, next) =>
      mergeExecutionRecords(current, Array.isArray(next) ? next : [next]),
  }),
  headValidationId: contentHashSchema.nullable().default(null),
  baselineValidationId: contentHashSchema.nullable().default(null),
  followup: verificationGapFollowupSchema.nullable().default(null),
  followupChecked: z.boolean().default(false),
  resultId: contentHashSchema.nullable().default(null),
  status: graphStatusSchema.default("running"),
})

export type TargetedVerificationStateValue =
  typeof TargetedVerificationState.State

const targetedVerificationStateSchema = z.strictObject({
  boundary: verificationBoundarySchema,
  graphName: z.literal(TARGETED_VERIFICATION_GRAPH_NAME),
  records: executionRecordListSchema,
  headValidationId: contentHashSchema.nullable(),
  baselineValidationId: contentHashSchema.nullable(),
  followup: verificationGapFollowupSchema.nullable(),
  followupChecked: z.boolean(),
  resultId: contentHashSchema.nullable(),
  status: graphStatusSchema,
})

export function parseTargetedVerificationState(
  input: unknown
): TargetedVerificationStateValue {
  const state = targetedVerificationStateSchema.parse(input)
  assertCompactCheckpointState(state)
  return state
}

export interface TargetedVerificationCurrentHeadPort {
  isCurrent(
    input: { readonly assessmentId: string; readonly headSha: string },
    signal?: AbortSignal
  ): Promise<boolean>
}

export interface TargetedVerificationIdentityPort {
  validate(
    request: DeploymentValidationRequest,
    signal?: AbortSignal
  ): Promise<DeploymentValidationResult>
}

export interface TargetedVerificationSetupPort {
  prepare(
    input: {
      readonly plan: VerificationMissionPlan
      readonly deployments: {
        readonly head: DeploymentValidationResult
        readonly baseline?: DeploymentValidationResult
      }
      readonly idempotencyKey: string
    },
    signal?: AbortSignal
  ): Promise<VerificationSetupReceipt>
  cleanup(
    input: {
      readonly receipt: VerificationSetupReceipt
      readonly idempotencyKey: string
    },
    signal?: AbortSignal
  ): Promise<void>
}

export interface TargetedVerificationMissionPort {
  /** Implementations must replay by idempotency key and close the browser context on every path. */
  execute(
    input: {
      readonly plan: VerificationMissionPlan
      readonly deployment: DeploymentValidationResult
      readonly phase: "baseline" | "head"
      readonly idempotencyKey: string
    },
    signal?: AbortSignal
  ): Promise<VerificationMissionEvidence>
}

export interface TargetedVerificationCuratorPort {
  proposeFollowup(
    input: {
      readonly planId: string
      readonly results: readonly VerificationMissionResult[]
      readonly namedGapCheckpointIds: readonly string[]
      readonly remainingBudget: MissionBudget
    },
    signal?: AbortSignal
  ): Promise<VerificationGapFollowup | null>
}

export interface TargetedVerificationArtifactPort {
  apply(
    input: {
      readonly decisions: readonly VerificationArtifactDecision[]
      readonly idempotencyKey: string
    },
    signal?: AbortSignal
  ): Promise<void>
}

export interface TargetedVerificationPublisherPort {
  /** Must append/version the report and update its check under one assessment/head CAS. */
  publishCurrent(
    input: {
      readonly assessmentId: string
      readonly headSha: string
      readonly result: TargetedVerificationResult
      readonly idempotencyKey: string
    },
    signal?: AbortSignal
  ): Promise<"published" | "existing" | "superseded">
}

export interface TargetedVerificationStore {
  saveInput(input: TargetedVerificationStartInput): Promise<string>
  loadInput(id: string): Promise<TargetedVerificationStartInput>
  saveValidation(validation: DeploymentValidationResult): Promise<string>
  loadValidation(id: string): Promise<DeploymentValidationResult>
  saveSetup(receipt: VerificationSetupReceipt): Promise<string>
  loadSetup(id: string): Promise<VerificationSetupReceipt>
  saveEvidence(evidence: VerificationMissionEvidence): Promise<string>
  loadEvidence(id: string): Promise<VerificationMissionEvidence>
  saveMissionResult(result: VerificationMissionResult): Promise<string>
  loadMissionResults(
    ids: readonly string[]
  ): Promise<VerificationMissionResult[]>
  saveResult(result: TargetedVerificationResult): Promise<string>
  loadResult(id: string): Promise<TargetedVerificationResult>
}

export interface TargetedVerificationDependencies extends RuntimeDependencies {
  readonly store: TargetedVerificationStore
  readonly currentHead: TargetedVerificationCurrentHeadPort
  readonly identity: TargetedVerificationIdentityPort
  readonly setup: TargetedVerificationSetupPort
  readonly mission: TargetedVerificationMissionPort
  readonly curator: TargetedVerificationCuratorPort
  readonly artifacts: TargetedVerificationArtifactPort
  readonly publisher: TargetedVerificationPublisherPort
  readonly now?: () => Date
}

function stateRuntime(state: TargetedVerificationStateValue) {
  return {
    runId: state.boundary.runId,
    graphName: state.graphName,
    startedAtMs: state.boundary.startedAtMs,
    budget: state.boundary.totalBudget,
  }
}

function inputIdentity(input: TargetedVerificationStartInput) {
  return createTargetedVerificationInputId(input)
}

async function loadInput(
  dependencies: TargetedVerificationDependencies,
  state: TargetedVerificationStateValue
): Promise<TargetedVerificationStartInput> {
  const input = targetedVerificationStartInputSchema.parse(
    await dependencies.store.loadInput(state.boundary.inputId)
  )
  if (
    inputIdentity(input) !== state.boundary.inputId ||
    input.plan.id !== state.boundary.planId ||
    input.plan.applicationId !== state.boundary.applicationId ||
    input.plan.runId !== state.boundary.runId ||
    input.plan.assessmentId !== state.boundary.assessmentId ||
    input.plan.deployment.pullRequestId !== state.boundary.pullRequestId ||
    input.headValidation.expectedCommitSha !== state.boundary.headSha
  ) {
    throw new CheckpointStateError()
  }
  return input
}

async function saveValidation(
  dependencies: TargetedVerificationDependencies,
  validation: DeploymentValidationResult
): Promise<string> {
  return contentHashSchema.parse(
    await dependencies.store.saveValidation(
      deploymentValidationResultSchema.parse(validation)
    )
  )
}

async function assertCurrent(
  dependencies: TargetedVerificationDependencies,
  input: TargetedVerificationStartInput,
  signal?: AbortSignal
): Promise<void> {
  const current = await dependencies.currentHead.isCurrent(
    {
      assessmentId: input.plan.assessmentId,
      headSha: input.headValidation.expectedCommitSha,
    },
    signal
  )
  if (!current) throw new CancelledOrchestrationError()
}

function trusted(validation: DeploymentValidationResult): boolean {
  return (
    validation.identityState === "exact" &&
    validation.trustState === "trusted" &&
    validation.readinessState === "ready" &&
    validation.browserAccessAllowed &&
    validation.credentialAccessAllowed
  )
}

function validateIdentityResult(
  request: DeploymentValidationRequest,
  value: DeploymentValidationResult
): DeploymentValidationResult {
  const result = deploymentValidationResultSchema.parse(value)
  if (
    result.applicationId !== request.applicationId ||
    result.purpose !== request.purpose ||
    result.assessmentId !== request.assessmentId ||
    result.pullRequestId !== request.pullRequestId ||
    result.expectedCommitSha !== request.expectedCommitSha ||
    result.registrationId !== request.registration.id
  ) {
    throw new Error("Deployment validator returned a cross-request identity")
  }
  return result
}

function budgetUsed(records: readonly ExecutionRecord[]): MissionBudget {
  return addBudgets(...records.map(({ budgetUsed }) => budgetUsed))
}

function executionKey(input: {
  readonly planId: string
  readonly missionId: string
  readonly phase: "setup" | "baseline" | "head" | "cleanup" | "artifacts"
}) {
  return hashCanonical({
    kind: "targeted-verification-execution",
    ...input,
    version: 1,
  })
}

function localSetupReceipt(input: {
  readonly plan: VerificationMissionPlan
  readonly now: Date
  readonly skipped?: boolean
}): VerificationSetupReceipt {
  const idempotencyKey = executionKey({
    planId: "local",
    missionId: input.plan.mission.id,
    phase: "setup",
  })
  const none = input.plan.setup.method === "none" || input.skipped === true
  const draft = {
    schemaVersion: 1 as const,
    missionId: input.plan.mission.id,
    classification: input.plan.setup.classification,
    method: input.plan.setup.method,
    status: none ? ("not_required" as const) : ("prepared" as const),
    idempotencyKey,
    evidenceIds: [],
    artifacts: [],
    cleanupRequired: !none && input.plan.setup.cleanupReference !== undefined,
    reasonCode: input.skipped
      ? "verification_budget_unavailable"
      : none
        ? "external_setup_not_required"
        : "ui_setup_delegated",
    summary: input.skipped
      ? "Mission was not run because its reserved budget was unavailable"
      : none
        ? "No external prerequisite setup was required"
        : "Impacted prerequisite setup is delegated to the UI mission",
    preparedAt: input.now.toISOString(),
  }
  return verificationSetupReceiptSchema.parse({
    ...draft,
    id: hashCanonical(draft),
  })
}

function nextPlan(
  state: TargetedVerificationStateValue,
  source: TargetedVerificationStartInput
): {
  readonly plan: VerificationMissionPlan
  readonly kind: ExecutionRecord["kind"]
} | null {
  const completed = new Set(
    state.records.map(({ kind, missionId }) => `${kind}:${missionId}`)
  )
  for (const plan of source.plan.missions) {
    if (!completed.has(`affected:${plan.mission.id}`)) {
      return { plan, kind: "affected" }
    }
  }
  if (
    source.plan.control !== undefined &&
    !completed.has(`control:${source.plan.control.mission.id}`)
  ) {
    return { plan: source.plan.control, kind: "control" }
  }
  if (
    state.followup !== null &&
    !completed.has(`followup:${state.followup.mission.mission.id}`)
  ) {
    return { plan: state.followup.mission, kind: "followup" }
  }
  return null
}

function hasNextPlan(state: TargetedVerificationStateValue): boolean {
  const completed = new Set(
    state.records.map(({ kind, missionId }) => `${kind}:${missionId}`)
  )
  if (
    state.boundary.affectedMissionIds.some(
      (missionId) => !completed.has(`affected:${missionId}`)
    )
  ) {
    return true
  }
  if (
    state.boundary.controlMissionId !== undefined &&
    !completed.has(`control:${state.boundary.controlMissionId}`)
  ) {
    return true
  }
  return (
    state.followup !== null &&
    !completed.has(`followup:${state.followup.mission.mission.id}`)
  )
}

function validateEvidence(
  plan: VerificationMissionPlan,
  evidence: VerificationMissionEvidence,
  phase: "baseline" | "head"
): VerificationMissionEvidence {
  const parsed = verificationMissionEvidenceSchema.parse(evidence)
  if (
    parsed.applicationId !== plan.mission.applicationId ||
    parsed.runId !== plan.mission.runId ||
    parsed.missionId !== plan.mission.id ||
    parsed.phase !== phase
  ) {
    throw new Error("Mission executor returned cross-scope evidence")
  }
  const checkpointIds = new Set(plan.checkpoints.map(({ id }) => id))
  if (
    parsed.checkpointObservations.some(
      ({ checkpointId }) => !checkpointIds.has(checkpointId)
    )
  ) {
    throw new Error("Mission executor returned an unplanned checkpoint")
  }
  return parsed
}

async function executePlan(input: {
  readonly state: TargetedVerificationStateValue
  readonly plan: VerificationMissionPlan
  readonly kind: ExecutionRecord["kind"]
  readonly dependencies: TargetedVerificationDependencies
  readonly signal?: AbortSignal
}): Promise<
  | { readonly unavailable: DeploymentValidationResult }
  | {
      readonly record: ExecutionRecord
      readonly headValidation: DeploymentValidationResult
      readonly baselineValidation?: DeploymentValidationResult
    }
> {
  const { dependencies, plan, state } = input
  const source = await loadInput(dependencies, state)
  const now = new Date(source.startedAtMs)
  const used = budgetUsed(state.records)
  if (!fitsBudget(used, plan.mission.budget, source.totalBudget)) {
    const setup = localSetupReceipt({ plan, now, skipped: true })
    const setupReceiptId = contentHashSchema.parse(
      await dependencies.store.saveSetup(setup)
    )
    if (setupReceiptId !== setup.id) {
      throw new Error("Verification store changed the setup receipt identity")
    }
    const result = buildNotRunVerificationMission({
      plan,
      setup,
      reason:
        "Mission was not run because the total verification budget was exhausted",
      now,
    })
    const resultId = contentHashSchema.parse(
      await dependencies.store.saveMissionResult(result)
    )
    if (resultId !== result.id) {
      throw new Error("Verification store changed the mission result identity")
    }
    return {
      record: executionRecordSchema.parse({
        missionId: plan.mission.id,
        kind: input.kind,
        setupReceiptId,
        resultId,
        budgetUsed: zeroBudget,
      }),
      headValidation:
        state.headValidationId === null
          ? deploymentValidationResultSchema.parse(source.plan.deployment)
          : await dependencies.store.loadValidation(state.headValidationId),
    }
  }

  await assertCurrent(dependencies, source, input.signal)
  const setupHeadValidation = validateIdentityResult(
    source.headValidation,
    await dependencies.identity.validate(source.headValidation, input.signal)
  )
  if (!trusted(setupHeadValidation)) {
    return { unavailable: setupHeadValidation }
  }
  let setupBaselineValidation: DeploymentValidationResult | undefined
  const reserveForPair = addBudgets(plan.mission.budget, plan.mission.budget)
  if (
    source.baselineValidation !== undefined &&
    fitsBudget(used, reserveForPair, source.totalBudget)
  ) {
    const candidate = validateIdentityResult(
      source.baselineValidation,
      await dependencies.identity.validate(
        source.baselineValidation,
        input.signal
      )
    )
    if (trusted(candidate)) setupBaselineValidation = candidate
  }
  let setup: VerificationSetupReceipt
  if (plan.setup.method === "trusted_fixture_api") {
    setup = verificationSetupReceiptSchema.parse(
      await dependencies.setup.prepare(
        {
          plan,
          deployments: {
            head: setupHeadValidation,
            ...(setupBaselineValidation === undefined
              ? {}
              : { baseline: setupBaselineValidation }),
          },
          idempotencyKey: executionKey({
            planId: source.plan.id,
            missionId: plan.mission.id,
            phase: "setup",
          }),
        },
        input.signal
      )
    )
  } else {
    setup = localSetupReceipt({ plan, now })
  }
  if (
    setup.missionId !== plan.mission.id ||
    setup.classification !== plan.setup.classification ||
    setup.method !== plan.setup.method
  ) {
    throw new Error("Setup adapter returned a cross-mission receipt")
  }
  const setupReceiptId = contentHashSchema.parse(
    await dependencies.store.saveSetup(setup)
  )
  if (setupReceiptId !== setup.id) {
    throw new Error("Verification store changed the setup receipt identity")
  }

  try {
    if (setup.status === "failed") {
      const result = buildBlockedSetupVerificationMission({
        plan,
        setup,
        artifactPolicy: source.artifactPolicy,
        now,
      })
      const resultId = contentHashSchema.parse(
        await dependencies.store.saveMissionResult(result)
      )
      if (resultId !== result.id) {
        throw new Error(
          "Verification store changed the mission result identity"
        )
      }
      await dependencies.artifacts.apply(
        {
          decisions: result.artifacts,
          idempotencyKey: executionKey({
            planId: source.plan.id,
            missionId: plan.mission.id,
            phase: "artifacts",
          }),
        },
        input.signal
      )
      return {
        record: executionRecordSchema.parse({
          missionId: plan.mission.id,
          kind: input.kind,
          setupReceiptId,
          resultId,
          budgetUsed: zeroBudget,
        }),
        headValidation: setupHeadValidation,
        ...(setupBaselineValidation === undefined
          ? {}
          : { baselineValidation: setupBaselineValidation }),
      }
    }

    let baselineValidation: DeploymentValidationResult | undefined
    let baselineEvidence: VerificationMissionEvidence | undefined
    let baselineEvidenceId: string | undefined
    if (setupBaselineValidation !== undefined) {
      baselineValidation = setupBaselineValidation
      if (trusted(setupBaselineValidation)) {
        baselineEvidence = validateEvidence(
          plan,
          await dependencies.mission.execute(
            {
              plan,
              deployment: setupBaselineValidation,
              phase: "baseline",
              idempotencyKey: executionKey({
                planId: source.plan.id,
                missionId: plan.mission.id,
                phase: "baseline",
              }),
            },
            input.signal
          ),
          "baseline"
        )
        baselineEvidenceId = contentHashSchema.parse(
          await dependencies.store.saveEvidence(baselineEvidence)
        )
      }
    }

    const headValidation = validateIdentityResult(
      source.headValidation,
      await dependencies.identity.validate(source.headValidation, input.signal)
    )
    if (!trusted(headValidation)) return { unavailable: headValidation }

    await assertCurrent(dependencies, source, input.signal)
    const headEvidence = validateEvidence(
      plan,
      await dependencies.mission.execute(
        {
          plan,
          deployment: headValidation,
          phase: "head",
          idempotencyKey: executionKey({
            planId: source.plan.id,
            missionId: plan.mission.id,
            phase: "head",
          }),
        },
        input.signal
      ),
      "head"
    )
    const headEvidenceId = contentHashSchema.parse(
      await dependencies.store.saveEvidence(headEvidence)
    )
    const result = evaluateVerificationMission({
      plan,
      setup,
      head: headEvidence,
      ...(baselineEvidence === undefined ? {} : { baseline: baselineEvidence }),
      artifactPolicy: source.artifactPolicy,
      kind: input.kind,
      now,
    })
    const resultId = contentHashSchema.parse(
      await dependencies.store.saveMissionResult(result)
    )
    if (resultId !== result.id) {
      throw new Error("Verification store changed the mission result identity")
    }
    await dependencies.artifacts.apply(
      {
        decisions: result.artifacts,
        idempotencyKey: executionKey({
          planId: source.plan.id,
          missionId: plan.mission.id,
          phase: "artifacts",
        }),
      },
      input.signal
    )
    const actualBudget = addBudgets(
      headEvidence.explorer.result.budgetUsed,
      ...(baselineEvidence === undefined
        ? []
        : [baselineEvidence.explorer.result.budgetUsed])
    )
    if (!fitsBudget(used, actualBudget, source.totalBudget)) {
      throw new Error("Mission executor exceeded the total verification budget")
    }
    return {
      record: executionRecordSchema.parse({
        missionId: plan.mission.id,
        kind: input.kind,
        setupReceiptId,
        headEvidenceId,
        ...(baselineEvidenceId === undefined ? {} : { baselineEvidenceId }),
        resultId,
        budgetUsed: actualBudget,
      }),
      headValidation,
      ...(baselineValidation === undefined ? {} : { baselineValidation }),
    }
  } finally {
    if (setup.cleanupRequired) {
      await dependencies.setup.cleanup(
        {
          receipt: setup,
          idempotencyKey: executionKey({
            planId: source.plan.id,
            missionId: plan.mission.id,
            phase: "cleanup",
          }),
        },
        input.signal
      )
    }
  }
}

function createInitialState(
  inputValue: TargetedVerificationStartInput,
  inputId: string
): TargetedVerificationStateValue {
  const input = targetedVerificationStartInputSchema.parse(inputValue)
  const pullRequestId = input.headValidation.pullRequestId
  if (pullRequestId === undefined) {
    throw new Error(
      "Targeted verification input requires pull-request identity"
    )
  }
  return parseTargetedVerificationState({
    boundary: {
      inputId: contentHashSchema.parse(inputId),
      planId: input.plan.id,
      applicationId: input.plan.applicationId,
      runId: input.plan.runId,
      assessmentId: input.plan.assessmentId,
      pullRequestId,
      headSha: input.headValidation.expectedCommitSha,
      affectedMissionIds: input.plan.missions.map(({ mission }) => mission.id),
      ...(input.plan.control === undefined
        ? {}
        : { controlMissionId: input.plan.control.mission.id }),
      totalBudget: input.totalBudget,
      startedAtMs: input.startedAtMs,
    },
    graphName: TARGETED_VERIFICATION_GRAPH_NAME,
    records: [],
    headValidationId: null,
    baselineValidationId: null,
    followup: null,
    followupChecked: false,
    resultId: null,
    status: "running",
  })
}

export function buildTargetedVerificationGraph(
  dependencies: TargetedVerificationDependencies,
  checkpointer: BaseCheckpointSaver
) {
  const validateContextNode = wrapNode(
    "validate_context",
    dependencies,
    parseTargetedVerificationState,
    async (state, runtime) => {
      const source = await loadInput(dependencies, state)
      await assertCurrent(dependencies, source, runtime.signal)
      if (source.plan.status === "planned") return {}
      const validation = validateIdentityResult(
        source.headValidation,
        await dependencies.identity.validate(
          source.headValidation,
          runtime.signal
        )
      )
      return {
        headValidationId: await saveValidation(dependencies, validation),
        status: "verification_unavailable" as const,
      }
    },
    { runtimeState: stateRuntime }
  )

  const executeMissionNode = wrapNode(
    "execute_mission",
    dependencies,
    parseTargetedVerificationState,
    async (state, runtime) => {
      const source = await loadInput(dependencies, state)
      const next = nextPlan(state, source)
      if (next === null) return {}
      const result = await executePlan({
        state,
        plan: next.plan,
        kind: next.kind,
        dependencies,
        signal: runtime.signal,
      })
      if ("unavailable" in result) {
        return {
          headValidationId: await saveValidation(
            dependencies,
            result.unavailable
          ),
          status: "verification_unavailable" as const,
        }
      }
      return {
        records: result.record,
        headValidationId: await saveValidation(
          dependencies,
          result.headValidation
        ),
        ...(result.baselineValidation === undefined
          ? {}
          : {
              baselineValidationId: await saveValidation(
                dependencies,
                result.baselineValidation
              ),
            }),
      }
    },
    { runtimeState: stateRuntime }
  )

  const proposeFollowupNode = wrapNode(
    "propose_followup",
    dependencies,
    parseTargetedVerificationState,
    async (state, runtime) => {
      const source = await loadInput(dependencies, state)
      await assertCurrent(dependencies, source, runtime.signal)
      const results = await dependencies.store.loadMissionResults(
        state.records.map(({ resultId }) => resultId)
      )
      const gapCheckpointIds = [
        ...new Set(
          results.flatMap(({ assertions }) =>
            assertions
              .filter(({ outcome }) => outcome === "blocked")
              .map(({ checkpoint }) => checkpoint.id)
          )
        ),
      ].sort()
      if (gapCheckpointIds.length === 0) return { followupChecked: true }
      const remainingBudget = subtractBudget(
        source.totalBudget,
        budgetUsed(state.records)
      )
      const proposed = await dependencies.curator.proposeFollowup(
        {
          planId: source.plan.id,
          results,
          namedGapCheckpointIds: gapCheckpointIds,
          remainingBudget,
        },
        runtime.signal
      )
      if (proposed === null) return { followupChecked: true }
      const followup = verificationGapFollowupSchema.parse(proposed)
      const allowedGaps = new Set(gapCheckpointIds)
      const missionCheckpointIds = new Set(
        followup.mission.checkpoints.map(({ id }) => id)
      )
      if (
        followup.mission.kind !== "affected" ||
        followup.mission.mission.applicationId !== source.plan.applicationId ||
        followup.mission.mission.runId !== source.plan.runId ||
        followup.gapCheckpointIds.some((id) => !allowedGaps.has(id)) ||
        followup.mission.checkpoints.some(({ id }) => !allowedGaps.has(id)) ||
        followup.gapCheckpointIds.some((id) => !missionCheckpointIds.has(id)) ||
        !fitsBudget(
          zeroBudget,
          followup.mission.mission.budget,
          remainingBudget
        )
      ) {
        throw new Error(
          "Curator follow-up violates the named gap or budget boundary"
        )
      }
      return { followup, followupChecked: true }
    },
    { runtimeState: stateRuntime }
  )

  const finalizeNode = wrapNode(
    "finalize_verification",
    dependencies,
    parseTargetedVerificationState,
    async (state) => {
      const source = await loadInput(dependencies, state)
      if (state.headValidationId === null) {
        throw new Error("Verification finalization is missing head validation")
      }
      const headValidation = validateIdentityResult(
        source.headValidation,
        await dependencies.store.loadValidation(state.headValidationId)
      )
      const baselineValidation =
        state.baselineValidationId === null ||
        source.baselineValidation === undefined
          ? undefined
          : validateIdentityResult(
              source.baselineValidation,
              await dependencies.store.loadValidation(
                state.baselineValidationId
              )
            )
      const records = state.records
      const results = await dependencies.store.loadMissionResults(
        records.map(({ resultId }) => resultId)
      )
      const resultById = new Map(
        results.map((resultValue) => {
          const result = verificationMissionResultSchema.parse(resultValue)
          return [result.id, result] as const
        })
      )
      if (
        resultById.size !== records.length ||
        records.some(({ resultId }) => !resultById.has(resultId))
      ) {
        throw new Error(
          "Verification store omitted or substituted a mission result"
        )
      }
      const missionResults = records
        .filter(({ kind }) => kind !== "control")
        .map((record) => resultById.get(record.resultId)!)
      const controlRecord = records.find(({ kind }) => kind === "control")
      const controlResult =
        controlRecord === undefined
          ? undefined
          : resultById.get(controlRecord.resultId)
      const result = buildTargetedVerificationResult({
        plan: source.plan,
        headValidation,
        ...(baselineValidation === undefined ? {} : { baselineValidation }),
        missionResults,
        ...(controlResult === undefined ? {} : { controlResult }),
        ...(state.followup === null ? {} : { followup: state.followup }),
        budgetUsed: budgetUsed(records),
        completedAt: new Date(source.startedAtMs),
      })
      const resultId = contentHashSchema.parse(
        await dependencies.store.saveResult(result)
      )
      if (resultId !== result.id) {
        throw new Error(
          "Verification store changed the aggregate result identity"
        )
      }
      return { resultId }
    },
    { runtimeState: stateRuntime }
  )

  const publishNode = wrapNode(
    "publish_verification",
    dependencies,
    parseTargetedVerificationState,
    async (state, runtime) => {
      if (state.resultId === null)
        throw new Error("Verification result is missing")
      const source = await loadInput(dependencies, state)
      await assertCurrent(dependencies, source, runtime.signal)
      const result = targetedVerificationResultSchema.parse(
        await dependencies.store.loadResult(state.resultId)
      )
      const disposition = await dependencies.publisher.publishCurrent(
        {
          assessmentId: source.plan.assessmentId,
          headSha: source.headValidation.expectedCommitSha,
          result,
          idempotencyKey: hashCanonical({
            kind: "targeted-verification-publication",
            assessmentId: source.plan.assessmentId,
            headSha: source.headValidation.expectedCommitSha,
            resultId: result.id,
            version: 1,
          }),
        },
        runtime.signal
      )
      return {
        status:
          disposition === "superseded"
            ? ("superseded" as const)
            : ("completed" as const),
      }
    },
    { runtimeState: stateRuntime }
  )

  const routeAfterValidation = (value: TargetedVerificationStateValue) =>
    parseTargetedVerificationState(value).status === "verification_unavailable"
      ? "finalize_verification"
      : "execute_mission"

  const routeAfterExecution = (value: TargetedVerificationStateValue) => {
    const state = parseTargetedVerificationState(value)
    if (state.status === "verification_unavailable") {
      return "finalize_verification"
    }
    if (hasNextPlan(state)) return "execute_mission"
    return state.followupChecked ? "finalize_verification" : "propose_followup"
  }

  const routeAfterFollowup = (value: TargetedVerificationStateValue) =>
    !hasNextPlan(parseTargetedVerificationState(value))
      ? "finalize_verification"
      : "execute_mission"

  return new StateGraph(TargetedVerificationState)
    .addNode("validate_context", validateContextNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addNode("execute_mission", executeMissionNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addNode("propose_followup", proposeFollowupNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addNode("finalize_verification", finalizeNode)
    .addNode("publish_verification", publishNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addEdge(START, "validate_context")
    .addConditionalEdges("validate_context", routeAfterValidation, [
      "execute_mission",
      "finalize_verification",
    ])
    .addConditionalEdges("execute_mission", routeAfterExecution, [
      "execute_mission",
      "propose_followup",
      "finalize_verification",
    ])
    .addConditionalEdges("propose_followup", routeAfterFollowup, [
      "execute_mission",
      "finalize_verification",
    ])
    .addEdge("finalize_verification", "publish_verification")
    .addEdge("publish_verification", END)
    .compile({ checkpointer, interruptAfter: [] })
}

export type TargetedVerificationGraph = ReturnType<
  typeof buildTargetedVerificationGraph
>

export interface TargetedVerificationRunResult {
  readonly status: "completed" | "superseded"
  readonly state: TargetedVerificationStateValue
  readonly result: TargetedVerificationResult
}

export class TargetedVerificationService {
  constructor(
    private readonly graph: TargetedVerificationGraph,
    private readonly store: TargetedVerificationStore,
    private readonly resumeCoordinator: ResumeCoordinator,
    private readonly recursionLimit = 100
  ) {}

  private config(runId: string) {
    const parsedRunId = runIdSchema.parse(runId)
    return {
      configurable: {
        thread_id: `${parsedRunId}:${TARGETED_VERIFICATION_GRAPH_NAME}`,
      },
      recursionLimit: this.recursionLimit,
    }
  }

  private executionLock(runId: string) {
    return {
      runId: runIdSchema.parse(runId),
      decisionId: "targeted_verification_execution",
    }
  }

  async hasCheckpoint(runId: string): Promise<boolean> {
    const snapshot = await this.graph.getState(this.config(runId))
    return (
      snapshot.values !== null &&
      typeof snapshot.values === "object" &&
      Object.keys(snapshot.values).length > 0
    )
  }

  private async toResult(
    runId: string
  ): Promise<TargetedVerificationRunResult> {
    const snapshot = await this.graph.getState(this.config(runId))
    const state = parseTargetedVerificationState(snapshot.values)
    if (
      (state.status !== "completed" && state.status !== "superseded") ||
      state.resultId === null
    ) {
      throw new Error(
        "Targeted verification graph ended without a terminal result"
      )
    }
    return {
      status: state.status,
      state,
      result: targetedVerificationResultSchema.parse(
        await this.store.loadResult(state.resultId)
      ),
    }
  }

  async start(inputValue: TargetedVerificationStartInput) {
    const input = targetedVerificationStartInputSchema.parse(inputValue)
    const expectedInputId = inputIdentity(input)
    const storedInputId = contentHashSchema.parse(
      await this.store.saveInput(input)
    )
    if (storedInputId !== expectedInputId) {
      throw new Error("Verification store changed the start-input identity")
    }
    const initial = createInitialState(input, storedInputId)
    return this.resumeCoordinator.runExclusive(
      this.executionLock(initial.boundary.runId),
      async () => {
        const config = this.config(initial.boundary.runId)
        const snapshot = await this.graph.getState(config)
        const exists =
          snapshot.values !== null &&
          typeof snapshot.values === "object" &&
          Object.keys(snapshot.values).length > 0
        if (exists) {
          let existing: TargetedVerificationStateValue
          try {
            existing = parseTargetedVerificationState(snapshot.values)
          } catch {
            throw new CheckpointStateError()
          }
          if (existing.boundary.inputId !== initial.boundary.inputId) {
            throw new CheckpointStateError()
          }
        }
        await this.graph.invoke(exists ? null : initial, config)
        return this.toResult(initial.boundary.runId)
      }
    )
  }

  async continue(runId: string) {
    const parsedRunId = runIdSchema.parse(runId)
    return this.resumeCoordinator.runExclusive(
      this.executionLock(parsedRunId),
      async () => {
        await this.graph.invoke(null, this.config(parsedRunId))
        return this.toResult(parsedRunId)
      }
    )
  }
}

export function createTargetedVerification(input: {
  readonly dependencies: TargetedVerificationDependencies
  readonly checkpointer: BaseCheckpointSaver
  readonly recursionLimit?: number
}) {
  const graph = buildTargetedVerificationGraph(
    input.dependencies,
    input.checkpointer
  )
  const recursionLimit = z
    .number()
    .int()
    .min(20)
    .max(500)
    .parse(input.recursionLimit ?? 100)
  return {
    graph,
    service: new TargetedVerificationService(
      graph,
      input.dependencies.store,
      input.dependencies.resumeCoordinator,
      recursionLimit
    ),
  }
}

export interface TargetedVerificationRunInputResolver {
  resolve(
    input: GraphRunInput,
    context: RunExecutionContext
  ): Promise<TargetedVerificationStartInput>
}

function stableRunId(databaseRunId: string) {
  return `run:${databaseRunId}`
}

export function createTargetedVerificationCompiledRunGraph(input: {
  readonly service: TargetedVerificationService
  readonly resolver: TargetedVerificationRunInputResolver
}): CompiledRunGraph {
  const resolve = async (
    graphInput: GraphRunInput,
    context: RunExecutionContext
  ) => {
    await context.assertActive()
    const resolved = targetedVerificationStartInputSchema.parse(
      await input.resolver.resolve(graphInput, context)
    )
    if (
      graphInput.payload === null ||
      typeof graphInput.payload !== "object" ||
      !("assessmentId" in graphInput.payload) ||
      resolved.plan.runId !== stableRunId(graphInput.runId) ||
      resolved.plan.assessmentId !== graphInput.payload.assessmentId ||
      hashCanonical(resolved.totalBudget) !== hashCanonical(graphInput.budget)
    ) {
      throw new Error(
        "Resolved verification input conflicts with the run command"
      )
    }
    return resolved
  }

  const execute = async (
    graphInput: GraphRunInput,
    context: RunExecutionContext
  ): Promise<GraphExecutionResult> => {
    const resolved = await resolve(graphInput, context)
    const result = await input.service.start(resolved)
    await context.assertActive()
    return result.status === "superseded"
      ? { status: "cancelled" }
      : {
          status: "succeeded",
          publication: {
            kind: "verification",
            assessmentId: resolved.plan.assessmentId,
          },
        }
  }

  return {
    hasCheckpoint: (graphInput) =>
      input.service.hasCheckpoint(stableRunId(graphInput.runId)),
    hasPendingInterrupt: async () => false,
    start: execute,
    continue: execute,
    resume: (graphInput, _decision, context) => execute(graphInput, context),
  }
}
