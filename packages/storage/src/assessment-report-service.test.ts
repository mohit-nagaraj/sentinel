import {
  REPORT_TEMPLATE_VERSION,
  REPORT_WORDING_PROMPT_VERSION,
  assessmentReportViewSchema,
  createArtifactId,
  hashCanonical,
  type AssessmentReportView,
} from "@sentinel/contracts"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ArtifactMetadata } from "./artifact-storage.ts"
import {
  AssessmentReportDeliveryService,
  bindAssessmentReportPublisher,
  type AssessmentReportArtifactPort,
  type AssessmentReportRecordPort,
} from "./assessment-report-service.ts"

const applicationDatabaseId = "00000000-0000-4000-8000-000000000101"
const runDatabaseId = "00000000-0000-4000-8000-000000000102"
const operatorId = "00000000-0000-4000-8000-000000000103"
const assessmentId = "00000000-0000-4000-8000-000000000029"
const applicationId = `application:v1:${"a".repeat(64)}`
const markdown = "# Assessment report\n"

function reportView(): AssessmentReportView {
  return assessmentReportViewSchema.parse({
    schemaVersion: 1,
    id: hashCanonical({ kind: "delivery-service-report" }),
    assessmentId,
    applicationId,
    runId: "run:00000000-0000-4000-8000-000000000029",
    repository: { host: "github.com", owner: "sentinel", name: "demo" },
    pullRequestId: `pull-request:v1:${"b".repeat(64)}`,
    pullRequestNumber: 29,
    pullRequestTitle: "Generate assessment report",
    baseSha: "1".repeat(40),
    headSha: "2".repeat(40),
    graphCommitSha: "1".repeat(40),
    graphRevision: 3,
    policyVersion: "blast-radius-policy-v1",
    templateVersion: REPORT_TEMPLATE_VERSION,
    wordingPromptVersion: REPORT_WORDING_PROMPT_VERSION,
    model: { mode: "deterministic_fallback" },
    generatedAt: "2026-09-09T10:00:00.000Z",
    overallRisk: "low",
    overallEvidenceStrength: "D",
    executiveSummary: "No product finding was produced for the supplied facts.",
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
      reason: "No trusted pull-request head deployment was configured.",
      version: 0,
    },
    unknowns: [],
    exclusions: [],
  })
}

function artifact(view: AssessmentReportView): ArtifactMetadata {
  const contentHash = hashCanonical(markdown)
  return {
    id: createArtifactId({
      applicationId: view.applicationId,
      contentHash,
      kind: "assessment_report_markdown",
    }),
    databaseId: "00000000-0000-4000-8000-000000000104",
    applicationId: applicationDatabaseId,
    runId: runDatabaseId,
    artifactType: "assessment_report_markdown",
    bucket: "sentinel-private",
    objectKey: "reports/assessment.md",
    contentHash,
    mimeType: "text/markdown",
    sizeBytes: new TextEncoder().encode(markdown).byteLength,
    referenceCount: 0,
    retainUntil: null,
  }
}

describe("AssessmentReportDeliveryService", () => {
  const view = reportView()
  const storedArtifact = artifact(view)
  let repository: AssessmentReportRecordPort
  let artifacts: AssessmentReportArtifactPort

  beforeEach(() => {
    repository = {
      finalize: vi.fn().mockResolvedValue("published"),
      getOwned: vi.fn().mockResolvedValue(null),
    }
    artifacts = {
      persist: vi.fn().mockResolvedValue(storedArtifact),
      delete: vi.fn().mockResolvedValue(true),
      readTextExcerpt: vi.fn().mockResolvedValue({
        artifactId: storedArtifact.id,
        mimeType: "text/plain",
        excerpt: "OrderService.submit",
        truncated: false,
      }),
      signedReportDownloadUrl: vi
        .fn()
        .mockResolvedValue("https://signed.example/report"),
    }
  })

  it.each(["published", "existing"] as const)(
    "returns an immutable artifact for a %s finalization",
    async (disposition) => {
      vi.mocked(repository.finalize).mockResolvedValue(disposition)
      const service = new AssessmentReportDeliveryService(repository, artifacts)

      const result = await service.publish({
        applicationDatabaseId,
        runDatabaseId,
        view,
        markdown,
      })

      expect(result).toEqual({
        disposition,
        artifact: {
          reportId: view.id,
          artifactId: storedArtifact.id,
          contentHash: storedArtifact.contentHash,
          mimeType: "text/markdown",
          sizeBytes: storedArtifact.sizeBytes,
        },
      })
      expect(repository.finalize).toHaveBeenCalledWith(
        expect.objectContaining({
          assessmentId,
          headSha: view.headSha,
          report: view,
          artifactDatabaseId: storedArtifact.databaseId,
        })
      )
      expect(artifacts.delete).not.toHaveBeenCalled()
    }
  )

  it("binds database identities to the orchestration publication shape", async () => {
    const delivery = new AssessmentReportDeliveryService(repository, artifacts)
    const publisher = bindAssessmentReportPublisher({
      delivery,
      applicationDatabaseId,
      runDatabaseId,
    })

    await expect(publisher.publish({ view, markdown })).resolves.toEqual({
      disposition: "published",
      artifactId: storedArtifact.id,
    })
    expect(artifacts.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId: applicationDatabaseId,
        runId: runDatabaseId,
      })
    )
  })

  it("deletes an unreferenced artifact when the PR head is superseded", async () => {
    vi.mocked(repository.finalize).mockResolvedValue("superseded")
    const service = new AssessmentReportDeliveryService(repository, artifacts)

    await expect(
      service.publish({
        applicationDatabaseId,
        runDatabaseId,
        view,
        markdown,
      })
    ).resolves.toMatchObject({ disposition: "superseded" })
    expect(artifacts.delete).toHaveBeenCalledWith(
      applicationDatabaseId,
      storedArtifact.id
    )
  })

  it("deletes an unreferenced artifact and preserves a finalization failure", async () => {
    vi.mocked(repository.finalize).mockRejectedValue(
      new Error("report identity conflict")
    )
    const service = new AssessmentReportDeliveryService(repository, artifacts)

    await expect(
      service.publish({
        applicationDatabaseId,
        runDatabaseId,
        view,
        markdown,
      })
    ).rejects.toThrow("report identity conflict")
    expect(artifacts.delete).toHaveBeenCalledWith(
      applicationDatabaseId,
      storedArtifact.id
    )
  })

  it("authorizes ownership before requesting a signed download", async () => {
    const service = new AssessmentReportDeliveryService(repository, artifacts)

    await expect(
      service.signedOwnedDownload({ operatorId, assessmentId })
    ).resolves.toBeNull()
    expect(artifacts.signedReportDownloadUrl).not.toHaveBeenCalled()

    vi.mocked(repository.getOwned).mockResolvedValue({
      assessmentId,
      applicationDatabaseId,
      artifactId: storedArtifact.id,
      view,
      verificationEnrichment: null,
    })
    await expect(
      service.signedOwnedDownload({
        operatorId,
        assessmentId,
        expiresInSeconds: 120,
      })
    ).resolves.toBe("https://signed.example/report")
    expect(artifacts.signedReportDownloadUrl).toHaveBeenCalledWith(
      applicationDatabaseId,
      storedArtifact.id,
      120
    )
  })

  it("reads only evidence artifacts referenced by the owned report", async () => {
    const evidenceId = `evidence:v1:${"8".repeat(64)}`
    const referencedView = assessmentReportViewSchema.parse({
      ...view,
      overallEvidenceStrength: "A",
      findings: [
        {
          id: hashCanonical({ kind: "referenced-delivery-finding" }),
          targetId: `requirement:v1:${"7".repeat(64)}`,
          targetKind: "requirement",
          risk: "low",
          evidenceStrength: "A",
          title: "Order submission",
          summary:
            "The supplied path connects the changed handler to the requirement.",
          changedSymbolIds: [`code-symbol:v1:${"6".repeat(64)}`],
          evidencePaths: [
            {
              id: hashCanonical({ kind: "referenced-delivery-path" }),
              evidenceStrength: "A",
              nodes: [
                {
                  id: `code-symbol:v1:${"6".repeat(64)}`,
                  kind: "code-symbol",
                  title: "OrderService.submit",
                },
                {
                  id: `requirement:v1:${"7".repeat(64)}`,
                  kind: "requirement",
                  title: "Buyers submit orders",
                },
              ],
              evidenceIds: [evidenceId],
              references: [
                {
                  id: evidenceId,
                  extractionMethod: "source_reference",
                  sourceUris: ["repository://src/order-service.ts"],
                  artifactIds: [storedArtifact.id],
                },
              ],
            },
          ],
          scenarios: [],
          caveats: [],
        },
      ],
    })
    vi.mocked(repository.getOwned).mockResolvedValue({
      assessmentId,
      applicationDatabaseId,
      artifactId: storedArtifact.id,
      view: referencedView,
      verificationEnrichment: null,
    })
    const service = new AssessmentReportDeliveryService(repository, artifacts)

    await expect(
      service.evidenceExcerpt({
        operatorId,
        assessmentId,
        artifactId: `artifact:v1:${"5".repeat(64)}`,
      })
    ).resolves.toBeNull()
    expect(artifacts.readTextExcerpt).not.toHaveBeenCalled()

    await expect(
      service.evidenceExcerpt({
        operatorId,
        assessmentId,
        artifactId: storedArtifact.id,
      })
    ).resolves.toMatchObject({ excerpt: "OrderService.submit" })
    expect(artifacts.readTextExcerpt).toHaveBeenCalledWith(
      applicationDatabaseId,
      storedArtifact.id,
      8_192
    )
  })
})
