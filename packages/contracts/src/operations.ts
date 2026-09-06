import { z } from "zod"

import {
  agentKindSchema,
  applicationIdSchema,
  claimIdSchema,
  commitShaSchema,
  contentHashSchema,
  evidenceIdSchema,
  hostnameSchema,
  missionIdSchema,
  persistedTextSchema,
  publicHttpUrlSchema,
  reasonCodeSchema,
  repositoryIdentitySchema,
  repositoryPathSchema,
  runIdSchema,
  runStatusSchema,
  runTypeSchema,
  schemaVersionSchema,
  secretReferenceSchema,
  shortTextSchema,
  sourceUriSchema,
  stableEntityIdSchema,
  terminalStatusSchema,
  timestampSchema,
} from "./primitives.ts"

export const applicationStatusSchema = z.enum([
  "not_configured",
  "inspecting",
  "awaiting_confirmation",
  "initializing_knowledge",
  "ready",
  "assessing_pr",
  "verifying",
  "refreshing",
  "needs_review",
  "stale",
  "failed",
])

export const applicationSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: applicationIdSchema,
  name: shortTextSchema,
  deploymentUrl: publicHttpUrlSchema,
  status: applicationStatusSchema,
  indexedCommitSha: commitShaSchema.optional(),
  graphRevision: z.number().int().nonnegative(),
  refreshedAt: timestampSchema.optional(),
})

export const sourceKindSchema = z.enum([
  "repository",
  "documentation",
  "application",
])

export const sourceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: stableEntityIdSchema,
  applicationId: applicationIdSchema,
  kind: sourceKindSchema,
  uri: sourceUriSchema,
  status: z.enum(["pending", "ready", "warning", "blocked", "failed"]),
  contentHash: contentHashSchema.optional(),
  secretReference: secretReferenceSchema.optional(),
  checkedAt: timestampSchema.optional(),
})

export const commitReferenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  repository: repositoryIdentitySchema,
  sha: commitShaSchema,
  ref: z.string().trim().min(1).max(255).optional(),
})

export const runSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: runIdSchema,
  applicationId: applicationIdSchema,
  type: runTypeSchema,
  status: runStatusSchema,
  idempotencyKey: persistedTextSchema,
  budget: z.lazy(() => executionBudgetSchema),
  createdAt: timestampSchema,
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional(),
})

export const missionModeSchema = z.enum([
  "baseline_discovery",
  "targeted_requirement_lookup",
  "conflict_resolution",
  "baseline_architecture_discovery",
  "implementation_trace",
  "pr_change_investigation",
  "unmapped_endpoint_resolution",
  "workflow_discovery",
  "targeted_requirement_observation",
  "pr_change_validation",
  "flow_recovery",
])

export const executionBudgetSchema = z.strictObject({
  toolCalls: z.number().int().nonnegative(),
  contentBytes: z.number().int().nonnegative(),
  documentBytes: z.number().int().nonnegative(),
  documentPages: z.number().int().nonnegative(),
  documentSections: z.number().int().nonnegative(),
  sourceLines: z.number().int().nonnegative(),
  repositoryBytes: z.number().int().nonnegative(),
  repositoryFiles: z.number().int().nonnegative(),
  browserActions: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  modelInputTokens: z.number().int().nonnegative(),
  modelOutputTokens: z.number().int().nonnegative(),
  reconciliationRounds: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
})

export const missionBudgetSchema = executionBudgetSchema

export const missionScopeSchema = z.strictObject({
  repositoryPaths: z.array(repositoryPathSchema).max(100).default([]),
  sourceUris: z.array(sourceUriSchema).max(100).default([]),
  allowedHosts: z.array(hostnameSchema).max(50).default([]),
  allowedTools: z.array(reasonCodeSchema).min(1).max(50),
})

const modesByAgent = {
  documentation: new Set([
    "baseline_discovery",
    "targeted_requirement_lookup",
    "conflict_resolution",
  ]),
  code: new Set([
    "baseline_architecture_discovery",
    "implementation_trace",
    "pr_change_investigation",
    "unmapped_endpoint_resolution",
  ]),
  application: new Set([
    "workflow_discovery",
    "targeted_requirement_observation",
    "pr_change_validation",
    "flow_recovery",
  ]),
} as const

export const discoveryMissionSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: missionIdSchema,
    runId: runIdSchema,
    applicationId: applicationIdSchema,
    agent: agentKindSchema.exclude(["curator", "system"]),
    mode: missionModeSchema,
    goal: persistedTextSchema,
    seedEvidenceIds: z.array(evidenceIdSchema).max(100),
    questions: z.array(persistedTextSchema).min(1).max(20),
    scope: missionScopeSchema,
    budget: missionBudgetSchema,
    successCriteria: z.array(persistedTextSchema).min(1).max(20),
  })
  .superRefine(({ agent, mode }, context) => {
    if (!modesByAgent[agent].has(mode)) {
      context.addIssue({
        code: "custom",
        message: `Mode ${mode} is not allowed for ${agent} missions`,
        path: ["mode"],
      })
    }
  })

export const unresolvedQuestionSchema = z.strictObject({
  question: persistedTextSchema,
  reasonCode: reasonCodeSchema,
  evidenceIds: z.array(evidenceIdSchema).max(100),
})

export const proposedClaimSchema = z.strictObject({
  id: claimIdSchema,
  status: z.literal("proposed"),
  subjectId: stableEntityIdSchema,
  predicate: reasonCodeSchema,
  objectId: stableEntityIdSchema,
  evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
  explanation: persistedTextSchema,
})

export const missionResultSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  missionId: missionIdSchema,
  status: terminalStatusSchema,
  claims: z.array(proposedClaimSchema).max(500),
  unresolved: z.array(unresolvedQuestionSchema).max(100),
  exclusions: z.array(persistedTextSchema).max(100),
  suggestedFollowups: z.array(discoveryMissionSchema).max(20),
  stopReason: z.strictObject({
    code: reasonCodeSchema,
    summary: persistedTextSchema,
  }),
  budgetUsed: missionBudgetSchema,
})

export type Application = z.infer<typeof applicationSchema>
export type Source = z.infer<typeof sourceSchema>
export type CommitReference = z.infer<typeof commitReferenceSchema>
export type Run = z.infer<typeof runSchema>
export type MissionBudget = z.infer<typeof missionBudgetSchema>
export type DiscoveryMission = z.infer<typeof discoveryMissionSchema>
export type ProposedClaim = z.infer<typeof proposedClaimSchema>
export type MissionResult = z.infer<typeof missionResultSchema>
