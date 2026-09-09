import {
  MAX_PR_INVESTIGATION_GROUPS,
  MAX_PR_INVESTIGATION_PATHS,
  MAX_PR_OVERLAY_CLAIMS,
  MAX_PR_GRAPH_QUERY_SEEDS,
  codeExplorerMissionSchema,
  codeMissionResultSchema,
  codeFileIdSchema,
  codeSymbolIdSchema,
  createMissionId,
  createStableKey,
  evidenceCuratorResultSchema,
  graphEvidencePathSchema,
  hashCanonical,
  missionBudgetSchema,
  prDiffAnalysisSchema,
  prImpactHypothesisSchema,
  prInvestigationChangeGroupSchema,
  prInvestigationGraphPathSchema,
  prInvestigationOverlaySchema,
  prInvestigationResultSchema,
  prInvestigationUnknownSchema,
  prVerificationMissionCandidateSchema,
  trustedHeadDeploymentSchema,
  type CodeMissionResult,
  type EvidenceCuratorResult,
  type GraphEvidencePath,
  type MissionBudget,
  type PrDiffAnalysis,
  type PrImpactHypothesis,
  type PrInvestigationChangeGroup,
  type PrInvestigationGraphPath,
  type PrInvestigationOverlay,
  type PrInvestigationResult,
  type PrInvestigationStartInput,
  type PrInvestigationUnknown,
  type PrVerificationMissionCandidate,
  type TrustedHeadDeployment,
} from "@sentinel/contracts"

export interface PrInvestigationPreparation {
  readonly groups: readonly PrInvestigationChangeGroup[]
  readonly unknowns: readonly PrInvestigationUnknown[]
}

export interface PrInvestigationStore {
  saveAnalysis(value: PrDiffAnalysis): Promise<string>
  loadAnalysis(id: string): Promise<PrDiffAnalysis>
  savePreparation(value: PrInvestigationPreparation): Promise<string>
  loadPreparation(id: string): Promise<PrInvestigationPreparation>
  saveCodeResult(value: CodeMissionResult): Promise<string>
  loadCodeResults(ids: readonly string[]): Promise<readonly CodeMissionResult[]>
  saveGraphPaths(value: readonly PrInvestigationGraphPath[]): Promise<string>
  loadGraphPaths(id: string): Promise<readonly PrInvestigationGraphPath[]>
  saveOverlay(value: PrInvestigationOverlay): Promise<string>
  loadOverlay(id: string): Promise<PrInvestigationOverlay>
  saveCuratorResult(value: EvidenceCuratorResult): Promise<string>
  loadCuratorResult(id: string): Promise<EvidenceCuratorResult>
  saveResult(value: PrInvestigationResult): Promise<string>
  loadResult(id: string): Promise<PrInvestigationResult>
}

type StoredKind =
  | "analysis"
  | "preparation"
  | "code-result"
  | "graph-paths"
  | "overlay"
  | "curator-result"
  | "result"

export class InMemoryPrInvestigationStore implements PrInvestigationStore {
  private readonly values = new Map<
    string,
    { kind: StoredKind; value: unknown }
  >()

  private async save(kind: StoredKind, value: unknown): Promise<string> {
    const id = hashCanonical({ kind, value, version: 1 })
    const existing = this.values.get(id)
    if (
      existing !== undefined &&
      (existing.kind !== kind ||
        hashCanonical(existing.value) !== hashCanonical(value))
    ) {
      throw new Error("Conflicting PR investigation store replay")
    }
    this.values.set(id, { kind, value: structuredClone(value) })
    return id
  }

  private load(id: string, kind: StoredKind): unknown {
    const stored = this.values.get(id)
    if (stored === undefined || stored.kind !== kind) {
      throw new Error(`Stored PR investigation ${kind} is missing`)
    }
    return structuredClone(stored.value)
  }

  saveAnalysis(value: PrDiffAnalysis) {
    return this.save("analysis", prDiffAnalysisSchema.parse(value))
  }

  async loadAnalysis(id: string) {
    return prDiffAnalysisSchema.parse(this.load(id, "analysis"))
  }

  savePreparation(value: PrInvestigationPreparation) {
    const groups = value.groups.map((group) =>
      prInvestigationChangeGroupSchema.parse(group)
    )
    const unknowns = value.unknowns.map((item) =>
      prInvestigationUnknownSchema.parse(item)
    )
    return this.save("preparation", { groups, unknowns })
  }

  async loadPreparation(id: string): Promise<PrInvestigationPreparation> {
    const value = this.load(id, "preparation") as PrInvestigationPreparation
    return {
      groups: value.groups,
      unknowns: value.unknowns.map((item) =>
        prInvestigationUnknownSchema.parse(item)
      ),
    }
  }

  saveCodeResult(value: CodeMissionResult) {
    const canonical = canonicalizeCodeMissionResult(value)
    return this.save("code-result", canonical)
  }

  async loadCodeResults(ids: readonly string[]) {
    return ids.map((id) =>
      codeMissionResultSchema.parse(this.load(id, "code-result"))
    )
  }

  saveGraphPaths(value: readonly PrInvestigationGraphPath[]) {
    const parsed = value.map((path) =>
      prInvestigationGraphPathSchema.parse(path)
    )
    return this.save("graph-paths", parsed)
  }

  async loadGraphPaths(id: string) {
    const value = this.load(id, "graph-paths") as readonly unknown[]
    return value.map((path) => prInvestigationGraphPathSchema.parse(path))
  }

  saveOverlay(value: PrInvestigationOverlay) {
    return this.save("overlay", prInvestigationOverlaySchema.parse(value))
  }

  async loadOverlay(id: string) {
    return prInvestigationOverlaySchema.parse(this.load(id, "overlay"))
  }

  saveCuratorResult(value: EvidenceCuratorResult) {
    return this.save("curator-result", evidenceCuratorResultSchema.parse(value))
  }

  async loadCuratorResult(id: string) {
    return evidenceCuratorResultSchema.parse(this.load(id, "curator-result"))
  }

  saveResult(value: PrInvestigationResult) {
    return this.save("result", prInvestigationResultSchema.parse(value))
  }

  async loadResult(id: string) {
    return prInvestigationResultSchema.parse(this.load(id, "result"))
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings)
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function canonicalizeCodeMissionResult(
  input: CodeMissionResult
): CodeMissionResult {
  const result = codeMissionResultSchema.parse(input)
  const claims = result.claims
    .map((claim) => ({
      ...claim,
      evidenceIds: sortedUnique(claim.evidenceIds),
      evidence: [...claim.evidence].sort((left, right) =>
        compareStrings(left.evidenceId, right.evidenceId)
      ),
    }))
    .sort((left, right) => compareStrings(left.id, right.id))
  const paths = result.paths
    .map((path) => ({
      ...path,
      edges: path.edges.map((edge) => ({
        ...edge,
        evidenceIds: sortedUnique(edge.evidenceIds),
      })),
    }))
    .sort((left, right) => compareStrings(left.key, right.key))
  const unresolved = result.unresolved
    .map((item) => ({ ...item, evidenceIds: sortedUnique(item.evidenceIds) }))
    .sort((left, right) =>
      compareStrings(hashCanonical(left), hashCanonical(right))
    )
  const unresolvedBoundaries = result.unresolvedBoundaries
    .map((item) => ({ ...item, evidenceIds: sortedUnique(item.evidenceIds) }))
    .sort((left, right) =>
      compareStrings(hashCanonical(left), hashCanonical(right))
    )
  const suggestedFollowups = result.suggestedFollowups
    .map((mission) => ({
      ...mission,
      seedEvidenceIds: sortedUnique(mission.seedEvidenceIds),
      questions: sortedUnique(mission.questions),
      successCriteria: sortedUnique(mission.successCriteria),
      scope: {
        ...mission.scope,
        repositoryPaths: sortedUnique(mission.scope.repositoryPaths),
        sourceUris: sortedUnique(mission.scope.sourceUris),
        allowedHosts: sortedUnique(mission.scope.allowedHosts),
        allowedTools: sortedUnique(mission.scope.allowedTools),
        ...(mission.scope.languages === undefined
          ? {}
          : { languages: sortedUnique(mission.scope.languages) }),
      },
    }))
    .sort((left, right) => compareStrings(left.id, right.id))
  return codeMissionResultSchema.parse({
    ...result,
    claims,
    paths,
    unresolved,
    unresolvedBoundaries,
    exclusions: sortedUnique(result.exclusions),
    suggestedFollowups,
  })
}

export function createCodeMissionResultId(input: CodeMissionResult): string {
  return hashCanonical({
    kind: "code-result",
    value: canonicalizeCodeMissionResult(input),
    version: 1,
  })
}

export function addMissionBudgets(
  left: MissionBudget,
  right: MissionBudget
): MissionBudget {
  return missionBudgetSchema.parse(
    Object.fromEntries(
      Object.keys(left).map((key) => [
        key,
        left[key as keyof MissionBudget] + right[key as keyof MissionBudget],
      ])
    )
  )
}

export function subtractMissionBudgets(
  limit: MissionBudget,
  used: MissionBudget
): MissionBudget {
  return missionBudgetSchema.parse(
    Object.fromEntries(
      Object.keys(limit).map((key) => [
        key,
        Math.max(
          0,
          limit[key as keyof MissionBudget] - used[key as keyof MissionBudget]
        ),
      ])
    )
  )
}

export function splitMissionBudget(
  budget: MissionBudget,
  countValue: number
): MissionBudget {
  const count = Math.max(1, Math.floor(countValue))
  return missionBudgetSchema.parse(
    Object.fromEntries(
      Object.entries(budget).map(([key, value]) => [
        key,
        key === "elapsedMs" ? value : Math.floor(value / count),
      ])
    )
  )
}

export function createPrChangeInvestigationMission(input: {
  readonly start: PrInvestigationStartInput
  readonly group: PrInvestigationChangeGroup
  readonly budget: MissionBudget
}) {
  const missionId = createMissionId({
    applicationId: input.start.applicationId,
    runId: input.start.runId,
    agent: "code",
    mode: "pr_change_investigation",
    ordinal: Number.parseInt(input.group.id.slice("sha256:".length, 12), 16),
  })
  return codeExplorerMissionSchema.parse({
    schemaVersion: 1,
    id: missionId,
    runId: input.start.runId,
    applicationId: input.start.applicationId,
    agent: "code",
    mode: "pr_change_investigation",
    goal: "Trace the implementation consequences of one related changed-symbol group",
    seedEvidenceIds: [],
    questions: [
      `Changed symbol IDs: ${input.group.symbolIds.join(", ")}`,
      "Which callers, callees, endpoints, tests, and domain relationships are affected?",
      "Which implementation boundaries remain unresolved after bounded traversal?",
    ],
    scope: {
      repositoryPaths: input.start.repositoryPaths,
      allowedHosts: [],
      sourceUris: [],
      allowedTools: [
        "list_repository_modules",
        "search_symbols",
        "search_code_text",
        "inspect_symbol",
        "find_definition",
        "find_references",
        "trace_callers",
        "trace_callees",
        "find_endpoint_handler",
        "find_frontend_callers",
        "inspect_tests",
        "submit_code_claim",
        "finish_code_mission",
      ],
    },
    budget: input.budget,
    successCriteria: [
      "Every proposed relationship cites structural repository evidence",
      "Unresolved dynamic or unmapped boundaries remain explicit",
    ],
  })
}

function resultUnknowns(input: {
  readonly start: PrInvestigationStartInput
  readonly groups: readonly PrInvestigationChangeGroup[]
  readonly results: readonly CodeMissionResult[]
  readonly graphPaths: readonly PrInvestigationGraphPath[]
}): PrInvestigationUnknown[] {
  const resultsByMission = new Map(
    input.results.map((result) => [result.missionId, result])
  )
  const mappedSymbols = new Set(
    input.graphPaths.flatMap(({ changedSymbolIds }) => changedSymbolIds)
  )
  return input.groups.flatMap((group) => {
    const expectedMissionId = createMissionId({
      applicationId: input.start.applicationId,
      runId: input.start.runId,
      agent: "code",
      mode: "pr_change_investigation",
      ordinal: Number.parseInt(group.id.slice("sha256:".length, 12), 16),
    })
    const result = resultsByMission.get(expectedMissionId)
    const unknownFor = (
      symbolIds: readonly string[],
      unresolvedReasons: readonly string[],
      summary: string
    ) => {
      const draft = {
        schemaVersion: 1,
        kind: "symbol" as const,
        filePaths: group.filePaths,
        symbolIds,
        classifications: [],
        unresolvedReasons: sortedUnique(unresolvedReasons),
        summary,
      }
      return prInvestigationUnknownSchema.parse({
        ...draft,
        id: hashCanonical({
          identityKind: "pr-investigation-unknown",
          ...draft,
        }),
      })
    }
    const unknowns: PrInvestigationUnknown[] = []
    const codeReasons = [
      ...(result !== undefined && result.status !== "complete"
        ? ["code_investigation_incomplete" as const]
        : []),
      ...(result !== undefined &&
      (result.unresolved.length > 0 || result.unresolvedBoundaries.length > 0)
        ? ["code_investigation_unresolved" as const]
        : []),
    ]
    if (codeReasons.length > 0) {
      unknowns.push(
        unknownFor(
          group.symbolIds,
          codeReasons,
          "Changed symbols retain unresolved Code Explorer boundaries"
        )
      )
    }
    const missingSymbols = group.symbolIds.filter(
      (symbolId) => !mappedSymbols.has(symbolId)
    )
    if (missingSymbols.length > 0) {
      unknowns.push(
        unknownFor(
          missingSymbols,
          ["graph_path_missing"],
          "Changed symbols have no current product evidence path"
        )
      )
    }
    return unknowns
  })
}

export function normalizeGraphPaths(input: {
  readonly seedSymbols: Readonly<Record<string, readonly string[]>>
  readonly paths: readonly GraphEvidencePath[]
}): PrInvestigationGraphPath[] {
  const normalized = input.paths.map((pathValue) => {
    const path = graphEvidencePathSchema.parse(pathValue)
    const pathChanged = sortedUnique(input.seedSymbols[path.nodes[0]!.id] ?? [])
    if (pathChanged.length === 0) {
      throw new Error("PR graph path is not seeded by a changed symbol")
    }
    return prInvestigationGraphPathSchema.parse({
      id: hashCanonical({ kind: "pr-graph-path", path, version: 1 }),
      changedSymbolIds: pathChanged,
      path,
    })
  })
  const deduplicated = new Map<string, PrInvestigationGraphPath>()
  for (const path of normalized) {
    const existing = deduplicated.get(path.id)
    if (
      existing !== undefined &&
      hashCanonical(existing) !== hashCanonical(path)
    ) {
      throw new Error("Conflicting normalized PR graph path")
    }
    deduplicated.set(path.id, path)
  }
  return [...deduplicated.values()]
    .sort((left, right) => compareStrings(left.id, right.id))
    .slice(0, MAX_PR_INVESTIGATION_PATHS)
}

export function createPrGraphSeedMap(input: {
  readonly start: PrInvestigationStartInput
  readonly groups: readonly PrInvestigationChangeGroup[]
  readonly analysis: PrDiffAnalysis
}): Readonly<Record<string, readonly string[]>> {
  const seeds = new Map<string, { rank: number; symbolIds: Set<string> }>()
  const add = (seedId: string, symbolIds: readonly string[], rank: number) => {
    const current = seeds.get(seedId) ?? { rank, symbolIds: new Set<string>() }
    current.rank = Math.min(current.rank, rank)
    symbolIds.forEach((symbolId) => current.symbolIds.add(symbolId))
    seeds.set(seedId, current)
  }
  const groupBySymbolId = new Map(
    input.groups.flatMap((group) =>
      group.symbolIds.map((symbolId) => [symbolId, group] as const)
    )
  )
  for (const symbol of input.analysis.symbols) {
    const knownIds = [symbol.base?.id, symbol.head?.id].filter(
      (id) => id !== undefined
    )
    const group = knownIds
      .map((id) => groupBySymbolId.get(id))
      .find((candidate) => candidate !== undefined)
    if (group === undefined || symbol.base === undefined) continue
    const baselineSymbolId = codeSymbolIdSchema.parse(
      createStableKey({
        kind: "code-symbol",
        applicationId: input.start.applicationId,
        repository: input.start.pullRequest.repository,
        commitSha: input.start.graphCommitSha,
        filePath: symbol.base.filePath,
        qualifiedName: symbol.base.qualifiedName,
        symbolKind: symbol.base.kind,
      })
    )
    add(
      baselineSymbolId,
      knownIds.filter((id) => group.symbolIds.includes(id)),
      0
    )
  }
  for (const group of input.groups) {
    group.endpointIds.forEach((endpointId) =>
      add(endpointId, group.symbolIds, 1)
    )
    group.domainEntityIds.forEach((domainEntityId) =>
      add(domainEntityId, group.symbolIds, 2)
    )
    for (const path of group.filePaths) {
      const fileId = codeFileIdSchema.parse(
        createStableKey({
          kind: "code-file",
          applicationId: input.start.applicationId,
          repository: input.start.pullRequest.repository,
          commitSha: input.start.graphCommitSha,
          path,
        })
      )
      add(fileId, group.symbolIds, 3)
    }
    group.symbolIds.forEach((symbolId) => add(symbolId, [symbolId], 4))
  }
  return Object.fromEntries(
    [...seeds.entries()]
      .sort(
        ([leftId, left], [rightId, right]) =>
          left.rank - right.rank || compareStrings(leftId, rightId)
      )
      .slice(0, MAX_PR_GRAPH_QUERY_SEEDS)
      .map(([seedId, { symbolIds }]) => [
        seedId,
        [...symbolIds].sort(compareStrings),
      ])
  )
}

export function buildPrInvestigationOverlay(input: {
  readonly start: PrInvestigationStartInput
  readonly diffAnalysisId: string
  readonly preparation: PrInvestigationPreparation
  readonly codeResultIds: readonly string[]
  readonly codeResults: readonly CodeMissionResult[]
  readonly graphPaths: readonly PrInvestigationGraphPath[]
  readonly curatorEvidenceStateId: string
  readonly validatedClaimIds: readonly string[]
  readonly rejectedClaimIds: readonly string[]
  readonly conflictIds: readonly string[]
}): PrInvestigationOverlay {
  const claims = new Map<string, CodeMissionResult["claims"][number]>()
  for (const claim of input.codeResults.flatMap(({ claims }) => claims)) {
    const existing = claims.get(claim.id)
    if (
      existing !== undefined &&
      hashCanonical(existing) !== hashCanonical(claim)
    ) {
      throw new Error("Conflicting Code Explorer claim in assessment overlay")
    }
    claims.set(claim.id, claim)
  }
  const unresolved = input.codeResults
    .flatMap(({ unresolvedBoundaries }) => unresolvedBoundaries)
    .sort((left, right) =>
      compareStrings(hashCanonical(left), hashCanonical(right))
    )
  const unknowns = [
    ...input.preparation.unknowns,
    ...resultUnknowns({
      start: input.start,
      groups: input.preparation.groups,
      results: input.codeResults,
      graphPaths: input.graphPaths,
    }),
  ]
  const referencedClaimIds = new Set([
    ...input.validatedClaimIds,
    ...input.rejectedClaimIds,
  ])
  const orderedClaims = [...claims.values()].sort((left, right) => {
    const leftReferenced = referencedClaimIds.has(left.id) ? 0 : 1
    const rightReferenced = referencedClaimIds.has(right.id) ? 0 : 1
    return leftReferenced - rightReferenced || compareStrings(left.id, right.id)
  })
  const draft = {
    schemaVersion: 1,
    mode: "assessment_only" as const,
    applicationId: input.start.applicationId,
    runId: input.start.runId,
    pullRequestId: input.start.pullRequest.id,
    graphRevision: input.start.graphRevision,
    graphCommitSha: input.start.graphCommitSha,
    diffAnalysisId: input.diffAnalysisId,
    codeResultIds: sortedUnique(input.codeResultIds),
    graphPaths: [...input.graphPaths].sort((left, right) =>
      compareStrings(left.id, right.id)
    ),
    proposedClaims: orderedClaims.slice(0, MAX_PR_OVERLAY_CLAIMS),
    validatedClaimIds: sortedUnique(input.validatedClaimIds),
    rejectedClaimIds: sortedUnique(input.rejectedClaimIds),
    conflictIds: sortedUnique(input.conflictIds),
    unresolvedBoundaries: unresolved,
    unknowns: [
      ...new Map(unknowns.map((item) => [item.id, item])).values(),
    ].sort((left, right) => compareStrings(left.id, right.id)),
    curatorEvidenceStateId: input.curatorEvidenceStateId,
  }
  return prInvestigationOverlaySchema.parse({
    ...draft,
    id: hashCanonical({ kind: "pr-assessment-overlay", version: 1, ...draft }),
  })
}

const affectedKinds = new Set([
  "requirement",
  "workflow",
  "screen",
  "ui-element",
])

export function buildPrImpactHypotheses(
  overlay: PrInvestigationOverlay
): PrImpactHypothesis[] {
  const mapped: PrImpactHypothesis[] = overlay.graphPaths.map((entry) => {
    const affectedEntityIds = sortedUnique(
      entry.path.nodes
        .filter(({ kind }) => affectedKinds.has(kind))
        .map(({ id }) => id)
    )
    const evidenceIds = sortedUnique(
      entry.path.relationships.flatMap(
        (relationship) => relationship.evidenceIds
      )
    )
    return prImpactHypothesisSchema.parse({
      schemaVersion: 1,
      id: hashCanonical({
        kind: "pr-impact-hypothesis",
        pathId: entry.id,
        changedSymbolIds: entry.changedSymbolIds,
        version: 1,
      }),
      status: "mapped",
      changedSymbolIds: entry.changedSymbolIds,
      affectedEntityIds,
      graphPathIds: [entry.id],
      evidenceIds,
      reasonCodes: ["active_graph_path"],
    })
  })
  const unknown = overlay.unknowns.map((item) =>
    prImpactHypothesisSchema.parse({
      schemaVersion: 1,
      id: hashCanonical({
        kind: "unknown-pr-impact",
        unknownId: item.id,
        version: 1,
      }),
      status: "unknown",
      changedSymbolIds: item.symbolIds,
      affectedEntityIds: [],
      graphPathIds: [],
      evidenceIds: [],
      reasonCodes: item.unresolvedReasons,
    })
  )
  return [
    ...new Map([...mapped, ...unknown].map((item) => [item.id, item])).values(),
  ].sort((left, right) => compareStrings(left.id, right.id))
}

export function buildVerificationCandidates(input: {
  readonly pullRequestHeadSha: string
  readonly deployment: TrustedHeadDeployment | null
  readonly hypotheses: readonly PrImpactHypothesis[]
}): PrVerificationMissionCandidate[] {
  if (input.deployment === null) return []
  const deployment = trustedHeadDeploymentSchema.parse(input.deployment)
  if (deployment.headSha !== input.pullRequestHeadSha) {
    throw new Error(
      "Trusted deployment does not match the investigated PR head"
    )
  }
  return input.hypotheses.flatMap((hypothesis) => {
    if (hypothesis.status !== "mapped") return []
    const workflowIds = hypothesis.affectedEntityIds.filter((id) =>
      String(id).startsWith("workflow:v1:")
    )
    if (workflowIds.length === 0) return []
    const requirementIds = hypothesis.affectedEntityIds.filter((id) =>
      String(id).startsWith("requirement:v1:")
    )
    const draft = {
      schemaVersion: 1,
      sourceHypothesisIds: [hypothesis.id],
      workflowIds,
      requirementIds,
      deployment,
      goal: "Validate the affected workflow against the trusted pull-request head deployment",
    }
    return [
      prVerificationMissionCandidateSchema.parse({
        ...draft,
        id: hashCanonical({
          kind: "pr-verification-candidate",
          version: 1,
          ...draft,
        }),
      }),
    ]
  })
}

export function assertStoreBounds(input: {
  readonly preparation: PrInvestigationPreparation
  readonly codeResults: readonly CodeMissionResult[]
}) {
  if (
    input.preparation.groups.length > MAX_PR_INVESTIGATION_GROUPS ||
    input.codeResults.length > MAX_PR_INVESTIGATION_GROUPS
  ) {
    throw new Error("PR investigation store value exceeds workflow bounds")
  }
}
