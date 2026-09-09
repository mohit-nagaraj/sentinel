import {
  REFRESH_KNOWLEDGE_POLICY_VERSION,
  coverageStatusSchema,
  entityKindValues,
  evidenceRelationshipSchema,
  graphPublicationInputSchema,
  graphPublicationSummarySchema,
  hashCanonical,
  refreshChangeSetSchema,
  refreshContextValidationSchema,
  refreshGraphInventorySchema,
  refreshKnowledgeStartInputSchema,
  refreshMissionReceiptSchema,
  refreshReconciliationSchema,
  refreshRetentionReceiptSchema,
  refreshSourceMapResultSchema,
  type RefreshContextValidation,
} from "@sentinel/contracts"
import { MemorySaver } from "@langchain/langgraph"
import { describe, expect, it, vi } from "vitest"

import {
  DefaultRefreshContextPort,
  createRefreshKnowledge,
  createRefreshKnowledgeCompiledRunGraph,
  type RefreshKnowledgeDependencies,
  type RefreshKnowledgeStore,
  type RefreshStoredRecord,
} from "./knowledge-refresh.ts"
import { CancelledOrchestrationError, SanitizedNodeError } from "./runtime.ts"
import { InMemoryResumeCoordinator } from "./resume-coordinator.ts"

const timestamp = "2026-09-09T10:00:00.000Z"
const applicationId = `application:v1:${"a".repeat(64)}`
const runId = "run:11111111-1111-4111-8111-111111111111"
const activeCommitSha = "1".repeat(40)
const targetCommitSha = "2".repeat(40)
const repository = { host: "github.com", owner: "acme", name: "shop" }
const hash = (character: string) => `sha256:${character.repeat(64)}`

const budget = {
  toolCalls: 30,
  contentBytes: 300_000,
  documentBytes: 100_000,
  documentPages: 30,
  documentSections: 60,
  sourceLines: 3_000,
  repositoryBytes: 3_000_000,
  repositoryFiles: 300,
  browserActions: 30,
  modelCalls: 15,
  modelInputTokens: 30_000,
  modelOutputTokens: 6_000,
  reconciliationRounds: 3,
  elapsedMs: 300_000,
}

const noBudget = {
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

const start = refreshKnowledgeStartInputSchema.parse({
  schemaVersion: 1,
  policyVersion: REFRESH_KNOWLEDGE_POLICY_VERSION,
  applicationId,
  runId,
  repository,
  activeCommitSha,
  targetCommitSha,
  expectedGraphRevision: 4,
  graphRevision: 5,
  inputFingerprint: hash("f"),
  budget,
  startedAt: timestamp,
})

function readyContext(): RefreshContextValidation {
  return refreshContextValidationSchema.parse({
    schemaVersion: 1,
    id: hash("1"),
    applicationId,
    activeCommitSha,
    targetCommitSha,
    activeGraphRevision: 4,
    activeGraphMatches: true,
    relationship: "descendant",
    deployment: {
      schemaVersion: 1,
      applicationId,
      registrationId: hash("2"),
      purpose: "post_deployment_refresh",
      expectedCommitSha: targetCommitSha,
      identityState: "exact",
      trustState: "trusted",
      readinessState: "ready",
      browserAccessAllowed: true,
      credentialAccessAllowed: true,
      reason: "deployment_ready",
      proof: {
        schemaVersion: 1,
        provider: "render",
        serviceId: "srv-1",
        deployId: "dep-1",
        repository,
        commitSha: targetCommitSha,
        publicUrl: "https://shop.example.test/",
        status: "live",
        observedAt: timestamp,
      },
      validatedAt: timestamp,
    },
    status: "ready",
    reason: "refresh_ready",
    validatedAt: timestamp,
  })
}

function deniedContext(): RefreshContextValidation {
  const ready = readyContext()
  const { proof: _proof, ...deployment } = ready.deployment
  void _proof
  return refreshContextValidationSchema.parse({
    ...ready,
    id: hash("3"),
    relationship: "unrelated",
    deployment: {
      ...deployment,
      identityState: "mismatch",
      trustState: "untrusted",
      readinessState: "not_checked",
      browserAccessAllowed: false,
      credentialAccessAllowed: false,
      reason: "deployment_commit_mismatch",
      actionRequired: "Deploy the expected merged commit.",
    },
    status: "denied",
    reason: "target_not_descendant",
    actionRequired: "Deploy a descendant of the active indexed commit.",
  })
}

class MemoryRefreshStore implements RefreshKnowledgeStore {
  readonly records = new Map<string, RefreshStoredRecord>()

  async save(record: RefreshStoredRecord): Promise<string> {
    const id = hashCanonical({
      kind: `refresh-${record.kind}`,
      value: record.value,
      version: 1,
    })
    const existing = this.records.get(id)
    if (
      existing !== undefined &&
      hashCanonical(existing) !== hashCanonical(record)
    ) {
      throw new Error("record conflict")
    }
    this.records.set(id, record)
    return id
  }

  async load(id: string): Promise<RefreshStoredRecord> {
    const record = this.records.get(id)
    if (record === undefined) throw new Error("missing record")
    return record
  }
}

function emptyInventory() {
  return refreshGraphInventorySchema.parse({
    schemaVersion: 1,
    id: hash("4"),
    applicationId,
    graphRevision: 4,
    indexedCommitSha: activeCommitSha,
    entities: [],
    links: [],
    immutableAssessments: [],
  })
}

function changeSet(path = "src/checkout.ts") {
  return refreshChangeSetSchema.parse({
    schemaVersion: 1,
    id: hash("5"),
    baseSha: activeCommitSha,
    targetSha: targetCommitSha,
    files: [
      {
        operation: "modified",
        oldPath: path,
        newPath: path,
        classifications: ["source"],
        contentHash: hash("6"),
      },
    ],
    complete: true,
    warnings: [],
  })
}

function nodeCounts() {
  return Object.fromEntries(
    entityKindValues.map((kind) => [kind, kind === "application" ? 1 : 0])
  )
}

function relationshipCounts() {
  return Object.fromEntries(
    evidenceRelationshipSchema.options.map((kind) => [kind, 0])
  )
}

function coverageCounts() {
  return Object.fromEntries(
    coverageStatusSchema.options.map((kind) => [kind, 0])
  )
}

function dependencies(
  input: {
    context?: RefreshContextValidation
    changedPath?: string
    abortDuringReindex?: AbortController
    failPublication?: boolean
    invalidRetention?: boolean
  } = {}
) {
  const store = new MemoryRefreshStore()
  let indexedCommit = activeCommitSha
  let runActive = true
  const compare = vi.fn(async () => changeSet(input.changedPath))
  const loadInventory = vi.fn(async () => emptyInventory())
  const reindex = vi.fn(
    async ({
      plan,
    }: Parameters<
      RefreshKnowledgeDependencies["sourceMaps"]["reindex"]
    >[0]) => {
      input.abortDuringReindex?.abort(new CancelledOrchestrationError())
      return refreshSourceMapResultSchema.parse({
        schemaVersion: 1,
        id: hash("7"),
        planId: plan.id,
        targetCommitSha,
        indexedPaths: [
          ...plan.sourceScope.typeScriptPaths,
          ...plan.sourceScope.phpPaths,
          ...plan.sourceScope.openApiPaths,
          ...plan.sourceScope.documentationPaths,
        ].sort(),
        removedEntityIds: [],
        nodeIds: [],
        linkIds: [],
        evidenceIds: [],
        unresolvedPaths: [],
        warnings: [],
      })
    }
  )
  const execute = vi.fn(
    async (
      mission: Parameters<
        RefreshKnowledgeDependencies["specialists"]["execute"]
      >[0]
    ) =>
      refreshMissionReceiptSchema.parse({
        schemaVersion: 1,
        missionId: mission.id,
        agent: mission.agent,
        resultId: hashCanonical({ missionId: mission.id }),
        status: "succeeded",
        factIds: [],
        linkIds: [],
        evidenceIds: [],
        warnings: [],
        budgetUsed: noBudget,
      })
  )
  const reconcile = vi.fn(
    async ({
      start: source,
      plan,
      sourceMap,
      missionReceipts,
    }: Parameters<RefreshKnowledgeDependencies["curator"]["reconcile"]>[0]) => {
      const publication = graphPublicationInputSchema.parse({
        schemaVersion: 1,
        applicationId,
        runId,
        inputFingerprint: source.inputFingerprint,
        indexedCommitSha: targetCommitSha,
        expectedGraphRevision: 4,
        graphRevision: 5,
        replacement: {
          kind: "affected",
          stableKeys: plan.replacementStableKeys,
        },
        nodes: [
          {
            kind: "application",
            fact: {
              id: applicationId,
              applicationId,
              name: "Shop",
              indexedCommitSha: targetCommitSha,
            },
            extractionMethod: "source_reference",
            evidenceTier: "A",
            evidenceIds: [],
            provenance: { sourceKind: "system", observedAt: timestamp },
            reviewState: "not_required",
          },
        ],
        links: [],
        evidence: [],
        retainedEvidenceIds: plan.retainedEvidenceIds,
        batchSize: 250,
      })
      return refreshReconciliationSchema.parse({
        schemaVersion: 1,
        id: hash("8"),
        planId: plan.id,
        sourceMapResultId: sourceMap.id,
        missionResultIds: missionReceipts
          .map(({ resultId }) => resultId)
          .sort(),
        publication,
        coverageReassessedRequirementIds: plan.reassessRequirementIds,
        retainedArtifactIds: plan.retainedArtifactIds,
        unresolved: [],
        warnings: [],
      })
    }
  )
  const retain = vi.fn(
    async (
      request: Parameters<
        RefreshKnowledgeDependencies["retention"]["retain"]
      >[0]
    ) =>
      refreshRetentionReceiptSchema.parse({
        schemaVersion: 1,
        id: hash("a"),
        planId: request.planId,
        assessmentIds: input.invalidRetention
          ? ["33333333-3333-4333-8333-333333333333"]
          : request.assessmentIds,
        evidenceIds: request.evidenceIds,
        artifactIds: request.artifactIds,
        retainedAt: timestamp,
      })
  )
  const publish = vi.fn(
    async (
      publication: Parameters<
        RefreshKnowledgeDependencies["publisher"]["publish"]
      >[0]
    ) => {
      if (input.failPublication) throw new Error("publication failed")
      indexedCommit = targetCommitSha
      runActive = false
      return graphPublicationSummarySchema.parse({
        schemaVersion: 1,
        applicationId,
        runId,
        inputFingerprint: publication.inputFingerprint,
        indexedCommitSha: targetCommitSha,
        expectedGraphRevision: 4,
        graphRevision: 5,
        publicationHash: hash("9"),
        replacementKind: "affected",
        nodeCounts: nodeCounts(),
        relationshipCounts: relationshipCounts(),
        coverageCounts: coverageCounts(),
        evidenceTierCounts: { A: 0, B: 0, C: 0 },
        nodeCount: 1,
        relationshipCount: 0,
        retainedEvidenceCount: publication.retainedEvidenceIds.length,
        publishedAt: timestamp,
      })
    }
  )
  const result: RefreshKnowledgeDependencies = {
    owner: "worker-1",
    control: {
      assertActive: vi.fn(async () => {
        if (!runActive) throw new CancelledOrchestrationError()
      }),
    },
    events: { append: vi.fn(async () => undefined) },
    effects: { execute: vi.fn(async () => undefined) },
    resumeAuthorization: { authorize: vi.fn(async () => true) },
    resumeCoordinator: new InMemoryResumeCoordinator(),
    ...(input.abortDuringReindex === undefined
      ? {}
      : { executionSignal: () => input.abortDuringReindex!.signal }),
    now: () => new Date(timestamp),
    store,
    context: { validate: vi.fn(async () => input.context ?? readyContext()) },
    changes: { compare },
    inventory: { load: loadInventory },
    sourceMaps: { reindex },
    specialists: { execute },
    curator: { reconcile },
    retention: { retain },
    publisher: { publish },
  }
  return {
    result,
    store,
    calls: {
      compare,
      loadInventory,
      reindex,
      execute,
      reconcile,
      retain,
      publish,
    },
    indexedCommit: () => indexedCommit,
  }
}

describe("refreshKnowledgeGraph", () => {
  it("reindexes, dispatches only the relevant specialist, reconciles, and publishes", async () => {
    const fixture = dependencies()
    const { service } = createRefreshKnowledge({
      dependencies: fixture.result,
      checkpointer: new MemorySaver(),
    })

    const result = await service.start(start)

    expect(result.status).toBe("completed")
    expect(result.summary.freshness).toBe("current")
    expect(result.summary.targetCommitSha).toBe(targetCommitSha)
    expect(result.summary.specialistMissionCount).toBe(1)
    expect(fixture.calls.execute).toHaveBeenCalledTimes(1)
    expect(fixture.calls.execute.mock.calls[0]?.[0].agent).toBe("code")
    expect(fixture.calls.retain).toHaveBeenCalledTimes(1)
    expect(fixture.calls.publish).toHaveBeenCalledTimes(1)
    expect(fixture.indexedCommit()).toBe(targetCommitSha)
  })

  it("advances an unrelated commit without specialist calls or fact reprocessing", async () => {
    const fixture = dependencies({ changedPath: "README.txt" })
    const { service } = createRefreshKnowledge({
      dependencies: fixture.result,
      checkpointer: new MemorySaver(),
    })

    const result = await service.start(start)

    expect(result.status).toBe("completed")
    expect(result.summary.affectedEntityCount).toBe(0)
    expect(result.summary.specialistMissionCount).toBe(0)
    expect(fixture.calls.execute).not.toHaveBeenCalled()
    expect(fixture.calls.reindex).not.toHaveBeenCalled()
    expect(fixture.calls.publish).toHaveBeenCalledTimes(1)
  })

  it("returns the compiled success result after publication terminalizes the run", async () => {
    const fixture = dependencies()
    const { service } = createRefreshKnowledge({
      dependencies: fixture.result,
      checkpointer: new MemorySaver(),
    })
    const compiled = createRefreshKnowledgeCompiledRunGraph({
      service,
      resolver: { resolve: vi.fn(async () => start) },
    })
    const assertActive = vi.fn(async () => {
      if (assertActive.mock.calls.length > 1) {
        throw new Error("run already terminalized")
      }
    })

    const result = await compiled.start(
      {
        runId: "11111111-1111-4111-8111-111111111111",
        applicationId: "22222222-2222-4222-8222-222222222222",
        budget,
        payload: {},
        configurationFingerprint: hash("b"),
      },
      {
        signal: new AbortController().signal,
        assertActive,
        registerCleanup: vi.fn(),
      }
    )

    expect(result.status).toBe("succeeded")
    expect(assertActive).toHaveBeenCalledTimes(1)
  })

  it("denies a deployment mismatch before comparison and leaves freshness unchanged", async () => {
    const fixture = dependencies({ context: deniedContext() })
    const { service } = createRefreshKnowledge({
      dependencies: fixture.result,
      checkpointer: new MemorySaver(),
    })

    const result = await service.start(start)

    expect(result.status).toBe("denied")
    expect(result.summary.freshness).toBe("unchanged")
    expect(fixture.calls.compare).not.toHaveBeenCalled()
    expect(fixture.calls.reindex).not.toHaveBeenCalled()
    expect(fixture.calls.publish).not.toHaveBeenCalled()
    expect(fixture.indexedCommit()).toBe(activeCommitSha)
  })

  it("does not publish or advance the indexed commit after cancellation", async () => {
    const abort = new AbortController()
    const fixture = dependencies({ abortDuringReindex: abort })
    const { service } = createRefreshKnowledge({
      dependencies: fixture.result,
      checkpointer: new MemorySaver(),
    })

    await expect(service.start(start)).rejects.toBeInstanceOf(
      CancelledOrchestrationError
    )
    expect(fixture.calls.publish).not.toHaveBeenCalled()
    expect(fixture.indexedCommit()).toBe(activeCommitSha)
  })

  it("does not emit a successful refresh or advance freshness when publication fails", async () => {
    const fixture = dependencies({ failPublication: true })
    const { service } = createRefreshKnowledge({
      dependencies: fixture.result,
      checkpointer: new MemorySaver(),
    })

    await expect(service.start(start)).rejects.toBeInstanceOf(
      SanitizedNodeError
    )
    expect(fixture.indexedCommit()).toBe(activeCommitSha)
    expect(
      [...fixture.store.records.values()].some(({ kind }) => kind === "summary")
    ).toBe(false)
  })

  it("refuses publication when immutable retention does not match the plan", async () => {
    const fixture = dependencies({ invalidRetention: true })
    const { service } = createRefreshKnowledge({
      dependencies: fixture.result,
      checkpointer: new MemorySaver(),
    })

    await expect(service.start(start)).rejects.toBeInstanceOf(
      SanitizedNodeError
    )
    expect(fixture.calls.retain).toHaveBeenCalledTimes(1)
    expect(fixture.calls.publish).not.toHaveBeenCalled()
    expect(fixture.indexedCommit()).toBe(activeCommitSha)
  })
})

describe("DefaultRefreshContextPort", () => {
  it("requires the current graph, descendant ancestry, and trusted target deployment", async () => {
    const port = new DefaultRefreshContextPort({
      deployment: { validate: vi.fn(async () => readyContext().deployment) },
      activeGraph: {
        current: vi.fn(async () => ({
          indexedCommitSha: activeCommitSha,
          graphRevision: 4,
        })),
      },
      commits: { relationship: vi.fn(async () => "descendant" as const) },
      now: () => new Date(timestamp),
    })

    const result = await port.validate(start)

    expect(result.status).toBe("ready")
    expect(result.reason).toBe("refresh_ready")
    expect(result.id).toBe(
      hashCanonical({
        kind: "refresh-context-validation",
        version: 1,
        ...Object.fromEntries(
          Object.entries(result).filter(([key]) => key !== "id")
        ),
      })
    )
  })

  it("denies an untrusted target deployment while preserving the active baseline", async () => {
    const port = new DefaultRefreshContextPort({
      deployment: { validate: vi.fn(async () => deniedContext().deployment) },
      activeGraph: {
        current: vi.fn(async () => ({
          indexedCommitSha: activeCommitSha,
          graphRevision: 4,
        })),
      },
      commits: { relationship: vi.fn(async () => "descendant" as const) },
      now: () => new Date(timestamp),
    })

    const result = await port.validate(start)

    expect(result.status).toBe("denied")
    expect(result.reason).toBe("deployment_not_ready")
    expect(result.activeGraphMatches).toBe(true)
  })
})
