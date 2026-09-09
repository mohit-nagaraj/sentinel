import { z } from "zod"

import {
  baselineCompatibilitySchema,
  riskSchema,
  verificationResultSchema,
} from "./assessment.ts"
import { blastRadiusResultSchema } from "./blast-radius.ts"
import { coverageStatusSchema } from "./coverage.ts"
import {
  applicationIdSchema,
  artifactIdSchema,
  commitShaSchema,
  contentHashSchema,
  evidenceIdSchema,
  persistedTextSchema,
  pullRequestIdSchema,
  repositoryIdentitySchema,
  runIdSchema,
  schemaVersionSchema,
  sourceUriSchema,
  stableEntityIdSchema,
  timestampSchema,
} from "./primitives.ts"

export const REPORT_TEMPLATE_VERSION = "assessment-report-v1" as const
export const REPORT_WORDING_PROMPT_VERSION = "report-wording-v1" as const

const unique = <T extends z.ZodType>(schema: T, label: string) =>
  z
    .array(schema)
    .refine((values) => new Set(values.map(String)).size === values.length, {
      message: `${label} must be unique`,
    })

export const reportVerificationSchema = z
  .strictObject({
    status: z.enum([
      "passed",
      "failed",
      "behavior_changed",
      "blocked",
      "not_run",
      "verification_unavailable",
    ]),
    results: z.array(verificationResultSchema).max(100),
    reason: persistedTextSchema,
    version: z.number().int().nonnegative(),
  })
  .superRefine((value, context) => {
    const unavailable =
      value.status === "not_run" || value.status === "verification_unavailable"
    if (unavailable !== (value.results.length === 0)) {
      context.addIssue({
        code: "custom",
        path: ["results"],
        message: "Verification placeholders cannot contain executed results",
      })
    }
    if (unavailable) return
    const executedStatuses = new Set([
      "passed",
      "failed",
      "behavior_changed",
      "blocked",
    ])
    if (value.results.some((result) => !executedStatuses.has(result.status))) {
      context.addIssue({
        code: "custom",
        path: ["results"],
        message: "Executed verification cannot contain placeholder results",
      })
      return
    }
    const statuses = new Set(value.results.map(({ status }) => status))
    const expected = statuses.has("failed")
      ? "failed"
      : statuses.has("blocked")
        ? "blocked"
        : statuses.has("behavior_changed")
          ? "behavior_changed"
          : "passed"
    if (value.status !== expected) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Verification aggregate status conflicts with its results",
      })
    }
  })

export const reportCoverageFactSchema = z.strictObject({
  requirementId: stableEntityIdSchema.refine(
    (id) => String(id).startsWith("requirement:v1:"),
    "Coverage report facts require requirement identities"
  ),
  status: coverageStatusSchema,
  scope: persistedTextSchema,
  wording: persistedTextSchema,
  evidenceIds: unique(evidenceIdSchema, "Coverage evidence IDs").max(100),
})

export const assessmentReportSourceSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    assessmentId: z.uuid(),
    applicationId: applicationIdSchema,
    runId: runIdSchema,
    pullRequest: z.strictObject({
      id: pullRequestIdSchema,
      repository: repositoryIdentitySchema,
      number: z.number().int().positive(),
      title: persistedTextSchema,
      baseSha: commitShaSchema,
      headSha: commitShaSchema,
    }),
    baseline: baselineCompatibilitySchema,
    blastRadius: blastRadiusResultSchema,
    coverage: z.array(reportCoverageFactSchema).max(10_000),
    exclusions: unique(persistedTextSchema, "Report exclusions").max(500),
    verification: reportVerificationSchema,
    generatedAt: timestampSchema,
    templateVersion: z.literal(REPORT_TEMPLATE_VERSION),
    wordingPromptVersion: z.literal(REPORT_WORDING_PROMPT_VERSION),
  })
  .superRefine((value, context) => {
    if (
      value.blastRadius.assessmentId !== value.assessmentId ||
      value.blastRadius.applicationId !== value.applicationId ||
      value.blastRadius.pullRequestId !== value.pullRequest.id ||
      value.blastRadius.graphCommitSha !== value.baseline.graphCommitSha ||
      value.pullRequest.baseSha !== value.baseline.baseSha
    ) {
      context.addIssue({
        code: "custom",
        message: "Report source identities do not describe one assessment",
      })
    }
    for (const [index, result] of value.verification.results.entries()) {
      if (
        result.runId !== value.runId ||
        result.pullRequestId !== value.pullRequest.id ||
        result.headSha !== value.pullRequest.headSha
      ) {
        context.addIssue({
          code: "custom",
          path: ["verification", "results", index],
          message:
            "Verification result does not belong to the report run and PR head",
        })
      }
    }
  })

export const reportWordingFindingSchema = z.strictObject({
  findingId: contentHashSchema,
  title: persistedTextSchema,
  summary: persistedTextSchema,
  evidencePathIds: unique(contentHashSchema, "Wording evidence path IDs").max(
    100
  ),
  scenarioIds: unique(contentHashSchema, "Wording scenario IDs").max(100),
  caveatIds: unique(contentHashSchema, "Wording caveat IDs").max(100),
})

export const reportWordingOutputSchema = z.strictObject({
  executiveSummary: persistedTextSchema,
  findingIds: unique(contentHashSchema, "Executive finding IDs")
    .min(1)
    .max(100),
  findings: z.array(reportWordingFindingSchema).max(100),
})

export const reportEvidenceReferenceSchema = z.strictObject({
  id: evidenceIdSchema,
  extractionMethod: z.string().trim().min(1).max(128),
  sourceUris: unique(sourceUriSchema, "Report source URIs").max(100),
  artifactIds: unique(artifactIdSchema, "Report evidence artifact IDs").max(
    100
  ),
})

export const reportEvidencePathViewSchema = z.strictObject({
  id: contentHashSchema,
  evidenceStrength: z.enum(["A", "B", "C"]),
  nodes: z
    .array(
      z.strictObject({
        id: stableEntityIdSchema,
        kind: z.string().trim().min(1).max(64),
        title: persistedTextSchema,
      })
    )
    .min(2)
    .max(13),
  evidenceIds: unique(evidenceIdSchema, "Report path evidence IDs")
    .min(1)
    .max(1_000),
  references: z.array(reportEvidenceReferenceSchema).max(10).default([]),
})

export const reportScenarioViewSchema = z.strictObject({
  id: contentHashSchema,
  kind: z.enum([
    "ui_interaction",
    "workflow_checkpoint",
    "requirement_acceptance",
  ]),
  targetId: stableEntityIdSchema,
  checkpointEntityIds: unique(stableEntityIdSchema, "Report checkpoint IDs")
    .min(1)
    .max(100),
  evidencePathIds: unique(contentHashSchema, "Report scenario path IDs")
    .min(1)
    .max(100),
  priority: z.enum(["high", "medium", "low"]),
})

export const reportFindingViewSchema = z.strictObject({
  id: contentHashSchema,
  targetId: stableEntityIdSchema.optional(),
  targetKind: z.enum([
    "ui-element",
    "screen",
    "workflow",
    "requirement",
    "unknown",
  ]),
  risk: riskSchema,
  evidenceStrength: z.enum(["A", "B", "C", "D"]),
  title: persistedTextSchema,
  summary: persistedTextSchema,
  changedSymbolIds: unique(
    stableEntityIdSchema,
    "Report changed symbol IDs"
  ).max(500),
  evidencePaths: z.array(reportEvidencePathViewSchema).max(1_000),
  scenarios: z.array(reportScenarioViewSchema).max(100),
  caveats: z
    .array(
      z.strictObject({ id: contentHashSchema, summary: persistedTextSchema })
    )
    .max(500),
})

export const reportSectionKeySchema = z.enum([
  "identity",
  "executive_summary",
  "product_areas",
  "user_interface",
  "workflows",
  "requirements",
  "evidence",
  "recommended_qa",
  "verification",
  "unknowns_and_exclusions",
  "generation",
])

export const assessmentReportViewSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: contentHashSchema,
    assessmentId: z.uuid(),
    applicationId: applicationIdSchema,
    runId: runIdSchema,
    repository: repositoryIdentitySchema,
    pullRequestId: pullRequestIdSchema,
    pullRequestNumber: z.number().int().positive(),
    pullRequestTitle: persistedTextSchema,
    baseSha: commitShaSchema,
    headSha: commitShaSchema,
    graphCommitSha: commitShaSchema,
    graphRevision: z.number().int().positive(),
    policyVersion: z.string().trim().min(1).max(128),
    templateVersion: z.literal(REPORT_TEMPLATE_VERSION),
    wordingPromptVersion: z.literal(REPORT_WORDING_PROMPT_VERSION),
    model: z.discriminatedUnion("mode", [
      z.strictObject({ mode: z.literal("deterministic_fallback") }),
      z.strictObject({
        mode: z.literal("validated_model_wording"),
        modelId: z.string().trim().min(1).max(256),
      }),
    ]),
    generatedAt: timestampSchema,
    overallRisk: riskSchema,
    overallEvidenceStrength: z.enum(["A", "B", "C", "D"]),
    executiveSummary: persistedTextSchema,
    sections: z.tuple([
      z.literal("identity"),
      z.literal("executive_summary"),
      z.literal("product_areas"),
      z.literal("user_interface"),
      z.literal("workflows"),
      z.literal("requirements"),
      z.literal("evidence"),
      z.literal("recommended_qa"),
      z.literal("verification"),
      z.literal("unknowns_and_exclusions"),
      z.literal("generation"),
    ]),
    findings: z.array(reportFindingViewSchema).max(13_000),
    coverage: z.array(reportCoverageFactSchema).max(10_000),
    verification: reportVerificationSchema,
    unknowns: z.array(reportFindingViewSchema).max(10_500),
    exclusions: z.array(persistedTextSchema).max(500),
  })
  .superRefine((view, context) => {
    const expected = new Map(
      view.findings
        .filter(({ risk }) => risk === "unknown")
        .map((finding) => [finding.id, finding])
    )
    const supplied = new Map(
      view.unknowns.map((finding) => [finding.id, finding])
    )
    if (
      expected.size !== view.unknowns.length ||
      expected.size !== supplied.size ||
      [...expected].some(
        ([id, finding]) =>
          JSON.stringify(finding) !== JSON.stringify(supplied.get(id))
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["unknowns"],
        message:
          "Report unknowns must project every Unknown finding exactly once",
      })
    }
  })

export const assessmentReportArtifactSchema = z.strictObject({
  reportId: contentHashSchema,
  artifactId: artifactIdSchema,
  contentHash: contentHashSchema,
  mimeType: z.literal("text/markdown"),
  sizeBytes: z.number().int().positive().max(10_000_000),
})

export const reportVerificationEnrichmentSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    assessmentId: z.uuid(),
    reportId: contentHashSchema,
    version: z.number().int().positive(),
    verification: reportVerificationSchema,
    appendedAt: timestampSchema,
  })
  .superRefine((value, context) => {
    if (value.version !== value.verification.version) {
      context.addIssue({
        code: "custom",
        path: ["verification", "version"],
        message: "Verification enrichment versions must match",
      })
    }
  })

export type AssessmentReportSource = z.infer<
  typeof assessmentReportSourceSchema
>
export type ReportWordingOutput = z.infer<typeof reportWordingOutputSchema>
export type AssessmentReportView = z.infer<typeof assessmentReportViewSchema>
export type AssessmentReportArtifact = z.infer<
  typeof assessmentReportArtifactSchema
>
export type ReportVerification = z.infer<typeof reportVerificationSchema>
export type ReportVerificationEnrichment = z.infer<
  typeof reportVerificationEnrichmentSchema
>
