import { describe, expect, it } from "vitest"

import {
  REPORT_TEMPLATE_VERSION,
  REPORT_WORDING_PROMPT_VERSION,
  assessmentReportSourceSchema,
  assessmentReportViewSchema,
  reportVerificationEnrichmentSchema,
  reportWordingOutputSchema,
} from "./report.ts"
import { BLAST_RADIUS_POLICY_VERSION } from "./blast-radius.ts"
import { hashCanonical } from "./identity.ts"

const assessmentId = "00000000-0000-4000-8000-000000000029"
const applicationId = `application:v1:${"a".repeat(64)}`
const runId = "run:00000000-0000-4000-8000-000000000029"
const pullRequestId = `pull-request:v1:${"b".repeat(64)}`
const timestamp = "2026-09-09T10:00:00.000Z"
const baseSha = "1".repeat(40)
const headSha = "2".repeat(40)

const sections = [
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

function blockedResult() {
  return {
    schemaVersion: 1,
    runId,
    pullRequestId,
    headSha,
    workflowId: `workflow:v1:${"c".repeat(64)}`,
    requirementIds: [],
    completedAt: timestamp,
    status: "blocked" as const,
    deploymentUrl: "https://preview.example/pr-29",
    assertions: [],
    requests: [],
  }
}

function executedResult(status: "passed" | "failed", ordinal: number) {
  return {
    schemaVersion: 1,
    runId,
    pullRequestId,
    headSha,
    workflowId: `workflow:v1:${ordinal.toString(16).padStart(64, "0")}`,
    requirementIds: [`requirement:v1:${"e".repeat(64)}`],
    completedAt: timestamp,
    status,
    deploymentUrl: "https://preview.example/pr-29",
    assertions: [
      {
        name: `Scenario ${ordinal}`,
        passed: status === "passed",
        evidenceIds: [`evidence:v1:${"f".repeat(64)}`],
      },
    ],
    requests: [],
  }
}

function sourceFixture() {
  return assessmentReportSourceSchema.parse({
    schemaVersion: 1,
    assessmentId,
    applicationId,
    runId,
    pullRequest: {
      id: pullRequestId,
      repository: { host: "github.com", owner: "sentinel", name: "demo" },
      number: 29,
      title: "Generate assessment report",
      baseSha,
      headSha,
    },
    baseline: {
      status: "exact",
      assessmentAllowed: true,
      graphCommitSha: baseSha,
      baseSha,
      reason: "graph_matches_pr_base",
      relevantInterveningPaths: [],
    },
    blastRadius: {
      schemaVersion: 1,
      id: hashCanonical({ kind: "contract-report-blast-radius" }),
      applicationId,
      assessmentId,
      pullRequestId,
      graphRevision: 3,
      graphCommitSha: baseSha,
      policyVersion: BLAST_RADIUS_POLICY_VERSION,
      evidencePaths: [],
      caveats: [],
      findings: [],
      summary: { high: 0, medium: 0, low: 0, unknown: 0 },
    },
    coverage: [],
    exclusions: [],
    verification: {
      status: "blocked",
      results: [blockedResult()],
      reason: "The trusted preview did not become ready.",
      version: 1,
    },
    generatedAt: timestamp,
    templateVersion: REPORT_TEMPLATE_VERSION,
    wordingPromptVersion: REPORT_WORDING_PROMPT_VERSION,
  })
}

function unknownFinding() {
  return {
    id: hashCanonical({ kind: "contract-report-unknown" }),
    targetKind: "unknown" as const,
    risk: "unknown" as const,
    evidenceStrength: "D" as const,
    title: "Configuration change",
    summary: "Product impact remains unknown within the assessed scope.",
    changedSymbolIds: [],
    evidencePaths: [],
    scenarios: [],
    caveats: [],
  }
}

function viewFixture() {
  const finding = unknownFinding()
  return assessmentReportViewSchema.parse({
    schemaVersion: 1,
    id: hashCanonical({ kind: "contract-report-view" }),
    assessmentId,
    applicationId,
    runId,
    repository: { host: "github.com", owner: "sentinel", name: "demo" },
    pullRequestId,
    pullRequestNumber: 29,
    pullRequestTitle: "Generate assessment report",
    baseSha,
    headSha,
    graphCommitSha: baseSha,
    graphRevision: 3,
    policyVersion: BLAST_RADIUS_POLICY_VERSION,
    templateVersion: REPORT_TEMPLATE_VERSION,
    wordingPromptVersion: REPORT_WORDING_PROMPT_VERSION,
    model: { mode: "deterministic_fallback" },
    generatedAt: timestamp,
    overallRisk: "unknown",
    overallEvidenceStrength: "D",
    executiveSummary: "One unknown finding requires product review.",
    sections,
    findings: [finding],
    coverage: [],
    verification: {
      status: "verification_unavailable",
      results: [],
      reason: "No trusted pull-request head deployment was configured.",
      version: 0,
    },
    unknowns: [finding],
    exclusions: [],
  })
}

describe("assessment report contracts", () => {
  it.each([
    ["runId", "run:00000000-0000-4000-8000-000000000030"],
    ["pullRequestId", `pull-request:v1:${"d".repeat(64)}`],
    ["headSha", "3".repeat(40)],
  ] as const)("rejects verification from another %s", (field, value) => {
    const valid = sourceFixture()
    const result = assessmentReportSourceSchema.safeParse({
      ...valid,
      verification: {
        ...valid.verification,
        results: [{ ...valid.verification.results[0], [field]: value }],
      },
    })

    expect(result.success).toBe(false)
    if (result.success) throw new Error("Expected report source rejection")
    expect(result.error.issues.map(({ message }) => message)).toContain(
      "Verification result does not belong to the report run and PR head"
    )
  })

  it("requires the complete ordered section contract", () => {
    const valid = viewFixture()
    expect(
      assessmentReportViewSchema.safeParse({
        ...valid,
        sections: valid.sections.slice(0, -1),
      }).success
    ).toBe(false)
  })

  it("requires unknown projections to exactly match unknown findings", () => {
    const valid = viewFixture()
    const result = assessmentReportViewSchema.safeParse({
      ...valid,
      unknowns: [
        {
          ...valid.unknowns[0],
          summary: "A different projection with the same identity.",
        },
      ],
    })

    expect(result.success).toBe(false)
    if (result.success) throw new Error("Expected unknown projection rejection")
    expect(result.error.issues.map(({ message }) => message)).toContain(
      "Report unknowns must project every Unknown finding exactly once"
    )
  })

  it("requires model-written executive prose to cite a supplied finding", () => {
    expect(
      reportWordingOutputSchema.safeParse({
        executiveSummary: "Checkout behavior needs focused retesting.",
        findingIds: [],
        findings: [],
      }).success
    ).toBe(false)
  })

  it("accepts passed and failed scenarios under an overall failed status", () => {
    const valid = sourceFixture()
    expect(
      assessmentReportSourceSchema.safeParse({
        ...valid,
        verification: {
          status: "failed",
          results: [executedResult("passed", 1), executedResult("failed", 2)],
          reason: "One selected scenario failed.",
          version: 1,
        },
      }).success
    ).toBe(true)
    expect(
      assessmentReportSourceSchema.safeParse({
        ...valid,
        verification: {
          status: "passed",
          results: [executedResult("passed", 1), executedResult("failed", 2)],
          reason: "The aggregate incorrectly reports success.",
          version: 1,
        },
      }).success
    ).toBe(false)
  })

  it("keeps verification enrichment versions aligned", () => {
    const reportId = hashCanonical({ kind: "enrichment-version-contract" })
    expect(
      reportVerificationEnrichmentSchema.safeParse({
        schemaVersion: 1,
        assessmentId,
        reportId,
        version: 2,
        verification: {
          status: "verification_unavailable",
          results: [],
          reason: "No trusted deployment is configured.",
          version: 1,
        },
        appendedAt: timestamp,
      }).success
    ).toBe(false)
  })
})
