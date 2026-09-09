import {
  BLAST_RADIUS_POLICY_VERSION,
  applicationIdSchema,
  blastRadiusCandidatePathSchema,
  blastRadiusInputSchema,
  codeSymbolIdSchema,
  contentHashSchema,
  evidenceIdSchema,
  graphEvidencePathSchema,
  hashCanonical,
  prInvestigationUnknownSchema,
  stableEntityIdSchema,
  type BlastRadiusCandidatePath,
  type BlastRadiusInput,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import {
  computeBlastRadius,
  createBlastRadiusCandidatesFromGraphPaths,
} from "./blast-radius.ts"

const applicationId = applicationIdSchema.parse(
  `application:v1:${"a".repeat(64)}`
)
const foreignApplicationId = applicationIdSchema.parse(
  `application:v1:${"b".repeat(64)}`
)
const symbolId = stableEntityIdSchema.parse(`code-symbol:v1:${"c".repeat(64)}`)
const endpointId = stableEntityIdSchema.parse(
  `api-endpoint:v1:${"d".repeat(64)}`
)
const secondaryEndpointId = stableEntityIdSchema.parse(
  `api-endpoint:v1:${"4".repeat(64)}`
)
const elementId = stableEntityIdSchema.parse(`ui-element:v1:${"e".repeat(64)}`)
const stepId = stableEntityIdSchema.parse(`flow-step:v1:${"f".repeat(64)}`)
const workflowId = stableEntityIdSchema.parse(`workflow:v1:${"1".repeat(64)}`)
const requirementId = stableEntityIdSchema.parse(
  `requirement:v1:${"2".repeat(64)}`
)
const assessmentId = "00000000-0000-4000-8000-000000000028"
const pullRequestId = `pull-request:v1:${"3".repeat(64)}`
const timestamp = "2026-09-09T08:00:00.000Z"

function evidenceId(key: unknown) {
  return evidenceIdSchema.parse(
    `evidence:v1:${hashCanonical(key).slice("sha256:".length)}`
  )
}

function node(
  id: string,
  kind: string,
  title: string,
  tier: "A" | "B" | "C" | "D" = "A",
  selectedApplicationId = applicationId,
  graphRevision = 3
) {
  return {
    id,
    applicationId: selectedApplicationId,
    kind,
    title,
    evidenceTier: tier,
    evidenceIds: [],
    provenance: { sourceKind: "system" as const, observedAt: timestamp },
    reviewState:
      tier === "C" ? ("accepted" as const) : ("not_required" as const),
    graphRevision,
  }
}

interface CandidateOptions {
  readonly key: string
  readonly targetIndex?: 2 | 4 | 5
  readonly tier?: "A" | "B" | "C" | "D"
  readonly operation?: "added" | "modified" | "deleted" | "renamed" | "moved"
  readonly source?:
    "current_graph" | "assessment_overlay" | "curator_reconciliation"
  readonly stale?: boolean
  readonly conflict?: boolean
  readonly invalidDirection?: boolean
  readonly cycle?: boolean
  readonly selectedApplicationId?: typeof applicationId
  readonly graphRevision?: number
}

function candidate(options: CandidateOptions): BlastRadiusCandidatePath {
  const tier = options.tier ?? "A"
  const selectedApplicationId = options.selectedApplicationId ?? applicationId
  const graphRevision = options.graphRevision ?? 3
  const nodes = [
    node(
      symbolId,
      "code-symbol",
      "OrderService.submit",
      tier,
      selectedApplicationId,
      graphRevision
    ),
    node(
      endpointId,
      "api-endpoint",
      "POST /orders",
      tier,
      selectedApplicationId,
      graphRevision
    ),
    node(
      elementId,
      "ui-element",
      "Submit order",
      tier,
      selectedApplicationId,
      graphRevision
    ),
    node(
      stepId,
      "flow-step",
      "Submit attendee details",
      tier,
      selectedApplicationId,
      graphRevision
    ),
    node(
      workflowId,
      "workflow",
      "Attendee checkout",
      tier,
      selectedApplicationId,
      graphRevision
    ),
    node(
      requirementId,
      "requirement",
      "Buyers create orders",
      tier,
      selectedApplicationId,
      graphRevision
    ),
  ]
  if (options.cycle) nodes[3] = nodes[2]!
  const selectedNodes = nodes.slice(0, (options.targetIndex ?? 5) + 1)
  const definitions = [
    { type: "HANDLED_BY", from: 1, to: 0 },
    { type: "TRIGGERS_API", from: 2, to: 1 },
    { type: "ACTS_ON", from: 3, to: 2 },
    { type: "HAS_STEP", from: 4, to: 3 },
    { type: "COVERED_BY", from: 5, to: 4 },
  ] as const
  const relationships = definitions
    .slice(0, selectedNodes.length - 1)
    .map((definition, index) => {
      const id = evidenceId({ key: options.key, index })
      const from =
        options.invalidDirection && index === 0
          ? selectedNodes[definition.to]!
          : selectedNodes[definition.from]!
      const to =
        options.invalidDirection && index === 0
          ? selectedNodes[definition.from]!
          : selectedNodes[definition.to]!
      return {
        id,
        applicationId: selectedApplicationId,
        type: definition.type,
        fromId: from.id,
        toId: to.id,
        evidenceTier: tier,
        extractionMethod: "fixture_evidence",
        evidenceIds: [id],
        provenance: [{ sourceKind: "system" as const, observedAt: timestamp }],
        reviewState:
          tier === "C"
            ? ("accepted" as const)
            : tier === "D"
              ? ("pending" as const)
              : ("not_required" as const),
        graphRevision,
        stale: options.stale ?? false,
        conflictIds: options.conflict
          ? [contentHashSchema.parse(hashCanonical({ conflict: options.key }))]
          : [],
      }
    })
  const target = selectedNodes.at(-1)!
  const draft = {
    schemaVersion: 1,
    source: options.source ?? "current_graph",
    applicationId: selectedApplicationId,
    graphRevision,
    seedId: selectedNodes[0]!.id,
    targetId: target.id,
    targetKind: target.kind,
    changedSymbolIds: [symbolId],
    operations: [options.operation ?? "modified"],
    nodes: selectedNodes,
    relationships,
  }
  return blastRadiusCandidatePathSchema.parse({
    ...draft,
    id: hashCanonical({ kind: "fixture-candidate", key: options.key }),
  })
}

function input(
  candidates: readonly BlastRadiusCandidatePath[],
  overrides: Partial<BlastRadiusInput> = {}
): BlastRadiusInput {
  return blastRadiusInputSchema.parse({
    schemaVersion: 1,
    applicationId,
    assessmentId,
    pullRequestId,
    graphRevision: 3,
    graphCommitSha: "1".repeat(40),
    policyVersion: BLAST_RADIUS_POLICY_VERSION,
    candidates,
    unknowns: [],
    criticalities: [],
    ...overrides,
  })
}

describe("blast-radius engine", () => {
  it("converts typed Neo4j paths into exact-operation policy candidates", () => {
    const base = candidate({ key: "neo4j-adapter" })
    const path = graphEvidencePathSchema.parse({
      nodes: base.nodes.map(
        ({ applicationId: selectedApplicationId, ...value }) => {
          expect(selectedApplicationId).toBe(applicationId)
          return value
        }
      ),
      relationships: base.relationships.map(
        ({
          applicationId: selectedApplicationId,
          conflictIds,
          provenance,
          stale,
          ...value
        }) => {
          expect(selectedApplicationId).toBe(applicationId)
          expect(conflictIds).toEqual([])
          expect(stale).toBe(false)
          return {
            ...value,
            evidence: value.evidenceIds.map((selectedEvidenceId) => ({
              evidenceId: selectedEvidenceId,
              extractionMethod: value.extractionMethod,
              provenance: provenance[0]!,
            })),
          }
        }
      ),
    })

    const candidates = createBlastRadiusCandidatesFromGraphPaths({
      applicationId,
      graphRevision: 3,
      source: "current_graph",
      paths: [
        {
          path,
          seeds: [{ changedSymbolId: symbolId, operation: "deleted" }],
        },
      ],
    })

    expect(candidates.map(({ targetKind }) => targetKind)).toEqual([
      "requirement",
    ])
    expect(
      candidates.every(({ operations }) => operations[0] === "deleted")
    ).toBe(true)
  })

  it("aggregates shared-symbol seeds instead of multiplying candidates", () => {
    const base = candidate({ key: "shared-symbol-adapter" })
    const path = graphEvidencePathSchema.parse({
      nodes: base.nodes.map((value) => ({
        id: value.id,
        kind: value.kind,
        title: value.title,
        evidenceTier: value.evidenceTier,
        evidenceIds: value.evidenceIds,
        provenance: value.provenance,
        reviewState: value.reviewState,
        graphRevision: value.graphRevision,
      })),
      relationships: base.relationships.map((value) => ({
        id: value.id,
        type: value.type,
        fromId: value.fromId,
        toId: value.toId,
        evidenceTier: value.evidenceTier,
        extractionMethod: value.extractionMethod,
        evidenceIds: value.evidenceIds,
        evidence: value.evidenceIds.map((selectedEvidenceId) => ({
          evidenceId: selectedEvidenceId,
          extractionMethod: value.extractionMethod,
          provenance: value.provenance[0]!,
        })),
        reviewState: value.reviewState,
        graphRevision: value.graphRevision,
      })),
    })
    const seeds = Array.from({ length: 40 }, (_, index) => ({
      changedSymbolId: codeSymbolIdSchema.parse(
        `code-symbol:v1:${index.toString(16).padStart(64, "0")}`
      ),
      operation: index === 0 ? ("deleted" as const) : ("modified" as const),
    }))

    const candidates = createBlastRadiusCandidatesFromGraphPaths({
      applicationId,
      graphRevision: 3,
      source: "current_graph",
      paths: [{ path, seeds }],
    })

    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.changedSymbolIds).toHaveLength(40)
    expect(candidates[0]!.operations).toEqual(["deleted", "modified"])
  })

  it("keeps high consequence separate from Tier-C evidence strength", () => {
    const result = computeBlastRadius(
      input(
        [candidate({ key: "critical-c", tier: "C", operation: "deleted" })],
        {
          criticalities: [{ entityId: requirementId, criticality: "critical" }],
        }
      )
    )

    expect(result.findings[0]).toMatchObject({
      targetId: requirementId,
      risk: "high",
      evidenceStrength: "C",
      criticality: "critical",
    })
    expect(result.findings[0]?.factors.map(({ code }) => code)).toEqual([
      "change_severity",
      "product_criticality",
      "path_directness",
      "affected_spread",
      "shared_fanout",
      "path_corroboration",
    ])
  })

  it("collapses duplicate paths while retaining corroboration and provenance", () => {
    const first = candidate({ key: "duplicate-a", tier: "B" })
    const second = candidate({
      key: "duplicate-b",
      tier: "A",
      source: "assessment_overlay",
    })
    const result = computeBlastRadius(input([second, first]))

    expect(result.evidencePaths).toHaveLength(1)
    expect(result.evidencePaths[0]).toMatchObject({
      evidenceStrength: "A",
      candidateIds: [first.id, second.id].sort(),
    })
    expect(result.evidencePaths[0]!.evidenceIds).toHaveLength(10)
    expect(result.evidencePaths[0]!.relationships[0]!.provenance).toHaveLength(
      1
    )
    expect(result.evidencePaths[0]!.provenance).toHaveLength(1)
  })

  it("bounds aggregate evidence for a maximum-size duplicate set", () => {
    const candidates = Array.from({ length: 1_001 }, (_, index) =>
      candidate({ key: `aggregate-${index}`, tier: "A" })
    )
    const result = computeBlastRadius(input(candidates))

    expect(result.evidencePaths).toHaveLength(1)
    expect(result.evidencePaths[0]!.candidateIds).toHaveLength(1_001)
    expect(result.evidencePaths[0]!.evidenceIds.length).toBeLessThanOrEqual(
      1_000
    )
    expect(
      result.evidencePaths[0]!.relationships.every(
        ({ evidenceIds, provenance }) =>
          evidenceIds.length <= 100 && provenance.length <= 100
      )
    ).toBe(true)
  })

  it("allows an endpoint seed to traverse its handler and another called endpoint", () => {
    const base = candidate({ key: "endpoint-seed", targetIndex: 2 })
    const calledEndpoint = {
      ...base.nodes[1],
      id: secondaryEndpointId,
      title: "POST /notifications",
    }
    const callsApiEvidence = evidenceId({ kind: "handler-calls-api" })
    const triggersEvidence = evidenceId({ kind: "secondary-trigger" })
    const endpointSeed = blastRadiusCandidatePathSchema.parse({
      ...base,
      id: hashCanonical({ kind: "endpoint-seed-candidate" }),
      seedId: endpointId,
      nodes: [base.nodes[1], base.nodes[0], calledEndpoint, base.nodes[2]],
      relationships: [
        base.relationships[0],
        {
          ...base.relationships[0],
          id: callsApiEvidence,
          type: "CALLS_API",
          fromId: symbolId,
          toId: secondaryEndpointId,
          evidenceIds: [callsApiEvidence],
        },
        {
          ...base.relationships[1],
          id: triggersEvidence,
          fromId: elementId,
          toId: secondaryEndpointId,
          evidenceIds: [triggersEvidence],
        },
      ],
    })

    const result = computeBlastRadius(input([endpointSeed]))
    expect(result.findings[0]).toMatchObject({
      targetId: elementId,
      evidenceStrength: "A",
    })
  })

  it("fans one shared change out to ranked UI, workflow, and requirement findings", () => {
    const result = computeBlastRadius(
      input([
        candidate({ key: "ui", targetIndex: 2, operation: "modified" }),
        candidate({ key: "workflow", targetIndex: 4, operation: "modified" }),
        candidate({
          key: "requirement",
          targetIndex: 5,
          operation: "modified",
        }),
      ])
    )

    expect(
      new Set(result.findings.map(({ targetKind }) => targetKind))
    ).toEqual(new Set(["ui-element", "workflow", "requirement"]))
    expect(
      result.findings.every(({ factors }) =>
        factors.some(
          ({ code, value }) =>
            code === "shared_fanout" && value === "shared_change"
        )
      )
    ).toBe(true)
  })

  it.each([
    ["tier_d_evidence", { tier: "D" }],
    ["stale_revision", { stale: true }],
    ["evidence_conflict", { conflict: true }],
    ["invalid_direction", { invalidDirection: true }],
    ["cycle_detected", { cycle: true }],
    ["foreign_application", { selectedApplicationId: foreignApplicationId }],
    ["stale_revision", { graphRevision: 2 }],
  ] as const)(
    "excludes %s candidates from confident impact",
    (code, options) => {
      const result = computeBlastRadius(
        input([candidate({ key: code, ...options })])
      )

      expect(result.evidencePaths).toHaveLength(0)
      expect(result.findings).toMatchObject([
        { risk: "unknown", evidenceStrength: "D", evidencePathIds: [] },
      ])
      expect(result.caveats.some((item) => item.code === code)).toBe(true)
    }
  )

  it("preserves an unsupported configuration change as Unknown", () => {
    const unknown = prInvestigationUnknownSchema.parse({
      schemaVersion: 1,
      id: hashCanonical({ kind: "unknown-config" }),
      kind: "file" as const,
      filePaths: ["config/runtime.yml"],
      symbolIds: [],
      classifications: ["configuration" as const],
      unresolvedReasons: ["configuration_change" as const],
      summary: "Configuration change has no product path",
    })
    const result = computeBlastRadius(input([], { unknowns: [unknown] }))

    expect(result.summary).toEqual({ high: 0, medium: 0, low: 0, unknown: 1 })
    expect(result.findings[0]).toMatchObject({
      targetKind: "unknown",
      risk: "unknown",
      title: unknown.summary,
    })
  })

  it("produces deterministic identities and ranking for equivalent input order", () => {
    const candidates = [
      candidate({ key: "det-ui", targetIndex: 2 }),
      candidate({ key: "det-workflow", targetIndex: 4 }),
      candidate({ key: "det-requirement", targetIndex: 5 }),
    ]
    const criticalities = [
      { entityId: requirementId, criticality: "critical" as const },
      { entityId: workflowId, criticality: "important" as const },
    ]

    expect(computeBlastRadius(input(candidates, { criticalities }))).toEqual(
      computeBlastRadius(
        input([...candidates].reverse(), {
          criticalities: [...criticalities].reverse(),
        })
      )
    )
  })

  it("derives structured QA checkpoints from inspectable path facts", () => {
    const result = computeBlastRadius(
      input([
        candidate({ key: "qa-ui", targetIndex: 2 }),
        candidate({ key: "qa-workflow", targetIndex: 4 }),
        candidate({ key: "qa-requirement", targetIndex: 5 }),
      ])
    )

    const scenarios = result.findings.flatMap(({ scenarios }) => scenarios)
    expect(new Set(scenarios.map(({ kind }) => kind))).toEqual(
      new Set([
        "ui_interaction",
        "workflow_checkpoint",
        "requirement_acceptance",
      ])
    )
    expect(
      scenarios.every(
        ({ checkpointEntityIds }) => checkpointEntityIds.length > 0
      )
    ).toBe(true)
    expect(
      scenarios.every(({ evidencePathIds }) => evidencePathIds.length > 0)
    ).toBe(true)
  })

  it("keeps low indirect consequence distinct from strong evidence", () => {
    const result = computeBlastRadius(
      input([candidate({ key: "low-a", operation: "renamed" })], {
        criticalities: [{ entityId: requirementId, criticality: "peripheral" }],
      })
    )

    expect(result.findings[0]).toMatchObject({
      risk: "low",
      evidenceStrength: "A",
    })
  })
})
