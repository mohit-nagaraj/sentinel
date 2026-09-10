import {
  applicationIdSchema,
  apiEndpointIdSchema,
  codeSymbolIdSchema,
  codeMissionResultSchema,
  commitShaSchema,
  evidenceCuratorResultSchema,
  evidenceIdSchema,
  graphEvidencePathSchema,
  hashCanonical,
  parsePrDiffAnalysis,
  prInvestigationStartInputSchema,
  runIdSchema,
  stableEntityIdSchema,
  type BaselineCompatibility,
  type CodeExplorerMission,
  type GraphEvidencePath,
  type MissionBudget,
  type PrDiffAnalysis,
  type PrInvestigationResult,
} from "@sentinel/contracts"
import { MemorySaver } from "@langchain/langgraph"
import { describe, expect, it, vi } from "vitest"

import {
  InMemoryPrInvestigationStore,
  type PrInvestigationStore,
} from "./pr-investigation-support.ts"
import {
  createPrInvestigation,
  createPrInvestigationCompiledRunGraph,
  type PrInvestigationDependencies,
} from "./pr-investigation.ts"

type BaselineCompatibilityStatus = BaselineCompatibility["status"]

const applicationId = applicationIdSchema.parse(
  `application:v1:${"a".repeat(64)}`
)
const pullRequestId = stableEntityIdSchema.parse(
  `pull-request:v1:${"b".repeat(64)}`
)
const symbolA = codeSymbolIdSchema.parse(`code-symbol:v1:${"c".repeat(64)}`)
const symbolB = codeSymbolIdSchema.parse(`code-symbol:v1:${"d".repeat(64)}`)
const endpointId = apiEndpointIdSchema.parse(
  `api-endpoint:v1:${"e".repeat(64)}`
)
const uiId = stableEntityIdSchema.parse(`ui-element:v1:${"f".repeat(64)}`)
const stepId = stableEntityIdSchema.parse(`flow-step:v1:${"1".repeat(64)}`)
const workflowId = stableEntityIdSchema.parse(`workflow:v1:${"2".repeat(64)}`)
const requirementId = stableEntityIdSchema.parse(
  `requirement:v1:${"3".repeat(64)}`
)
const baseSha = commitShaSchema.parse("1".repeat(40))
const headSha = commitShaSchema.parse("2".repeat(40))
const graphSha = commitShaSchema.parse("0".repeat(40))
const runId = runIdSchema.parse("run:00000000-0000-4000-8000-000000000027")
const analyzedAt = "2026-09-09T06:00:00.000Z"
const assessmentId = "00000000-0000-4000-8000-000000000027"
const zeroBudget = {
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
} as const
const budget = {
  toolCalls: 40,
  contentBytes: 100_000,
  documentBytes: 0,
  documentPages: 0,
  documentSections: 0,
  sourceLines: 10_000,
  repositoryBytes: 1_000_000,
  repositoryFiles: 100,
  browserActions: 0,
  modelCalls: 10,
  modelInputTokens: 20_000,
  modelOutputTokens: 5_000,
  reconciliationRounds: 3,
  elapsedMs: 60_000,
} as const

function contentHash(character: string) {
  return `sha256:${character.repeat(64)}`
}

function symbolRecord(id: string, path: string, ordinal: number) {
  const base = {
    id,
    filePath: path,
    qualifiedName: `Feature${ordinal}.run`,
    name: "run",
    kind: "method",
    language: "typescript" as const,
    range: { startLine: 10, endLine: 20 },
    parentSymbolIds: [],
    contentHash: contentHash(String(ordinal + 3)),
  }
  return {
    operation: "modified" as const,
    base,
    head: { ...base, contentHash: contentHash(String(ordinal + 5)) },
    baseRanges: [{ startLine: 15, endLine: 15 }],
    headRanges: [{ startLine: 15, endLine: 16 }],
    matchStrategy: "same_structure" as const,
    unresolvedReasons: [],
  }
}

function makeAnalysis(
  status: BaselineCompatibilityStatus = "exact"
): PrDiffAnalysis {
  const selectedGraphSha = status === "exact" ? baseSha : graphSha
  const compatibility = {
    exact: {
      assessmentAllowed: true,
      reason: "graph_matches_pr_base" as const,
      relevantInterveningPaths: [],
    },
    safe_ancestor_warning: {
      assessmentAllowed: true,
      reason: "ancestor_without_relevant_changes" as const,
      relevantInterveningPaths: [],
    },
    stale_relevant: {
      assessmentAllowed: false,
      reason: "ancestor_with_relevant_changes" as const,
      relevantInterveningPaths: ["src/feature-a.ts"],
    },
    unrelated_or_unknown: {
      assessmentAllowed: false,
      reason: "baseline_not_ancestor_of_pr_base" as const,
      relevantInterveningPaths: [],
    },
  }[status]
  const provenance = {
    pullRequestId,
    baseSha,
    headSha,
    diffHash: contentHash("9"),
  }
  const symbols = [
    { ...symbolRecord(symbolA, "src/feature-a.ts", 0), provenance },
    { ...symbolRecord(symbolB, "src/feature-b.ts", 1), provenance },
  ]
  const files = symbols.map((symbol) => ({
    operation: "modified" as const,
    oldPath: symbol.base.filePath,
    newPath: symbol.head.filePath,
    language: "typescript" as const,
    classifications: ["source" as const],
    baseRanges: symbol.baseRanges,
    headRanges: symbol.headRanges,
    binary: false,
    noNewlineAtEnd: false,
    mappingStatus: "mapped" as const,
    baseSymbolIds: [symbol.base.id],
    headSymbolIds: [symbol.head.id],
    unresolvedReasons: [],
    provenance,
  }))
  return parsePrDiffAnalysis({
    schemaVersion: 1,
    pullRequestId,
    repository: { host: "github.com", owner: "Sentinel", name: "Demo" },
    baseSha,
    headSha,
    diffHash: provenance.diffHash,
    ancestry: "base_is_ancestor",
    baseline: {
      status,
      graphCommitSha: selectedGraphSha,
      baseSha,
      ...compatibility,
    },
    files,
    symbols,
    summary: {
      fileCount: files.length,
      symbolCount: symbols.length,
      mappedFileCount: files.length,
      unmappedFileCount: 0,
    },
  })
}

function start(status: BaselineCompatibilityStatus = "exact") {
  return prInvestigationStartInputSchema.parse({
    schemaVersion: 1,
    assessmentId,
    runId,
    applicationId,
    pullRequest: {
      schemaVersion: 1,
      id: pullRequestId,
      applicationId,
      repository: { host: "github.com", owner: "sentinel", name: "demo" },
      number: 27,
      title: "Investigate order flow",
      baseSha,
      headSha,
      analyzedAt,
    },
    graphRevision: 3,
    graphCommitSha: status === "exact" ? baseSha : graphSha,
    repositoryPaths: ["src"],
    budget,
    startedAtMs: new Date(analyzedAt).getTime(),
  })
}

function entity(id: string, kind: string, title: string) {
  return {
    id,
    kind,
    title,
    evidenceTier: "A" as const,
    evidenceIds: [],
    provenance: { sourceKind: "system" as const, observedAt: analyzedAt },
    reviewState: "not_required" as const,
    graphRevision: 3,
  }
}

function evidencePath(symbolId: string, ordinal: number): GraphEvidencePath {
  const relationshipTypes = [
    "HANDLED_BY",
    "TRIGGERS_API",
    "ACTS_ON",
    "HAS_STEP",
    "COVERED_BY",
  ] as const
  const nodes = [
    entity(symbolId, "code-symbol", `Feature ${ordinal}`),
    entity(endpointId, "api-endpoint", "POST /orders"),
    entity(uiId, "ui-element", "Submit order"),
    entity(stepId, "flow-step", "Submit attendee details"),
    entity(workflowId, "workflow", "Attendee checkout"),
    entity(requirementId, "requirement", "Create an order"),
  ]
  const relationships = relationshipTypes.map((type, index) => {
    const id = evidenceIdSchema.parse(
      `evidence:v1:${String(ordinal + index + 4).repeat(64)}`
    )
    return {
      id,
      type,
      fromId: nodes[index]!.id,
      toId: nodes[index + 1]!.id,
      evidenceTier: "A" as const,
      extractionMethod: "validated_fixture",
      evidenceIds: [id],
      evidence: [
        {
          evidenceId: id,
          extractionMethod: "validated_fixture",
          provenance: { sourceKind: "system" as const, observedAt: analyzedAt },
        },
      ],
      reviewState: "not_required" as const,
      graphRevision: 3,
    }
  })
  return graphEvidencePathSchema.parse({ nodes, relationships })
}

function curatorResult(
  evidenceStateId: string,
  budgetUsed: MissionBudget = zeroBudget,
  noProgress = false
) {
  const matrix = {
    schemaVersion: 1,
    applicationId,
    runId,
    evidenceStateId,
    evidenceFingerprint: hashCanonical({ evidenceStateId, kind: "matrix" }),
    gaps: [],
    stats: {
      entityCount: 7,
      confidentLinkCount: 5,
      requirementCount: 1,
      workflowCount: 1,
      endpointCount: 1,
      codeSymbolCount: 2,
      gapCount: 0,
      humanGapCount: 0,
    },
    readiness: noProgress ? "needs_reconciliation" : "ready",
    publicationReady: !noProgress,
  }
  return evidenceCuratorResultSchema.parse({
    schemaVersion: 1,
    applicationId,
    runId,
    status: noProgress ? "unresolved" : "complete",
    stopReason: noProgress
      ? "no_material_evidence_gain"
      : "evidence_sufficient",
    roundsUsed: noProgress ? 1 : 0,
    budgetUsed,
    matrix,
    missionReceipts: [],
    missionRejections: [],
    reviews: [],
  })
}

interface HarnessOptions {
  readonly baselineStatus?: BaselineCompatibilityStatus
  readonly publish?: "published" | "superseded"
  readonly failGraphOnce?: boolean
  readonly supersedeAtCurrentCheck?: number
  readonly curatorOverBudget?: boolean
  readonly curatorNoProgress?: boolean
  readonly baselineGraphCurrent?: boolean
  readonly deploymentAvailable?: boolean
  readonly reconcileOverlay?: boolean
  readonly firstPathOnly?: boolean
  readonly sharedGroup?: boolean
  readonly baselineExpiresAtCheck?: number
}

function harness(options: HarnessOptions = {}) {
  const store: PrInvestigationStore = new InMemoryPrInvestigationStore()
  const events: {
    readonly event: { readonly kind?: string }
    readonly options?: { readonly idempotencyKey?: string }
  }[] = []
  const codeCalls: CodeExplorerMission[] = []
  const published: PrInvestigationResult[] = []
  const overlayModes: string[] = []
  let graphCalls = 0
  let currentChecks = 0
  let baselineChecks = 0
  let failGraph = options.failGraphOnce === true
  const selectedAnalysis = makeAnalysis(options.baselineStatus)
  const dependencies: PrInvestigationDependencies = {
    owner: "test-worker",
    control: { assertActive: async () => undefined },
    events: {
      append: async (event, eventOptions) =>
        void events.push({
          event,
          ...(eventOptions === undefined ? {} : { options: eventOptions }),
        }),
    },
    effects: { execute: async () => undefined },
    resumeAuthorization: { authorize: async () => true },
    resumeCoordinator: { runExclusive: async (_input, work) => work() },
    store,
    diff: {
      analyze: async () => ({
        analysis: selectedAnalysis,
        hints: options.sharedGroup
          ? [
              {
                symbolId: symbolA,
                endpointIds: [endpointId],
                domainEntityIds: [],
              },
              {
                symbolId: symbolB,
                endpointIds: [endpointId],
                domainEntityIds: [],
              },
            ]
          : [],
      }),
    },
    currentHead: {
      isCurrent: async () => {
        currentChecks += 1
        return (
          options.supersedeAtCurrentCheck === undefined ||
          currentChecks < options.supersedeAtCurrentCheck
        )
      },
    },
    baselineGraph: {
      isCurrent: async () => {
        baselineChecks += 1
        return (
          options.baselineGraphCurrent !== false &&
          (options.baselineExpiresAtCheck === undefined ||
            baselineChecks < options.baselineExpiresAtCheck)
        )
      },
    },
    code: {
      investigate: async (mission) => {
        codeCalls.push(mission)
        if (mission.scope.repositoryPaths.includes("src/feature-a.ts")) {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        return codeMissionResultSchema.parse({
          schemaVersion: 1,
          missionId: mission.id,
          status: "complete",
          claims: [],
          paths: [],
          unresolved: [],
          unresolvedBoundaries: [],
          exclusions: [],
          suggestedFollowups: [],
          stopReason: { code: "complete", summary: "Investigation complete" },
          budgetUsed: zeroBudget,
          traversalHopsUsed: 0,
          resultItemsUsed: 0,
        })
      },
    },
    graph: {
      findPullRequestImpactPaths: async ({ seedIds }) => {
        graphCalls += 1
        if (failGraph) {
          failGraph = false
          throw new Error("fixture graph outage")
        }
        return seedIds
          .filter((id) => String(id).startsWith("code-symbol:v1:"))
          .slice(0, options.firstPathOnly ? 1 : 2)
          .map((id, index) => evidencePath(id, index))
      },
    },
    overlay: {
      stageAssessmentEvidence: async ({ mode }) => {
        overlayModes.push(mode)
        return {
          curatorEvidenceStateId: hashCanonical({
            kind: "overlay-state",
            mode,
          }),
          validatedClaimIds: [],
          rejectedClaimIds: [],
          conflictIds: [],
        }
      },
      loadReconciledAssessmentEvidence: async ({ originalOverlay }) =>
        options.reconcileOverlay !== true
          ? originalOverlay
          : {
              ...originalOverlay,
              id: hashCanonical({
                kind: "reconciled-overlay",
                originalOverlay,
              }),
              unknowns: [],
            },
    },
    curator: {
      reconcile: async ({ budget: remaining, evidenceStateId }) =>
        curatorResult(
          evidenceStateId,
          options.curatorOverBudget
            ? { ...zeroBudget, toolCalls: remaining.toolCalls + 1 }
            : zeroBudget,
          options.curatorNoProgress === true
        ),
    },
    deployment: {
      resolveTrustedHead: async ({ headSha: selectedHead }) =>
        options.deploymentAvailable === false
          ? null
          : {
              url: "https://preview.example.com/pr/27",
              headSha: commitShaSchema.parse(selectedHead),
              trust: "trusted_exact_head",
            },
    },
    publisher: {
      publishCurrent: async ({ result }) => {
        published.push(result)
        return options.publish ?? "published"
      },
    },
    now: () => new Date(analyzedAt),
  }
  const workflow = createPrInvestigation({
    dependencies,
    checkpointer: new MemorySaver(),
  })
  return {
    ...workflow,
    codeCalls,
    events,
    overlayModes,
    published,
    graphCalls: () => graphCalls,
    currentChecks: () => currentChecks,
  }
}

describe("PR investigation graph", () => {
  it("canonicalizes equivalent worker result ordering before storage", async () => {
    const store = new InMemoryPrInvestigationStore()
    const result = codeMissionResultSchema.parse({
      schemaVersion: 1,
      missionId: `mission:v1:${"9".repeat(64)}`,
      status: "complete",
      claims: [],
      paths: [],
      unresolved: [],
      unresolvedBoundaries: [],
      exclusions: ["Second exclusion", "First exclusion"],
      suggestedFollowups: [],
      stopReason: { code: "complete", summary: "Investigation complete" },
      budgetUsed: zeroBudget,
      traversalHopsUsed: 0,
      resultItemsUsed: 0,
    })

    await expect(store.saveCodeResult(result)).resolves.toBe(
      await store.saveCodeResult({
        ...result,
        exclusions: [...result.exclusions].reverse(),
      })
    )
  })

  it("runs the whole bounded graph and deterministically reduces parallel groups", async () => {
    const fixture = harness()
    const output = await fixture.service.start(start())

    expect(output.status).toBe("completed")
    expect(output.result).toMatchObject({
      status: "completed",
      baseline: { disposition: "proceed" },
    })
    expect(output.result?.groups).toHaveLength(2)
    expect(output.result?.workerReceipts).toHaveLength(2)
    expect(output.result?.workerReceipts.map(({ groupId }) => groupId)).toEqual(
      [...(output.result?.workerReceipts ?? [])]
        .map(({ groupId }) => groupId)
        .sort()
    )
    expect(
      output.result?.hypotheses.filter(({ status }) => status === "mapped")
    ).toHaveLength(2)
    expect(output.result?.verificationCandidates).toHaveLength(2)
    expect(output.result?.unknowns).toEqual([])
    expect(output.result?.id).toBe(
      "sha256:bc396087479af8a0b207f14c3b77a25b5a0a297401cf0406fd667413df189a23"
    )
    expect(fixture.codeCalls).toHaveLength(2)
    for (const mission of fixture.codeCalls) {
      expect(mission.questions[0]).toContain("code-symbol:v1:")
      expect(mission.scope.repositoryPaths).toEqual(["src"])
    }
    expect(fixture.overlayModes).toEqual(["assessment_only"])
    expect(fixture.published).toHaveLength(1)
    expect(fixture.events.length).toBeGreaterThan(5)
    const committedEvents = fixture.events.filter(
      ({ event }) => event.kind === "node_completed"
    )
    expect(committedEvents.length).toBeGreaterThan(0)
    expect(
      committedEvents.every(({ options }) =>
        options?.idempotencyKey?.startsWith("sha256:")
      )
    ).toBe(true)
  })

  it("continues with a warning for a safe ancestor baseline", async () => {
    const fixture = harness({ baselineStatus: "safe_ancestor_warning" })
    const output = await fixture.service.start(start("safe_ancestor_warning"))

    expect(output.status).toBe("completed")
    expect(output.result?.baseline).toMatchObject({
      disposition: "proceed_with_warning",
      action: "none",
    })
    expect(
      output.result?.hypotheses.filter(({ status }) => status === "mapped")
    ).toHaveLength(2)
    expect(output.result?.unknowns).toEqual([])
    expect(fixture.codeCalls).toHaveLength(2)
  })

  it.each([
    ["stale_relevant", "refresh_graph"],
    ["unrelated_or_unknown", "reconnect_baseline"],
  ] as const)(
    "publishes %s action-required without expensive investigation",
    async (baselineStatus, action) => {
      const fixture = harness({ baselineStatus })
      const output = await fixture.service.start(start(baselineStatus))

      expect(output.status).toBe("action_required")
      expect(output.result).toMatchObject({
        status: "action_required",
        baseline: { action },
        groups: [],
        workerReceipts: [],
      })
      expect(fixture.codeCalls).toHaveLength(0)
      expect(fixture.graphCalls()).toBe(0)
      expect(fixture.overlayModes).toHaveLength(0)
    }
  )

  it("does not mark a superseded head result current", async () => {
    const fixture = harness({ publish: "superseded" })
    const output = await fixture.service.start(start())

    expect(output.status).toBe("superseded")
    expect(fixture.published).toHaveLength(1)
    expect(output.state.status).toBe("superseded")
  })

  it("stops a superseded head before graph and Curator work", async () => {
    const fixture = harness({ supersedeAtCurrentCheck: 7 })

    await expect(fixture.service.start(start())).rejects.toThrow()
    expect(fixture.codeCalls).toHaveLength(2)
    expect(fixture.graphCalls()).toBe(0)
    expect(fixture.published).toHaveLength(0)
  })

  it("rejects Curator usage beyond the remaining global budget", async () => {
    const fixture = harness({ curatorOverBudget: true })

    await expect(fixture.service.start(start())).rejects.toThrow()
    expect(fixture.published).toHaveLength(0)
  })

  it("preserves a bounded Curator no-progress outcome", async () => {
    const fixture = harness({ curatorNoProgress: true })
    const output = await fixture.service.start(start())

    expect(output.status).toBe("completed")
    expect(output.result?.curatorResult).toMatchObject({
      status: "unresolved",
      stopReason: "no_material_evidence_gain",
    })
  })

  it("builds final hypotheses from the reconciled Curator overlay", async () => {
    const fixture = harness({ reconcileOverlay: true })
    const output = await fixture.service.start(start())

    expect(output.result?.unknowns).toEqual([])
    expect(
      output.result?.hypotheses.every(({ status }) => status === "mapped")
    ).toBe(true)
  })

  it("retains the unmapped symbol when only part of a group has a graph path", async () => {
    const fixture = harness({ firstPathOnly: true, sharedGroup: true })
    const output = await fixture.service.start(start())

    expect(output.result?.unknowns).toHaveLength(1)
    const mapped = new Set(
      output.result?.hypotheses
        .filter(({ status }) => status === "mapped")
        .flatMap(({ changedSymbolIds }) => changedSymbolIds) ?? []
    )
    const expectedMissing = [symbolA, symbolB].filter((id) => !mapped.has(id))
    expect(output.result?.unknowns[0]).toMatchObject({
      symbolIds: expectedMissing,
      unresolvedReasons: ["graph_path_missing"],
    })
  })

  it("rechecks graph ownership after workers and before the Neo4j read", async () => {
    const fixture = harness({ baselineExpiresAtCheck: 3 })

    await expect(fixture.service.start(start())).rejects.toThrow(
      "Orchestration run is cancelled"
    )
    expect(fixture.codeCalls).toHaveLength(2)
    expect(fixture.graphCalls()).toBe(0)
    expect(fixture.published).toHaveLength(0)
  })

  it("does not create verification missions without a trusted head deployment", async () => {
    const fixture = harness({ deploymentAvailable: false })
    const output = await fixture.service.start(start())

    expect(output.result?.verificationCandidates).toEqual([])
  })

  it("rejects a graph revision that is no longer the current baseline", async () => {
    const fixture = harness({ baselineGraphCurrent: false })

    await expect(fixture.service.start(start())).rejects.toThrow()
    expect(fixture.codeCalls).toHaveLength(0)
    expect(fixture.graphCalls()).toBe(0)
  })

  it("resumes after graph-query failure without repeating completed workers", async () => {
    const fixture = harness({ failGraphOnce: true })

    await expect(fixture.service.start(start())).rejects.toThrow()
    expect(fixture.codeCalls).toHaveLength(2)
    await expect(fixture.service.start(start())).resolves.toMatchObject({
      status: "completed",
    })
    expect(fixture.codeCalls).toHaveLength(2)
    expect(fixture.graphCalls()).toBe(2)
  })

  it("adapts assess_pr run commands to the compiled run-graph contract", async () => {
    const fixture = harness()
    const finalizeReport = vi.fn().mockResolvedValue("published" as const)
    const publishCheck = vi.fn().mockResolvedValue("published" as const)
    const compiled = createPrInvestigationCompiledRunGraph({
      service: fixture.service,
      resolver: { resolve: async () => start() },
      reports: { finalize: finalizeReport },
      checks: { publishCheck },
    })
    const graphInput = {
      runId: assessmentId,
      applicationId: "00000000-0000-4000-8000-000000000001",
      budget,
      payload: { pullRequestNumber: 27, baseSha, headSha },
      configurationFingerprint: contentHash("8"),
    }
    const context = {
      signal: new AbortController().signal,
      assertActive: async () => undefined,
      registerCleanup: () => undefined,
    }

    await expect(compiled.hasCheckpoint(graphInput)).resolves.toBe(false)
    await expect(compiled.start(graphInput, context)).resolves.toEqual({
      status: "succeeded",
      publication: { kind: "assessment", assessmentId },
    })
    expect(finalizeReport).toHaveBeenCalledWith(
      { investigation: expect.objectContaining({ status: "completed" }) },
      context.signal
    )
    expect(publishCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        assessmentId,
        headSha,
        lifecycle: expect.objectContaining({ state: "running" }),
      })
    )
    await expect(compiled.hasCheckpoint(graphInput)).resolves.toBe(true)
    await expect(
      compiled.hasPendingInterrupt(graphInput, "unused")
    ).resolves.toBe(false)
  })

  it("finalizes an action-required assessment report", async () => {
    const fixture = harness({ baselineStatus: "stale_relevant" })
    const finalizeReport = vi.fn().mockResolvedValue("published" as const)
    const compiled = createPrInvestigationCompiledRunGraph({
      service: fixture.service,
      resolver: { resolve: async () => start() },
      reports: { finalize: finalizeReport },
      checks: { publishCheck: async () => "published" },
    })
    const context = {
      signal: new AbortController().signal,
      assertActive: async () => undefined,
      registerCleanup: () => undefined,
    }

    await expect(
      compiled.start(
        {
          runId: assessmentId,
          applicationId: "00000000-0000-4000-8000-000000000001",
          budget,
          payload: { pullRequestNumber: 27, baseSha, headSha },
          configurationFingerprint: contentHash("8"),
        },
        context
      )
    ).resolves.toMatchObject({ status: "succeeded" })
    expect(finalizeReport).toHaveBeenCalledWith(
      { investigation: expect.objectContaining({ status: "action_required" }) },
      context.signal
    )
  })
})
