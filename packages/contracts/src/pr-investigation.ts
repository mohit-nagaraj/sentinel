import { z } from "zod"

import {
  baselineCompatibilitySchema,
  changedFileClassificationSchema,
  changedFileUnresolvedReasonSchema,
  prDiffAnalysisSchema,
  pullRequestSchema,
} from "./assessment.ts"
import {
  codeProposedClaimSchema,
  codeUnresolvedBoundarySchema,
} from "./code-explorer.ts"
import { evidenceCuratorResultSchema } from "./evidence-curator.ts"
import { graphEvidencePathSchema } from "./graph-publication.ts"
import { missionBudgetSchema } from "./operations.ts"
import {
  apiEndpointIdSchema,
  applicationIdSchema,
  codeSymbolIdSchema,
  claimIdSchema,
  commitShaSchema,
  contentHashSchema,
  domainEntityIdSchema,
  evidenceIdSchema,
  missionIdSchema,
  persistedTextSchema,
  publicHttpUrlSchema,
  reasonCodeSchema,
  repositoryPathSchema,
  runIdSchema,
  schemaVersionSchema,
  stableEntityIdSchema,
  terminalStatusSchema,
} from "./primitives.ts"

export const PR_INVESTIGATION_SCHEMA_VERSION = 1 as const
export const MAX_PR_INVESTIGATION_GROUPS = 24 as const
export const MAX_PR_SYMBOLS_PER_GROUP = 40 as const
export const MAX_PR_INVESTIGATED_SYMBOLS = 500 as const
export const MAX_PR_INVESTIGATION_PATHS = 200 as const
export const MAX_PR_OVERLAY_CLAIMS = 5_000 as const

function uniqueValues<T extends z.ZodType>(schema: T, label: string) {
  return z
    .array(schema)
    .refine((values) => new Set(values.map(String)).size === values.length, {
      message: `${label} must be unique`,
    })
}

export const prInvestigationGroupingReasonSchema = z.enum([
  "same_file",
  "structural_parent",
  "shared_endpoint",
  "shared_domain_entity",
  "standalone_change",
])

export const prInvestigationRelationshipHintSchema = z.strictObject({
  symbolId: codeSymbolIdSchema,
  endpointIds: uniqueValues(apiEndpointIdSchema, "Hint endpoint IDs")
    .max(50)
    .default([]),
  domainEntityIds: uniqueValues(domainEntityIdSchema, "Hint domain entity IDs")
    .max(50)
    .default([]),
})

export const prInvestigationChangeGroupSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: contentHashSchema,
  symbolIds: uniqueValues(codeSymbolIdSchema, "Change-group symbol IDs")
    .min(1)
    .max(MAX_PR_SYMBOLS_PER_GROUP),
  filePaths: uniqueValues(repositoryPathSchema, "Change-group file paths").max(
    100
  ),
  endpointIds: uniqueValues(
    apiEndpointIdSchema,
    "Change-group endpoint IDs"
  ).max(100),
  domainEntityIds: uniqueValues(
    domainEntityIdSchema,
    "Change-group domain entity IDs"
  ).max(100),
  operations: uniqueValues(
    z.enum(["added", "modified", "deleted", "renamed", "moved"]),
    "Change-group operations"
  )
    .min(1)
    .max(5),
  groupingReasons: uniqueValues(
    prInvestigationGroupingReasonSchema,
    "Change-group reasons"
  ).min(1),
})

export const prInvestigationUnknownSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: contentHashSchema,
  kind: z.enum(["file", "symbol"]),
  filePaths: uniqueValues(repositoryPathSchema, "Unknown file paths").max(100),
  symbolIds: uniqueValues(codeSymbolIdSchema, "Unknown symbol IDs").max(100),
  classifications: uniqueValues(
    changedFileClassificationSchema,
    "Unknown classifications"
  ).max(7),
  unresolvedReasons: uniqueValues(
    z.union([
      changedFileUnresolvedReasonSchema,
      z.enum([
        "investigation_group_limit",
        "investigation_symbol_limit",
        "code_investigation_incomplete",
        "code_investigation_unresolved",
        "graph_path_missing",
        "configuration_change",
        "schema_change",
        "generated_change",
        "lockfile_change",
        "binary_change",
        "unsupported_change",
      ]),
    ]),
    "Unknown reasons"
  ).min(1),
  summary: persistedTextSchema,
})

export const prInvestigationBaselineOutcomeSchema = z
  .strictObject({
    disposition: z.enum(["proceed", "proceed_with_warning", "action_required"]),
    action: z.enum(["none", "refresh_graph", "reconnect_baseline"]),
    compatibility: baselineCompatibilitySchema,
  })
  .superRefine((value, context) => {
    const expected = value.compatibility.assessmentAllowed
      ? value.compatibility.status === "exact"
        ? { disposition: "proceed", action: "none" }
        : { disposition: "proceed_with_warning", action: "none" }
      : value.compatibility.status === "stale_relevant"
        ? { disposition: "action_required", action: "refresh_graph" }
        : { disposition: "action_required", action: "reconnect_baseline" }
    if (
      value.disposition !== expected.disposition ||
      value.action !== expected.action
    ) {
      context.addIssue({
        code: "custom",
        message: "Baseline outcome does not match compatibility policy",
      })
    }
  })

export const prInvestigationWorkerReceiptSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  groupId: contentHashSchema,
  missionId: missionIdSchema,
  resultId: contentHashSchema,
  status: terminalStatusSchema,
  evidenceIds: uniqueValues(evidenceIdSchema, "Worker evidence IDs").max(100),
  unresolvedCount: z.number().int().nonnegative(),
  budgetUsed: missionBudgetSchema,
})

export const prInvestigationGraphPathSchema = z.strictObject({
  id: contentHashSchema,
  changedSymbolIds: uniqueValues(
    codeSymbolIdSchema,
    "Graph-path changed symbol IDs"
  )
    .min(1)
    .max(MAX_PR_SYMBOLS_PER_GROUP),
  path: graphEvidencePathSchema,
})

export const prInvestigationOverlaySchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: contentHashSchema,
    mode: z.literal("assessment_only"),
    applicationId: applicationIdSchema,
    runId: runIdSchema,
    pullRequestId: stableEntityIdSchema.refine(
      (id) => String(id).startsWith("pull-request:v1:"),
      "Overlay pull request identity is invalid"
    ),
    graphRevision: z.number().int().positive(),
    graphCommitSha: commitShaSchema,
    diffAnalysisId: contentHashSchema,
    codeResultIds: uniqueValues(
      contentHashSchema,
      "Overlay code result IDs"
    ).max(MAX_PR_INVESTIGATION_GROUPS),
    graphPaths: z
      .array(prInvestigationGraphPathSchema)
      .max(MAX_PR_INVESTIGATION_PATHS),
    proposedClaims: z.array(codeProposedClaimSchema).max(MAX_PR_OVERLAY_CLAIMS),
    validatedClaimIds: uniqueValues(
      claimIdSchema,
      "Overlay validated claim IDs"
    ).max(MAX_PR_OVERLAY_CLAIMS),
    rejectedClaimIds: uniqueValues(
      claimIdSchema,
      "Overlay rejected claim IDs"
    ).max(MAX_PR_OVERLAY_CLAIMS),
    conflictIds: uniqueValues(contentHashSchema, "Overlay conflict IDs").max(
      5_000
    ),
    unresolvedBoundaries: z.array(codeUnresolvedBoundarySchema).max(2_400),
    unknowns: z.array(prInvestigationUnknownSchema).max(10_000),
    curatorEvidenceStateId: contentHashSchema,
  })
  .superRefine((overlay, context) => {
    const proposed = new Set(overlay.proposedClaims.map(({ id }) => id))
    const validated = new Set(overlay.validatedClaimIds)
    for (const [field, ids] of [
      ["validatedClaimIds", overlay.validatedClaimIds],
      ["rejectedClaimIds", overlay.rejectedClaimIds],
    ] as const) {
      if (ids.some((id) => !proposed.has(id))) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Overlay validation IDs must reference proposed claims",
        })
      }
    }
    if (overlay.rejectedClaimIds.some((id) => validated.has(id))) {
      context.addIssue({
        code: "custom",
        path: ["rejectedClaimIds"],
        message: "Overlay claims cannot be both validated and rejected",
      })
    }
    if (
      overlay.validatedClaimIds.length + overlay.rejectedClaimIds.length >
      MAX_PR_OVERLAY_CLAIMS
    ) {
      context.addIssue({
        code: "custom",
        path: ["validatedClaimIds"],
        message:
          "Overlay validation decisions exceed the aggregate claim limit",
      })
    }
  })

export const prImpactHypothesisSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: contentHashSchema,
    status: z.enum(["mapped", "unknown"]),
    changedSymbolIds: uniqueValues(
      codeSymbolIdSchema,
      "Hypothesis changed symbol IDs"
    ).max(MAX_PR_SYMBOLS_PER_GROUP),
    affectedEntityIds: uniqueValues(
      stableEntityIdSchema,
      "Hypothesis affected entity IDs"
    ).max(500),
    graphPathIds: uniqueValues(
      contentHashSchema,
      "Hypothesis graph path IDs"
    ).max(MAX_PR_INVESTIGATION_PATHS),
    evidenceIds: uniqueValues(evidenceIdSchema, "Hypothesis evidence IDs").max(
      1_000
    ),
    reasonCodes: uniqueValues(reasonCodeSchema, "Hypothesis reasons").min(1),
  })
  .superRefine((value, context) => {
    if (
      value.status === "mapped" &&
      (value.changedSymbolIds.length === 0 ||
        value.affectedEntityIds.length === 0 ||
        value.graphPathIds.length === 0 ||
        value.evidenceIds.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Mapped hypotheses require symbols, targets, paths, and evidence",
      })
    }
    if (
      value.status === "unknown" &&
      (value.affectedEntityIds.length > 0 || value.graphPathIds.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Unknown hypotheses cannot claim mapped targets or paths",
      })
    }
  })

export const trustedHeadDeploymentSchema = z.strictObject({
  url: publicHttpUrlSchema,
  headSha: commitShaSchema,
  trust: z.literal("trusted_exact_head"),
})

export const prVerificationMissionCandidateSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: contentHashSchema,
  sourceHypothesisIds: uniqueValues(
    contentHashSchema,
    "Verification source hypothesis IDs"
  ).min(1),
  workflowIds: uniqueValues(
    stableEntityIdSchema.refine(
      (id) => String(id).startsWith("workflow:v1:"),
      "Verification workflow identity is invalid"
    ),
    "Verification workflow IDs"
  ).min(1),
  requirementIds: uniqueValues(
    stableEntityIdSchema.refine(
      (id) => String(id).startsWith("requirement:v1:"),
      "Verification requirement identity is invalid"
    ),
    "Verification requirement IDs"
  ),
  deployment: trustedHeadDeploymentSchema,
  goal: persistedTextSchema,
})

export const prInvestigationStartInputSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    assessmentId: z.uuid(),
    runId: runIdSchema,
    applicationId: applicationIdSchema,
    pullRequest: pullRequestSchema,
    graphRevision: z.number().int().positive(),
    graphCommitSha: commitShaSchema,
    repositoryPaths: uniqueValues(
      repositoryPathSchema,
      "Investigation repository paths"
    )
      .min(1)
      .max(100),
    budget: missionBudgetSchema,
    startedAtMs: z.number().int().nonnegative(),
  })
  .superRefine((value, context) => {
    if (value.pullRequest.applicationId !== value.applicationId) {
      context.addIssue({
        code: "custom",
        path: ["pullRequest", "applicationId"],
        message: "Pull request must belong to the investigation application",
      })
    }
  })

const resultIdentityFields = {
  schemaVersion: schemaVersionSchema,
  id: contentHashSchema,
  assessmentId: z.uuid(),
  applicationId: applicationIdSchema,
  runId: runIdSchema,
  pullRequest: pullRequestSchema,
  graphRevision: z.number().int().positive(),
  graphCommitSha: commitShaSchema,
  diffAnalysisId: contentHashSchema,
  baseline: prInvestigationBaselineOutcomeSchema,
  completedAt: z.iso.datetime({ offset: true }),
}

export const prInvestigationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...resultIdentityFields,
    status: z.literal("action_required"),
    groups: z.array(prInvestigationChangeGroupSchema).max(0),
    workerReceipts: z.array(prInvestigationWorkerReceiptSchema).max(0),
    overlayId: z.null(),
    curatorResult: z.null(),
    hypotheses: z.array(prImpactHypothesisSchema).max(0),
    verificationCandidates: z
      .array(prVerificationMissionCandidateSchema)
      .max(0),
    unknowns: z.array(prInvestigationUnknownSchema).max(10_000),
  }),
  z.strictObject({
    ...resultIdentityFields,
    status: z.literal("completed"),
    groups: z
      .array(prInvestigationChangeGroupSchema)
      .max(MAX_PR_INVESTIGATION_GROUPS),
    workerReceipts: z
      .array(prInvestigationWorkerReceiptSchema)
      .max(MAX_PR_INVESTIGATION_GROUPS),
    overlayId: contentHashSchema,
    curatorResult: evidenceCuratorResultSchema,
    hypotheses: z.array(prImpactHypothesisSchema).max(10_000),
    verificationCandidates: z
      .array(prVerificationMissionCandidateSchema)
      .max(1_000),
    unknowns: z.array(prInvestigationUnknownSchema).max(10_000),
  }),
])

export const prInvestigationPreparedInputSchema = z
  .strictObject({
    analysis: prDiffAnalysisSchema,
    hints: z
      .array(prInvestigationRelationshipHintSchema)
      .max(MAX_PR_INVESTIGATED_SYMBOLS),
  })
  .superRefine(({ hints }, context) => {
    const ids = hints.map(({ symbolId }) => symbolId)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["hints"],
        message: "PR relationship hints must identify unique symbols",
      })
    }
  })

export type PrInvestigationRelationshipHint = z.infer<
  typeof prInvestigationRelationshipHintSchema
>
export type PrInvestigationChangeGroup = z.infer<
  typeof prInvestigationChangeGroupSchema
>
export type PrInvestigationUnknown = z.infer<
  typeof prInvestigationUnknownSchema
>
export type PrInvestigationBaselineOutcome = z.infer<
  typeof prInvestigationBaselineOutcomeSchema
>
export type PrInvestigationWorkerReceipt = z.infer<
  typeof prInvestigationWorkerReceiptSchema
>
export type PrInvestigationGraphPath = z.infer<
  typeof prInvestigationGraphPathSchema
>
export type PrInvestigationOverlay = z.infer<
  typeof prInvestigationOverlaySchema
>
export type PrImpactHypothesis = z.infer<typeof prImpactHypothesisSchema>
export type TrustedHeadDeployment = z.infer<typeof trustedHeadDeploymentSchema>
export type PrVerificationMissionCandidate = z.infer<
  typeof prVerificationMissionCandidateSchema
>
export type PrInvestigationStartInput = z.infer<
  typeof prInvestigationStartInputSchema
>
export type PrInvestigationResult = z.infer<typeof prInvestigationResultSchema>
