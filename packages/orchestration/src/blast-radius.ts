import {
  BLAST_RADIUS_POLICY_VERSION,
  MAX_BLAST_RADIUS_CANDIDATES,
  blastRadiusRelationshipTypes,
  MAX_BLAST_RADIUS_CAVEATS,
  MAX_BLAST_RADIUS_FINDINGS,
  blastRadiusCandidatePathSchema,
  blastRadiusCaveatSchema,
  blastRadiusCriticalitySchema,
  blastRadiusEvidencePathSchema,
  blastRadiusFindingSchema,
  blastRadiusInputSchema,
  blastRadiusResultSchema,
  blastRadiusScenarioSchema,
  hashCanonical,
  prInvestigationOverlaySchema,
  prInvestigationResultSchema,
  stableEntityIdSchema,
  type BlastRadiusCandidatePath,
  type BlastRadiusCaveat,
  type BlastRadiusCaveatCode,
  type BlastRadiusCriticality,
  type BlastRadiusEvidencePath,
  type BlastRadiusFinding,
  type BlastRadiusInput,
  type BlastRadiusPathNode,
  type BlastRadiusPathRelationship,
  type BlastRadiusRiskFactor,
  type BlastRadiusResult,
  type BlastRadiusScenario,
  type BlastRadiusTargetKind,
  type GraphEvidencePath,
  type PrInvestigationOverlay,
  type PrInvestigationResult,
  type ApplicationId,
} from "@sentinel/contracts"

const targetKinds = new Set<BlastRadiusTargetKind>([
  "ui-element",
  "screen",
  "workflow",
  "requirement",
])
const allowedRelationshipTypes = new Set<string>(blastRadiusRelationshipTypes)

const riskOrder = { high: 0, medium: 1, low: 2, unknown: 3 } as const
const evidenceOrder = { A: 0, B: 1, C: 2, D: 3 } as const
const criticalityOrder = {
  critical: 0,
  important: 1,
  standard: 2,
  peripheral: 3,
} as const

function compareStrings(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareStrings)
}

function stableIds(values: readonly string[]) {
  return sortedUnique(values.map((value) => stableEntityIdSchema.parse(value)))
}

function targetKind(value: string): value is BlastRadiusTargetKind {
  return targetKinds.has(value as BlastRadiusTargetKind)
}

const caveatSummary: Record<BlastRadiusCaveatCode, string> = {
  foreign_application:
    "Candidate path crosses the selected application boundary",
  stale_revision: "Candidate path is stale for the selected graph revision",
  cycle_detected: "Candidate path revisits a graph entity",
  invalid_direction:
    "Candidate path violates the allowed product-impact direction",
  tier_d_evidence: "Candidate path contains unresolved Tier-D evidence",
  evidence_conflict: "Candidate path contains unresolved evidence conflicts",
  review_unresolved:
    "Candidate path contains evidence awaiting or denied review",
  disconnected_path:
    "Candidate path relationships do not connect adjacent nodes",
  depth_exceeded: "Candidate path exceeds the blast-radius depth policy",
  unsupported_target: "Candidate path ends at an unsupported impact target",
  no_product_path:
    "Changed implementation has no eligible product evidence path",
}

function caveat(input: {
  readonly code: BlastRadiusCaveatCode
  readonly candidate?: BlastRadiusCandidatePath
  readonly changedSymbolIds: readonly string[]
  readonly evidenceIds?: readonly string[]
  readonly conflictIds?: readonly string[]
}): BlastRadiusCaveat {
  const draft = {
    schemaVersion: 1,
    code: input.code,
    ...(input.candidate === undefined
      ? {}
      : { candidateId: input.candidate.id }),
    changedSymbolIds: sortedUnique(input.changedSymbolIds),
    evidenceIds: sortedUnique(input.evidenceIds ?? []).slice(0, 1_000),
    conflictIds: sortedUnique(input.conflictIds ?? []).slice(0, 100),
    summary: caveatSummary[input.code],
  }
  return blastRadiusCaveatSchema.parse({
    ...draft,
    id: hashCanonical({ kind: "blast-radius-caveat", version: 1, ...draft }),
  })
}

function relationshipEvidence(
  relationships: readonly BlastRadiusPathRelationship[]
): string[] {
  return sortedUnique(
    relationships.flatMap((relationship) => relationship.evidenceIds)
  )
}

function candidateCaveats(
  input: BlastRadiusInput,
  candidate: BlastRadiusCandidatePath
): BlastRadiusCaveat[] {
  const evidenceIds = relationshipEvidence(candidate.relationships)
  const conflicts = sortedUnique(
    candidate.relationships.flatMap(({ conflictIds }) => conflictIds)
  )
  const codes: BlastRadiusCaveatCode[] = []
  const allApplicationIds = [
    candidate.applicationId,
    ...candidate.nodes.map(({ applicationId }) => applicationId),
    ...candidate.relationships.map(({ applicationId }) => applicationId),
  ]
  if (allApplicationIds.some((id) => id !== input.applicationId)) {
    codes.push("foreign_application")
  }
  if (
    candidate.graphRevision !== input.graphRevision ||
    candidate.nodes.some(
      ({ graphRevision }) => graphRevision !== input.graphRevision
    ) ||
    candidate.relationships.some(
      ({ graphRevision, stale }) =>
        graphRevision !== input.graphRevision || stale
    )
  ) {
    codes.push("stale_revision")
  }
  if (candidate.relationships.length > 10) codes.push("depth_exceeded")
  if (
    new Set(candidate.nodes.map(({ id }) => id)).size !== candidate.nodes.length
  ) {
    codes.push("cycle_detected")
  }
  if (!targetKind(candidate.targetKind)) codes.push("unsupported_target")
  if (
    candidate.relationships.some((relationship, index) => {
      const current = candidate.nodes[index]?.id
      const next = candidate.nodes[index + 1]?.id
      return (
        current === undefined ||
        next === undefined ||
        !(
          (relationship.fromId === current && relationship.toId === next) ||
          (relationship.fromId === next && relationship.toId === current)
        )
      )
    })
  ) {
    codes.push("disconnected_path")
  }
  if (!validPathDirection(candidate)) codes.push("invalid_direction")
  if (
    candidate.nodes.some(({ evidenceTier }) => evidenceTier === "D") ||
    candidate.relationships.some(({ evidenceTier }) => evidenceTier === "D")
  ) {
    codes.push("tier_d_evidence")
  }
  if (conflicts.length > 0) codes.push("evidence_conflict")
  if (
    [...candidate.nodes, ...candidate.relationships].some(
      ({ evidenceTier, reviewState }) =>
        reviewState === "pending" ||
        reviewState === "rejected" ||
        (evidenceTier === "C" && reviewState !== "accepted")
    )
  ) {
    codes.push("review_unresolved")
  }
  return sortedUnique(codes).map((code) =>
    caveat({
      code: code as BlastRadiusCaveatCode,
      candidate,
      changedSymbolIds: candidate.changedSymbolIds,
      evidenceIds,
      conflictIds: conflicts,
    })
  )
}

function stage(kind: BlastRadiusPathNode["kind"]): number | undefined {
  if (
    kind === "code-symbol" ||
    kind === "code-file" ||
    kind === "domain-entity"
  ) {
    return 0
  }
  if (kind === "api-endpoint" || kind === "frontend-route") return 1
  if (kind === "ui-element" || kind === "screen") return 2
  if (kind === "flow-step") return 3
  if (kind === "workflow") return 4
  if (kind === "requirement") return 5
  return undefined
}

function directionOf(input: {
  readonly relationship: BlastRadiusPathRelationship
  readonly current: BlastRadiusPathNode
  readonly next: BlastRadiusPathNode
}): "forward" | "reverse" | "disconnected" {
  if (
    input.relationship.fromId === input.current.id &&
    input.relationship.toId === input.next.id
  ) {
    return "forward"
  }
  if (
    input.relationship.toId === input.current.id &&
    input.relationship.fromId === input.next.id
  ) {
    return "reverse"
  }
  return "disconnected"
}

function validStep(input: {
  readonly relationship: BlastRadiusPathRelationship
  readonly current: BlastRadiusPathNode
  readonly next: BlastRadiusPathNode
}): boolean {
  if (!allowedRelationshipTypes.has(input.relationship.type as never)) {
    return false
  }
  const direction = directionOf(input)
  if (direction === "disconnected") return false
  const currentStage = stage(input.current.kind)
  const nextStage = stage(input.next.kind)
  if (currentStage === undefined || nextStage === undefined) {
    return false
  }
  const pair = `${input.current.kind}:${input.next.kind}`
  switch (input.relationship.type) {
    case "CALLS":
      return pair === "code-symbol:code-symbol"
    case "READS":
    case "WRITES":
      return (
        pair === "code-symbol:domain-entity" ||
        pair === "domain-entity:code-symbol"
      )
    case "CALLS_API":
      return pair === "code-symbol:api-endpoint" && direction === "forward"
    case "HANDLED_BY":
      return (
        (pair === "code-symbol:api-endpoint" && direction === "reverse") ||
        (pair === "api-endpoint:code-symbol" && direction === "forward")
      )
    case "BINDS":
      return pair === "code-symbol:ui-element" && direction === "reverse"
    case "RENDERED_BY":
      return (
        (pair === "code-symbol:ui-element" || pair === "code-symbol:screen") &&
        direction === "reverse"
      )
    case "MATCHES_ROUTE":
      return pair === "frontend-route:screen" && direction === "reverse"
    case "TRIGGERS_API":
      return pair === "api-endpoint:ui-element" && direction === "reverse"
    case "CONTAINS":
      return pair === "screen:ui-element" || pair === "ui-element:screen"
    case "ACTS_ON":
      return pair === "ui-element:flow-step" && direction === "reverse"
    case "ON_SCREEN":
      return pair === "screen:flow-step" && direction === "reverse"
    case "NEXT":
      return pair === "flow-step:flow-step"
    case "HAS_STEP":
      return pair === "flow-step:workflow" && direction === "reverse"
    case "COVERED_BY":
      return pair === "workflow:requirement" && direction === "reverse"
    default:
      return false
  }
}

export function validPathDirection(
  candidate: BlastRadiusCandidatePath
): boolean {
  return candidate.relationships.every((relationship, index) => {
    const current = candidate.nodes[index]
    const next = candidate.nodes[index + 1]
    return current !== undefined && next !== undefined
      ? validStep({ relationship, current, next })
      : false
  })
}

function pathStrength(candidate: BlastRadiusCandidatePath): "A" | "B" | "C" {
  const tiers = [
    ...candidate.nodes.map(({ evidenceTier }) => evidenceTier),
    ...candidate.relationships.map(({ evidenceTier }) => evidenceTier),
  ]
  return tiers.includes("C") ? "C" : tiers.includes("B") ? "B" : "A"
}

function semanticPathKey(candidate: BlastRadiusCandidatePath): string {
  return hashCanonical({
    seedId: candidate.seedId,
    targetId: candidate.targetId,
    nodes: candidate.nodes.map(({ id }) => id),
    relationships: candidate.relationships.map(({ fromId, toId, type }) => ({
      fromId,
      toId,
      type,
    })),
  })
}

function mergeRelationship(
  left: BlastRadiusPathRelationship,
  right: BlastRadiusPathRelationship
): BlastRadiusPathRelationship {
  const strength =
    evidenceOrder[left.evidenceTier] <= evidenceOrder[right.evidenceTier]
      ? left.evidenceTier
      : right.evidenceTier
  return {
    ...left,
    evidenceTier: strength,
    evidenceIds: sortedUnique([
      ...left.evidenceIds,
      ...right.evidenceIds,
    ]).slice(0, 100),
    sourceUris: sortedUnique([...left.sourceUris, ...right.sourceUris]).slice(
      0,
      100
    ),
    artifactIds: sortedUnique([
      ...left.artifactIds,
      ...right.artifactIds,
    ]).slice(0, 100),
    provenance: [
      ...new Map(
        [...left.provenance, ...right.provenance].map((value) => [
          hashCanonical(value),
          value,
        ])
      ).values(),
    ]
      .sort((a, b) => compareStrings(hashCanonical(a), hashCanonical(b)))
      .slice(0, 100),
    conflictIds: sortedUnique([
      ...left.conflictIds,
      ...right.conflictIds,
    ]).slice(0, 100),
  }
}

function normalizeCandidates(input: BlastRadiusInput): {
  readonly paths: readonly BlastRadiusEvidencePath[]
  readonly caveats: readonly BlastRadiusCaveat[]
} {
  const groups = new Map<string, BlastRadiusCandidatePath[]>()
  const caveats: BlastRadiusCaveat[] = []
  for (const candidate of [...input.candidates].sort((a, b) =>
    compareStrings(a.id, b.id)
  )) {
    const rejected = candidateCaveats(input, candidate)
    caveats.push(...rejected)
    if (rejected.length > 0) continue
    const key = semanticPathKey(candidate)
    groups.set(key, [...(groups.get(key) ?? []), candidate])
  }

  const paths = [...groups.entries()].map(([semanticKey, candidates]) => {
    const ordered = candidates.sort((a, b) => compareStrings(a.id, b.id))
    const first = ordered[0]!
    const relationships = first.relationships.map((relationship, index) =>
      ordered
        .slice(1)
        .reduce(
          (merged, candidate) =>
            mergeRelationship(merged, candidate.relationships[index]!),
          relationship
        )
    )
    const draft = {
      schemaVersion: 1,
      semanticKey,
      applicationId: input.applicationId,
      graphRevision: input.graphRevision,
      seedId: first.seedId,
      targetId: first.targetId,
      targetKind: first.targetKind,
      changedSymbolIds: sortedUnique(
        ordered.flatMap(({ changedSymbolIds }) => changedSymbolIds)
      ),
      operations: sortedUnique(ordered.flatMap(({ operations }) => operations)),
      evidenceStrength: ordered
        .map(pathStrength)
        .sort((a, b) => evidenceOrder[a] - evidenceOrder[b])[0]!,
      candidateIds: ordered.map(({ id }) => id),
      evidenceIds: sortedUnique([
        ...ordered.flatMap(({ nodes }) =>
          nodes.flatMap(({ evidenceIds }) => evidenceIds)
        ),
        ...relationshipEvidence(relationships),
      ]).slice(0, 1_000),
      provenance: [
        ...new Map(
          ordered
            .flatMap(({ nodes, relationships }) => [
              ...nodes.map(({ provenance }) => provenance),
              ...relationships.flatMap(({ provenance }) => provenance),
            ])
            .map((value) => [hashCanonical(value), value])
        ).values(),
      ]
        .sort((a, b) => compareStrings(hashCanonical(a), hashCanonical(b)))
        .slice(0, 1_000),
      nodes: first.nodes,
      relationships,
    }
    return blastRadiusEvidencePathSchema.parse({
      ...draft,
      id: hashCanonical({
        kind: "blast-radius-evidence-path",
        version: 1,
        ...draft,
      }),
    })
  })
  return {
    paths: paths.sort((a, b) => compareStrings(a.id, b.id)),
    caveats: [...new Map(caveats.map((item) => [item.id, item])).values()].sort(
      (a, b) => compareStrings(a.id, b.id)
    ),
  }
}

function criticalityPoints(criticality: BlastRadiusCriticality): number {
  return { critical: 4, important: 3, standard: 2, peripheral: 1 }[criticality]
}

function changePoints(operations: readonly string[]): number {
  return Math.max(
    ...operations.map(
      (operation) =>
        ({ deleted: 3, modified: 2, added: 2, renamed: 1, moved: 1 })[
          operation
        ] ?? 0
    )
  )
}

function factorsFor(input: {
  readonly paths: readonly BlastRadiusEvidencePath[]
  readonly criticality: BlastRadiusCriticality
  readonly targetCounts: ReadonlyMap<string, number>
}): BlastRadiusRiskFactor[] {
  const operations = sortedUnique(
    input.paths.flatMap(({ operations }) => operations)
  )
  const changedSymbolIds = sortedUnique(
    input.paths.flatMap(({ changedSymbolIds }) => changedSymbolIds)
  )
  const minimumDepth = Math.min(
    ...input.paths.map(({ relationships }) => relationships.length)
  )
  const maxSpread = Math.max(
    1,
    ...changedSymbolIds.map((id) => input.targetCounts.get(id) ?? 1)
  )
  const corroborated = input.paths.some(
    ({ candidateIds, evidenceIds, provenance, relationships }) =>
      candidateIds.length >= 2 &&
      (evidenceIds.length > relationships.length || provenance.length > 1)
  )
  return [
    {
      code: "change_severity",
      points: changePoints(operations),
      value: operations.includes("deleted")
        ? "deleted_change"
        : operations.includes("modified")
          ? "modified_change"
          : "structural_change",
      relatedIds: stableIds(changedSymbolIds),
    },
    {
      code: "product_criticality",
      points: criticalityPoints(input.criticality),
      value: input.criticality,
      relatedIds: [],
    },
    {
      code: "path_directness",
      points: minimumDepth <= 2 ? 3 : minimumDepth <= 5 ? 2 : 1,
      value:
        minimumDepth <= 2
          ? "direct_path"
          : minimumDepth <= 5
            ? "bounded_indirect_path"
            : "deep_indirect_path",
      relatedIds: [],
    },
    {
      code: "affected_spread",
      points: maxSpread >= 5 ? 3 : maxSpread >= 2 ? 2 : 1,
      value:
        maxSpread >= 5
          ? "broad_spread"
          : maxSpread >= 2
            ? "multi_target"
            : "single_target",
      relatedIds: stableIds(changedSymbolIds),
    },
    {
      code: "shared_fanout",
      points: maxSpread >= 2 ? 2 : 0,
      value: maxSpread >= 2 ? "shared_change" : "isolated_change",
      relatedIds: stableIds(changedSymbolIds),
    },
    {
      code: "path_corroboration",
      points: corroborated ? 1 : 0,
      value: corroborated ? "independent_evidence" : "single_evidence_set",
      relatedIds: [],
    },
  ]
}

function riskFor(score: number): "high" | "medium" | "low" {
  return score >= 10 ? "high" : score >= 6 ? "medium" : "low"
}

function evidenceStrengthFor(paths: readonly BlastRadiusEvidencePath[]) {
  return paths
    .map(({ evidenceStrength }) => evidenceStrength)
    .sort((a, b) => evidenceOrder[a] - evidenceOrder[b])[0]!
}

function scenariosFor(input: {
  readonly targetId: string
  readonly targetKind: BlastRadiusTargetKind
  readonly paths: readonly BlastRadiusEvidencePath[]
  readonly priority: "high" | "medium" | "low"
}): BlastRadiusScenario[] {
  const scenarios = input.paths.map((path) => {
    const workflowId = path.nodes.find(({ kind }) => kind === "workflow")?.id
    const requirementId = path.nodes.find(
      ({ kind }) => kind === "requirement"
    )?.id
    const checkpointEntityIds = sortedUnique(
      path.nodes
        .filter(({ kind }) =>
          [
            "ui-element",
            "screen",
            "flow-step",
            "workflow",
            "requirement",
          ].includes(kind)
        )
        .map(({ id }) => id)
    )
    const kind =
      input.targetKind === "requirement"
        ? "requirement_acceptance"
        : input.targetKind === "workflow"
          ? "workflow_checkpoint"
          : "ui_interaction"
    const draft = {
      schemaVersion: 1,
      kind,
      targetId: input.targetId,
      ...(workflowId === undefined ? {} : { workflowId }),
      ...(requirementId === undefined ? {} : { requirementId }),
      checkpointEntityIds,
      evidencePathIds: [path.id],
      priority: input.priority,
    }
    return blastRadiusScenarioSchema.parse({
      ...draft,
      id: hashCanonical({
        identityKind: "blast-radius-scenario",
        version: 1,
        ...draft,
      }),
    })
  })
  return [
    ...new Map(scenarios.map((scenario) => [scenario.id, scenario])).values(),
  ]
    .sort((a, b) => compareStrings(a.id, b.id))
    .slice(0, 100)
}

function confidentFindings(input: {
  readonly paths: readonly BlastRadiusEvidencePath[]
  readonly caveats: readonly BlastRadiusCaveat[]
  readonly criticalities: ReadonlyMap<string, BlastRadiusCriticality>
}): BlastRadiusFinding[] {
  const byTarget = new Map<string, BlastRadiusEvidencePath[]>()
  for (const path of input.paths) {
    byTarget.set(path.targetId, [...(byTarget.get(path.targetId) ?? []), path])
  }
  const targetCounts = new Map<string, number>()
  for (const paths of byTarget.values()) {
    for (const symbolId of new Set(
      paths.flatMap(({ changedSymbolIds }) => changedSymbolIds)
    )) {
      targetCounts.set(symbolId, (targetCounts.get(symbolId) ?? 0) + 1)
    }
  }
  return [...byTarget.entries()].map(([targetId, paths]) => {
    const orderedPaths = paths.sort((a, b) => compareStrings(a.id, b.id))
    const target = orderedPaths[0]!.nodes.at(-1)!
    const criticality = input.criticalities.get(targetId) ?? "standard"
    const factors = factorsFor({
      paths: orderedPaths,
      criticality,
      targetCounts,
    })
    const score = factors.reduce((total, factor) => total + factor.points, 0)
    const risk = riskFor(score)
    const changedSymbolIds = sortedUnique(
      orderedPaths.flatMap(({ changedSymbolIds }) => changedSymbolIds)
    )
    const caveatIds = input.caveats
      .filter((item) =>
        item.changedSymbolIds.some((id) => changedSymbolIds.includes(id))
      )
      .map(({ id }) => id)
      .sort(compareStrings)
      .slice(0, 500)
    const draft = {
      schemaVersion: 1,
      targetId,
      targetKind: target.kind as BlastRadiusTargetKind,
      title: target.title,
      risk,
      evidenceStrength: evidenceStrengthFor(orderedPaths),
      criticality,
      changedSymbolIds,
      evidencePathIds: orderedPaths.map(({ id }) => id),
      caveatIds,
      factors,
      scenarios: scenariosFor({
        targetId,
        targetKind: target.kind as BlastRadiusTargetKind,
        paths: orderedPaths,
        priority: risk,
      }),
      score,
    }
    return blastRadiusFindingSchema.parse({
      ...draft,
      id: hashCanonical({ kind: "blast-radius-finding", version: 1, ...draft }),
    })
  })
}

function unknownFinding(input: {
  readonly identity: unknown
  readonly title: string
  readonly changedSymbolIds: readonly string[]
  readonly caveatIds: readonly string[]
}): BlastRadiusFinding {
  const factors: BlastRadiusRiskFactor[] = [
    {
      code: "unmapped_change",
      points: 0,
      value: "product_path_unknown",
      relatedIds: stableIds(input.changedSymbolIds),
    },
  ]
  const draft = {
    schemaVersion: 1,
    targetKind: "unknown" as const,
    title: input.title,
    risk: "unknown" as const,
    evidenceStrength: "D" as const,
    criticality: "standard" as const,
    changedSymbolIds: sortedUnique(input.changedSymbolIds),
    evidencePathIds: [],
    caveatIds: sortedUnique(input.caveatIds).slice(0, 500),
    factors,
    scenarios: [],
    score: 0,
  }
  return blastRadiusFindingSchema.parse({
    ...draft,
    id: hashCanonical({
      kind: "unknown-blast-radius-finding",
      input: input.identity,
    }),
  })
}

function unknownFindings(input: {
  readonly source: BlastRadiusInput
  readonly paths: readonly BlastRadiusEvidencePath[]
  readonly caveats: BlastRadiusCaveat[]
}): BlastRadiusFinding[] {
  const findings = input.source.unknowns.map((unknown) => {
    const relatedCaveats = input.caveats
      .filter((item) =>
        unknown.symbolIds.some((symbolId) =>
          item.changedSymbolIds.includes(symbolId)
        )
      )
      .map(({ id }) => id)
    return unknownFinding({
      identity: unknown.id,
      title: unknown.summary,
      changedSymbolIds: unknown.symbolIds,
      caveatIds: relatedCaveats,
    })
  })
  const mappedSymbols = new Set(
    input.paths.flatMap(({ changedSymbolIds }) => changedSymbolIds)
  )
  const knownUnknownSymbols = new Set(
    findings.flatMap(({ changedSymbolIds }) => changedSymbolIds)
  )
  const rejectedSymbols = sortedUnique(
    input.source.candidates.flatMap(({ changedSymbolIds }) => changedSymbolIds)
  ).filter((id) => !mappedSymbols.has(id) && !knownUnknownSymbols.has(id))
  for (const symbolId of rejectedSymbols) {
    const related = input.caveats.filter(({ changedSymbolIds }) =>
      changedSymbolIds.includes(symbolId)
    )
    const missing = caveat({
      code: "no_product_path",
      changedSymbolIds: [symbolId],
      evidenceIds: related.flatMap(({ evidenceIds }) => evidenceIds),
      conflictIds: related.flatMap(({ conflictIds }) => conflictIds),
    })
    input.caveats.push(missing)
    findings.push(
      unknownFinding({
        identity: symbolId,
        title: caveatSummary.no_product_path,
        changedSymbolIds: [symbolId],
        caveatIds: [...related.map(({ id }) => id), missing.id],
      })
    )
  }
  return findings
}

function sortFindings(findings: readonly BlastRadiusFinding[]) {
  return [...findings].sort(
    (left, right) =>
      riskOrder[left.risk] - riskOrder[right.risk] ||
      right.score - left.score ||
      evidenceOrder[left.evidenceStrength] -
        evidenceOrder[right.evidenceStrength] ||
      criticalityOrder[left.criticality] -
        criticalityOrder[right.criticality] ||
      compareStrings(left.targetId ?? left.id, right.targetId ?? right.id)
  )
}

export function computeBlastRadius(
  inputValue: BlastRadiusInput
): BlastRadiusResult {
  const input = blastRadiusInputSchema.parse(inputValue)
  const normalized = normalizeCandidates(input)
  const caveats = [...normalized.caveats]
  const criticalities = new Map(
    input.criticalities.map(({ criticality, entityId }) => [
      entityId,
      blastRadiusCriticalitySchema.parse(criticality),
    ])
  )
  const confident = confidentFindings({
    paths: normalized.paths,
    caveats,
    criticalities,
  })
  const unknown = unknownFindings({
    source: input,
    paths: normalized.paths,
    caveats,
  })
  const findings = sortFindings([...confident, ...unknown]).slice(
    0,
    MAX_BLAST_RADIUS_FINDINGS
  )
  const finalCaveats = [
    ...new Map(caveats.map((item) => [item.id, item])).values(),
  ]
    .sort((a, b) => compareStrings(a.id, b.id))
    .slice(0, MAX_BLAST_RADIUS_CAVEATS)
  const summary = {
    high: findings.filter(({ risk }) => risk === "high").length,
    medium: findings.filter(({ risk }) => risk === "medium").length,
    low: findings.filter(({ risk }) => risk === "low").length,
    unknown: findings.filter(({ risk }) => risk === "unknown").length,
  }
  const draft = {
    schemaVersion: 1,
    applicationId: input.applicationId,
    assessmentId: input.assessmentId,
    pullRequestId: input.pullRequestId,
    graphRevision: input.graphRevision,
    graphCommitSha: input.graphCommitSha,
    policyVersion: BLAST_RADIUS_POLICY_VERSION,
    evidencePaths: normalized.paths,
    caveats: finalCaveats,
    findings,
    summary,
  }
  return blastRadiusResultSchema.parse({
    ...draft,
    id: hashCanonical({ kind: "blast-radius-result", version: 1, ...draft }),
  })
}

function candidateNode(input: {
  readonly applicationId: ApplicationId
  readonly node: PrInvestigationOverlay["graphPaths"][number]["path"]["nodes"][number]
}): BlastRadiusPathNode {
  return {
    ...input.node,
    applicationId: input.applicationId,
  }
}

export function createBlastRadiusCandidatesFromInvestigation(input: {
  readonly investigation: PrInvestigationResult
  readonly overlay: PrInvestigationOverlay
  readonly operationsBySymbol: Readonly<
    Record<string, "added" | "modified" | "deleted" | "renamed" | "moved">
  >
}): BlastRadiusCandidatePath[] {
  const investigation = prInvestigationResultSchema.parse(input.investigation)
  const overlay = prInvestigationOverlaySchema.parse(input.overlay)
  if (
    investigation.status !== "completed" ||
    investigation.overlayId !== overlay.id ||
    investigation.applicationId !== overlay.applicationId ||
    investigation.runId !== overlay.runId ||
    String(investigation.pullRequest.id) !== String(overlay.pullRequestId) ||
    investigation.graphRevision !== overlay.graphRevision ||
    investigation.graphCommitSha !== overlay.graphCommitSha
  ) {
    throw new Error(
      "PR investigation and assessment overlay identities conflict"
    )
  }
  return createBlastRadiusCandidatesFromGraphPaths({
    applicationId: overlay.applicationId,
    graphRevision: overlay.graphRevision,
    source: "current_graph",
    includeIntermediateTargets: true,
    paths: overlay.graphPaths.map(({ changedSymbolIds, path }) => ({
      path,
      seeds: changedSymbolIds.map((changedSymbolId) => {
        const operation = input.operationsBySymbol[changedSymbolId]
        if (operation === undefined) {
          throw new Error("Changed symbol operation is missing")
        }
        return { changedSymbolId, operation }
      }),
    })),
  })
}

export function createBlastRadiusCandidatesFromGraphPaths(input: {
  readonly applicationId: ApplicationId
  readonly graphRevision: number
  readonly source:
    "current_graph" | "assessment_overlay" | "curator_reconciliation"
  readonly includeIntermediateTargets?: boolean
  readonly paths: readonly {
    readonly path: GraphEvidencePath
    readonly seeds: readonly {
      readonly changedSymbolId: string
      readonly operation: "added" | "modified" | "deleted" | "renamed" | "moved"
    }[]
  }[]
}): BlastRadiusCandidatePath[] {
  const candidates: BlastRadiusCandidatePath[] = []
  for (const sourcePath of input.paths) {
    const targetIndexes = input.includeIntermediateTargets
      ? Array.from(
          { length: sourcePath.path.nodes.length - 1 },
          (_, index) => index + 1
        )
      : [sourcePath.path.nodes.length - 1]
    for (const index of targetIndexes) {
      const target = sourcePath.path.nodes[index]!
      if (!targetKind(target.kind)) continue
      const nodes = sourcePath.path.nodes
        .slice(0, index + 1)
        .map((node) =>
          candidateNode({ applicationId: input.applicationId, node })
        )
      const relationships = sourcePath.path.relationships
        .slice(0, index)
        .map(({ evidence, sourceUri, artifactId, ...relationship }) => ({
          ...relationship,
          applicationId: input.applicationId,
          sourceUris: sourceUri === undefined ? [] : [sourceUri],
          artifactIds: artifactId === undefined ? [] : [artifactId],
          provenance: evidence.map(({ provenance }) => provenance),
          stale: false,
          conflictIds: [],
        }))
      const draft = {
        schemaVersion: 1,
        source: input.source,
        applicationId: input.applicationId,
        graphRevision: input.graphRevision,
        seedId: nodes[0]!.id,
        targetId: target.id,
        targetKind: target.kind,
        changedSymbolIds: sortedUnique(
          sourcePath.seeds.map(({ changedSymbolId }) => changedSymbolId)
        ),
        operations: sortedUnique(
          sourcePath.seeds.map(({ operation }) => operation)
        ),
        nodes,
        relationships,
      }
      candidates.push(
        blastRadiusCandidatePathSchema.parse({
          ...draft,
          id: hashCanonical({
            kind: "blast-radius-candidate",
            semanticPath: {
              nodes: nodes.map(({ id }) => id),
              relationships: relationships.map(({ id }) => id),
            },
            changedSymbolIds: draft.changedSymbolIds,
            operations: draft.operations,
            targetId: target.id,
            version: 1,
          }),
        })
      )
    }
  }
  const normalized = [
    ...new Map(
      candidates.map((candidate) => [candidate.id, candidate])
    ).values(),
  ].sort((a, b) => compareStrings(a.id, b.id))
  if (normalized.length > MAX_BLAST_RADIUS_CANDIDATES) {
    throw new Error(
      "Blast-radius candidate expansion exceeds its bounded limit"
    )
  }
  return normalized
}
