import {
  REPORT_TEMPLATE_VERSION,
  REPORT_WORDING_PROMPT_VERSION,
  applicationIdSchema,
  assessmentReportViewSchema,
  hashCanonical,
  reportVerificationEnrichmentSchema,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import type { DatabaseExecutor, SqlParameter } from "./database.ts"
import { AssessmentReportRepository } from "./assessment-report-repository.ts"

const assessmentId = "00000000-0000-4000-8000-000000000029"
const operatorId = "11111111-1111-4111-8111-111111111111"
const applicationDatabaseId = "22222222-2222-4222-8222-222222222222"
const applicationId = applicationIdSchema.parse(
  `application:v1:${"a".repeat(64)}`
)
const reportId = hashCanonical({ kind: "storage-report" })
const artifactId = `artifact:v1:${"b".repeat(64)}`
const artifactDatabaseId = "33333333-3333-4333-8333-333333333333"
const timestamp = "2026-09-09T10:00:00.000Z"

function view() {
  return assessmentReportViewSchema.parse({
    schemaVersion: 1,
    id: reportId,
    assessmentId,
    applicationId,
    runId: "run:00000000-0000-4000-8000-000000000029",
    repository: { host: "github.com", owner: "sentinel", name: "demo" },
    pullRequestId: `pull-request:v1:${"c".repeat(64)}`,
    pullRequestNumber: 29,
    pullRequestTitle: "Report delivery",
    baseSha: "1".repeat(40),
    headSha: "2".repeat(40),
    graphCommitSha: "1".repeat(40),
    graphRevision: 3,
    policyVersion: "blast-radius-policy-v1",
    templateVersion: REPORT_TEMPLATE_VERSION,
    wordingPromptVersion: REPORT_WORDING_PROMPT_VERSION,
    model: { mode: "deterministic_fallback" },
    generatedAt: timestamp,
    overallRisk: "unknown",
    overallEvidenceStrength: "D",
    executiveSummary: "One unknown finding requires review.",
    sections: [
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
    ],
    findings: [],
    coverage: [],
    verification: {
      status: "verification_unavailable",
      results: [],
      reason: "No trusted head deployment was configured.",
      version: 0,
    },
    unknowns: [],
    exclusions: [],
  })
}

class FakeDatabase implements DatabaseExecutor {
  readonly queries: {
    statement: string
    parameters: readonly SqlParameter[]
  }[] = []
  disposition: "published" | "existing" | "superseded" = "published"
  current = true

  async query<Row extends Record<string, unknown>>(
    statement: string,
    parameters: readonly SqlParameter[] = []
  ): Promise<readonly Row[]> {
    this.queries.push({ statement, parameters })
    if (statement.includes("select exists")) {
      return [{ current: this.current } as unknown as Row]
    }
    if (statement.includes("finalize_assessment_report")) {
      return [
        {
          disposition: this.disposition,
          report_id: this.disposition === "superseded" ? null : reportId,
        } as unknown as Row,
      ]
    }
    if (statement.includes("report_artifact_stable_key")) {
      return [
        {
          assessment_id: assessmentId,
          application_database_id: applicationDatabaseId,
          application_stable_id: applicationId,
          report_artifact_stable_key: artifactId,
          report_view: view(),
          latest_verification: null,
        } as unknown as Row,
      ]
    }
    if (statement.includes("append_report_verification_enrichment")) {
      return [{ appended: true } as unknown as Row]
    }
    return []
  }
}

describe("assessment report repository", () => {
  it("provides the report workflow current-head guard", async () => {
    const database = new FakeDatabase()
    const repository = new AssessmentReportRepository(database)

    await expect(
      repository.isCurrent({ assessmentId, headSha: "2".repeat(40) })
    ).resolves.toBe(true)
    expect(database.queries[0]?.statement).toContain("assessment.is_current")
    expect(database.queries[0]?.parameters).toEqual([
      assessmentId,
      "2".repeat(40),
    ])
  })

  it("finalizes immutable report metadata through the compare-and-set function", async () => {
    const database = new FakeDatabase()
    const repository = new AssessmentReportRepository(database)

    await expect(
      repository.finalize({
        assessmentId,
        headSha: "2".repeat(40),
        report: view(),
        identityHash: hashCanonical({ identity: reportId }),
        artifactDatabaseId,
      })
    ).resolves.toBe("published")
    expect(database.queries[0]?.statement).toContain(
      "finalize_assessment_report"
    )
    expect(database.queries[0]?.parameters[0]).toBe(assessmentId)
    expect(String(database.queries[0]?.parameters[6])).not.toContain(
      "object_key"
    )
  })

  it("owner-scopes report reads and private artifact identity", async () => {
    const database = new FakeDatabase()
    const repository = new AssessmentReportRepository(database)

    await expect(
      repository.getOwned({ operatorId, assessmentId })
    ).resolves.toMatchObject({
      assessmentId,
      applicationDatabaseId,
      artifactId,
    })
    expect(database.queries[0]?.statement).toContain("onboarding.operator_id")
    expect(database.queries[0]?.statement).toContain("bucket.public = false")
    expect(database.queries[0]?.statement).toContain(
      "report_verification_enrichments"
    )
  })

  it("appends versioned verification instead of mutating the report", async () => {
    const database = new FakeDatabase()
    const repository = new AssessmentReportRepository(database)

    await expect(
      repository.appendVerification(
        reportVerificationEnrichmentSchema.parse({
          schemaVersion: 1,
          assessmentId,
          reportId,
          version: 1,
          verification: {
            status: "verification_unavailable",
            results: [],
            reason: "No trusted deployment was configured.",
            version: 1,
          },
          appendedAt: timestamp,
        })
      )
    ).resolves.toBe(true)
    expect(database.queries[0]?.statement).toContain(
      "append_report_verification_enrichment"
    )
  })
})
