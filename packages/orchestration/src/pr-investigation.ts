import {
  MAX_PR_INVESTIGATION_GROUPS,
  codeMissionResultSchema,
  commitShaSchema,
  contentHashSchema,
  evidenceCuratorResultSchema,
  graphEvidencePathSchema,
  githubCheckLifecycleSchema,
  hashCanonical,
  missionBudgetSchema,
  prInvestigationBaselineOutcomeSchema,
  prInvestigationChangeGroupSchema,
  prInvestigationRelationshipHintSchema,
  prInvestigationOverlaySchema,
  prInvestigationResultSchema,
  prInvestigationStartInputSchema,
  prInvestigationWorkerReceiptSchema,
  runIdSchema,
  stableEntityIdSchema,
  trustedHeadDeploymentSchema,
  type CodeExplorerMission,
  type CodeMissionResult,
  type EvidenceCuratorResult,
  type GraphEvidencePath,
  type GraphPullRequestImpactQuery,
  type MissionBudget,
  type PrDiffAnalysis,
  type PrInvestigationChangeGroup,
  type PrInvestigationGraphPath,
  type PrInvestigationOverlay,
  type PrInvestigationRelationshipHint,
  type PrInvestigationResult,
  type PrInvestigationStartInput,
  type PrInvestigationWorkerReceipt,
  type TrustedHeadDeployment,
} from "@sentinel/contracts"
import {
  END,
  ReducedValue,
  START,
  Send,
  StateGraph,
  StateSchema,
  type BaseCheckpointSaver,
} from "@langchain/langgraph"
import { z } from "zod"

import { baselineOutcome, groupPrChanges } from "./pr-investigation-grouping.ts"
import {
  addMissionBudgets,
  buildPrImpactHypotheses,
  buildPrInvestigationOverlay,
  buildVerificationCandidates,
  canonicalizeCodeMissionResult,
  createCodeMissionResultId,
  createPrChangeInvestigationMission,
  createPrGraphSeedMap,
  normalizeGraphPaths,
  splitMissionBudget,
  subtractMissionBudgets,
  type PrInvestigationStore,
} from "./pr-investigation-support.ts"
import {
  CancelledOrchestrationError,
  CheckpointStateError,
  appendOrchestrationEvent,
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
import type {
  AssessmentReportCheckPort,
  AssessmentReportRunFinalizerPort,
} from "./report.ts"

export const PR_INVESTIGATION_GRAPH_NAME = "assess_pull_request" as const

function compareStrings(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

const zeroBudget = missionBudgetSchema.parse({
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
})

function mergeReceipts(
  current: readonly PrInvestigationWorkerReceipt[],
  additions: readonly PrInvestigationWorkerReceipt[]
): PrInvestigationWorkerReceipt[] {
  const merged = new Map(current.map((receipt) => [receipt.groupId, receipt]))
  for (const receiptValue of additions) {
    const receipt = prInvestigationWorkerReceiptSchema.parse(receiptValue)
    const existing = merged.get(receipt.groupId)
    if (
      existing !== undefined &&
      hashCanonical(existing) !== hashCanonical(receipt)
    ) {
      throw new Error("Conflicting PR investigation worker receipt")
    }
    merged.set(receipt.groupId, receipt)
  }
  return [...merged.values()].sort((left, right) =>
    compareStrings(left.groupId, right.groupId)
  )
}

const receiptListSchema = z
  .array(prInvestigationWorkerReceiptSchema)
  .max(MAX_PR_INVESTIGATION_GROUPS)
  .default(() => [])

const investigationStatusSchema = z.enum([
  "running",
  "action_required",
  "completed",
  "superseded",
])

export const PrInvestigationState = new StateSchema({
  input: prInvestigationStartInputSchema,
  graphName: z.literal(PR_INVESTIGATION_GRAPH_NAME),
  analysisId: contentHashSchema.nullable().default(null),
  preparationId: contentHashSchema.nullable().default(null),
  baseline: prInvestigationBaselineOutcomeSchema.nullable().default(null),
  workerReceipts: new ReducedValue(receiptListSchema, {
    inputSchema: z.union([
      prInvestigationWorkerReceiptSchema,
      receiptListSchema,
    ]),
    reducer: (current, next) =>
      mergeReceipts(current, Array.isArray(next) ? next : [next]),
  }),
  graphPathsId: contentHashSchema.nullable().default(null),
  overlayId: contentHashSchema.nullable().default(null),
  curatorResultId: contentHashSchema.nullable().default(null),
  resultId: contentHashSchema.nullable().default(null),
  status: investigationStatusSchema.default("running"),
})

export type PrInvestigationStateValue = typeof PrInvestigationState.State

const stateSchema = z.strictObject({
  input: prInvestigationStartInputSchema,
  graphName: z.literal(PR_INVESTIGATION_GRAPH_NAME),
  analysisId: contentHashSchema.nullable(),
  preparationId: contentHashSchema.nullable(),
  baseline: prInvestigationBaselineOutcomeSchema.nullable(),
  workerReceipts: receiptListSchema,
  graphPathsId: contentHashSchema.nullable(),
  overlayId: contentHashSchema.nullable(),
  curatorResultId: contentHashSchema.nullable(),
  resultId: contentHashSchema.nullable(),
  status: investigationStatusSchema,
})

const workerInputSchema = z.strictObject({
  input: prInvestigationStartInputSchema,
  graphName: z.literal(PR_INVESTIGATION_GRAPH_NAME),
  group: prInvestigationChangeGroupSchema,
  budget: missionBudgetSchema,
})

type WorkerInput = z.infer<typeof workerInputSchema>

const pullRequestRunPayloadSchema = z.strictObject({
  pullRequestNumber: z.number().int().positive(),
  baseSha: commitShaSchema,
  headSha: commitShaSchema,
})

export function parsePrInvestigationState(
  input: unknown
): PrInvestigationStateValue {
  const state = stateSchema.parse(input)
  assertCompactCheckpointState(state)
  return state
}

export interface PrInvestigationDiffPort {
  analyze(
    input: PrInvestigationStartInput,
    signal?: AbortSignal
  ): Promise<{
    readonly analysis: PrDiffAnalysis
    readonly hints: readonly PrInvestigationRelationshipHint[]
  }>
}

export interface PrInvestigationCurrentHeadPort {
  isCurrent(
    input: {
      readonly assessmentId: string
      readonly headSha: string
    },
    signal?: AbortSignal
  ): Promise<boolean>
}

export interface PrInvestigationBaselineGraphPort {
  isCurrent(
    input: {
      readonly applicationId: string
      readonly graphRevision: number
      readonly graphCommitSha: string
    },
    signal?: AbortSignal
  ): Promise<boolean>
}

export interface PrInvestigationCodePort {
  investigate(
    mission: CodeExplorerMission,
    signal?: AbortSignal
  ): Promise<CodeMissionResult>
}

export interface PrInvestigationGraphPort {
  findPullRequestImpactPaths(
    input: GraphPullRequestImpactQuery,
    signal?: AbortSignal
  ): Promise<readonly GraphEvidencePath[]>
}

export interface PrInvestigationOverlayPort {
  stageAssessmentEvidence(
    input: {
      readonly mode: "assessment_only"
      readonly start: PrInvestigationStartInput
      readonly analysis: PrDiffAnalysis
      readonly groups: readonly PrInvestigationChangeGroup[]
      readonly codeResults: readonly CodeMissionResult[]
      readonly graphPaths: readonly PrInvestigationGraphPath[]
    },
    signal?: AbortSignal
  ): Promise<{
    readonly curatorEvidenceStateId: string
    readonly validatedClaimIds: readonly string[]
    readonly rejectedClaimIds: readonly string[]
    readonly conflictIds: readonly string[]
  }>
  loadReconciledAssessmentEvidence(
    input: {
      readonly originalOverlay: PrInvestigationOverlay
      readonly curatorResult: EvidenceCuratorResult
    },
    signal?: AbortSignal
  ): Promise<PrInvestigationOverlay>
}

export interface PrInvestigationCuratorPort {
  reconcile(
    input: {
      readonly applicationId: string
      readonly runId: string
      readonly evidenceStateId: string
      readonly budget: MissionBudget
      readonly mode: "pr_impact"
    },
    signal?: AbortSignal
  ): Promise<EvidenceCuratorResult>
}

export interface PrInvestigationDeploymentPort {
  resolveTrustedHead(
    input: {
      readonly assessmentId: string
      readonly headSha: string
    },
    signal?: AbortSignal
  ): Promise<TrustedHeadDeployment | null>
}

export interface PrInvestigationPublisherPort {
  /** Must compare-and-set assessment/head ownership in the same publication action. */
  publishCurrent(
    input: {
      readonly assessmentId: string
      readonly headSha: string
      readonly result: PrInvestigationResult
    },
    signal?: AbortSignal
  ): Promise<"published" | "superseded">
}

export interface PrInvestigationDependencies extends RuntimeDependencies {
  readonly store: PrInvestigationStore
  readonly diff: PrInvestigationDiffPort
  readonly currentHead: PrInvestigationCurrentHeadPort
  readonly baselineGraph: PrInvestigationBaselineGraphPort
  readonly code: PrInvestigationCodePort
  readonly graph: PrInvestigationGraphPort
  readonly overlay: PrInvestigationOverlayPort
  readonly curator: PrInvestigationCuratorPort
  readonly deployment: PrInvestigationDeploymentPort
  readonly publisher: PrInvestigationPublisherPort
}

export interface PrInvestigationOptions {
  readonly graphMaxDepth?: number
  readonly graphPathLimit?: number
  readonly recursionLimit?: number
}

function stateRuntime(state: PrInvestigationStateValue | WorkerInput) {
  return {
    runId: state.input.runId,
    graphName: state.graphName,
    startedAtMs: state.input.startedAtMs,
    budget: state.input.budget,
  }
}

async function assertCurrent(
  dependencies: PrInvestigationDependencies,
  input: PrInvestigationStartInput,
  signal?: AbortSignal
) {
  const current = await dependencies.currentHead.isCurrent(
    { assessmentId: input.assessmentId, headSha: input.pullRequest.headSha },
    signal
  )
  if (!current) throw new CancelledOrchestrationError()
}

async function assertBaselineCurrent(
  dependencies: PrInvestigationDependencies,
  input: PrInvestigationStartInput,
  signal?: AbortSignal
) {
  const current = await dependencies.baselineGraph.isCurrent(
    {
      applicationId: input.applicationId,
      graphRevision: input.graphRevision,
      graphCommitSha: input.graphCommitSha,
    },
    signal
  )
  if (!current) throw new CancelledOrchestrationError()
}

function sameRepository(
  left: PrInvestigationStartInput["pullRequest"]["repository"],
  right: PrDiffAnalysis["repository"]
) {
  return (
    left.host === right.host &&
    left.owner === right.owner &&
    left.name === right.name
  )
}

function validateAnalysis(
  start: PrInvestigationStartInput,
  analysis: PrDiffAnalysis
) {
  if (
    analysis.pullRequestId !== start.pullRequest.id ||
    analysis.baseSha !== start.pullRequest.baseSha ||
    analysis.headSha !== start.pullRequest.headSha ||
    analysis.baseline.graphCommitSha !== start.graphCommitSha ||
    !sameRepository(start.pullRequest.repository, analysis.repository)
  ) {
    throw new Error(
      "PR diff analysis does not match the investigation identity"
    )
  }
}

function withinBudget(used: MissionBudget, limit: MissionBudget): boolean {
  return Object.keys(limit).every(
    (key) =>
      used[key as keyof MissionBudget] <= limit[key as keyof MissionBudget]
  )
}

function receiptEvidence(result: CodeMissionResult): string[] {
  return [
    ...new Set([
      ...result.claims.flatMap(({ evidenceIds }) => evidenceIds),
      ...result.unresolved.flatMap(({ evidenceIds }) => evidenceIds),
      ...result.unresolvedBoundaries.flatMap(({ evidenceIds }) => evidenceIds),
    ]),
  ]
    .sort()
    .slice(0, 100)
}

function resultIdentity(input: {
  readonly start: PrInvestigationStartInput
  readonly diffAnalysisId: string
  readonly status: "action_required" | "completed"
  readonly overlayId?: string
  readonly curatorResultId?: string
}) {
  return hashCanonical({
    kind: "pr-investigation-result",
    assessmentId: input.start.assessmentId,
    pullRequestId: input.start.pullRequest.id,
    baseSha: input.start.pullRequest.baseSha,
    headSha: input.start.pullRequest.headSha,
    graphRevision: input.start.graphRevision,
    graphCommitSha: input.start.graphCommitSha,
    diffAnalysisId: input.diffAnalysisId,
    status: input.status,
    overlayId: input.overlayId ?? null,
    curatorResultId: input.curatorResultId ?? null,
    version: 1,
  })
}

export function createPrInvestigationInitialState(
  inputValue: PrInvestigationStartInput
): PrInvestigationStateValue {
  const input = prInvestigationStartInputSchema.parse(inputValue)
  return parsePrInvestigationState({
    input,
    graphName: PR_INVESTIGATION_GRAPH_NAME,
    analysisId: null,
    preparationId: null,
    baseline: null,
    workerReceipts: [],
    graphPathsId: null,
    overlayId: null,
    curatorResultId: null,
    resultId: null,
    status: "running",
  })
}

export function buildPrInvestigationGraph(
  dependencies: PrInvestigationDependencies,
  checkpointer: BaseCheckpointSaver,
  options: PrInvestigationOptions = {}
) {
  if (checkpointer === undefined) {
    throw new Error("PR investigation graph requires a checkpointer")
  }
  const graphMaxDepth = z
    .number()
    .int()
    .positive()
    .max(12)
    .parse(options.graphMaxDepth ?? 8)
  const graphPathLimit = z
    .number()
    .int()
    .positive()
    .max(200)
    .parse(options.graphPathLimit ?? 100)

  const validateContextNode = wrapNode(
    "validate_context",
    dependencies,
    parsePrInvestigationState,
    async (state, runtime) => {
      await assertCurrent(dependencies, state.input, runtime.signal)
      await assertBaselineCurrent(dependencies, state.input, runtime.signal)
      return {}
    },
    { runtimeState: stateRuntime }
  )

  const analyzeDiffNode = wrapNode(
    "analyze_diff",
    dependencies,
    parsePrInvestigationState,
    async (state, runtime) => {
      await assertCurrent(dependencies, state.input, runtime.signal)
      await assertBaselineCurrent(dependencies, state.input, runtime.signal)
      const prepared = await dependencies.diff.analyze(
        state.input,
        runtime.signal
      )
      validateAnalysis(state.input, prepared.analysis)
      const hints = prepared.hints.map((hint) =>
        prInvestigationRelationshipHintSchema.parse(hint)
      )
      const grouped = groupPrChanges({ analysis: prepared.analysis, hints })
      const [analysisId, preparationId] = await Promise.all([
        dependencies.store.saveAnalysis(prepared.analysis),
        dependencies.store.savePreparation(grouped),
      ])
      const baseline = baselineOutcome(prepared.analysis.baseline)
      return {
        analysisId,
        preparationId,
        baseline,
        status:
          baseline.disposition === "action_required"
            ? ("action_required" as const)
            : ("running" as const),
      }
    },
    { runtimeState: stateRuntime }
  )

  const routeAfterDiff = (stateValue: PrInvestigationStateValue) => {
    const state = parsePrInvestigationState(stateValue)
    return state.status === "action_required"
      ? "build_action_required_result"
      : "dispatch_groups"
  }

  const dispatchGroups = async (stateValue: PrInvestigationStateValue) => {
    const state = parsePrInvestigationState(stateValue)
    if (state.preparationId === null)
      throw new Error("PR preparation is missing")
    const preparation = await dependencies.store.loadPreparation(
      state.preparationId
    )
    if (preparation.groups.length === 0) return "query_graph"
    const budget = splitMissionBudget(
      state.input.budget,
      preparation.groups.length
    )
    return preparation.groups.map(
      (group) =>
        new Send("investigate_group", {
          input: state.input,
          graphName: state.graphName,
          group,
          budget,
        })
    )
  }

  const investigateGroupNode = wrapNode(
    "investigate_group",
    dependencies,
    (value) => workerInputSchema.parse(value),
    async (worker, runtime) => {
      await assertCurrent(dependencies, worker.input, runtime.signal)
      const mission = createPrChangeInvestigationMission({
        start: worker.input,
        group: worker.group,
        budget: worker.budget,
      })
      const result = canonicalizeCodeMissionResult(
        codeMissionResultSchema.parse(
          await dependencies.code.investigate(mission, runtime.signal)
        )
      )
      if (
        result.missionId !== mission.id ||
        !withinBudget(result.budgetUsed, mission.budget)
      ) {
        throw new Error("Code Explorer result violates its PR mission")
      }
      const resultId = await dependencies.store.saveCodeResult(result)
      if (resultId !== createCodeMissionResultId(result)) {
        throw new Error(
          "PR investigation store returned a noncanonical result ID"
        )
      }
      return {
        workerReceipts: prInvestigationWorkerReceiptSchema.parse({
          schemaVersion: 1,
          groupId: worker.group.id,
          missionId: mission.id,
          resultId,
          status: result.status,
          evidenceIds: receiptEvidence(result),
          unresolvedCount:
            result.unresolved.length + result.unresolvedBoundaries.length,
          budgetUsed: result.budgetUsed,
        }),
      }
    },
    {
      runtimeState: stateRuntime,
      eventContext: (worker) => ({
        agent: "code",
        missionId: createPrChangeInvestigationMission({
          start: worker.input,
          group: worker.group,
          budget: worker.budget,
        }).id,
      }),
    }
  )

  const reportWorkersNode = async (stateValue: PrInvestigationStateValue) => {
    const state = parsePrInvestigationState(stateValue)
    await dependencies.control.assertActive({
      runId: state.input.runId,
      owner: dependencies.owner,
    })
    await assertCurrent(dependencies, state.input)
    if (state.preparationId === null)
      throw new Error("PR preparation is missing")
    const preparation = await dependencies.store.loadPreparation(
      state.preparationId
    )
    if (state.workerReceipts.length !== preparation.groups.length) {
      throw new Error("Parallel PR investigation fan-in lost a worker receipt")
    }
    for (const receipt of state.workerReceipts) {
      await appendOrchestrationEvent(
        dependencies,
        {
          runId: state.input.runId,
          graphName: state.graphName,
          nodeName: "investigate_group",
          agent: "code",
          missionId: receipt.missionId,
          evidenceIds: receipt.evidenceIds,
          kind: "mission_completed",
          status: "completed",
          summary: "Related changed-symbol investigation completed",
          reasonCode: receipt.status,
        },
        {
          idempotencyKey: hashCanonical({
            kind: "pr-worker-completed-event",
            receipt,
            version: 1,
          }),
        }
      )
    }
    return {}
  }

  const queryGraphNode = wrapNode(
    "query_graph",
    dependencies,
    parsePrInvestigationState,
    async (state, runtime) => {
      await assertCurrent(dependencies, state.input, runtime.signal)
      await assertBaselineCurrent(dependencies, state.input, runtime.signal)
      if (state.preparationId === null || state.analysisId === null) {
        throw new Error("PR preparation or diff analysis is missing")
      }
      const [preparation, analysis] = await Promise.all([
        dependencies.store.loadPreparation(state.preparationId),
        dependencies.store.loadAnalysis(state.analysisId),
      ])
      const seedSymbols = createPrGraphSeedMap({
        start: state.input,
        groups: preparation.groups,
        analysis,
      })
      const seedIds = Object.keys(seedSymbols).map((id) =>
        stableEntityIdSchema.parse(id)
      )
      const paths =
        seedIds.length === 0
          ? []
          : (
              await dependencies.graph.findPullRequestImpactPaths(
                {
                  applicationId: state.input.applicationId,
                  graphRevision: state.input.graphRevision,
                  seedIds,
                  evidenceTiers: ["A", "B"],
                  maxDepth: graphMaxDepth,
                  limit: graphPathLimit,
                },
                runtime.signal
              )
            ).map((path) => graphEvidencePathSchema.parse(path))
      const normalized = normalizeGraphPaths({ seedSymbols, paths })
      return {
        graphPathsId: await dependencies.store.saveGraphPaths(normalized),
      }
    },
    { runtimeState: stateRuntime }
  )

  const buildOverlayNode = wrapNode(
    "build_overlay",
    dependencies,
    parsePrInvestigationState,
    async (state, runtime) => {
      await assertCurrent(dependencies, state.input, runtime.signal)
      if (
        state.analysisId === null ||
        state.preparationId === null ||
        state.graphPathsId === null
      ) {
        throw new Error("PR investigation evidence inputs are missing")
      }
      const [analysis, preparation, codeResults, graphPaths] =
        await Promise.all([
          dependencies.store.loadAnalysis(state.analysisId),
          dependencies.store.loadPreparation(state.preparationId),
          dependencies.store.loadCodeResults(
            state.workerReceipts.map(({ resultId }) => resultId)
          ),
          dependencies.store.loadGraphPaths(state.graphPathsId),
        ])
      const staged = await dependencies.overlay.stageAssessmentEvidence(
        {
          mode: "assessment_only",
          start: state.input,
          analysis,
          groups: preparation.groups,
          codeResults,
          graphPaths,
        },
        runtime.signal
      )
      const overlay = buildPrInvestigationOverlay({
        start: state.input,
        diffAnalysisId: state.analysisId,
        preparation,
        codeResultIds: codeResults.map(createCodeMissionResultId),
        codeResults,
        graphPaths,
        curatorEvidenceStateId: contentHashSchema.parse(
          staged.curatorEvidenceStateId
        ),
        validatedClaimIds: staged.validatedClaimIds,
        rejectedClaimIds: staged.rejectedClaimIds,
        conflictIds: staged.conflictIds,
      })
      return { overlayId: await dependencies.store.saveOverlay(overlay) }
    },
    { runtimeState: stateRuntime }
  )

  const runCuratorNode = wrapNode(
    "run_curator",
    dependencies,
    parsePrInvestigationState,
    async (state, runtime) => {
      await assertCurrent(dependencies, state.input, runtime.signal)
      if (state.overlayId === null) throw new Error("PR overlay is missing")
      const overlay = await dependencies.store.loadOverlay(state.overlayId)
      const workerBudget = state.workerReceipts.reduce(
        (total, receipt) => addMissionBudgets(total, receipt.budgetUsed),
        zeroBudget
      )
      const remainingBudget = subtractMissionBudgets(
        state.input.budget,
        workerBudget
      )
      const result = evidenceCuratorResultSchema.parse(
        await dependencies.curator.reconcile(
          {
            applicationId: state.input.applicationId,
            runId: state.input.runId,
            evidenceStateId: overlay.curatorEvidenceStateId,
            budget: remainingBudget,
            mode: "pr_impact",
          },
          runtime.signal
        )
      )
      if (
        result.applicationId !== state.input.applicationId ||
        result.runId !== state.input.runId ||
        result.matrix.evidenceStateId !== overlay.curatorEvidenceStateId ||
        !withinBudget(result.budgetUsed, remainingBudget)
      ) {
        throw new Error("Curator result violates the PR investigation boundary")
      }
      const reconciledOverlay = prInvestigationOverlaySchema.parse(
        await dependencies.overlay.loadReconciledAssessmentEvidence(
          { originalOverlay: overlay, curatorResult: result },
          runtime.signal
        )
      )
      if (
        reconciledOverlay.mode !== "assessment_only" ||
        reconciledOverlay.applicationId !== overlay.applicationId ||
        reconciledOverlay.runId !== overlay.runId ||
        reconciledOverlay.pullRequestId !== overlay.pullRequestId ||
        reconciledOverlay.graphRevision !== overlay.graphRevision ||
        reconciledOverlay.graphCommitSha !== overlay.graphCommitSha ||
        reconciledOverlay.diffAnalysisId !== overlay.diffAnalysisId ||
        reconciledOverlay.curatorEvidenceStateId !==
          result.matrix.evidenceStateId
      ) {
        throw new Error("Reconciled PR overlay changed its immutable boundary")
      }
      const [curatorResultId, overlayId] = await Promise.all([
        dependencies.store.saveCuratorResult(result),
        dependencies.store.saveOverlay(reconciledOverlay),
      ])
      return {
        curatorResultId,
        overlayId,
      }
    },
    { runtimeState: stateRuntime }
  )

  const buildActionRequiredResultNode = wrapNode(
    "build_action_required_result",
    dependencies,
    parsePrInvestigationState,
    async (state) => {
      if (
        state.analysisId === null ||
        state.preparationId === null ||
        state.baseline === null ||
        state.baseline.disposition !== "action_required"
      ) {
        throw new Error(
          "Action-required PR result is missing baseline evidence"
        )
      }
      const preparation = await dependencies.store.loadPreparation(
        state.preparationId
      )
      const result = prInvestigationResultSchema.parse({
        schemaVersion: 1,
        id: resultIdentity({
          start: state.input,
          diffAnalysisId: state.analysisId,
          status: "action_required",
        }),
        assessmentId: state.input.assessmentId,
        applicationId: state.input.applicationId,
        runId: state.input.runId,
        pullRequest: state.input.pullRequest,
        graphRevision: state.input.graphRevision,
        graphCommitSha: state.input.graphCommitSha,
        diffAnalysisId: state.analysisId,
        baseline: state.baseline,
        completedAt: state.input.pullRequest.analyzedAt,
        status: "action_required",
        groups: [],
        workerReceipts: [],
        overlayId: null,
        curatorResult: null,
        hypotheses: [],
        verificationCandidates: [],
        unknowns: preparation.unknowns,
      })
      return { resultId: await dependencies.store.saveResult(result) }
    },
    { runtimeState: stateRuntime }
  )

  const buildCompletedResultNode = wrapNode(
    "build_completed_result",
    dependencies,
    parsePrInvestigationState,
    async (state, runtime) => {
      await assertCurrent(dependencies, state.input, runtime.signal)
      if (
        state.analysisId === null ||
        state.preparationId === null ||
        state.baseline === null ||
        state.overlayId === null ||
        state.curatorResultId === null
      ) {
        throw new Error("Completed PR investigation inputs are missing")
      }
      const [preparation, overlay, curatorResult, deploymentValue] =
        await Promise.all([
          dependencies.store.loadPreparation(state.preparationId),
          dependencies.store.loadOverlay(state.overlayId),
          dependencies.store.loadCuratorResult(state.curatorResultId),
          dependencies.deployment.resolveTrustedHead(
            {
              assessmentId: state.input.assessmentId,
              headSha: state.input.pullRequest.headSha,
            },
            runtime.signal
          ),
        ])
      const deployment =
        deploymentValue === null
          ? null
          : trustedHeadDeploymentSchema.parse(deploymentValue)
      const hypotheses = buildPrImpactHypotheses(overlay)
      const verificationCandidates = buildVerificationCandidates({
        pullRequestHeadSha: state.input.pullRequest.headSha,
        deployment,
        hypotheses,
      })
      const result = prInvestigationResultSchema.parse({
        schemaVersion: 1,
        id: resultIdentity({
          start: state.input,
          diffAnalysisId: state.analysisId,
          status: "completed",
          overlayId: state.overlayId,
          curatorResultId: state.curatorResultId,
        }),
        assessmentId: state.input.assessmentId,
        applicationId: state.input.applicationId,
        runId: state.input.runId,
        pullRequest: state.input.pullRequest,
        graphRevision: state.input.graphRevision,
        graphCommitSha: state.input.graphCommitSha,
        diffAnalysisId: state.analysisId,
        baseline: state.baseline,
        completedAt: state.input.pullRequest.analyzedAt,
        status: "completed",
        groups: preparation.groups,
        workerReceipts: state.workerReceipts,
        overlayId: state.overlayId,
        curatorResult,
        hypotheses,
        verificationCandidates,
        unknowns: overlay.unknowns,
      })
      return { resultId: await dependencies.store.saveResult(result) }
    },
    { runtimeState: stateRuntime }
  )

  const publishResultNode = wrapNode(
    "publish_result",
    dependencies,
    parsePrInvestigationState,
    async (state, runtime) => {
      if (state.resultId === null)
        throw new Error("PR investigation result is missing")
      await assertCurrent(dependencies, state.input, runtime.signal)
      await assertBaselineCurrent(dependencies, state.input, runtime.signal)
      const result = await dependencies.store.loadResult(state.resultId)
      const publication = await dependencies.publisher.publishCurrent(
        {
          assessmentId: state.input.assessmentId,
          headSha: state.input.pullRequest.headSha,
          result,
        },
        runtime.signal
      )
      return {
        status:
          publication === "published"
            ? result.status === "action_required"
              ? ("action_required" as const)
              : ("completed" as const)
            : ("superseded" as const),
      }
    },
    { runtimeState: stateRuntime }
  )

  const reportCommitted =
    (nodeName: string, checkCurrent = true) =>
    async (stateValue: PrInvestigationStateValue) => {
      const state = parsePrInvestigationState(stateValue)
      await dependencies.control.assertActive({
        runId: state.input.runId,
        owner: dependencies.owner,
      })
      if (checkCurrent) await assertCurrent(dependencies, state.input)
      await appendOrchestrationEvent(
        dependencies,
        {
          runId: state.input.runId,
          graphName: state.graphName,
          nodeName,
          kind: "node_completed",
          status: "completed",
          summary: "Node state committed",
          reasonCode: "node_committed",
        },
        {
          idempotencyKey: hashCanonical({
            kind: "pr-committed-node-event",
            runId: state.input.runId,
            nodeName,
            version: 1,
          }),
        }
      )
      return {}
    }

  const routeAfterPublish = (stateValue: PrInvestigationStateValue) =>
    parsePrInvestigationState(stateValue).status === "superseded"
      ? END
      : "report_published"

  return new StateGraph(PrInvestigationState)
    .addNode("validate_context", validateContextNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addNode("report_context", reportCommitted("validate_context"))
    .addNode("analyze_diff", analyzeDiffNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addNode("report_diff", reportCommitted("analyze_diff"))
    .addNode("dispatch_groups", async () => ({}))
    .addNode("investigate_group", investigateGroupNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addNode("report_workers", reportWorkersNode)
    .addNode("query_graph", queryGraphNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addNode("report_graph", reportCommitted("query_graph"))
    .addNode("build_overlay", buildOverlayNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addNode("report_overlay", reportCommitted("build_overlay"))
    .addNode("run_curator", runCuratorNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addNode("report_curator", reportCommitted("run_curator"))
    .addNode("build_action_required_result", buildActionRequiredResultNode)
    .addNode("build_completed_result", buildCompletedResultNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addNode("publish_result", publishResultNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addNode("report_published", reportCommitted("publish_result", false))
    .addEdge(START, "validate_context")
    .addEdge("validate_context", "report_context")
    .addEdge("report_context", "analyze_diff")
    .addEdge("analyze_diff", "report_diff")
    .addConditionalEdges("report_diff", routeAfterDiff, [
      "build_action_required_result",
      "dispatch_groups",
    ])
    .addConditionalEdges("dispatch_groups", dispatchGroups, [
      "investigate_group",
      "query_graph",
    ])
    .addEdge("investigate_group", "report_workers")
    .addEdge("report_workers", "query_graph")
    .addEdge("query_graph", "report_graph")
    .addEdge("report_graph", "build_overlay")
    .addEdge("build_overlay", "report_overlay")
    .addEdge("report_overlay", "run_curator")
    .addEdge("run_curator", "report_curator")
    .addEdge("report_curator", "build_completed_result")
    .addEdge("build_action_required_result", "publish_result")
    .addEdge("build_completed_result", "publish_result")
    .addConditionalEdges("publish_result", routeAfterPublish, [
      "report_published",
      END,
    ])
    .addEdge("report_published", END)
    .compile({ checkpointer, interruptAfter: [] })
}

export type PrInvestigationGraph = ReturnType<typeof buildPrInvestigationGraph>

export interface PrInvestigationRunResult {
  readonly status: "completed" | "action_required" | "superseded"
  readonly state: PrInvestigationStateValue
  readonly result?: PrInvestigationResult
}

export class PrInvestigationService {
  constructor(
    private readonly graph: PrInvestigationGraph,
    private readonly store: PrInvestigationStore,
    private readonly resumeCoordinator: ResumeCoordinator,
    private readonly recursionLimit = 200
  ) {}

  private config(runId: string) {
    const parsedRunId = runIdSchema.parse(runId)
    return {
      configurable: {
        thread_id: `${parsedRunId}:${PR_INVESTIGATION_GRAPH_NAME}`,
      },
      recursionLimit: this.recursionLimit,
    }
  }

  private executionLock(runId: string) {
    return {
      runId: runIdSchema.parse(runId),
      decisionId: "pr_investigation_execution",
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

  private async currentState(runId: string) {
    const snapshot = await this.graph.getState(this.config(runId))
    return parsePrInvestigationState(snapshot.values)
  }

  private async toResult(runId: string): Promise<PrInvestigationRunResult> {
    const state = await this.currentState(runId)
    if (state.status === "running") {
      throw new Error("PR investigation graph ended without a terminal state")
    }
    const result =
      state.resultId === null
        ? undefined
        : await this.store.loadResult(state.resultId)
    return {
      status: state.status,
      state,
      ...(result === undefined ? {} : { result }),
    }
  }

  async start(inputValue: PrInvestigationStartInput) {
    const initial = createPrInvestigationInitialState(inputValue)
    return this.resumeCoordinator.runExclusive(
      this.executionLock(initial.input.runId),
      async () => {
        const config = this.config(initial.input.runId)
        const snapshot = await this.graph.getState(config)
        const exists =
          snapshot.values !== null &&
          typeof snapshot.values === "object" &&
          Object.keys(snapshot.values).length > 0
        if (exists) {
          let existing: PrInvestigationStateValue
          try {
            existing = parsePrInvestigationState(snapshot.values)
          } catch {
            throw new CheckpointStateError()
          }
          if (hashCanonical(existing.input) !== hashCanonical(initial.input)) {
            throw new CheckpointStateError()
          }
        }
        await this.graph.invoke(exists ? null : initial, config)
        return this.toResult(initial.input.runId)
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

export function createPrInvestigation(input: {
  readonly dependencies: PrInvestigationDependencies
  readonly checkpointer: BaseCheckpointSaver
  readonly options?: PrInvestigationOptions
}) {
  const graph = buildPrInvestigationGraph(
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
    service: new PrInvestigationService(
      graph,
      input.dependencies.store,
      input.dependencies.resumeCoordinator,
      recursionLimit
    ),
  }
}

export interface PrInvestigationRunInputResolver {
  resolve(
    input: GraphRunInput,
    context: RunExecutionContext
  ): Promise<PrInvestigationStartInput>
}

function stableRunId(databaseRunId: string) {
  return `run:${databaseRunId}`
}

export function createPrInvestigationCompiledRunGraph(input: {
  readonly service: PrInvestigationService
  readonly resolver: PrInvestigationRunInputResolver
  readonly reports: AssessmentReportRunFinalizerPort
  readonly checks: AssessmentReportCheckPort
  readonly now?: () => Date
}): CompiledRunGraph {
  const resolve = async (
    graphInput: GraphRunInput,
    context: RunExecutionContext
  ) => {
    await context.assertActive()
    const resolved = prInvestigationStartInputSchema.parse(
      await input.resolver.resolve(graphInput, context)
    )
    const payload = pullRequestRunPayloadSchema.parse(graphInput.payload)
    if (
      resolved.runId !== stableRunId(graphInput.runId) ||
      hashCanonical(resolved.budget) !== hashCanonical(graphInput.budget) ||
      resolved.pullRequest.number !== payload.pullRequestNumber ||
      resolved.pullRequest.baseSha !== payload.baseSha ||
      resolved.pullRequest.headSha !== payload.headSha
    ) {
      throw new Error(
        "Resolved PR investigation input conflicts with the run command"
      )
    }
    return resolved
  }

  const execute = async (
    graphInput: GraphRunInput,
    context: RunExecutionContext
  ): Promise<GraphExecutionResult> => {
    const resolved = await resolve(graphInput, context)
    const now = input.now ?? (() => new Date())
    const startedAt = now().toISOString()
    const running = await input.checks.publishCheck({
      assessmentId: resolved.assessmentId,
      headSha: resolved.pullRequest.headSha,
      lifecycle: githubCheckLifecycleSchema.parse({
        state: "running",
        startedAt,
      }),
    })
    if (running === "superseded") return { status: "cancelled" }
    if (running === "sync_pending") {
      throw new Error("Assessment GitHub check synchronization is pending")
    }
    try {
      const result = await input.service.start(resolved)
      await context.assertActive()
      if (
        (result.status === "completed" ||
          result.status === "action_required") &&
        result.result !== undefined
      ) {
        const report = await input.reports.finalize(
          { investigation: result.result },
          context.signal
        )
        await context.assertActive()
        if (report === "superseded") return { status: "cancelled" }
      }
      return result.status === "superseded"
        ? { status: "cancelled" }
        : {
            status: "succeeded",
            publication: {
              kind: "assessment",
              assessmentId: resolved.assessmentId,
            },
          }
    } catch (error) {
      if (context.signal.aborted !== true) {
        await input.checks
          .publishCheck({
            assessmentId: resolved.assessmentId,
            headSha: resolved.pullRequest.headSha,
            lifecycle: githubCheckLifecycleSchema.parse({
              state: "completed",
              outcome: "infrastructure_failed",
              title: "Sentinel analysis failed",
              summary:
                "Sentinel could not complete this assessment. Retry the run or inspect the Sentinel activity record for the bounded failure category.",
              completedAt: now().toISOString(),
            }),
          })
          .catch(() => undefined)
      }
      throw error
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
