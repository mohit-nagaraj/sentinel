import {
  assessmentReportArtifactSchema,
  assessmentReportViewSchema,
  artifactIdSchema,
  hashCanonical,
  type AssessmentReportArtifact,
  type AssessmentReportView,
} from "@sentinel/contracts"

import type { ArtifactService } from "./artifact-storage.ts"
import {
  AssessmentReportRepository,
  type OwnedAssessmentReport,
} from "./assessment-report-repository.ts"

export type AssessmentReportArtifactPort = Pick<
  ArtifactService,
  "delete" | "persist" | "readTextExcerpt" | "signedReportDownloadUrl"
>

export type AssessmentReportRecordPort = Pick<
  AssessmentReportRepository,
  "finalize" | "getOwned"
>

export class AssessmentReportDeliveryService {
  constructor(
    private readonly repository: AssessmentReportRecordPort,
    private readonly artifacts: AssessmentReportArtifactPort
  ) {}

  async publish(input: {
    readonly applicationDatabaseId: string
    readonly runDatabaseId: string
    readonly view: AssessmentReportView
    readonly markdown: string
  }): Promise<{
    readonly disposition: "published" | "existing" | "superseded"
    readonly artifact: AssessmentReportArtifact
  }> {
    const view = assessmentReportViewSchema.parse(input.view)
    const body = new TextEncoder().encode(input.markdown)
    if (body.byteLength === 0 || body.byteLength > 10_000_000) {
      throw new Error("Assessment report Markdown size is invalid")
    }
    const artifact = await this.artifacts.persist({
      applicationId: input.applicationDatabaseId,
      applicationStableId: view.applicationId,
      runId: input.runDatabaseId,
      artifactType: "assessment_report_markdown",
      mimeType: "text/markdown",
      body,
      retainUntil: null,
    })
    const identityHash = hashCanonical({
      repository: view.repository,
      pullRequestNumber: view.pullRequestNumber,
      headSha: view.headSha,
      graphRevision: view.graphRevision,
      policyVersion: view.policyVersion,
      templateVersion: view.templateVersion,
      wordingPromptVersion: view.wordingPromptVersion,
      model: view.model,
    })
    let disposition: "published" | "existing" | "superseded"
    try {
      disposition = await this.repository.finalize({
        assessmentId: view.assessmentId,
        headSha: view.headSha,
        report: view,
        identityHash,
        artifactDatabaseId: artifact.databaseId,
      })
    } catch (error) {
      await this.artifacts
        .delete(input.applicationDatabaseId, artifact.id)
        .catch(() => undefined)
      throw error
    }
    if (disposition === "superseded") {
      await this.artifacts.delete(input.applicationDatabaseId, artifact.id)
    }
    return {
      disposition,
      artifact: assessmentReportArtifactSchema.parse({
        reportId: view.id,
        artifactId: artifact.id,
        contentHash: artifact.contentHash,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
      }),
    }
  }

  getOwned(input: {
    readonly operatorId: string
    readonly assessmentId: string
  }): Promise<OwnedAssessmentReport | null> {
    return this.repository.getOwned(input)
  }

  async signedOwnedDownload(input: {
    readonly operatorId: string
    readonly assessmentId: string
    readonly expiresInSeconds?: number
  }): Promise<string | null> {
    const report = await this.repository.getOwned(input)
    if (report === null) return null
    return this.artifacts.signedReportDownloadUrl(
      report.applicationDatabaseId,
      report.artifactId,
      input.expiresInSeconds ?? 300
    )
  }

  async evidenceExcerpt(input: {
    readonly operatorId: string
    readonly assessmentId: string
    readonly artifactId: string
    readonly maximumCharacters?: number
  }) {
    const artifactId = artifactIdSchema.parse(input.artifactId)
    const report = await this.repository.getOwned(input)
    if (report === null) return null
    const referenced = new Set(
      report.view.findings.flatMap((finding) =>
        finding.evidencePaths.flatMap((path) =>
          path.references.flatMap((reference) => reference.artifactIds)
        )
      )
    )
    if (!referenced.has(artifactId)) return null
    return this.artifacts.readTextExcerpt(
      report.applicationDatabaseId,
      artifactId,
      input.maximumCharacters ?? 8_192
    )
  }
}

export function createAssessmentReportDeliveryService(input: {
  readonly repository: AssessmentReportRepository
  readonly artifacts: ArtifactService
}) {
  return new AssessmentReportDeliveryService(input.repository, input.artifacts)
}

export function bindAssessmentReportPublisher(input: {
  readonly delivery: AssessmentReportDeliveryService
  readonly applicationDatabaseId: string
  readonly runDatabaseId: string
}) {
  return {
    publish: async (report: {
      readonly view: AssessmentReportView
      readonly markdown: string
    }) => {
      const result = await input.delivery.publish({
        applicationDatabaseId: input.applicationDatabaseId,
        runDatabaseId: input.runDatabaseId,
        ...report,
      })
      return {
        disposition: result.disposition,
        artifactId: result.artifact.artifactId,
      }
    },
  }
}
