import { z } from "zod"

import {
  applicationIdSchema,
  artifactIdSchema,
  codeSymbolIdSchema,
  commitShaSchema,
  contentHashSchema,
  coverageAssessmentIdSchema,
  evidenceIdSchema,
  evidenceTierSchema,
  findingIdSchema,
  httpMethodSchema,
  lineRangeSchema,
  nonEmptyStringSchema,
  normalizedPathSchema,
  pullRequestIdSchema,
  repositoryIdentitySchema,
  repositoryPathSchema,
  requirementIdSchema,
  reviewStateSchema,
  runIdSchema,
  schemaVersionSchema,
  screenIdSchema,
  shortTextSchema,
  stableEntityIdSchema,
  timestampSchema,
  workflowIdSchema,
} from "./primitives.ts"

export const evidenceRelationshipSchema = z.enum([
  "HAS_PAGE",
  "HAS_SECTION",
  "LINKS_TO",
  "STATES",
  "REQUIRES",
  "COVERED_BY",
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
  "CHANGES",
  "HAS_ASSESSMENT",
])

export const evidenceLinkSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: evidenceIdSchema,
  applicationId: applicationIdSchema,
  fromId: stableEntityIdSchema,
  relationship: evidenceRelationshipSchema,
  toId: stableEntityIdSchema,
  extractionMethod: nonEmptyStringSchema,
  evidenceTier: evidenceTierSchema,
  explanation: nonEmptyStringSchema,
  evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
  sourceCommitSha: commitShaSchema.optional(),
  crawlRunId: runIdSchema.optional(),
  artifactId: artifactIdSchema.optional(),
  reviewState: reviewStateSchema,
  graphRevision: z.number().int().nonnegative(),
  lastConfirmedAt: timestampSchema,
})

export const coverageStatusSchema = z.enum([
  "observed",
  "partially_observed",
  "not_observed",
  "blocked",
  "not_evaluated",
  "ambiguous",
])

export const coverageAssessmentSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: coverageAssessmentIdSchema,
  applicationId: applicationIdSchema,
  requirementId: requirementIdSchema,
  status: coverageStatusSchema,
  scope: nonEmptyStringSchema,
  reason: nonEmptyStringSchema,
  possibleCauses: z.array(nonEmptyStringSchema).max(20),
  runId: runIdSchema,
  evidenceIds: z.array(evidenceIdSchema).max(100),
})

export const pullRequestSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: pullRequestIdSchema,
  applicationId: applicationIdSchema,
  repository: repositoryIdentitySchema,
  number: z.number().int().positive(),
  title: shortTextSchema,
  baseSha: commitShaSchema,
  headSha: commitShaSchema,
  analyzedAt: timestampSchema,
})

export const prChangeSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  pullRequestId: pullRequestIdSchema,
  changeType: z.enum([
    "added",
    "modified",
    "deleted",
    "renamed",
    "configuration",
    "schema",
  ]),
  oldPath: repositoryPathSchema.optional(),
  newPath: repositoryPathSchema.optional(),
  baseRanges: z.array(lineRangeSchema).max(1_000),
  headRanges: z.array(lineRangeSchema).max(1_000),
  baseSymbolIds: z.array(codeSymbolIdSchema).max(500),
  headSymbolIds: z.array(codeSymbolIdSchema).max(500),
  diffHash: contentHashSchema,
})

export const riskSchema = z.enum(["high", "medium", "low", "unknown"])
export const verificationStatusSchema = z.enum([
  "passed",
  "failed",
  "behavior_changed",
  "blocked",
  "not_run",
  "verification_unavailable",
])

export const assessmentFindingSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: findingIdSchema,
  applicationId: applicationIdSchema,
  pullRequestId: pullRequestIdSchema,
  risk: riskSchema,
  evidenceStrength: evidenceTierSchema,
  title: shortTextSchema,
  summary: nonEmptyStringSchema,
  changedSymbolIds: z.array(codeSymbolIdSchema).max(500),
  screenIds: z.array(screenIdSchema).max(500),
  workflowIds: z.array(workflowIdSchema).max(500),
  requirementIds: z.array(requirementIdSchema).max(500),
  evidencePaths: z
    .array(z.array(stableEntityIdSchema).min(2).max(50))
    .min(1)
    .max(100),
  recommendedScenarios: z.array(nonEmptyStringSchema).max(50),
  verificationStatus: verificationStatusSchema,
})

export const verificationResultSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  runId: runIdSchema,
  pullRequestId: pullRequestIdSchema,
  headSha: commitShaSchema,
  deploymentUrl: z.url({ protocol: /^https?$/ }),
  status: verificationStatusSchema,
  workflowId: workflowIdSchema,
  requirementIds: z.array(requirementIdSchema).max(100),
  assertions: z.array(
    z.strictObject({
      name: shortTextSchema,
      passed: z.boolean(),
      evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
    })
  ),
  requests: z.array(
    z.strictObject({
      method: httpMethodSchema,
      normalizedPath: normalizedPathSchema,
      status: z.number().int().min(100).max(599),
    })
  ),
  completedAt: timestampSchema,
})

export type EvidenceLink = z.infer<typeof evidenceLinkSchema>
export type CoverageAssessment = z.infer<typeof coverageAssessmentSchema>
export type PullRequest = z.infer<typeof pullRequestSchema>
export type PrChange = z.infer<typeof prChangeSchema>
export type AssessmentFinding = z.infer<typeof assessmentFindingSchema>
export type VerificationResult = z.infer<typeof verificationResultSchema>
