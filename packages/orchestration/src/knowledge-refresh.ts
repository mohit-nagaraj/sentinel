import {
  contentHashSchema,
  discoveryMissionSchema,
  graphPublicationSummarySchema,
  hashCanonical,
  refreshChangeSetSchema,
  refreshContextValidationSchema,
  refreshGraphInventorySchema,
  refreshKnowledgeStartInputSchema,
  refreshKnowledgeSummarySchema,
  refreshMissionReceiptSchema,
  refreshReconciliationSchema,
  refreshRetentionReceiptSchema,
  refreshSourceMapResultSchema,
  runIdSchema,
  type DiscoveryMission,
  type GraphPublicationInput,
  type GraphPublicationSummary,
  type MissionBudget,
  type RefreshChangeSet,
  type RefreshContextValidation,
  type RefreshGraphInventory,
  type RefreshKnowledgeStartInput,
  type RefreshKnowledgeSummary,
  type RefreshMissionReceipt,
  type RefreshReconciliation,
  type RefreshRetentionReceipt,
  type RefreshScopePlan,
  type RefreshSourceMapResult,
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

import { planRefreshScope } from "./knowledge-refresh-planning.ts"
import {
  CheckpointStateError,
  emitCommittedNodeEvent,
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

export const REFRESH_KNOWLEDGE_GRAPH_NAME = "refresh_knowledge_graph" as const

const receiptListSchema = z
  .array(refreshMissionReceiptSchema)
  .max(3)
  .default(() => [])

function compareStrings(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"))
}

function mergeReceipts(
  current: readonly RefreshMissionReceipt[],
  additions: readonly RefreshMissionReceipt[]
): RefreshMissionReceipt[] {
  const merged = new Map(current.map((receipt) => [receipt.missionId, receipt]))
  for (const value of additions) {
    const receipt = refreshMissionReceiptSchema.parse(value)
    const existing = merged.get(receipt.missionId)
    if (
      existing !== undefined &&
      hashCanonical(existing) !== hashCanonical(receipt)
    ) {
      throw new Error("Conflicting refresh mission receipt")
    }
    merged.set(receipt.missionId, receipt)
  }
  return [...merged.values()].sort((left, right) =>
    compareStrings(left.missionId, right.missionId)
  )
}

export const RefreshKnowledgeState = new StateSchema({
  input: refreshKnowledgeStartInputSchema,
  graphName: z.literal(REFRESH_KNOWLEDGE_GRAPH_NAME),
  contextId: contentHashSchema.nullable().default(null),
  changeSetId: contentHashSchema.nullable().default(null),
  inventoryId: contentHashSchema.nullable().default(null),
  planId: contentHashSchema.nullable().default(null),
  sourceMapResultId: contentHashSchema.nullable().default(null),
  missionReceipts: new ReducedValue(receiptListSchema, {
    inputSchema: z.union([refreshMissionReceiptSchema, receiptListSchema]),
    reducer: (current, next) =>
      mergeReceipts(current, Array.isArray(next) ? next : [next]),
  }),
  reconciliationId: contentHashSchema.nullable().default(null),
  retentionId: contentHashSchema.nullable().default(null),
  publicationSummaryId: contentHashSchema.nullable().default(null),
  summaryId: contentHashSchema.nullable().default(null),
  status: z.enum(["running", "completed", "denied"]).default("running"),
})

export type RefreshKnowledgeStateValue = typeof RefreshKnowledgeState.State

const stateValueSchema = z.strictObject({
  input: refreshKnowledgeStartInputSchema,
  graphName: z.literal(REFRESH_KNOWLEDGE_GRAPH_NAME),
  contextId: contentHashSchema.nullable(),
  changeSetId: contentHashSchema.nullable(),
  inventoryId: contentHashSchema.nullable(),
  planId: contentHashSchema.nullable(),
  sourceMapResultId: contentHashSchema.nullable(),
  missionReceipts: receiptListSchema,
  reconciliationId: contentHashSchema.nullable(),
  retentionId: contentHashSchema.nullable(),
  publicationSummaryId: contentHashSchema.nullable(),
  summaryId: contentHashSchema.nullable(),
  status: z.enum(["running", "completed", "denied"]),
})

const missionWorkerSchema = z.strictObject({
  input: refreshKnowledgeStartInputSchema,
  graphName: z.literal(REFRESH_KNOWLEDGE_GRAPH_NAME),
  mission: discoveryMissionSchema,
})

type MissionWorker = z.infer<typeof missionWorkerSchema>

export function parseRefreshKnowledgeState(
  input: unknown
): RefreshKnowledgeStateValue {
  const state = stateValueSchema.parse(input)
  assertCompactCheckpointState(state)
  return state
}

interface RefreshStoredValues {
  readonly context: RefreshContextValidation
  readonly change_set: RefreshChangeSet
  readonly inventory: RefreshGraphInventory
  readonly plan: RefreshScopePlan
  readonly source_map: RefreshSourceMapResult
  readonly reconciliation: RefreshReconciliation
  readonly retention: RefreshRetentionReceipt
  readonly publication_summary: GraphPublicationSummary
  readonly summary: RefreshKnowledgeSummary
}

export type RefreshStoredRecord = {
  [Kind in keyof RefreshStoredValues]: {
    readonly kind: Kind
    readonly value: RefreshStoredValues[Kind]
  }
}[keyof RefreshStoredValues]

export interface RefreshKnowledgeStore {
  save(record: RefreshStoredRecord): Promise<string>
  load(id: string): Promise<RefreshStoredRecord>
}

export interface RefreshContextPort {
  validate(
    input: RefreshKnowledgeStartInput,
    signal?: AbortSignal
  ): Promise<RefreshContextValidation>
}

export interface RefreshDeploymentValidationPort {
  validate(
    input: RefreshKnowledgeStartInput,
    signal?: AbortSignal
  ): Promise<RefreshContextValidation["deployment"]>
}

export interface RefreshActiveGraphPort {
  current(
    input: { readonly applicationId: string },
    signal?: AbortSignal
  ): Promise<{
    readonly indexedCommitSha: string
    readonly graphRevision: number
  } | null>
}

export interface RefreshCommitRelationshipPort {
  relationship(
    input: {
      readonly repository: RefreshKnowledgeStartInput["repository"]
      readonly baseSha: string
      readonly targetSha: string
    },
    signal?: AbortSignal
  ): Promise<"descendant" | "same" | "unrelated" | "unknown">
}

export class DefaultRefreshContextPort implements RefreshContextPort {
  private readonly now: () => Date

  constructor(
    private readonly dependencies: {
      readonly deployment: RefreshDeploymentValidationPort
      readonly activeGraph: RefreshActiveGraphPort
      readonly commits: RefreshCommitRelationshipPort
      readonly now?: () => Date
    }
  ) {
    this.now = dependencies.now ?? (() => new Date())
  }

  async validate(
    inputValue: RefreshKnowledgeStartInput,
    signal?: AbortSignal
  ): Promise<RefreshContextValidation> {
    const input = refreshKnowledgeStartInputSchema.parse(inputValue)
    const [deploymentValue, activeGraph, relationshipValue] = await Promise.all(
      [
        this.dependencies.deployment.validate(input, signal),
        this.dependencies.activeGraph.current(
          { applicationId: input.applicationId },
          signal
        ),
        this.dependencies.commits.relationship(
          {
            repository: input.repository,
            baseSha: input.activeCommitSha,
            targetSha: input.targetCommitSha,
          },
          signal
        ),
      ]
    )
    const deployment =
      refreshContextValidationSchema.shape.deployment.parse(deploymentValue)
    const relationship = z
      .enum(["descendant", "same", "unrelated", "unknown"])
      .parse(relationshipValue)
    const activeGraphMatches =
      activeGraph !== null &&
      activeGraph.indexedCommitSha === input.activeCommitSha &&
      activeGraph.graphRevision === input.expectedGraphRevision
    const deploymentReady =
      deployment.applicationId === input.applicationId &&
      deployment.purpose === "post_deployment_refresh" &&
      deployment.expectedCommitSha === input.targetCommitSha &&
      deployment.identityState === "exact" &&
      deployment.trustState === "trusted" &&
      deployment.readinessState === "ready" &&
      deployment.reason === "deployment_ready"
    const ready =
      activeGraphMatches && relationship === "descendant" && deploymentReady
    const reason = !activeGraphMatches
      ? "active_graph_mismatch"
      : !deploymentReady
        ? "deployment_not_ready"
        : relationship !== "descendant"
          ? "target_not_descendant"
          : "refresh_ready"
    const actionRequired =
      reason === "active_graph_mismatch"
        ? "Reload the current indexed commit and graph revision before retrying refresh."
        : reason === "deployment_not_ready"
          ? (deployment.actionRequired ??
            "Register a trusted live deployment of the target commit.")
          : reason === "target_not_descendant"
            ? "Refresh only to a descendant of the active indexed commit."
            : undefined
    const validatedAt = this.now().toISOString()
    const draft = {
      schemaVersion: 1 as const,
      applicationId: input.applicationId,
      activeCommitSha: input.activeCommitSha,
      targetCommitSha: input.targetCommitSha,
      activeGraphRevision: input.expectedGraphRevision,
      activeGraphMatches,
      relationship,
      deployment,
      status: ready ? ("ready" as const) : ("denied" as const),
      reason,
      ...(actionRequired === undefined ? {} : { actionRequired }),
      validatedAt,
    }
    return refreshContextValidationSchema.parse({
      ...draft,
      id: hashCanonical({
        kind: "refresh-context-validation",
        version: 1,
        ...draft,
      }),
    })
  }
}

export interface RefreshChangePort {
  compare(
    input: RefreshKnowledgeStartInput,
    signal?: AbortSignal
  ): Promise<RefreshChangeSet>
}

export interface RefreshInventoryPort {
  load(
    input: RefreshKnowledgeStartInput,
    signal?: AbortSignal
  ): Promise<RefreshGraphInventory>
}

export interface RefreshSourceMapPort {
  reindex(
    input: {
      readonly start: RefreshKnowledgeStartInput
      readonly plan: RefreshScopePlan
    },
    signal?: AbortSignal
  ): Promise<RefreshSourceMapResult>
}

export interface RefreshSpecialistPort {
  execute(
    mission: DiscoveryMission,
    signal?: AbortSignal
  ): Promise<RefreshMissionReceipt>
}

export interface RefreshCuratorPort {
  reconcile(
    input: {
      readonly start: RefreshKnowledgeStartInput
      readonly plan: RefreshScopePlan
      readonly sourceMap: RefreshSourceMapResult
      readonly missionReceipts: readonly RefreshMissionReceipt[]
    },
    signal?: AbortSignal
  ): Promise<RefreshReconciliation>
}

export interface RefreshPublisherPort {
  publish(
    publication: GraphPublicationInput,
    signal?: AbortSignal
  ): Promise<GraphPublicationSummary>
}

export interface RefreshRetentionPort {
  retain(
    input: {
      readonly applicationId: string
      readonly runId: string
      readonly planId: string
      readonly assessmentIds: readonly string[]
      readonly evidenceIds: readonly string[]
      readonly artifactIds: readonly string[]
    },
    signal?: AbortSignal
  ): Promise<RefreshRetentionReceipt>
}

export interface RefreshKnowledgeDependencies extends RuntimeDependencies {
  readonly store: RefreshKnowledgeStore
  readonly context: RefreshContextPort
  readonly changes: RefreshChangePort
  readonly inventory: RefreshInventoryPort
  readonly sourceMaps: RefreshSourceMapPort
  readonly specialists: RefreshSpecialistPort
  readonly curator: RefreshCuratorPort
  readonly retention: RefreshRetentionPort
  readonly publisher: RefreshPublisherPort
}

function stateRuntime(state: RefreshKnowledgeStateValue | MissionWorker) {
  return {
    runId: state.input.runId,
    graphName: state.graphName,
    startedAtMs: Date.parse(state.input.startedAt),
    budget: state.input.budget,
  }
}

function withinBudget(used: MissionBudget, limit: MissionBudget): boolean {
  return (Object.keys(limit) as (keyof MissionBudget)[]).every(
    (key) => used[key] <= limit[key]
  )
}

async function saveRecord(
  store: RefreshKnowledgeStore,
  record: RefreshStoredRecord
): Promise<string> {
  const expected = hashCanonical({
    kind: `refresh-${record.kind}`,
    value: record.value,
    version: 1,
  })
  const stored = contentHashSchema.parse(await store.save(record))
  if (stored !== expected) {
    throw new Error("Refresh store returned a noncanonical record ID")
  }
  return stored
}

async function loadRecord<Kind extends keyof RefreshStoredValues>(
  store: RefreshKnowledgeStore,
  id: string,
  kind: Kind
): Promise<RefreshStoredValues[Kind]> {
  const record = await store.load(contentHashSchema.parse(id))
  if (record.kind !== kind) {
    throw new Error("Refresh store returned the wrong record kind")
  }
  const expected = hashCanonical({
    kind: `refresh-${record.kind}`,
    value: record.value,
    version: 1,
  })
  if (expected !== id) {
    throw new Error("Refresh store record content does not match its ID")
  }
  return record.value as RefreshStoredValues[Kind]
}

function validateContextIdentity(
  start: RefreshKnowledgeStartInput,
  context: RefreshContextValidation
) {
  if (
    context.applicationId !== start.applicationId ||
    context.activeCommitSha !== start.activeCommitSha ||
    context.targetCommitSha !== start.targetCommitSha ||
    context.activeGraphRevision !== start.expectedGraphRevision
  ) {
    throw new Error("Refresh validation crossed run identity")
  }
}

function validateChangeSetIdentity(
  start: RefreshKnowledgeStartInput,
  changeSet: RefreshChangeSet
) {
  if (
    changeSet.baseSha !== start.activeCommitSha ||
    changeSet.targetSha !== start.targetCommitSha ||
    !changeSet.complete
  ) {
    throw new Error("Refresh change set is incomplete or mismatched")
  }
}

function validateInventoryIdentity(
  start: RefreshKnowledgeStartInput,
  inventory: RefreshGraphInventory
) {
  if (
    inventory.applicationId !== start.applicationId ||
    inventory.graphRevision !== start.expectedGraphRevision ||
    inventory.indexedCommitSha !== start.activeCommitSha
  ) {
    throw new Error("Refresh inventory does not match the active graph")
  }
}

function validateReconciliation(
  start: RefreshKnowledgeStartInput,
  plan: RefreshScopePlan,
  sourceMap: RefreshSourceMapResult,
  receipts: readonly RefreshMissionReceipt[],
  reconciliation: RefreshReconciliation
) {
  const publication = reconciliation.publication
  if (
    reconciliation.planId !== plan.id ||
    reconciliation.sourceMapResultId !== sourceMap.id ||
    hashCanonical(reconciliation.missionResultIds) !==
      hashCanonical(
        receipts.map(({ resultId }) => resultId).sort(compareStrings)
      ) ||
    publication.applicationId !== start.applicationId ||
    publication.runId !== start.runId ||
    publication.inputFingerprint !== start.inputFingerprint ||
    publication.indexedCommitSha !== start.targetCommitSha ||
    publication.expectedGraphRevision !== start.expectedGraphRevision ||
    publication.graphRevision !== start.graphRevision ||
    publication.replacement.kind !== "affected" ||
    hashCanonical(publication.replacement.stableKeys) !==
      hashCanonical(plan.replacementStableKeys) ||
    hashCanonical(publication.retainedEvidenceIds) !==
      hashCanonical(plan.retainedEvidenceIds) ||
    hashCanonical(reconciliation.coverageReassessedRequirementIds) !==
      hashCanonical(plan.reassessRequirementIds) ||
    hashCanonical(reconciliation.retainedArtifactIds) !==
      hashCanonical(plan.retainedArtifactIds)
  ) {
    throw new Error("Refresh reconciliation violates its scoped publication")
  }
}

export function createRefreshKnowledgeInitialState(
  inputValue: RefreshKnowledgeStartInput
): RefreshKnowledgeStateValue {
  const input = refreshKnowledgeStartInputSchema.parse(inputValue)
  return parseRefreshKnowledgeState({
    input,
    graphName: REFRESH_KNOWLEDGE_GRAPH_NAME,
    contextId: null,
    changeSetId: null,
    inventoryId: null,
    planId: null,
    sourceMapResultId: null,
    missionReceipts: [],
    reconciliationId: null,
    retentionId: null,
    publicationSummaryId: null,
    summaryId: null,
    status: "running",
  })
}

export function buildRefreshKnowledgeGraph(
  dependencies: RefreshKnowledgeDependencies,
  checkpointer: BaseCheckpointSaver
) {
  if (checkpointer === undefined) {
    throw new Error("Knowledge refresh graph requires a checkpointer")
  }

  const validateContextNode = wrapNode(
    "validate_refresh_context",
    dependencies,
    parseRefreshKnowledgeState,
    async (state, runtime) => {
      const context = refreshContextValidationSchema.parse(
        await dependencies.context.validate(state.input, runtime.signal)
      )
      validateContextIdentity(state.input, context)
      return {
        contextId: await saveRecord(dependencies.store, {
          kind: "context",
          value: context,
        }),
        status: context.status === "ready" ? "running" : "denied",
      }
    },
    { runtimeState: stateRuntime }
  )

  const compareChangesNode = wrapNode(
    "compare_refresh_commits",
    dependencies,
    parseRefreshKnowledgeState,
    async (state, runtime) => {
      const changeSet = refreshChangeSetSchema.parse(
        await dependencies.changes.compare(state.input, runtime.signal)
      )
      validateChangeSetIdentity(state.input, changeSet)
      return {
        changeSetId: await saveRecord(dependencies.store, {
          kind: "change_set",
          value: changeSet,
        }),
      }
    },
    { runtimeState: stateRuntime }
  )

  const loadInventoryNode = wrapNode(
    "load_refresh_inventory",
    dependencies,
    parseRefreshKnowledgeState,
    async (state, runtime) => {
      const inventory = refreshGraphInventorySchema.parse(
        await dependencies.inventory.load(state.input, runtime.signal)
      )
      validateInventoryIdentity(state.input, inventory)
      return {
        inventoryId: await saveRecord(dependencies.store, {
          kind: "inventory",
          value: inventory,
        }),
      }
    },
    { runtimeState: stateRuntime }
  )

  const planScopeNode = wrapNode(
    "plan_refresh_scope",
    dependencies,
    parseRefreshKnowledgeState,
    async (state) => {
      if (
        state.contextId === null ||
        state.changeSetId === null ||
        state.inventoryId === null
      ) {
        throw new Error("Refresh planning inputs are missing")
      }
      const [context, changeSet, inventory] = await Promise.all([
        loadRecord(dependencies.store, state.contextId, "context"),
        loadRecord(dependencies.store, state.changeSetId, "change_set"),
        loadRecord(dependencies.store, state.inventoryId, "inventory"),
      ])
      const plan = planRefreshScope({
        start: state.input,
        context,
        changeSet,
        inventory,
      })
      return {
        planId: await saveRecord(dependencies.store, {
          kind: "plan",
          value: plan,
        }),
      }
    },
    { runtimeState: stateRuntime }
  )

  const reindexNode = wrapNode(
    "reindex_refresh_sources",
    dependencies,
    parseRefreshKnowledgeState,
    async (state, runtime) => {
      if (state.planId === null) throw new Error("Refresh plan is missing")
      const plan = await loadRecord(dependencies.store, state.planId, "plan")
      const hasSourceWork = Object.values(plan.sourceScope).some(
        (values) => values.length > 0
      )
      const result = refreshSourceMapResultSchema.parse(
        hasSourceWork
          ? await dependencies.sourceMaps.reindex(
              { start: state.input, plan },
              runtime.signal
            )
          : (() => {
              const draft = {
                schemaVersion: 1 as const,
                planId: plan.id,
                targetCommitSha: state.input.targetCommitSha,
                indexedPaths: [],
                removedEntityIds: [],
                nodeIds: [],
                linkIds: [],
                evidenceIds: [],
                unresolvedPaths: [],
                warnings: [],
              }
              return {
                ...draft,
                id: hashCanonical({
                  kind: "empty-refresh-source-map",
                  version: 1,
                  ...draft,
                }),
              }
            })()
      )
      if (
        result.planId !== plan.id ||
        result.targetCommitSha !== state.input.targetCommitSha ||
        result.removedEntityIds.some(
          (id) => !plan.affectedEntityIds.includes(id)
        )
      ) {
        throw new Error("Source-map refresh exceeds the planned scope")
      }
      return {
        sourceMapResultId: await saveRecord(dependencies.store, {
          kind: "source_map",
          value: result,
        }),
      }
    },
    { runtimeState: stateRuntime }
  )

  const dispatchMissions = async (stateValue: RefreshKnowledgeStateValue) => {
    const state = parseRefreshKnowledgeState(stateValue)
    if (state.planId === null) throw new Error("Refresh plan is missing")
    const plan = await loadRecord(dependencies.store, state.planId, "plan")
    if (plan.missions.length === 0) return "reconcile_refresh"
    return plan.missions.map(
      (mission) =>
        new Send("run_refresh_mission", {
          input: state.input,
          graphName: state.graphName,
          mission,
        })
    )
  }

  const runMissionNode = wrapNode(
    "run_refresh_mission",
    dependencies,
    (value) => missionWorkerSchema.parse(value),
    async (worker, runtime) => {
      const receipt = refreshMissionReceiptSchema.parse(
        await dependencies.specialists.execute(worker.mission, runtime.signal)
      )
      if (
        receipt.missionId !== worker.mission.id ||
        receipt.agent !== worker.mission.agent ||
        !withinBudget(receipt.budgetUsed, worker.mission.budget)
      ) {
        throw new Error("Specialist receipt violates its refresh mission")
      }
      return { missionReceipts: receipt }
    },
    {
      runtimeState: stateRuntime,
      eventContext: (worker) => ({
        agent: worker.mission.agent,
        missionId: worker.mission.id,
      }),
    }
  )

  const reconcileNode = wrapNode(
    "reconcile_refresh",
    dependencies,
    parseRefreshKnowledgeState,
    async (state, runtime) => {
      if (state.planId === null || state.sourceMapResultId === null) {
        throw new Error("Refresh reconciliation inputs are missing")
      }
      const [plan, sourceMap] = await Promise.all([
        loadRecord(dependencies.store, state.planId, "plan"),
        loadRecord(dependencies.store, state.sourceMapResultId, "source_map"),
      ])
      if (state.missionReceipts.length !== plan.missions.length) {
        throw new Error("Refresh mission fan-in lost a receipt")
      }
      const reconciliation = refreshReconciliationSchema.parse(
        await dependencies.curator.reconcile(
          {
            start: state.input,
            plan,
            sourceMap,
            missionReceipts: state.missionReceipts,
          },
          runtime.signal
        )
      )
      validateReconciliation(
        state.input,
        plan,
        sourceMap,
        state.missionReceipts,
        reconciliation
      )
      return {
        reconciliationId: await saveRecord(dependencies.store, {
          kind: "reconciliation",
          value: reconciliation,
        }),
      }
    },
    { runtimeState: stateRuntime }
  )

  const retainArtifactsNode = wrapNode(
    "retain_refresh_artifacts",
    dependencies,
    parseRefreshKnowledgeState,
    async (state, runtime) => {
      if (state.planId === null) throw new Error("Refresh plan is missing")
      const plan = await loadRecord(dependencies.store, state.planId, "plan")
      const receipt = refreshRetentionReceiptSchema.parse(
        await dependencies.retention.retain(
          {
            applicationId: state.input.applicationId,
            runId: state.input.runId,
            planId: plan.id,
            assessmentIds: plan.immutableAssessmentIds,
            evidenceIds: plan.retainedEvidenceIds,
            artifactIds: plan.retainedArtifactIds,
          },
          runtime.signal
        )
      )
      if (
        receipt.planId !== plan.id ||
        hashCanonical(receipt.assessmentIds) !==
          hashCanonical(plan.immutableAssessmentIds) ||
        hashCanonical(receipt.evidenceIds) !==
          hashCanonical(plan.retainedEvidenceIds) ||
        hashCanonical(receipt.artifactIds) !==
          hashCanonical(plan.retainedArtifactIds)
      ) {
        throw new Error("Artifact retention does not match the refresh plan")
      }
      return {
        retentionId: await saveRecord(dependencies.store, {
          kind: "retention",
          value: receipt,
        }),
      }
    },
    { runtimeState: stateRuntime }
  )

  const publishNode = wrapNode(
    "publish_refresh_revision",
    dependencies,
    parseRefreshKnowledgeState,
    async (state, runtime) => {
      if (
        state.planId === null ||
        state.sourceMapResultId === null ||
        state.reconciliationId === null ||
        state.retentionId === null
      ) {
        throw new Error("Refresh publication inputs are missing")
      }
      const [plan, sourceMap, reconciliation, retention] = await Promise.all([
        loadRecord(dependencies.store, state.planId, "plan"),
        loadRecord(dependencies.store, state.sourceMapResultId, "source_map"),
        loadRecord(
          dependencies.store,
          state.reconciliationId,
          "reconciliation"
        ),
        loadRecord(dependencies.store, state.retentionId, "retention"),
      ])
      if (
        retention.planId !== plan.id ||
        hashCanonical(retention.assessmentIds) !==
          hashCanonical(plan.immutableAssessmentIds) ||
        hashCanonical(retention.evidenceIds) !==
          hashCanonical(plan.retainedEvidenceIds) ||
        hashCanonical(retention.artifactIds) !==
          hashCanonical(plan.retainedArtifactIds)
      ) {
        throw new Error(
          "Stored retention receipt does not match the refresh plan"
        )
      }
      const publicationSummary = graphPublicationSummarySchema.parse(
        await dependencies.publisher.publish(
          reconciliation.publication,
          runtime.signal
        )
      )
      if (
        publicationSummary.applicationId !== state.input.applicationId ||
        publicationSummary.runId !== state.input.runId ||
        publicationSummary.inputFingerprint !== state.input.inputFingerprint ||
        publicationSummary.indexedCommitSha !== state.input.targetCommitSha ||
        publicationSummary.expectedGraphRevision !==
          state.input.expectedGraphRevision ||
        publicationSummary.graphRevision !== state.input.graphRevision ||
        publicationSummary.replacementKind !== "affected"
      ) {
        throw new Error("Publisher returned a mismatched refresh summary")
      }
      const publicationSummaryId = await saveRecord(dependencies.store, {
        kind: "publication_summary",
        value: publicationSummary,
      })
      const warnings = [
        ...plan.warnings,
        ...sourceMap.warnings,
        ...state.missionReceipts.flatMap(({ warnings }) => warnings),
        ...reconciliation.warnings,
        ...reconciliation.unresolved,
      ]
        .map(String)
        .filter((value, index, values) => values.indexOf(value) === index)
        .sort(compareStrings)
        .slice(0, 200)
      const summary = refreshKnowledgeSummarySchema.parse({
        schemaVersion: 1,
        applicationId: state.input.applicationId,
        runId: state.input.runId,
        status: "completed",
        activeCommitSha: state.input.activeCommitSha,
        targetCommitSha: state.input.targetCommitSha,
        graphRevision: state.input.graphRevision,
        affectedEntityCount: plan.affectedEntityIds.length,
        reusedEntityCount: plan.reusedEntityIds.length,
        invalidatedLinkCount: plan.invalidatedLinkIds.length,
        reassessedRequirementCount:
          reconciliation.coverageReassessedRequirementIds.length,
        specialistMissionCount: state.missionReceipts.length,
        retainedEvidenceCount: plan.retainedEvidenceIds.length,
        retainedArtifactCount: reconciliation.retainedArtifactIds.length,
        warnings,
        freshness: "current",
        publication: publicationSummary,
        completedAt: publicationSummary.publishedAt,
      })
      return {
        publicationSummaryId,
        summaryId: await saveRecord(dependencies.store, {
          kind: "summary",
          value: summary,
        }),
        status: "completed" as const,
      }
    },
    {
      runtimeState: stateRuntime,
      // Activation can terminalize the run before LangGraph checkpoints this
      // update. Retrying is safe because publication and records are idempotent.
      checkActiveAfter: false,
    }
  )

  const buildDeniedSummaryNode = wrapNode(
    "build_denied_refresh_summary",
    dependencies,
    parseRefreshKnowledgeState,
    async (state) => {
      if (state.contextId === null) {
        throw new Error("Denied refresh context is missing")
      }
      const context = await loadRecord(
        dependencies.store,
        state.contextId,
        "context"
      )
      const summary = refreshKnowledgeSummarySchema.parse({
        schemaVersion: 1,
        applicationId: state.input.applicationId,
        runId: state.input.runId,
        status: "denied",
        activeCommitSha: state.input.activeCommitSha,
        targetCommitSha: state.input.targetCommitSha,
        graphRevision: state.input.expectedGraphRevision,
        affectedEntityCount: 0,
        reusedEntityCount: 0,
        invalidatedLinkCount: 0,
        reassessedRequirementCount: 0,
        specialistMissionCount: 0,
        retainedEvidenceCount: 0,
        retainedArtifactCount: 0,
        warnings: [],
        freshness: "unchanged",
        reason: context.actionRequired,
        completedAt: context.validatedAt,
      })
      return {
        summaryId: await saveRecord(dependencies.store, {
          kind: "summary",
          value: summary,
        }),
        status: "denied" as const,
      }
    },
    { runtimeState: stateRuntime }
  )

  const report =
    (nodeName: string) => async (stateValue: RefreshKnowledgeStateValue) => {
      const state = parseRefreshKnowledgeState(stateValue)
      await dependencies.control.assertActive({
        runId: state.input.runId,
        owner: dependencies.owner,
      })
      await emitCommittedNodeEvent(dependencies, stateRuntime(state), nodeName)
      return {}
    }

  const routeAfterContext = (stateValue: RefreshKnowledgeStateValue) =>
    parseRefreshKnowledgeState(stateValue).status === "denied"
      ? "build_denied_refresh_summary"
      : "compare_refresh_commits"

  return new StateGraph(RefreshKnowledgeState)
    .addNode("validate_refresh_context", validateContextNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addNode("report_refresh_context", report("validate_refresh_context"))
    .addNode("compare_refresh_commits", compareChangesNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addNode("load_refresh_inventory", loadInventoryNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addNode("plan_refresh_scope", planScopeNode)
    .addNode("reindex_refresh_sources", reindexNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addNode("dispatch_refresh_missions", async () => ({}))
    .addNode("run_refresh_mission", runMissionNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addNode("reconcile_refresh", reconcileNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addNode("retain_refresh_artifacts", retainArtifactsNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addNode("publish_refresh_revision", publishNode, {
      retryPolicy: transientRetryPolicy,
    })
    .addNode("build_denied_refresh_summary", buildDeniedSummaryNode)
    .addEdge(START, "validate_refresh_context")
    .addEdge("validate_refresh_context", "report_refresh_context")
    .addConditionalEdges("report_refresh_context", routeAfterContext, [
      "build_denied_refresh_summary",
      "compare_refresh_commits",
    ])
    .addEdge("compare_refresh_commits", "load_refresh_inventory")
    .addEdge("load_refresh_inventory", "plan_refresh_scope")
    .addEdge("plan_refresh_scope", "reindex_refresh_sources")
    .addEdge("reindex_refresh_sources", "dispatch_refresh_missions")
    .addConditionalEdges("dispatch_refresh_missions", dispatchMissions, [
      "run_refresh_mission",
      "reconcile_refresh",
    ])
    .addEdge("run_refresh_mission", "reconcile_refresh")
    .addEdge("reconcile_refresh", "retain_refresh_artifacts")
    .addEdge("retain_refresh_artifacts", "publish_refresh_revision")
    .addEdge("publish_refresh_revision", END)
    .addEdge("build_denied_refresh_summary", END)
    .compile({ checkpointer, interruptAfter: [] })
}

export type RefreshKnowledgeGraph = ReturnType<
  typeof buildRefreshKnowledgeGraph
>

export interface RefreshKnowledgeRunResult {
  readonly status: "completed" | "denied"
  readonly state: RefreshKnowledgeStateValue
  readonly summary: RefreshKnowledgeSummary
}

export class RefreshKnowledgeService {
  constructor(
    private readonly graph: RefreshKnowledgeGraph,
    private readonly store: RefreshKnowledgeStore,
    private readonly resumeCoordinator: ResumeCoordinator,
    private readonly recursionLimit = 100
  ) {}

  private config(runId: string) {
    const parsedRunId = runIdSchema.parse(runId)
    return {
      configurable: {
        thread_id: `${parsedRunId}:${REFRESH_KNOWLEDGE_GRAPH_NAME}`,
      },
      recursionLimit: this.recursionLimit,
    }
  }

  private executionLock(runId: string) {
    return {
      runId: runIdSchema.parse(runId),
      decisionId: "refresh_knowledge_execution",
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

  private async toResult(runId: string): Promise<RefreshKnowledgeRunResult> {
    const snapshot = await this.graph.getState(this.config(runId))
    const state = parseRefreshKnowledgeState(snapshot.values)
    if (state.status === "running" || state.summaryId === null) {
      throw new Error(
        "Knowledge refresh graph ended without a terminal summary"
      )
    }
    const summary = refreshKnowledgeSummarySchema.parse(
      await loadRecord(this.store, state.summaryId, "summary")
    )
    return { status: state.status, state, summary }
  }

  async start(inputValue: RefreshKnowledgeStartInput) {
    const initial = createRefreshKnowledgeInitialState(inputValue)
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
          let current: RefreshKnowledgeStateValue
          try {
            current = parseRefreshKnowledgeState(snapshot.values)
          } catch {
            throw new CheckpointStateError()
          }
          if (hashCanonical(current.input) !== hashCanonical(initial.input)) {
            throw new CheckpointStateError()
          }
        }
        await this.graph.invoke(exists ? null : initial, config)
        return this.toResult(initial.input.runId)
      }
    )
  }
}

export function createRefreshKnowledge(input: {
  readonly dependencies: RefreshKnowledgeDependencies
  readonly checkpointer: BaseCheckpointSaver
  readonly recursionLimit?: number
}) {
  const graph = buildRefreshKnowledgeGraph(
    input.dependencies,
    input.checkpointer
  )
  const recursionLimit = z
    .number()
    .int()
    .min(20)
    .max(1_000)
    .parse(input.recursionLimit ?? 100)
  return {
    graph,
    service: new RefreshKnowledgeService(
      graph,
      input.dependencies.store,
      input.dependencies.resumeCoordinator,
      recursionLimit
    ),
  }
}

export interface RefreshKnowledgeRunInputResolver {
  resolve(
    input: GraphRunInput,
    context: RunExecutionContext
  ): Promise<RefreshKnowledgeStartInput>
}

function stableRunId(databaseRunId: string) {
  return `run:${databaseRunId}`
}

export function createRefreshKnowledgeCompiledRunGraph(input: {
  readonly service: RefreshKnowledgeService
  readonly resolver: RefreshKnowledgeRunInputResolver
}): CompiledRunGraph {
  const execute = async (
    graphInput: GraphRunInput,
    context: RunExecutionContext
  ): Promise<GraphExecutionResult> => {
    await context.assertActive()
    const resolved = refreshKnowledgeStartInputSchema.parse(
      await input.resolver.resolve(graphInput, context)
    )
    if (
      resolved.runId !== stableRunId(graphInput.runId) ||
      hashCanonical(resolved.budget) !== hashCanonical(graphInput.budget) ||
      Object.keys(graphInput.payload).length !== 0
    ) {
      throw new Error(
        "Resolved knowledge refresh conflicts with the run command"
      )
    }
    const result = await input.service.start(resolved)
    if (result.status === "denied") {
      await context.assertActive()
      return { status: "cancelled" }
    }
    return {
      status: "succeeded",
      publication: {
        kind: "knowledge",
        inputFingerprint: resolved.inputFingerprint,
        expectedGraphRevision: resolved.expectedGraphRevision,
        indexedCommitSha: resolved.targetCommitSha,
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
