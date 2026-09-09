import {
  REPORT_TEMPLATE_VERSION,
  REPORT_WORDING_PROMPT_VERSION,
  assessmentReportViewSchema,
  hashCanonical,
  type AssessmentReportView,
} from "@sentinel/contracts"
import { renderAssessmentReportMarkdown } from "@sentinel/orchestration/report"
import { z } from "zod"

const idSchema = z.string().regex(/^[a-z]+:[a-z0-9-]+$/)
const textSchema = z.string().trim().min(1).max(4_096)
const evidenceIdsSchema = z.array(idSchema).min(1).max(20)

const affectedAreaSchema = z.strictObject({
  id: idSchema,
  title: textSchema.max(256),
  audienceSummary: textSchema,
  risk: z.enum(["high", "medium", "low"]),
  changedBehavior: textSchema,
  evidenceIds: evidenceIdsSchema,
  evidencePath: z.array(textSchema.max(256)).min(2).max(12),
  recommendedTests: z.array(textSchema).min(1).max(10),
})

export const sampleReportSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    reportKind: z.literal("reference_fixture"),
    generatedAt: z.iso.datetime({ offset: true }),
    assessment: z.strictObject({
      repository: z.literal("HiEventsDev/Hi.Events"),
      pullRequest: z.literal(1338),
      pullRequestUrl: z.literal(
        "https://github.com/HiEventsDev/Hi.Events/pull/1338"
      ),
      title: textSchema.max(512),
      baseSha: z.literal("2064f88ff7590e93c738efb8becaa7d732063619"),
      headSha: z.literal("f68df0dabd18d04df5e6c7e873aac2b5e5201584"),
      changedFiles: z.number().int().positive(),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
      graphRevision: z.number().int().positive(),
      verificationStatus: z.literal("verification_unavailable"),
    }),
    summary: z.strictObject({
      overallRisk: z.enum(["high", "medium", "low", "unknown"]),
      headline: textSchema.max(512),
      explanation: textSchema,
    }),
    affectedAreas: z.array(affectedAreaSchema).min(1).max(20),
    controls: z.array(
      z.strictObject({
        id: idSchema,
        title: textSchema.max(256),
        reason: textSchema,
        evidenceIds: evidenceIdsSchema,
      })
    ),
    unknowns: z
      .array(
        z.strictObject({
          id: idSchema,
          title: textSchema.max(256),
          consequence: textSchema,
          operatorAction: textSchema,
        })
      )
      .min(1),
    evidence: z
      .array(
        z.strictObject({
          id: idSchema,
          kind: z.enum(["public_pr", "public_diff", "golden_fixture"]),
          uri: z.string().trim().min(1).max(2_048),
          description: textSchema,
        })
      )
      .min(1),
    limitations: z.array(textSchema).min(1),
  })
  .superRefine((report, context) => {
    const evidenceIds = report.evidence.map(({ id }) => id)
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "Evidence identities must be unique",
      })
    }
    const knownEvidence = new Set(evidenceIds)
    for (const [collection, records] of [
      ["affectedAreas", report.affectedAreas],
      ["controls", report.controls],
    ] as const) {
      for (const [index, record] of records.entries()) {
        if (record.evidenceIds.some((id) => !knownEvidence.has(id))) {
          context.addIssue({
            code: "custom",
            path: [collection, index, "evidenceIds"],
            message: "Report record references unknown evidence",
          })
        }
      }
    }
  })

export type SampleReport = z.infer<typeof sampleReportSchema>

const reportSections = [
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
] as const

export function buildSampleReportView(
  value: SampleReport
): AssessmentReportView {
  const report = sampleReportSchema.parse(value)
  const evidenceById = new Map(report.evidence.map((item) => [item.id, item]))
  const findings = report.affectedAreas.map((area, index) => {
    const targetKind = targetKindFor(index)
    const targetId = stableId(targetKind, `target:${area.id}`)
    const findingId = hashCanonical({
      kind: "sample-report-finding",
      id: area.id,
    })
    const pathId = hashCanonical({ kind: "sample-report-path", id: area.id })
    const evidenceIds = area.evidenceIds.map((id) => evidenceId(id))
    const nodes = area.evidencePath.map((title, nodeIndex) => {
      const kind = nodeKind(title, nodeIndex, area.evidencePath.length)
      return {
        id: stableId(kind, `${area.id}:${nodeIndex}:${title}`),
        kind,
        title,
      }
    })
    const recommendationText = area.recommendedTests
      .map(
        (recommendation, recommendationIndex) =>
          `${recommendationIndex + 1}) ${recommendation}`
      )
      .join(" ")
    return {
      id: findingId,
      targetId,
      targetKind,
      risk: area.risk,
      evidenceStrength: index === 0 ? ("A" as const) : ("B" as const),
      title: area.title,
      summary: `${area.audienceSummary} ${area.changedBehavior} Recommended checks: ${recommendationText}`,
      changedSymbolIds: [stableId("code-symbol", `changed:${area.id}`)],
      evidencePaths: [
        {
          id: pathId,
          evidenceStrength: index === 0 ? ("A" as const) : ("B" as const),
          nodes,
          evidenceIds,
          references: area.evidenceIds.map((id) => {
            const evidence = evidenceById.get(id)!
            return {
              id: evidenceId(id),
              extractionMethod: evidence.kind,
              sourceUris: [normalizeSourceUri(evidence.uri)],
              artifactIds: [],
            }
          }),
        },
      ],
      scenarios: [
        {
          id: hashCanonical({ kind: "sample-report-scenario", id: area.id }),
          kind:
            targetKind === "workflow"
              ? ("workflow_checkpoint" as const)
              : ("ui_interaction" as const),
          targetId,
          checkpointEntityIds: [targetId],
          evidencePathIds: [pathId],
          priority: area.risk,
        },
      ],
      caveats: [],
    }
  })

  const unknowns = report.unknowns.map((unknown) => ({
    id: hashCanonical({ kind: "sample-report-unknown", id: unknown.id }),
    targetKind: "unknown" as const,
    risk: "unknown" as const,
    evidenceStrength: "D" as const,
    title: unknown.title,
    summary: `${unknown.consequence} Operator action: ${unknown.operatorAction}`,
    changedSymbolIds: [],
    evidencePaths: [],
    scenarios: [],
    caveats: [],
  }))
  const requirementId = stableId(
    "requirement",
    "admin-attribution-reporting-requirement"
  )
  const controlExclusions = report.controls.map(
    (control) => `Control flow ${control.title}: ${control.reason}`
  )
  const primaryFinding = findings[0]!
  const requirementFinding = {
    ...primaryFinding,
    id: hashCanonical({
      kind: "sample-report-requirement-finding",
      pullRequest: report.assessment.pullRequest,
    }),
    targetId: requirementId,
    targetKind: "requirement" as const,
    risk: "high" as const,
    evidenceStrength: "A" as const,
    title: "Admin attribution filters remain correct",
    summary:
      "The reviewed requirement expects administrators to filter and group attribution analytics correctly. The same cross-stack evidence makes date-range, grouping, and validation behavior a high-priority acceptance check.",
    scenarios: [
      {
        id: hashCanonical({
          kind: "sample-report-requirement-scenario",
          pullRequest: report.assessment.pullRequest,
        }),
        kind: "requirement_acceptance" as const,
        targetId: requirementId,
        checkpointEntityIds: [requirementId],
        evidencePathIds: primaryFinding.evidencePaths.map(({ id }) => id),
        priority: "high" as const,
      },
    ],
  }

  return assessmentReportViewSchema.parse({
    schemaVersion: 1,
    id: hashCanonical({
      kind: "sample-assessment-report",
      pullRequest: report.assessment.pullRequest,
      headSha: report.assessment.headSha,
    }),
    assessmentId: "00000000-0000-4000-8000-000000000029",
    applicationId: stableId("application", "hi-events-sample"),
    runId: "run:00000000-0000-4000-8000-000000000029",
    repository: {
      host: "github.com",
      owner: "HiEventsDev",
      name: "Hi.Events",
    },
    pullRequestId: stableId("pull-request", "hi-events-pr-1338"),
    pullRequestNumber: report.assessment.pullRequest,
    pullRequestTitle: report.assessment.title,
    baseSha: report.assessment.baseSha,
    headSha: report.assessment.headSha,
    graphCommitSha: report.assessment.baseSha,
    graphRevision: report.assessment.graphRevision,
    policyVersion: "blast-radius-policy-v1",
    templateVersion: REPORT_TEMPLATE_VERSION,
    wordingPromptVersion: REPORT_WORDING_PROMPT_VERSION,
    model: { mode: "deterministic_fallback" },
    generatedAt: report.generatedAt,
    overallRisk: report.summary.overallRisk,
    overallEvidenceStrength: "B",
    executiveSummary: `${report.summary.headline} ${report.summary.explanation}`,
    sections: reportSections,
    findings: [...findings, requirementFinding, ...unknowns],
    coverage: [
      {
        requirementId,
        status: "partially_observed",
        scope: "Admin attribution analytics on the reviewed baseline",
        wording:
          "Static evidence connects the attribution report across UI and backend layers; PR-head browser behavior was not dynamically verified.",
        evidenceIds: report.evidence
          .slice(0, 3)
          .map(({ id }) => evidenceId(id)),
      },
    ],
    verification: {
      status: report.assessment.verificationStatus,
      results: [],
      reason:
        "No trusted pull-request head deployment was registered for this sample run.",
      version: 0,
    },
    unknowns,
    exclusions: [...controlExclusions, ...report.limitations],
  })
}

export function renderSampleReportMarkdown(value: SampleReport): string {
  return renderAssessmentReportMarkdown(buildSampleReportView(value))
}

function evidenceId(value: string): `evidence:v1:${string}` {
  return `evidence:v1:${digest({ kind: "sample-evidence", value })}`
}

function stableId<
  Kind extends
    | "application"
    | "pull-request"
    | "code-symbol"
    | "api-endpoint"
    | "workflow"
    | "requirement"
    | "screen"
    | "ui-element",
>(kind: Kind, value: string): `${Kind}:v1:${string}` {
  return `${kind}:v1:${digest({ kind, value })}`
}

function digest(value: unknown): string {
  return String(hashCanonical(value)).slice("sha256:".length)
}

function targetKindFor(index: number): "screen" | "ui-element" | "workflow" {
  return index === 0 ? "screen" : index === 1 ? "ui-element" : "workflow"
}

function nodeKind(
  title: string,
  index: number,
  length: number
):
  | "pull-request"
  | "code-symbol"
  | "api-endpoint"
  | "workflow"
  | "requirement"
  | "screen"
  | "ui-element" {
  const normalized = title.toLowerCase()
  if (index === 0 && normalized.startsWith("pr #")) return "pull-request"
  if (normalized.includes("endpoint") || normalized.includes("request")) {
    return "api-endpoint"
  }
  if (normalized.includes("workflow")) return "workflow"
  if (normalized.includes("requirement")) return "requirement"
  if (normalized.includes("screen") || normalized.includes("summary cards")) {
    return "screen"
  }
  if (normalized.includes("cell")) return "ui-element"
  if (index === length - 1) return "requirement"
  return "code-symbol"
}

function normalizeSourceUri(value: string): string {
  if (value.startsWith("../../packages/evaluation/")) {
    return `repository://${value.slice("../../".length)}`
  }
  return value
}
