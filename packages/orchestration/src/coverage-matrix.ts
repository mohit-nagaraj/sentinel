import {
  EVIDENCE_CURATOR_SCHEMA_VERSION,
  coverageGapSchema,
  coverageMatrixInputSchema,
  coverageMatrixSchema,
  hashCanonical,
  type CoverageEntity,
  type CoverageGap,
  type CoverageMatrix,
  type CoverageMatrixInput,
  type EvidenceLink,
} from "@sentinel/contracts"

const TECHNICAL_PATH_RELATIONSHIPS = new Set([
  "HAS_STEP",
  "NEXT",
  "ON_SCREEN",
  "ACTS_ON",
  "CONTAINS",
  "MATCHES_ROUTE",
  "RENDERED_BY",
  "BINDS",
  "TRIGGERS_API",
  "CALLS_API",
  "HANDLED_BY",
  "CALLS",
  "READS",
  "WRITES",
])

const INTENT_PATH_RELATIONSHIPS = new Set([
  ...TECHNICAL_PATH_RELATIONSHIPS,
  "COVERED_BY",
  "STATES",
  "REQUIRES",
])

interface AdjacencyEdge {
  readonly id: string
  readonly relationship: string
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[]
}

function entityKind(id: string): string {
  return id.split(":v1:", 1)[0] ?? ""
}

function confident(link: EvidenceLink, stale: ReadonlySet<string>): boolean {
  if (link.evidenceIds.some((evidenceId) => stale.has(evidenceId))) return false
  if (link.evidenceTier === "D") return false
  if (link.evidenceTier === "C") return link.reviewState === "accepted"
  return link.reviewState === "accepted" || link.reviewState === "not_required"
}

function deduplicateLinks(input: CoverageMatrixInput): EvidenceLink[] {
  const byId = new Map<string, EvidenceLink>()
  for (const link of [...input.currentLinks, ...input.pendingBatch.links]) {
    byId.set(link.id, link)
  }
  const stale = new Set(input.staleEvidenceIds)
  return [...byId.values()]
    .filter((link) => confident(link, stale))
    .sort((left, right) => left.id.localeCompare(right.id))
}

function adjacencyFor(links: readonly EvidenceLink[]) {
  const adjacency = new Map<string, AdjacencyEdge[]>()
  const add = (from: string, to: string, relationship: string) => {
    const edges = adjacency.get(from) ?? []
    edges.push({ id: to, relationship })
    adjacency.set(from, edges)
  }
  for (const link of links) {
    add(link.fromId, link.toId, link.relationship)
    add(link.toId, link.fromId, link.relationship)
  }
  for (const edges of adjacency.values()) {
    edges.sort(
      (left, right) =>
        left.relationship.localeCompare(right.relationship) ||
        left.id.localeCompare(right.id)
    )
  }
  return adjacency
}

function hasPathToKind(input: {
  readonly startId: string
  readonly targetKinds: ReadonlySet<string>
  readonly relationships: ReadonlySet<string>
  readonly adjacency: ReadonlyMap<string, readonly AdjacencyEdge[]>
  readonly maxDepth?: number
}): boolean {
  const maxDepth = input.maxDepth ?? 8
  const queue: { readonly id: string; readonly depth: number }[] = [
    { id: input.startId, depth: 0 },
  ]
  const visited = new Set([input.startId])
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || current.depth >= maxDepth) continue
    for (const edge of input.adjacency.get(current.id) ?? []) {
      if (!input.relationships.has(edge.relationship) || visited.has(edge.id)) {
        continue
      }
      if (input.targetKinds.has(entityKind(edge.id))) return true
      visited.add(edge.id)
      queue.push({ id: edge.id, depth: current.depth + 1 })
    }
  }
  return false
}

function hasDirectLink(
  links: readonly EvidenceLink[],
  fromId: string,
  relationship: string
): boolean {
  return links.some(
    (link) => link.fromId === fromId && link.relationship === relationship
  )
}

interface CoverageGapDraft {
  readonly kind: CoverageGap["kind"]
  readonly subjectIds: readonly string[]
  readonly evidenceIds: readonly string[]
  readonly candidateIds: readonly string[]
  readonly conflictIds: readonly string[]
  readonly summary: string
  readonly requiresHuman: boolean
  readonly recommendedAgent?: "documentation" | "code" | "application"
  readonly allowedModes: readonly CoverageGap["allowedModes"][number][]
}

function gap(input: CoverageGapDraft): CoverageGap {
  const normalized = {
    ...input,
    subjectIds: sortedUnique(input.subjectIds),
    evidenceIds: sortedUnique(input.evidenceIds),
    candidateIds: sortedUnique(input.candidateIds),
    conflictIds: sortedUnique(input.conflictIds),
    allowedModes: sortedUnique(input.allowedModes),
  }
  return coverageGapSchema.parse({
    ...normalized,
    id: hashCanonical({
      kind: normalized.kind,
      subjectIds: normalized.subjectIds,
      candidateIds: normalized.candidateIds,
      conflictIds: normalized.conflictIds,
      evidenceIds: normalized.evidenceIds,
      version: 1,
    }),
  })
}

function entityEvidence(entity: CoverageEntity): CoverageEntity["evidenceIds"] {
  return entity.evidenceIds
}

function reviewedTargets(input: CoverageMatrixInput): ReadonlySet<string> {
  return new Set(
    input.reviewDecisions.map(
      ({ targetId, targetKind }) => `${targetKind}:${targetId}`
    )
  )
}

function staleGap(input: CoverageMatrixInput): CoverageGap | undefined {
  const stale = new Set(input.staleEvidenceIds)
  if (stale.size === 0) return undefined
  const subjectIds = sortedUnique([
    ...input.entities
      .filter((entity) => entity.evidenceIds.some((id) => stale.has(id)))
      .map(({ id }) => id),
    ...[...input.currentLinks, ...input.pendingBatch.links]
      .filter((link) => link.evidenceIds.some((id) => stale.has(id)))
      .flatMap(({ fromId, toId }) => [fromId, toId]),
  ])
  const activeSubjectIds =
    subjectIds.length === 0 ? [input.applicationId] : subjectIds
  const hasCode = activeSubjectIds.some(
    (id) => entityKind(id) === "code-symbol"
  )
  const hasApplication = activeSubjectIds.some((id) =>
    ["workflow", "flow-step", "screen", "ui-element"].includes(entityKind(id))
  )
  return gap({
    kind: "stale_evidence",
    subjectIds: activeSubjectIds,
    evidenceIds: [...stale],
    candidateIds: [],
    conflictIds: [],
    summary:
      "Current coverage references stale evidence that must be refreshed",
    requiresHuman: false,
    recommendedAgent: hasCode
      ? "code"
      : hasApplication
        ? "application"
        : "documentation",
    allowedModes: hasCode
      ? ["implementation_trace"]
      : hasApplication
        ? ["workflow_discovery"]
        : ["targeted_requirement_lookup"],
  })
}

export function buildCoverageMatrix(inputValue: unknown): CoverageMatrix {
  const input = coverageMatrixInputSchema.parse(inputValue)
  const links = deduplicateLinks(input)
  const adjacency = adjacencyFor(links)
  const gaps: CoverageGap[] = []

  for (const requirement of input.entities.filter(
    ({ kind }) => kind === "requirement"
  )) {
    if (!hasDirectLink(links, requirement.id, "COVERED_BY")) {
      gaps.push(
        gap({
          kind: "requirement_without_workflow",
          subjectIds: [requirement.id],
          evidenceIds: entityEvidence(requirement),
          candidateIds: [],
          conflictIds: [],
          summary: "Requirement has no evidence-backed workflow coverage",
          requiresHuman: false,
          recommendedAgent: "application",
          allowedModes: ["targeted_requirement_observation"],
        })
      )
    }
  }

  for (const workflow of input.entities.filter(
    ({ kind }) => kind === "workflow"
  )) {
    const hasUi = hasPathToKind({
      startId: workflow.id,
      targetKinds: new Set(["screen", "ui-element"]),
      relationships: new Set(["HAS_STEP", "NEXT", "ON_SCREEN", "ACTS_ON"]),
      adjacency,
      maxDepth: 4,
    })
    if (!hasUi) {
      gaps.push(
        gap({
          kind: "workflow_without_ui",
          subjectIds: [workflow.id],
          evidenceIds: entityEvidence(workflow),
          candidateIds: [],
          conflictIds: [],
          summary:
            "Observed workflow has no linked screen or UI action evidence",
          requiresHuman: false,
          recommendedAgent: "application",
          allowedModes: ["workflow_discovery"],
        })
      )
    }

    const hasCode = hasPathToKind({
      startId: workflow.id,
      targetKinds: new Set(["code-symbol"]),
      relationships: TECHNICAL_PATH_RELATIONSHIPS,
      adjacency,
    })
    if (!hasCode) {
      gaps.push(
        gap({
          kind: "workflow_without_code",
          subjectIds: [workflow.id],
          evidenceIds: entityEvidence(workflow),
          candidateIds: [],
          conflictIds: [],
          summary: "Workflow or runtime behavior has no implementation path",
          requiresHuman: false,
          recommendedAgent: "code",
          allowedModes: ["implementation_trace"],
        })
      )
    }
  }

  for (const endpoint of input.entities.filter(
    ({ kind }) => kind === "api-endpoint"
  )) {
    if (!hasDirectLink(links, endpoint.id, "HANDLED_BY")) {
      gaps.push(
        gap({
          kind: "endpoint_without_code",
          subjectIds: [endpoint.id],
          evidenceIds: entityEvidence(endpoint),
          candidateIds: [],
          conflictIds: [],
          summary: "Runtime endpoint has no exact handler relationship",
          requiresHuman: false,
          recommendedAgent: "code",
          allowedModes: ["unmapped_endpoint_resolution"],
        })
      )
    }
  }

  for (const symbol of input.entities.filter(
    ({ kind, behavioral }) => kind === "code-symbol" && behavioral
  )) {
    const hasIntent = hasPathToKind({
      startId: symbol.id,
      targetKinds: new Set(["requirement"]),
      relationships: INTENT_PATH_RELATIONSHIPS,
      adjacency,
    })
    if (!hasIntent) {
      gaps.push(
        gap({
          kind: "code_without_intent",
          subjectIds: [symbol.id],
          evidenceIds: entityEvidence(symbol),
          candidateIds: [],
          conflictIds: [],
          summary: "Behavioral code has no cited product-intent path",
          requiresHuman: false,
          recommendedAgent: "documentation",
          allowedModes: ["targeted_requirement_lookup"],
        })
      )
    }

    const changed =
      symbol.changed ||
      links.some(
        (link) =>
          link.relationship === "CHANGES" &&
          String(link.toId) === String(symbol.id)
      )
    if (
      changed &&
      !hasPathToKind({
        startId: symbol.id,
        targetKinds: new Set([
          "requirement",
          "workflow",
          "screen",
          "ui-element",
        ]),
        relationships: INTENT_PATH_RELATIONSHIPS,
        adjacency,
      })
    ) {
      gaps.push(
        gap({
          kind: "changed_symbol_without_product_path",
          subjectIds: [symbol.id],
          evidenceIds: entityEvidence(symbol),
          candidateIds: [],
          conflictIds: [],
          summary: "Changed symbol has no confident product path",
          requiresHuman: false,
          recommendedAgent: "code",
          allowedModes: ["pr_change_investigation"],
        })
      )
    }
  }

  const reviewed = reviewedTargets(input)
  for (const conflict of input.pendingBatch.conflicts) {
    if (reviewed.has(`conflict:${conflict.id}`)) continue
    gaps.push(
      gap({
        kind: "conflict",
        subjectIds: [conflict.fromId, conflict.toId],
        evidenceIds: conflict.evidenceIds,
        candidateIds: [],
        conflictIds: [conflict.id],
        summary: conflict.summary,
        requiresHuman: true,
        allowedModes: [],
      })
    )
  }

  for (const candidate of input.pendingBatch.reviewCandidates) {
    if (
      candidate.modelDisposition === "rejected" ||
      reviewed.has(`candidate:${candidate.id}`)
    ) {
      continue
    }
    gaps.push(
      gap({
        kind: "human_review_required",
        subjectIds: [candidate.fromId, candidate.toId],
        evidenceIds: candidate.evidenceIds,
        candidateIds: [candidate.id],
        conflictIds: [],
        summary: `Tier ${candidate.evidenceTier} ${candidate.relationship} candidate requires review`,
        requiresHuman: true,
        allowedModes: [],
      })
    )
  }

  const stale = staleGap(input)
  if (stale !== undefined) gaps.push(stale)

  const deduplicatedGaps = [
    ...new Map(gaps.map((item) => [item.id, item])).values(),
  ].sort((left, right) => left.id.localeCompare(right.id))
  const humanGapCount = deduplicatedGaps.filter(
    ({ requiresHuman }) => requiresHuman
  ).length
  const readiness =
    deduplicatedGaps.length === 0
      ? "ready"
      : humanGapCount > 0
        ? "needs_human"
        : "needs_reconciliation"
  const stats = {
    entityCount: input.entities.length,
    confidentLinkCount: links.length,
    requirementCount: input.entities.filter(
      ({ kind }) => kind === "requirement"
    ).length,
    workflowCount: input.entities.filter(({ kind }) => kind === "workflow")
      .length,
    endpointCount: input.entities.filter(({ kind }) => kind === "api-endpoint")
      .length,
    codeSymbolCount: input.entities.filter(({ kind }) => kind === "code-symbol")
      .length,
    gapCount: deduplicatedGaps.length,
    humanGapCount,
  }

  return coverageMatrixSchema.parse({
    schemaVersion: EVIDENCE_CURATOR_SCHEMA_VERSION,
    applicationId: input.applicationId,
    runId: input.runId,
    evidenceStateId: input.evidenceStateId,
    evidenceFingerprint: hashCanonical({
      entities: input.entities
        .map(({ id, evidenceIds, behavioral, changed }) => ({
          id,
          evidenceIds: [...evidenceIds].sort(),
          behavioral,
          changed,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      links: links.map(
        ({ id, evidenceIds, evidenceTier, reviewState, graphRevision }) => ({
          id,
          evidenceIds: [...evidenceIds].sort(),
          evidenceTier,
          reviewState,
          graphRevision,
        })
      ),
      pendingBatchHash: input.pendingBatch.batchHash,
      staleEvidenceIds: [...input.staleEvidenceIds].sort(),
      reviewDecisions: [...input.reviewDecisions]
        .map(({ targetKind, targetId, approved }) => ({
          targetKind,
          targetId,
          approved,
        }))
        .sort((left, right) =>
          `${left.targetKind}:${left.targetId}`.localeCompare(
            `${right.targetKind}:${right.targetId}`
          )
        ),
    }),
    gaps: deduplicatedGaps,
    stats,
    readiness,
    publicationReady: readiness === "ready",
  })
}
