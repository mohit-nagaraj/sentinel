import { z } from "zod"

import { evidenceRelationshipSchema, riskSchema } from "./assessment.ts"
import { prInvestigationUnknownSchema } from "./pr-investigation.ts"
import {
  applicationIdSchema,
  artifactIdSchema,
  codeSymbolIdSchema,
  commitShaSchema,
  contentHashSchema,
  entityKindSchema,
  evidenceIdSchema,
  evidenceTierSchema,
  persistedTextSchema,
  provenanceSchema,
  pullRequestIdSchema,
  reasonCodeSchema,
  reviewStateSchema,
  schemaVersionSchema,
  sourceUriSchema,
  stableEntityIdSchema,
} from "./primitives.ts"

export const BLAST_RADIUS_POLICY_VERSION = "blast-radius-policy-v1" as const
export const MAX_BLAST_RADIUS_CANDIDATES = 2_500 as const
export const MAX_BLAST_RADIUS_PATHS = MAX_BLAST_RADIUS_CANDIDATES
export const MAX_BLAST_RADIUS_FINDINGS = 13_000 as const
export const MAX_BLAST_RADIUS_CAVEATS = 25_500 as const
export const MAX_BLAST_RADIUS_PATH_DEPTH = 10 as const
export const MAX_BLAST_RADIUS_CANDIDATE_DEPTH = 12 as const

function uniqueValues<T extends z.ZodType>(schema: T, label: string) {
  return z
    .array(schema)
    .refine((values) => new Set(values.map(String)).size === values.length, {
      message: `${label} must be unique`,
    })
}

export const blastRadiusTargetKindSchema = z.enum([
  "ui-element",
  "screen",
  "workflow",
  "requirement",
])

export const blastRadiusCriticalitySchema = z.enum([
  "critical",
  "important",
  "standard",
  "peripheral",
])

export const blastRadiusCandidateSourceSchema = z.enum([
  "current_graph",
  "assessment_overlay",
  "curator_reconciliation",
])

export const blastRadiusPathNodeSchema = z.strictObject({
  id: stableEntityIdSchema,
  applicationId: applicationIdSchema,
  kind: entityKindSchema,
  title: persistedTextSchema,
  evidenceTier: evidenceTierSchema,
  evidenceIds: uniqueValues(evidenceIdSchema, "Path-node evidence IDs").max(
    100
  ),
  provenance: provenanceSchema,
  reviewState: reviewStateSchema,
  graphRevision: z.number().int().nonnegative(),
})

export const blastRadiusPathRelationshipSchema = z.strictObject({
  id: evidenceIdSchema,
  applicationId: applicationIdSchema,
  type: evidenceRelationshipSchema,
  fromId: stableEntityIdSchema,
  toId: stableEntityIdSchema,
  evidenceTier: evidenceTierSchema,
  extractionMethod: reasonCodeSchema,
  evidenceIds: uniqueValues(evidenceIdSchema, "Path-relationship evidence IDs")
    .min(1)
    .max(100),
  sourceUris: uniqueValues(sourceUriSchema, "Path-relationship source URIs")
    .max(100)
    .default([]),
  artifactIds: uniqueValues(artifactIdSchema, "Path-relationship artifact IDs")
    .max(100)
    .default([]),
  provenance: z.array(provenanceSchema).min(1).max(100),
  reviewState: reviewStateSchema,
  graphRevision: z.number().int().nonnegative(),
  stale: z.boolean().default(false),
  conflictIds: uniqueValues(contentHashSchema, "Path conflict IDs").max(100),
})

export const blastRadiusCandidatePathSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: contentHashSchema,
    source: blastRadiusCandidateSourceSchema,
    applicationId: applicationIdSchema,
    graphRevision: z.number().int().nonnegative(),
    seedId: stableEntityIdSchema,
    targetId: stableEntityIdSchema,
    targetKind: entityKindSchema,
    changedSymbolIds: uniqueValues(
      codeSymbolIdSchema,
      "Candidate changed symbol IDs"
    )
      .min(1)
      .max(500),
    operations: uniqueValues(
      z.enum(["added", "modified", "deleted", "renamed", "moved"]),
      "Candidate change operations"
    )
      .min(1)
      .max(5),
    nodes: z
      .array(blastRadiusPathNodeSchema)
      .min(2)
      .max(MAX_BLAST_RADIUS_CANDIDATE_DEPTH + 1),
    relationships: z
      .array(blastRadiusPathRelationshipSchema)
      .min(1)
      .max(MAX_BLAST_RADIUS_CANDIDATE_DEPTH),
  })
  .superRefine((path, context) => {
    if (path.nodes[0]?.id !== path.seedId) {
      context.addIssue({
        code: "custom",
        path: ["seedId"],
        message: "Candidate seed must be the first path node",
      })
    }
    const last = path.nodes.at(-1)
    if (last?.id !== path.targetId || last.kind !== path.targetKind) {
      context.addIssue({
        code: "custom",
        path: ["targetId"],
        message: "Candidate target must be the final path node",
      })
    }
    if (path.relationships.length !== path.nodes.length - 1) {
      context.addIssue({
        code: "custom",
        path: ["relationships"],
        message: "Candidate paths require one relationship per node step",
      })
    }
  })

export const blastRadiusEvidencePathSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: contentHashSchema,
  semanticKey: contentHashSchema,
  applicationId: applicationIdSchema,
  graphRevision: z.number().int().positive(),
  seedId: stableEntityIdSchema,
  targetId: stableEntityIdSchema,
  targetKind: blastRadiusTargetKindSchema,
  changedSymbolIds: uniqueValues(
    codeSymbolIdSchema,
    "Evidence-path changed symbol IDs"
  )
    .min(1)
    .max(500),
  operations: uniqueValues(
    z.enum(["added", "modified", "deleted", "renamed", "moved"]),
    "Evidence-path operations"
  )
    .min(1)
    .max(5),
  evidenceStrength: evidenceTierSchema.exclude(["D"]),
  candidateIds: uniqueValues(contentHashSchema, "Corroborating candidate IDs")
    .min(1)
    .max(MAX_BLAST_RADIUS_CANDIDATES),
  evidenceIds: uniqueValues(evidenceIdSchema, "Evidence-path evidence IDs")
    .min(1)
    .max(1_000),
  provenance: z.array(provenanceSchema).min(1).max(1_000),
  nodes: z
    .array(blastRadiusPathNodeSchema)
    .min(2)
    .max(MAX_BLAST_RADIUS_PATH_DEPTH + 1),
  relationships: z
    .array(blastRadiusPathRelationshipSchema)
    .min(1)
    .max(MAX_BLAST_RADIUS_PATH_DEPTH),
})

export const blastRadiusCaveatCodeSchema = z.enum([
  "foreign_application",
  "stale_revision",
  "cycle_detected",
  "invalid_direction",
  "tier_d_evidence",
  "evidence_conflict",
  "review_unresolved",
  "disconnected_path",
  "depth_exceeded",
  "unsupported_target",
  "no_product_path",
])

export const blastRadiusCaveatSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: contentHashSchema,
  code: blastRadiusCaveatCodeSchema,
  candidateId: contentHashSchema.optional(),
  changedSymbolIds: uniqueValues(
    codeSymbolIdSchema,
    "Caveat changed symbol IDs"
  ).max(500),
  evidenceIds: uniqueValues(evidenceIdSchema, "Caveat evidence IDs").max(1_000),
  conflictIds: uniqueValues(contentHashSchema, "Caveat conflict IDs").max(100),
  summary: persistedTextSchema,
})

export const blastRadiusFactorCodeSchema = z.enum([
  "change_severity",
  "product_criticality",
  "path_directness",
  "affected_spread",
  "shared_fanout",
  "path_corroboration",
  "unmapped_change",
])

export const blastRadiusRiskFactorSchema = z.strictObject({
  code: blastRadiusFactorCodeSchema,
  points: z.number().int().min(0).max(10),
  value: reasonCodeSchema,
  relatedIds: uniqueValues(stableEntityIdSchema, "Risk-factor related IDs").max(
    500
  ),
})

export const blastRadiusScenarioKindSchema = z.enum([
  "ui_interaction",
  "workflow_checkpoint",
  "requirement_acceptance",
])

export const blastRadiusScenarioSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: contentHashSchema,
  kind: blastRadiusScenarioKindSchema,
  targetId: stableEntityIdSchema,
  workflowId: stableEntityIdSchema.optional(),
  requirementId: stableEntityIdSchema.optional(),
  checkpointEntityIds: uniqueValues(
    stableEntityIdSchema,
    "Scenario checkpoint IDs"
  )
    .min(1)
    .max(100),
  evidencePathIds: uniqueValues(contentHashSchema, "Scenario evidence paths")
    .min(1)
    .max(100),
  priority: riskSchema.exclude(["unknown"]),
})

export const blastRadiusFindingSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: contentHashSchema,
    targetId: stableEntityIdSchema.optional(),
    targetKind: z.union([blastRadiusTargetKindSchema, z.literal("unknown")]),
    title: persistedTextSchema,
    risk: riskSchema,
    evidenceStrength: evidenceTierSchema,
    criticality: blastRadiusCriticalitySchema,
    changedSymbolIds: uniqueValues(
      codeSymbolIdSchema,
      "Finding changed symbol IDs"
    ).max(500),
    evidencePathIds: uniqueValues(contentHashSchema, "Finding path IDs").max(
      MAX_BLAST_RADIUS_PATHS
    ),
    caveatIds: uniqueValues(contentHashSchema, "Finding caveat IDs").max(500),
    factors: z.array(blastRadiusRiskFactorSchema).min(1).max(20),
    scenarios: z.array(blastRadiusScenarioSchema).max(100),
    score: z.number().int().min(0).max(100),
  })
  .superRefine((finding, context) => {
    if (finding.risk === "unknown") {
      if (
        finding.targetKind !== "unknown" ||
        finding.targetId !== undefined ||
        finding.evidenceStrength !== "D" ||
        finding.evidencePathIds.length > 0 ||
        finding.scenarios.length > 0
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Unknown findings cannot claim a target, confident path, or scenario",
        })
      }
      return
    }
    if (
      finding.targetId !== undefined &&
      !String(finding.targetId).startsWith(`${finding.targetKind}:v1:`)
    ) {
      context.addIssue({
        code: "custom",
        path: ["targetId"],
        message: "Finding target identity must match its kind",
      })
    }
    if (
      finding.targetKind === "unknown" ||
      finding.targetId === undefined ||
      finding.evidenceStrength === "D" ||
      finding.evidencePathIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Confident findings require a target and inspectable non-Tier-D path",
      })
    }
  })

export const blastRadiusCriticalityInputSchema = z.strictObject({
  entityId: stableEntityIdSchema,
  criticality: blastRadiusCriticalitySchema,
})

export const blastRadiusInputSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    applicationId: applicationIdSchema,
    assessmentId: z.uuid(),
    pullRequestId: pullRequestIdSchema,
    graphRevision: z.number().int().positive(),
    graphCommitSha: commitShaSchema,
    policyVersion: z.literal(BLAST_RADIUS_POLICY_VERSION),
    candidates: z
      .array(blastRadiusCandidatePathSchema)
      .max(MAX_BLAST_RADIUS_CANDIDATES),
    unknowns: z.array(prInvestigationUnknownSchema).max(10_000),
    criticalities: z.array(blastRadiusCriticalityInputSchema).max(10_000),
  })
  .superRefine((input, context) => {
    const candidateIds = input.candidates.map(({ id }) => id)
    if (new Set(candidateIds).size !== candidateIds.length) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Blast-radius candidate IDs must be unique",
      })
    }
    const changedSymbolIds = new Set(
      input.candidates.flatMap(({ changedSymbolIds }) => changedSymbolIds)
    )
    if (changedSymbolIds.size > 500) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Blast-radius input exceeds the changed-symbol limit",
      })
    }
    const ids = input.criticalities.map(({ entityId }) => entityId)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["criticalities"],
        message: "Criticality inputs must identify unique entities",
      })
    }
  })

export const blastRadiusResultSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: contentHashSchema,
    applicationId: applicationIdSchema,
    assessmentId: z.uuid(),
    pullRequestId: pullRequestIdSchema,
    graphRevision: z.number().int().positive(),
    graphCommitSha: commitShaSchema,
    policyVersion: z.literal(BLAST_RADIUS_POLICY_VERSION),
    evidencePaths: z
      .array(blastRadiusEvidencePathSchema)
      .max(MAX_BLAST_RADIUS_PATHS),
    caveats: z.array(blastRadiusCaveatSchema).max(MAX_BLAST_RADIUS_CAVEATS),
    findings: z.array(blastRadiusFindingSchema).max(MAX_BLAST_RADIUS_FINDINGS),
    summary: z.strictObject({
      high: z.number().int().nonnegative(),
      medium: z.number().int().nonnegative(),
      low: z.number().int().nonnegative(),
      unknown: z.number().int().nonnegative(),
    }),
  })
  .superRefine((result, context) => {
    const pathIds = new Set(result.evidencePaths.map(({ id }) => id))
    const caveatIds = new Set(result.caveats.map(({ id }) => id))
    const findingIds = result.findings.map(({ id }) => id)
    if (pathIds.size !== result.evidencePaths.length) {
      context.addIssue({
        code: "custom",
        path: ["evidencePaths"],
        message: "Result path IDs must be unique",
      })
    }
    if (caveatIds.size !== result.caveats.length) {
      context.addIssue({
        code: "custom",
        path: ["caveats"],
        message: "Result caveat IDs must be unique",
      })
    }
    if (new Set(findingIds).size !== findingIds.length) {
      context.addIssue({
        code: "custom",
        path: ["findings"],
        message: "Result finding IDs must be unique",
      })
    }
    for (const [index, finding] of result.findings.entries()) {
      if (finding.evidencePathIds.some((id) => !pathIds.has(id))) {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "evidencePathIds"],
          message: "Finding references an unknown evidence path",
        })
      }
      if (finding.caveatIds.some((id) => !caveatIds.has(id))) {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "caveatIds"],
          message: "Finding references an unknown caveat",
        })
      }
      for (const [scenarioIndex, scenario] of finding.scenarios.entries()) {
        if (scenario.evidencePathIds.some((id) => !pathIds.has(id))) {
          context.addIssue({
            code: "custom",
            path: [
              "findings",
              index,
              "scenarios",
              scenarioIndex,
              "evidencePathIds",
            ],
            message: "Scenario references an unknown evidence path",
          })
        }
      }
    }
    for (const risk of riskSchema.options) {
      const expected = result.findings.filter(
        (finding) => finding.risk === risk
      ).length
      if (result.summary[risk] !== expected) {
        context.addIssue({
          code: "custom",
          path: ["summary", risk],
          message: "Blast-radius summary count is inconsistent",
        })
      }
    }
  })

export type BlastRadiusTargetKind = z.infer<typeof blastRadiusTargetKindSchema>
export type BlastRadiusCriticality = z.infer<
  typeof blastRadiusCriticalitySchema
>
export type BlastRadiusPathNode = z.infer<typeof blastRadiusPathNodeSchema>
export type BlastRadiusPathRelationship = z.infer<
  typeof blastRadiusPathRelationshipSchema
>
export type BlastRadiusCandidatePath = z.infer<
  typeof blastRadiusCandidatePathSchema
>
export type BlastRadiusEvidencePath = z.infer<
  typeof blastRadiusEvidencePathSchema
>
export type BlastRadiusCaveat = z.infer<typeof blastRadiusCaveatSchema>
export type BlastRadiusCaveatCode = z.infer<typeof blastRadiusCaveatCodeSchema>
export type BlastRadiusRiskFactor = z.infer<typeof blastRadiusRiskFactorSchema>
export type BlastRadiusScenario = z.infer<typeof blastRadiusScenarioSchema>
export type BlastRadiusFinding = z.infer<typeof blastRadiusFindingSchema>
export type BlastRadiusInput = z.infer<typeof blastRadiusInputSchema>
export type BlastRadiusResult = z.infer<typeof blastRadiusResultSchema>
