import { z } from "zod"

import { evidenceLinkSchema } from "./assessment.ts"
import {
  evidenceCandidateIdSchema,
  pendingEvidenceLinkBatchSchema,
} from "./evidence-linking.ts"
import {
  discoveryMissionSchema,
  missionBudgetSchema,
  missionModeSchema,
} from "./operations.ts"
import {
  agentKindSchema,
  applicationIdSchema,
  contentHashSchema,
  evidenceIdSchema,
  hostnameSchema,
  missionIdSchema,
  persistedTextSchema,
  reasonCodeSchema,
  repositoryPathSchema,
  runIdSchema,
  schemaVersionSchema,
  sourceUriSchema,
  stableEntityIdSchema,
  terminalStatusSchema,
  timestampSchema,
} from "./primitives.ts"

export const EVIDENCE_CURATOR_SCHEMA_VERSION = 1 as const
export const MAX_CURATOR_MISSIONS_PER_ROUND = 12 as const

export const coverageEntityKindSchema = z.enum([
  "requirement",
  "workflow",
  "flow-step",
  "screen",
  "ui-element",
  "frontend-route",
  "api-endpoint",
  "code-symbol",
  "pull-request",
])

export const coverageEntitySchema = z
  .strictObject({
    id: stableEntityIdSchema,
    applicationId: applicationIdSchema,
    kind: coverageEntityKindSchema,
    evidenceIds: z
      .array(evidenceIdSchema)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Coverage entity evidence IDs must be unique",
      }),
    behavioral: z.boolean().default(false),
    changed: z.boolean().default(false),
  })
  .superRefine(({ id, kind }, context) => {
    if (!id.startsWith(`${kind}:v1:`)) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "Coverage entity ID must match its kind",
      })
    }
  })

export const evidenceReviewDecisionSchema = z.strictObject({
  targetKind: z.enum(["candidate", "conflict"]),
  targetId: z.union([evidenceCandidateIdSchema, contentHashSchema]),
  approved: z.boolean(),
  reason: persistedTextSchema,
  actorId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9:._-]+$/),
  decidedAt: timestampSchema,
})

export const coverageMatrixInputSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    applicationId: applicationIdSchema,
    runId: runIdSchema,
    evidenceStateId: contentHashSchema,
    entities: z.array(coverageEntitySchema).max(20_000),
    currentLinks: z.array(evidenceLinkSchema).max(20_000),
    pendingBatch: pendingEvidenceLinkBatchSchema,
    staleEvidenceIds: z
      .array(evidenceIdSchema)
      .max(10_000)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Stale evidence IDs must be unique",
      }),
    reviewDecisions: z.array(evidenceReviewDecisionSchema).max(10_000),
  })
  .superRefine((input, context) => {
    if (
      input.pendingBatch.applicationId !== input.applicationId ||
      input.pendingBatch.runId !== input.runId
    ) {
      context.addIssue({
        code: "custom",
        path: ["pendingBatch"],
        message: "Pending evidence batch must belong to the coverage run",
      })
    }
    const entityIds = input.entities.map(({ id }) => id)
    if (new Set(entityIds).size !== entityIds.length) {
      context.addIssue({
        code: "custom",
        path: ["entities"],
        message: "Coverage entity IDs must be unique",
      })
    }
    for (const [index, entity] of input.entities.entries()) {
      if (entity.applicationId !== input.applicationId) {
        context.addIssue({
          code: "custom",
          path: ["entities", index, "applicationId"],
          message: "Coverage entities cannot cross application namespaces",
        })
      }
    }
    for (const [index, link] of input.currentLinks.entries()) {
      if (link.applicationId !== input.applicationId) {
        context.addIssue({
          code: "custom",
          path: ["currentLinks", index, "applicationId"],
          message: "Current links cannot cross application namespaces",
        })
      }
    }
  })

export const coverageGapKindSchema = z.enum([
  "requirement_without_workflow",
  "workflow_without_ui",
  "workflow_without_code",
  "endpoint_without_code",
  "code_without_intent",
  "changed_symbol_without_product_path",
  "conflict",
  "stale_evidence",
  "human_review_required",
])

export const coverageGapSchema = z
  .strictObject({
    id: contentHashSchema,
    kind: coverageGapKindSchema,
    subjectIds: z.array(stableEntityIdSchema).min(1).max(100),
    evidenceIds: z.array(evidenceIdSchema).max(200),
    candidateIds: z.array(evidenceCandidateIdSchema).max(100),
    conflictIds: z.array(contentHashSchema).max(100),
    summary: persistedTextSchema,
    requiresHuman: z.boolean(),
    recommendedAgent: agentKindSchema.exclude(["curator", "system"]).optional(),
    allowedModes: z.array(missionModeSchema).max(5),
  })
  .superRefine((gap, context) => {
    if (
      gap.requiresHuman &&
      (gap.recommendedAgent !== undefined || gap.allowedModes.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Human gaps cannot grant specialist dispatch authority",
      })
    }
    if (
      !gap.requiresHuman &&
      (gap.recommendedAgent === undefined || gap.allowedModes.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Automated gaps require a bounded specialist recommendation",
      })
    }
  })

export const publicationReadinessSchema = z.enum([
  "ready",
  "needs_reconciliation",
  "needs_human",
  "blocked",
])

export const coverageMatrixSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  applicationId: applicationIdSchema,
  runId: runIdSchema,
  evidenceStateId: contentHashSchema,
  evidenceFingerprint: contentHashSchema,
  gaps: z.array(coverageGapSchema).max(10_000),
  stats: z.strictObject({
    entityCount: z.number().int().nonnegative(),
    confidentLinkCount: z.number().int().nonnegative(),
    requirementCount: z.number().int().nonnegative(),
    workflowCount: z.number().int().nonnegative(),
    endpointCount: z.number().int().nonnegative(),
    codeSymbolCount: z.number().int().nonnegative(),
    gapCount: z.number().int().nonnegative(),
    humanGapCount: z.number().int().nonnegative(),
  }),
  readiness: publicationReadinessSchema,
  publicationReady: z.boolean(),
})

export const curatorAgentPolicySchema = z.strictObject({
  agent: agentKindSchema.exclude(["curator", "system"]),
  modes: z.array(missionModeSchema).min(1).max(8),
  allowedRepositoryPaths: z.array(repositoryPathSchema).max(100),
  allowedSourceUris: z.array(sourceUriSchema).max(100),
  allowedHosts: z.array(hostnameSchema).max(50),
  allowedTools: z.array(reasonCodeSchema).min(1).max(50),
  maxMissionBudget: missionBudgetSchema,
  maxMissionsPerRound: z
    .number()
    .int()
    .positive()
    .max(MAX_CURATOR_MISSIONS_PER_ROUND),
})

export const curatorModelRequestSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  applicationId: applicationIdSchema,
  runId: runIdSchema,
  round: z.number().int().positive(),
  matrix: coverageMatrixSchema,
  remainingBudget: missionBudgetSchema,
  policies: z.array(curatorAgentPolicySchema).min(1).max(3),
  priorMissionIds: z.array(missionIdSchema).max(500),
})

export const curatorMissionProposalSchema = z.strictObject({
  gapId: contentHashSchema,
  mission: discoveryMissionSchema,
})

export const curatorModelOutputSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    missions: z
      .array(curatorMissionProposalSchema)
      .max(MAX_CURATOR_MISSIONS_PER_ROUND),
  })
  .superRefine(({ missions }, context) => {
    const missionIds = missions.map(({ mission }) => mission.id)
    if (new Set(missionIds).size !== missionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["missions"],
        message: "Curator mission IDs must be unique",
      })
    }
  })

export const curatorMissionRejectionCodeSchema = z.enum([
  "model_output_invalid",
  "unknown_gap",
  "human_gap",
  "agent_not_allowed",
  "mode_not_allowed",
  "scope_not_allowed",
  "tool_not_allowed",
  "mission_budget_exceeded",
  "global_budget_exceeded",
  "duplicate_mission",
  "redundant_mission",
  "round_limit_exceeded",
])

export const curatorMissionRejectionSchema = z.strictObject({
  id: contentHashSchema,
  round: z.number().int().positive(),
  missionId: missionIdSchema.optional(),
  gapId: contentHashSchema.optional(),
  code: curatorMissionRejectionCodeSchema,
  summary: persistedTextSchema,
})

export const curatorMissionReceiptSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  round: z.number().int().positive(),
  gapId: contentHashSchema,
  missionId: missionIdSchema,
  agent: agentKindSchema.exclude(["curator", "system"]),
  mode: missionModeSchema,
  status: terminalStatusSchema,
  resultFingerprint: contentHashSchema,
  evidenceIds: z.array(evidenceIdSchema).max(100),
  budgetUsed: missionBudgetSchema,
})

export const curatorReviewRecordSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  decisionId: reasonCodeSchema,
  gapId: contentHashSchema,
  targetKind: z.enum(["candidate", "conflict"]),
  targetId: z.union([evidenceCandidateIdSchema, contentHashSchema]),
  status: z.enum(["pending", "accepted", "rejected"]),
  actorId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9:._-]+$/)
    .optional(),
  reason: persistedTextSchema.optional(),
})

export const reconciliationEventKindSchema = z.enum([
  "coverage_built",
  "mission_proposed",
  "mission_rejected",
  "mission_dispatched",
  "mission_completed",
  "evidence_relinked",
  "human_review_requested",
  "human_review_resumed",
  "reconciliation_stopped",
])

export const reconciliationEventSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: contentHashSchema,
  applicationId: applicationIdSchema,
  runId: runIdSchema,
  round: z.number().int().nonnegative(),
  kind: reconciliationEventKindSchema,
  summary: persistedTextSchema,
  reasonCode: reasonCodeSchema,
  gapId: contentHashSchema.optional(),
  missionId: missionIdSchema.optional(),
  agent: agentKindSchema.exclude(["curator", "system"]).optional(),
  evidenceGain: z.number().int().nonnegative().optional(),
  occurredAt: timestampSchema,
})

export const evidenceCuratorStopReasonSchema = z.enum([
  "evidence_sufficient",
  "no_material_evidence_gain",
  "maximum_rounds_reached",
  "global_budget_exhausted",
  "no_valid_missions",
  "human_review_rejected",
  "human_review_resolved",
])

export const evidenceCuratorResultSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  applicationId: applicationIdSchema,
  runId: runIdSchema,
  status: z.enum(["complete", "unresolved", "needs_human"]),
  stopReason: evidenceCuratorStopReasonSchema,
  roundsUsed: z.number().int().nonnegative(),
  budgetUsed: missionBudgetSchema,
  matrix: coverageMatrixSchema,
  missionReceipts: z.array(curatorMissionReceiptSchema).max(500),
  missionRejections: z.array(curatorMissionRejectionSchema).max(500),
  reviews: z.array(curatorReviewRecordSchema).max(500),
})

export type CoverageEntity = z.infer<typeof coverageEntitySchema>
export type EvidenceReviewDecision = z.infer<
  typeof evidenceReviewDecisionSchema
>
export type CoverageMatrixInput = z.infer<typeof coverageMatrixInputSchema>
export type CoverageGap = z.infer<typeof coverageGapSchema>
export type CoverageMatrix = z.infer<typeof coverageMatrixSchema>
export type CuratorAgentPolicy = z.infer<typeof curatorAgentPolicySchema>
export type CuratorModelRequest = z.infer<typeof curatorModelRequestSchema>
export type CuratorMissionProposal = z.infer<
  typeof curatorMissionProposalSchema
>
export type CuratorModelOutput = z.infer<typeof curatorModelOutputSchema>
export type CuratorMissionRejection = z.infer<
  typeof curatorMissionRejectionSchema
>
export type CuratorMissionReceipt = z.infer<typeof curatorMissionReceiptSchema>
export type CuratorReviewRecord = z.infer<typeof curatorReviewRecordSchema>
export type ReconciliationEvent = z.infer<typeof reconciliationEventSchema>
export type EvidenceCuratorResult = z.infer<typeof evidenceCuratorResultSchema>
