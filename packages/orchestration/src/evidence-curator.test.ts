import {
  coverageMatrixInputSchema,
  coverageEntitySchema,
  curatorMissionReceiptSchema,
  discoveryMissionSchema,
  evidenceLinkSchema,
  hashCanonical,
  missionBudgetSchema,
  missionResultSchema,
  pendingEvidenceLinkBatchSchema,
  type CoverageMatrixInput,
  type CuratorAgentPolicy,
  type CuratorModelRequest,
  type DiscoveryMission,
  type EvidenceLink,
  type MissionBudget,
  type MissionResult,
  type ReconciliationEvent,
} from "@sentinel/contracts"
import { MemorySaver } from "@langchain/langgraph"
import { describe, expect, it, vi } from "vitest"

import { buildCoverageMatrix } from "./coverage-matrix.ts"
import {
  EVIDENCE_CURATOR_GRAPH_NAME,
  InMemoryCuratorMissionResultStore,
  createCuratorMissionId,
  createCuratorSpecialistDispatcher,
  createEvidenceCurator,
  validateCuratorMissionProposals,
  type CuratorEvidenceStatePort,
  type CuratorModelPort,
} from "./evidence-curator.ts"
import { InMemoryResumeCoordinator } from "./resume-coordinator.ts"
import { CheckpointStateError } from "./runtime.ts"

const applicationId = entityId("application", "application")
const runId = "run:00000000-0000-4000-8000-000000000019"
const evidenceStateId = hashCanonical("evidence-state")
const capturedAt = "2026-09-09T10:00:00.000Z"

function entityId(kind: string, seed: string): string {
  return `${kind}:v1:${hashCanonical(seed).slice("sha256:".length)}`
}

function evidenceId(seed: string): string {
  return `evidence:v1:${hashCanonical(seed).slice("sha256:".length)}`
}

const zeroBudget: MissionBudget = missionBudgetSchema.parse({
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

const globalBudget: MissionBudget = missionBudgetSchema.parse({
  toolCalls: 20,
  contentBytes: 100_000,
  documentBytes: 100_000,
  documentPages: 20,
  documentSections: 100,
  sourceLines: 5_000,
  repositoryBytes: 2_000_000,
  repositoryFiles: 1_000,
  browserActions: 20,
  modelCalls: 10,
  modelInputTokens: 20_000,
  modelOutputTokens: 5_000,
  reconciliationRounds: 5,
  elapsedMs: 120_000,
})

const missionBudget: MissionBudget = missionBudgetSchema.parse({
  ...zeroBudget,
  toolCalls: 2,
  contentBytes: 1_000,
  sourceLines: 100,
  repositoryBytes: 10_000,
  repositoryFiles: 10,
  modelCalls: 2,
  modelInputTokens: 1_000,
  modelOutputTokens: 500,
  elapsedMs: 10_000,
})

const codePolicy: CuratorAgentPolicy = {
  agent: "code",
  modes: [
    "implementation_trace",
    "unmapped_endpoint_resolution",
    "pr_change_investigation",
  ],
  allowedRepositoryPaths: ["backend"],
  allowedSourceUris: [],
  allowedHosts: [],
  allowedTools: ["find_endpoint_handler", "find_definition"],
  maxMissionBudget: missionBudget,
  maxMissionsPerRound: 12,
}

const documentationPolicy: CuratorAgentPolicy = {
  agent: "documentation",
  modes: ["targeted_requirement_lookup", "conflict_resolution"],
  allowedRepositoryPaths: [],
  allowedSourceUris: ["https://docs.example.com"],
  allowedHosts: ["docs.example.com"],
  allowedTools: ["search_documentation", "read_document_section"],
  maxMissionBudget: missionBudget,
  maxMissionsPerRound: 4,
}

const applicationPolicy: CuratorAgentPolicy = {
  agent: "application",
  modes: ["workflow_discovery", "targeted_requirement_observation"],
  allowedRepositoryPaths: [],
  allowedSourceUris: ["https://app.example.com"],
  allowedHosts: ["app.example.com"],
  allowedTools: ["observe_page", "perform_observed_action"],
  maxMissionBudget: missionBudget,
  maxMissionsPerRound: 4,
}

const allPolicies = [codePolicy, documentationPolicy, applicationPolicy]

function entity(
  kind:
    | "requirement"
    | "workflow"
    | "flow-step"
    | "screen"
    | "ui-element"
    | "frontend-route"
    | "api-endpoint"
    | "code-symbol"
    | "pull-request",
  seed: string,
  options: { behavioral?: boolean; changed?: boolean } = {}
) {
  return coverageEntitySchema.parse({
    id: entityId(kind, seed),
    applicationId,
    kind,
    evidenceIds: [evidenceId(seed)],
    behavioral: options.behavioral ?? false,
    changed: options.changed ?? false,
  })
}

function link(
  relationship: EvidenceLink["relationship"],
  fromId: string,
  toId: string,
  seed: string
): EvidenceLink {
  return evidenceLinkSchema.parse({
    schemaVersion: 1,
    id: evidenceId(`link:${seed}`),
    applicationId,
    fromId,
    relationship,
    toId,
    extractionMethod: "fixture",
    evidenceTier: "A",
    explanation: `Fixture ${relationship}`,
    evidenceIds: [evidenceId(`proof:${seed}`)],
    reviewState: "not_required",
    graphRevision: 1,
    lastConfirmedAt: capturedAt,
  })
}

function emptyBatch() {
  const base = {
    schemaVersion: 1,
    applicationId,
    runId,
    graphRevision: 1,
    status: "pending",
    evidence: [],
    links: [],
    reviewCandidates: [],
    conflicts: [],
    rejections: [],
  }
  return pendingEvidenceLinkBatchSchema.parse({
    ...base,
    batchHash: hashCanonical(base),
  })
}

function source(
  overrides: Readonly<Record<string, unknown>> = {}
): CoverageMatrixInput {
  return coverageMatrixInputSchema.parse({
    schemaVersion: 1,
    applicationId,
    runId,
    evidenceStateId,
    entities: [],
    currentLinks: [],
    pendingBatch: emptyBatch(),
    staleEvidenceIds: [],
    reviewDecisions: [],
    ...overrides,
  })
}

function missionForGap(
  gap: ReturnType<typeof buildCoverageMatrix>["gaps"][number],
  ordinal = 0
): DiscoveryMission {
  const agent = gap.recommendedAgent
  const mode = gap.allowedModes[0]
  if (agent === undefined || mode === undefined) {
    throw new Error("Fixture gap is not actionable")
  }
  const policy = allPolicies.find((item) => item.agent === agent)
  if (policy === undefined) throw new Error("Missing fixture policy")
  const allowedTools = policy.allowedTools.slice(0, 1)
  const scope = {
    repositoryPaths: agent === "code" ? ["backend"] : [],
    sourceUris:
      agent === "documentation"
        ? ["https://docs.example.com/orders"]
        : agent === "application"
          ? ["https://app.example.com/checkout"]
          : [],
    allowedHosts:
      agent === "documentation"
        ? ["docs.example.com"]
        : agent === "application"
          ? ["app.example.com"]
          : [],
    allowedTools,
  }
  return discoveryMissionSchema.parse({
    schemaVersion: 1,
    id: createCuratorMissionId({
      applicationId,
      runId,
      gapId: gap.id,
      agent,
      mode,
    }),
    runId,
    applicationId,
    agent,
    mode,
    goal: `Resolve ${gap.kind} ${ordinal}`,
    seedEvidenceIds: gap.evidenceIds,
    questions: [`What evidence resolves ${gap.kind}?`],
    scope,
    budget: missionBudget,
    successCriteria: ["Return material cited evidence"],
  })
}

function missionResult(mission: DiscoveryMission): MissionResult {
  return missionResultSchema.parse({
    schemaVersion: 1,
    missionId: mission.id,
    status: "complete",
    claims: [],
    unresolved: [],
    exclusions: [],
    suggestedFollowups: [],
    stopReason: {
      code: "fixture_complete",
      summary: "Fixture mission complete",
    },
    budgetUsed: { ...zeroBudget, toolCalls: 1 },
  })
}

describe("buildCoverageMatrix", () => {
  it("classifies missing UI, endpoint handler, documented intent, changed path, conflict, and stale evidence", () => {
    const requirement = entity("requirement", "requirement")
    const workflow = entity("workflow", "workflow")
    const endpoint = entity("api-endpoint", "endpoint")
    const symbol = entity("code-symbol", "symbol", {
      behavioral: true,
      changed: true,
    })
    const conflictId = hashCanonical("conflict")
    const conflictBatch = {
      ...emptyBatch(),
      conflicts: [
        {
          id: conflictId,
          applicationId,
          fromId: symbol.id,
          relationship: "CALLS",
          toId: entityId("code-symbol", "other-symbol"),
          supportingClaimIds: [
            `claim:v1:${hashCanonical("support").slice("sha256:".length)}`,
          ],
          contradictingClaimIds: [
            `claim:v1:${hashCanonical("contradict").slice("sha256:".length)}`,
          ],
          evidenceIds: [evidenceId("support"), evidenceId("contradict")],
          status: "unresolved",
          reviewState: "pending",
          summary: "Conflicting call evidence",
        },
      ],
    }
    const matrix = buildCoverageMatrix(
      source({
        entities: [requirement, workflow, endpoint, symbol],
        pendingBatch: pendingEvidenceLinkBatchSchema.parse(conflictBatch),
        staleEvidenceIds: [endpoint.evidenceIds[0]!],
      })
    )

    const kinds = new Set(matrix.gaps.map(({ kind }) => kind))
    expect(kinds).toEqual(
      new Set([
        "requirement_without_workflow",
        "workflow_without_ui",
        "workflow_without_code",
        "endpoint_without_code",
        "code_without_intent",
        "changed_symbol_without_product_path",
        "conflict",
        "stale_evidence",
      ])
    )
    expect(
      matrix.gaps.find(({ kind }) => kind === "workflow_without_ui")
    ).toMatchObject({ recommendedAgent: "application" })
    expect(
      matrix.gaps.find(({ kind }) => kind === "endpoint_without_code")
    ).toMatchObject({ recommendedAgent: "code" })
    expect(
      matrix.gaps.find(({ kind }) => kind === "code_without_intent")
    ).toMatchObject({ recommendedAgent: "documentation" })
    expect(matrix.readiness).toBe("needs_human")
    expect(matrix.publicationReady).toBe(false)
  })

  it("ignores Tier D and accepts complete confident paths deterministically", () => {
    const requirement = entity("requirement", "complete-requirement")
    const workflow = entity("workflow", "complete-workflow")
    const step = entity("flow-step", "complete-step")
    const screen = entity("screen", "complete-screen")
    const element = entity("ui-element", "complete-element")
    const endpoint = entity("api-endpoint", "complete-endpoint")
    const symbol = entity("code-symbol", "complete-symbol", {
      behavioral: true,
    })
    const links = [
      link("COVERED_BY", requirement.id, workflow.id, "covered"),
      link("HAS_STEP", workflow.id, step.id, "step"),
      link("ON_SCREEN", step.id, screen.id, "screen"),
      link("ACTS_ON", step.id, element.id, "action"),
      link("TRIGGERS_API", element.id, endpoint.id, "request"),
      link("HANDLED_BY", endpoint.id, symbol.id, "handler"),
    ]
    const matrixInput = source({
      entities: [
        requirement,
        workflow,
        step,
        screen,
        element,
        endpoint,
        symbol,
      ],
      currentLinks: links,
    })
    const first = buildCoverageMatrix(matrixInput)
    const second = buildCoverageMatrix(matrixInput)

    expect(first).toStrictEqual(second)
    expect(first.gaps).toHaveLength(0)
    expect(first).toMatchObject({ readiness: "ready", publicationReady: true })
  })

  it("changes the evidence fingerprint when existing coverage is strengthened", () => {
    const endpoint = entity("api-endpoint", "strengthened-endpoint")
    const first = buildCoverageMatrix(source({ entities: [endpoint] }))
    const strengthened = coverageEntitySchema.parse({
      ...endpoint,
      evidenceIds: [...endpoint.evidenceIds, evidenceId("stronger-proof")],
    })
    const second = buildCoverageMatrix(
      source({
        evidenceStateId: hashCanonical("strengthened-state"),
        entities: [strengthened],
      })
    )

    expect(second.stats).toStrictEqual(first.stats)
    expect(second.evidenceFingerprint).not.toBe(first.evidenceFingerprint)
  })
})

describe("validateCuratorMissionProposals", () => {
  it("accepts golden App, Code, and Documentation missions", () => {
    const requirement = entity("requirement", "golden-requirement")
    const workflow = entity("workflow", "golden-workflow")
    const endpoint = entity("api-endpoint", "golden-endpoint")
    const symbol = entity("code-symbol", "golden-symbol", {
      behavioral: true,
    })
    const matrix = buildCoverageMatrix(
      source({ entities: [requirement, workflow, endpoint, symbol] })
    )
    const selectedKinds = new Set([
      "requirement_without_workflow",
      "endpoint_without_code",
      "code_without_intent",
    ])
    const proposals = matrix.gaps
      .filter(({ kind }) => selectedKinds.has(kind))
      .map((gap, index) => ({
        gapId: gap.id,
        mission: missionForGap(gap, index),
      }))
    const result = validateCuratorMissionProposals({
      round: 1,
      proposals,
      matrix,
      policies: allPolicies,
      remainingBudget: globalBudget,
      previousReceipts: [],
      priorMissionIds: [],
      maxRoundsReached: false,
    })

    expect(result.rejections).toHaveLength(0)
    expect(result.missions.map(({ mission }) => mission.agent).sort()).toEqual([
      "application",
      "code",
      "documentation",
    ])
  })

  it.each([
    ["unknown_gap", (mission: DiscoveryMission) => mission],
    [
      "tool_not_allowed",
      (mission: DiscoveryMission) => ({
        ...mission,
        scope: { ...mission.scope, allowedTools: ["write_neo4j"] },
      }),
    ],
    [
      "scope_not_allowed",
      (mission: DiscoveryMission) => ({
        ...mission,
        scope: { ...mission.scope, repositoryPaths: ["outside"] },
      }),
    ],
    [
      "mission_budget_exceeded",
      (mission: DiscoveryMission) => ({
        ...mission,
        budget: { ...mission.budget, toolCalls: 100 },
      }),
    ],
  ] as const)("rejects %s missions at the parent boundary", (code, mutate) => {
    const endpoint = entity("api-endpoint", `reject-${code}`)
    const matrix = buildCoverageMatrix(source({ entities: [endpoint] }))
    const gap = matrix.gaps[0]!
    const mission = mutate(missionForGap(gap))
    const proposal = {
      gapId: code === "unknown_gap" ? hashCanonical("unknown") : gap.id,
      mission,
    }
    const result = validateCuratorMissionProposals({
      round: 1,
      proposals: [proposal],
      matrix,
      policies: allPolicies,
      remainingBudget: globalBudget,
      previousReceipts: [],
      priorMissionIds: [],
      maxRoundsReached: false,
    })

    expect(result.missions).toHaveLength(0)
    expect(result.rejections[0]).toMatchObject({ code })
  })

  it("rejects arbitrary mission identities, duplicates, redundancy, and round overflow", () => {
    const endpoint = entity("api-endpoint", "stable-mission")
    const matrix = buildCoverageMatrix(source({ entities: [endpoint] }))
    const gap = matrix.gaps[0]!
    const stable = missionForGap(gap)
    const arbitrary = {
      ...stable,
      id: `mission:v1:${"f".repeat(64)}`,
    } as DiscoveryMission
    const arbitraryResult = validateCuratorMissionProposals({
      round: 1,
      proposals: [{ gapId: gap.id, mission: arbitrary }],
      matrix,
      policies: allPolicies,
      remainingBudget: globalBudget,
      previousReceipts: [],
      priorMissionIds: [],
      maxRoundsReached: false,
    })
    expect(arbitraryResult.rejections[0]).toMatchObject({
      code: "scope_not_allowed",
    })

    const duplicateResult = validateCuratorMissionProposals({
      round: 1,
      proposals: [{ gapId: gap.id, mission: stable }],
      matrix,
      policies: allPolicies,
      remainingBudget: globalBudget,
      previousReceipts: [],
      priorMissionIds: [stable.id],
      maxRoundsReached: false,
    })
    expect(duplicateResult.rejections[0]).toMatchObject({
      code: "duplicate_mission",
    })

    const priorReceipt = curatorMissionReceiptSchema.parse({
      schemaVersion: 1,
      round: 1,
      gapId: gap.id,
      missionId: stable.id,
      agent: stable.agent,
      mode: stable.mode,
      status: "complete",
      resultFingerprint: hashCanonical("result"),
      evidenceIds: [],
      budgetUsed: zeroBudget,
    })
    const redundantResult = validateCuratorMissionProposals({
      round: 1,
      proposals: [{ gapId: gap.id, mission: stable }],
      matrix,
      policies: allPolicies,
      remainingBudget: globalBudget,
      previousReceipts: [priorReceipt],
      priorMissionIds: [],
      maxRoundsReached: false,
    })
    expect(redundantResult.rejections[0]).toMatchObject({
      code: "redundant_mission",
    })

    const roundResult = validateCuratorMissionProposals({
      round: 1,
      proposals: [{ gapId: gap.id, mission: stable }],
      matrix,
      policies: allPolicies,
      remainingBudget: globalBudget,
      previousReceipts: [],
      priorMissionIds: [],
      maxRoundsReached: true,
    })
    expect(roundResult.rejections[0]).toMatchObject({
      code: "round_limit_exceeded",
    })
    expect(
      createCuratorMissionId({
        applicationId,
        runId,
        gapId: gap.id,
        agent: stable.agent,
        mode: stable.mode,
      })
    ).toBe(stable.id)
  })
})

function threeEndpointFixture() {
  const endpoints = [0, 1, 2].map((index) =>
    entity("api-endpoint", `parallel-endpoint-${index}`)
  )
  const symbols = [0, 1, 2].map((index) =>
    entity("code-symbol", `parallel-symbol-${index}`)
  )
  const initial = source({ entities: [...endpoints, ...symbols] })
  const completed = source({
    evidenceStateId: hashCanonical("completed-state"),
    entities: [...endpoints, ...symbols],
    currentLinks: endpoints.map((endpoint, index) =>
      link("HANDLED_BY", endpoint.id, symbols[index]!.id, `handler-${index}`)
    ),
  })
  return { initial, completed }
}

function scriptedModel(
  implementation?: (request: CuratorModelRequest) => unknown
): CuratorModelPort & { propose: ReturnType<typeof vi.fn> } {
  return {
    propose: vi.fn(async (request: CuratorModelRequest) => ({
      output: implementation?.(request) ?? {
        schemaVersion: 1,
        missions: request.matrix.gaps
          .filter(({ requiresHuman }) => !requiresHuman)
          .map((gap, index) => ({
            gapId: gap.id,
            mission: missionForGap(gap, index),
          })),
      },
      inputTokens: 20,
      outputTokens: 10,
    })),
  }
}

function eventSink() {
  const events: ReconciliationEvent[] = []
  return {
    events,
    sink: {
      append: vi.fn(async (event: ReconciliationEvent) => {
        events.push(event)
      }),
    },
  }
}

describe("Evidence Curator graph", () => {
  it("fans independent missions out in parallel and merges without lost results", async () => {
    const fixture = threeEndpointFixture()
    let active = 0
    let maxActive = 0
    const handler = async (mission: DiscoveryMission) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active -= 1
      return missionResult(mission)
    }
    const dispatcher = createCuratorSpecialistDispatcher({
      documentation: handler,
      code: handler,
      application: handler,
    })
    const appliedInputs: Parameters<
      CuratorEvidenceStatePort["applyMissionResults"]
    >[0][] = []
    const applyMissionResults = vi.fn(
      async (
        input: Parameters<CuratorEvidenceStatePort["applyMissionResults"]>[0]
      ) => {
        appliedInputs.push(input)
        return fixture.completed
      }
    )
    const evidenceState: CuratorEvidenceStatePort = {
      load: vi.fn(async () => fixture.initial),
      applyMissionResults,
      applyReview: vi.fn(async () => fixture.completed),
    }
    const events = eventSink()
    const { service } = createEvidenceCurator({
      dependencies: {
        resumeCoordinator: new InMemoryResumeCoordinator(),
        model: scriptedModel(),
        dispatcher,
        resultStore: new InMemoryCuratorMissionResultStore(),
        evidenceState,
        events: events.sink,
        policies: allPolicies,
        now: () => new Date(capturedAt),
      },
      checkpointer: new MemorySaver(),
    })

    const result = await service.start({
      applicationId,
      runId,
      evidenceStateId,
      budget: globalBudget,
    })

    expect(result.status).toBe("completed")
    expect(result.result).toMatchObject({
      status: "complete",
      stopReason: "evidence_sufficient",
      roundsUsed: 1,
    })
    expect(result.result?.missionReceipts).toHaveLength(3)
    expect(maxActive).toBeGreaterThan(1)
    expect(applyMissionResults).toHaveBeenCalledOnce()
    const applied = appliedInputs[0]
    expect(applied?.missions).toHaveLength(3)
    expect(applied?.results).toHaveLength(3)
    expect(new Set(applied?.results.map(({ missionId }) => missionId))).toEqual(
      new Set(applied?.missions.map(({ id }) => id))
    )
    expect(new Set(events.events.map(({ kind }) => kind))).toEqual(
      expect.objectContaining({
        has: expect.any(Function),
      })
    )
    for (const kind of [
      "coverage_built",
      "mission_proposed",
      "mission_dispatched",
      "mission_completed",
      "evidence_relinked",
      "reconciliation_stopped",
    ] as const) {
      expect(events.events.some((event) => event.kind === kind)).toBe(true)
    }
  })

  it("stops without model calls when the matrix is complete", async () => {
    const model = scriptedModel()
    const complete = source()
    const events = eventSink()
    const dispatcher = createCuratorSpecialistDispatcher({
      documentation: async (mission) => missionResult(mission),
      code: async (mission) => missionResult(mission),
      application: async (mission) => missionResult(mission),
    })
    const { service } = createEvidenceCurator({
      dependencies: {
        resumeCoordinator: new InMemoryResumeCoordinator(),
        model,
        dispatcher,
        resultStore: new InMemoryCuratorMissionResultStore(),
        evidenceState: {
          load: async () => complete,
          applyMissionResults: async () => complete,
          applyReview: async () => complete,
        },
        events: events.sink,
        policies: allPolicies,
        now: () => new Date(capturedAt),
      },
      checkpointer: new MemorySaver(),
    })

    const result = await service.start({
      applicationId,
      runId,
      evidenceStateId,
      budget: globalBudget,
    })

    expect(result.result).toMatchObject({
      status: "complete",
      stopReason: "evidence_sufficient",
      roundsUsed: 0,
    })
    expect(model.propose).not.toHaveBeenCalled()
  })

  it("retries post-commit event reporting without rebuilding the matrix", async () => {
    const complete = source()
    const load = vi.fn(async () => complete)
    const attemptedCoverageIds: string[] = []
    const persisted = new Map<string, ReconciliationEvent>()
    let failCoverageEvent = true
    const dispatcher = createCuratorSpecialistDispatcher({
      documentation: async (mission) => missionResult(mission),
      code: async (mission) => missionResult(mission),
      application: async (mission) => missionResult(mission),
    })
    const { graph, service } = createEvidenceCurator({
      dependencies: {
        resumeCoordinator: new InMemoryResumeCoordinator(),
        model: scriptedModel(),
        dispatcher,
        resultStore: new InMemoryCuratorMissionResultStore(),
        evidenceState: {
          load,
          applyMissionResults: async () => complete,
          applyReview: async () => complete,
        },
        events: {
          append: vi.fn(async (event: ReconciliationEvent) => {
            if (event.kind === "coverage_built") {
              attemptedCoverageIds.push(event.id)
              if (failCoverageEvent) {
                failCoverageEvent = false
                throw new Error("planned event sink failure")
              }
            }
            persisted.set(event.id, event)
          }),
        },
        policies: allPolicies,
        now: () => new Date(capturedAt),
      },
      checkpointer: new MemorySaver(),
    })

    await expect(
      service.start({
        applicationId,
        runId,
        evidenceStateId,
        budget: globalBudget,
      })
    ).rejects.toThrow("planned event sink failure")
    const snapshot = await graph.getState({
      configurable: {
        thread_id: `${runId}:${EVIDENCE_CURATOR_GRAPH_NAME}`,
      },
    })
    expect(snapshot.next).toEqual(["report_matrix"])
    expect(snapshot.values).toMatchObject({
      matrix: { publicationReady: true },
    })

    const recovered = await service.continue(runId)
    expect(recovered.result).toMatchObject({
      status: "complete",
      stopReason: "evidence_sufficient",
    })
    expect(load).toHaveBeenCalledOnce()
    expect(attemptedCoverageIds).toHaveLength(2)
    expect(new Set(attemptedCoverageIds).size).toBe(1)
    expect(
      [...persisted.values()].filter(({ kind }) => kind === "coverage_built")
    ).toHaveLength(1)
  })

  it("serializes duplicate starts and rejects conflicting start state", async () => {
    const complete = source()
    const load = vi.fn(async () => complete)
    const dispatcher = createCuratorSpecialistDispatcher({
      documentation: async (mission) => missionResult(mission),
      code: async (mission) => missionResult(mission),
      application: async (mission) => missionResult(mission),
    })
    const events = eventSink()
    const { service } = createEvidenceCurator({
      dependencies: {
        resumeCoordinator: new InMemoryResumeCoordinator(),
        model: scriptedModel(),
        dispatcher,
        resultStore: new InMemoryCuratorMissionResultStore(),
        evidenceState: {
          load,
          applyMissionResults: async () => complete,
          applyReview: async () => complete,
        },
        events: events.sink,
        policies: allPolicies,
        now: () => new Date(capturedAt),
      },
      checkpointer: new MemorySaver(),
    })
    const start = {
      applicationId,
      runId,
      evidenceStateId,
      budget: globalBudget,
    }

    const [first, duplicate] = await Promise.all([
      service.start(start),
      service.start(start),
    ])
    expect(first.result).toStrictEqual(duplicate.result)
    expect(load).toHaveBeenCalledOnce()

    await expect(
      service.start({
        ...start,
        evidenceStateId: hashCanonical("conflicting-start"),
      })
    ).rejects.toBeInstanceOf(CheckpointStateError)
  })

  it.each([
    ["no_material_evidence_gain", { maxRounds: 3, maxNoProgressRounds: 1 }],
    ["maximum_rounds_reached", { maxRounds: 1, maxNoProgressRounds: 10 }],
  ] as const)(
    "terminates with %s and explicit unresolved coverage",
    async (stopReason, options) => {
      const endpoint = entity("api-endpoint", `stop-${stopReason}`)
      const unchanged = source({ entities: [endpoint] })
      const dispatcher = createCuratorSpecialistDispatcher({
        documentation: async (mission) => missionResult(mission),
        code: async (mission) => missionResult(mission),
        application: async (mission) => missionResult(mission),
      })
      const events = eventSink()
      const { service } = createEvidenceCurator({
        dependencies: {
          resumeCoordinator: new InMemoryResumeCoordinator(),
          model: scriptedModel(),
          dispatcher,
          resultStore: new InMemoryCuratorMissionResultStore(),
          evidenceState: {
            load: async () => unchanged,
            applyMissionResults: async () => unchanged,
            applyReview: async () => unchanged,
          },
          events: events.sink,
          policies: allPolicies,
          now: () => new Date(capturedAt),
        },
        checkpointer: new MemorySaver(),
        options,
      })

      const result = await service.start({
        applicationId,
        runId,
        evidenceStateId,
        budget: globalBudget,
      })

      expect(result.result).toMatchObject({ status: "unresolved", stopReason })
      expect(result.result?.matrix.gaps).not.toHaveLength(0)
    }
  )

  it("rejects a repeated mission without dispatching duplicate work", async () => {
    const endpoint = entity("api-endpoint", "repeated-mission")
    const unchanged = source({ entities: [endpoint] })
    const model = scriptedModel()
    const handler = vi.fn(async (mission: DiscoveryMission) =>
      missionResult(mission)
    )
    const dispatcher = createCuratorSpecialistDispatcher({
      documentation: handler,
      code: handler,
      application: handler,
    })
    const events = eventSink()
    const { service } = createEvidenceCurator({
      dependencies: {
        resumeCoordinator: new InMemoryResumeCoordinator(),
        model,
        dispatcher,
        resultStore: new InMemoryCuratorMissionResultStore(),
        evidenceState: {
          load: async () => unchanged,
          applyMissionResults: async () => unchanged,
          applyReview: async () => unchanged,
        },
        events: events.sink,
        policies: allPolicies,
        now: () => new Date(capturedAt),
      },
      checkpointer: new MemorySaver(),
      options: { maxRounds: 3, maxNoProgressRounds: 2 },
    })

    const result = await service.start({
      applicationId,
      runId,
      evidenceStateId,
      budget: globalBudget,
    })

    expect(result.result).toMatchObject({
      status: "unresolved",
      stopReason: "no_valid_missions",
      missionRejections: [
        expect.objectContaining({ code: "duplicate_mission" }),
      ],
    })
    expect(model.propose).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenCalledOnce()
  })

  it("terminates on global budget without calling the model", async () => {
    const endpoint = entity("api-endpoint", "budget-endpoint")
    const unresolved = source({ entities: [endpoint] })
    const model = scriptedModel()
    const dispatcher = createCuratorSpecialistDispatcher({
      documentation: async (mission) => missionResult(mission),
      code: async (mission) => missionResult(mission),
      application: async (mission) => missionResult(mission),
    })
    const events = eventSink()
    const { service } = createEvidenceCurator({
      dependencies: {
        resumeCoordinator: new InMemoryResumeCoordinator(),
        model,
        dispatcher,
        resultStore: new InMemoryCuratorMissionResultStore(),
        evidenceState: {
          load: async () => unresolved,
          applyMissionResults: async () => unresolved,
          applyReview: async () => unresolved,
        },
        events: events.sink,
        policies: allPolicies,
        now: () => new Date(capturedAt),
      },
      checkpointer: new MemorySaver(),
    })

    const result = await service.start({
      applicationId,
      runId,
      evidenceStateId,
      budget: zeroBudget,
    })

    expect(result.result).toMatchObject({
      status: "unresolved",
      stopReason: "global_budget_exhausted",
    })
    expect(model.propose).not.toHaveBeenCalled()
  })

  it.each([
    {
      approved: true,
      expectedStatus: "complete",
      expectedStopReason: "evidence_sufficient",
      expectedReviewStatus: "accepted",
    },
    {
      approved: false,
      expectedStatus: "unresolved",
      expectedStopReason: "human_review_rejected",
      expectedReviewStatus: "rejected",
    },
  ] as const)(
    "checkpoints and resumes a human gap as $expectedReviewStatus",
    async ({
      approved,
      expectedStatus,
      expectedStopReason,
      expectedReviewStatus,
    }) => {
      const symbol = entity("code-symbol", "conflict-symbol")
      const other = entity("code-symbol", "conflict-other")
      const conflictId = hashCanonical("human-conflict")
      const pendingBatch = {
        ...emptyBatch(),
        conflicts: [
          {
            id: conflictId,
            applicationId,
            fromId: symbol.id,
            relationship: "CALLS",
            toId: other.id,
            supportingClaimIds: [
              `claim:v1:${hashCanonical("human-support").slice("sha256:".length)}`,
            ],
            contradictingClaimIds: [
              `claim:v1:${hashCanonical("human-contradict").slice("sha256:".length)}`,
            ],
            evidenceIds: [
              evidenceId("human-support"),
              evidenceId("human-contradict"),
            ],
            status: "unresolved",
            reviewState: "pending",
            summary: "Human conflict",
          },
        ],
      }
      const parsedPendingBatch =
        pendingEvidenceLinkBatchSchema.parse(pendingBatch)
      const pending = source({
        entities: [symbol, other],
        pendingBatch: parsedPendingBatch,
      })
      const reviewed = source({
        entities: [symbol, other],
        pendingBatch: parsedPendingBatch,
        reviewDecisions: [
          {
            targetKind: "conflict",
            targetId: conflictId,
            approved,
            reason: "Reviewed evidence",
            actorId: "operator:1",
            decidedAt: capturedAt,
          },
        ],
      })
      const applyReview = vi.fn(async () => reviewed)
      const events = eventSink()
      const dispatcher = createCuratorSpecialistDispatcher({
        documentation: async (mission) => missionResult(mission),
        code: async (mission) => missionResult(mission),
        application: async (mission) => missionResult(mission),
      })
      const model = scriptedModel()
      const { service } = createEvidenceCurator({
        dependencies: {
          resumeCoordinator: new InMemoryResumeCoordinator(),
          model,
          dispatcher,
          resultStore: new InMemoryCuratorMissionResultStore(),
          evidenceState: {
            load: async () => pending,
            applyMissionResults: async () => pending,
            applyReview,
          },
          events: events.sink,
          policies: allPolicies,
          now: () => new Date(capturedAt),
        },
        checkpointer: new MemorySaver(),
      })

      const interrupted = await service.start({
        applicationId,
        runId,
        evidenceStateId,
        budget: globalBudget,
      })
      expect(interrupted.status).toBe("interrupted")
      expect(interrupted.interrupts).toHaveLength(1)
      const pendingInterrupt = interrupted.interrupts[0]!

      const resumed = await service.resume({
        runId,
        decisionId: pendingInterrupt.decisionId,
        actorId: "operator:1",
        approved,
        reason: "Reviewed evidence",
      })

      expect(resumed.status).toBe("completed")
      expect(resumed.result).toMatchObject({
        status: expectedStatus,
        stopReason: expectedStopReason,
      })
      expect(resumed.result?.reviews).toEqual([
        expect.objectContaining({
          status: expectedReviewStatus,
          actorId: "operator:1",
        }),
      ])
      expect(applyReview).toHaveBeenCalledOnce()
      expect(model.propose).not.toHaveBeenCalled()
      expect(
        events.events.some(({ kind }) => kind === "human_review_requested")
      ).toBe(true)
      expect(
        events.events.some(({ kind }) => kind === "human_review_resumed")
      ).toBe(true)
      const terminalEvent = events.events.find(
        ({ kind }) => kind === "reconciliation_stopped"
      )
      expect(terminalEvent?.summary).toBe(
        approved
          ? "Evidence matrix is ready for publication"
          : "Reconciliation stopped with explicit unresolved coverage"
      )
    }
  )

  it("fails closed on invalid structured Curator output", async () => {
    const endpoint = entity("api-endpoint", "invalid-output")
    const unresolved = source({ entities: [endpoint] })
    const model = scriptedModel(() => ({
      schemaVersion: 1,
      missions: [],
      writeGraph: true,
    }))
    const dispatcher = createCuratorSpecialistDispatcher({
      documentation: async (mission) => missionResult(mission),
      code: async (mission) => missionResult(mission),
      application: async (mission) => missionResult(mission),
    })
    const events = eventSink()
    const { service } = createEvidenceCurator({
      dependencies: {
        resumeCoordinator: new InMemoryResumeCoordinator(),
        model,
        dispatcher,
        resultStore: new InMemoryCuratorMissionResultStore(),
        evidenceState: {
          load: async () => unresolved,
          applyMissionResults: async () => unresolved,
          applyReview: async () => unresolved,
        },
        events: events.sink,
        policies: allPolicies,
        now: () => new Date(capturedAt),
      },
      checkpointer: new MemorySaver(),
    })

    const result = await service.start({
      applicationId,
      runId,
      evidenceStateId,
      budget: globalBudget,
    })

    expect(result.result).toMatchObject({
      status: "unresolved",
      stopReason: "no_valid_missions",
      missionRejections: [
        expect.objectContaining({ code: "model_output_invalid" }),
      ],
    })
  })
})
