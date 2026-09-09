import {
  assessmentReportViewSchema,
  commitShaSchema,
  contentHashSchema,
  reportVerificationEnrichmentSchema,
  type AssessmentReportView,
  type ReportVerificationEnrichment,
} from "@sentinel/contracts"
import { z } from "zod"

import type { DatabaseExecutor } from "./database.ts"

const finalizeRowSchema = z.object({
  disposition: z.enum(["published", "existing", "superseded"]),
  report_id: contentHashSchema.nullable(),
})

const currentHeadRowSchema = z.object({ current: z.boolean() })

const ownedRowSchema = z.object({
  assessment_id: z.uuid(),
  application_database_id: z.uuid(),
  application_stable_id: z.string().regex(/^application:v1:[a-f0-9]{64}$/),
  report_artifact_stable_key: z.string().regex(/^artifact:v1:[a-f0-9]{64}$/),
  report_view: z.unknown(),
  latest_verification: z.unknown().nullable(),
})

export interface OwnedAssessmentReport {
  readonly assessmentId: string
  readonly applicationDatabaseId: string
  readonly artifactId: string
  readonly view: AssessmentReportView
  readonly verificationEnrichment: ReportVerificationEnrichment | null
}

export class AssessmentReportRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async isCurrent(input: {
    readonly assessmentId: string
    readonly headSha: string
  }): Promise<boolean> {
    const rows = await this.database.query(
      `select exists (
         select 1
         from sentinel.pr_assessments assessment
         where assessment.id = $1::uuid
           and assessment.head_sha = $2
           and assessment.is_current
       ) as current`,
      [z.uuid().parse(input.assessmentId), commitShaSchema.parse(input.headSha)]
    )
    return currentHeadRowSchema.parse(rows[0]).current
  }

  async finalize(input: {
    readonly assessmentId: string
    readonly headSha: string
    readonly report: AssessmentReportView
    readonly identityHash: string
    readonly artifactDatabaseId: string
  }): Promise<"published" | "existing" | "superseded"> {
    const report = assessmentReportViewSchema.parse(input.report)
    const identityHash = contentHashSchema.parse(input.identityHash)
    if (
      report.assessmentId !== input.assessmentId ||
      report.headSha !== input.headSha
    ) {
      throw new Error("Report finalization identity conflicts with its view")
    }
    const rows = await this.database.query(
      `select * from sentinel.finalize_assessment_report(
         $1::uuid, $2, $3, $4, $5::uuid, $6::text::jsonb,
         $7::text::jsonb, $8::timestamptz
       )`,
      [
        z.uuid().parse(input.assessmentId),
        commitShaSchema.parse(input.headSha),
        report.id,
        identityHash,
        z.uuid().parse(input.artifactDatabaseId),
        JSON.stringify({
          policyVersion: report.policyVersion,
          templateVersion: report.templateVersion,
          wordingPromptVersion: report.wordingPromptVersion,
          model: report.model,
          graphRevision: report.graphRevision,
          graphCommitSha: report.graphCommitSha,
        }),
        JSON.stringify(report),
        new Date(report.generatedAt),
      ]
    )
    const row = finalizeRowSchema.parse(rows[0])
    if (row.disposition !== "superseded" && row.report_id !== report.id) {
      throw new Error("Finalized report identity changed")
    }
    return row.disposition
  }

  async getOwned(input: {
    readonly operatorId: string
    readonly assessmentId: string
  }): Promise<OwnedAssessmentReport | null> {
    const rows = await this.database.query(
      `select assessment.id as assessment_id,
              application.id as application_database_id,
              application.stable_key as application_stable_id,
              artifact.stable_key as report_artifact_stable_key,
              assessment.report_view,
              enrichment.payload as latest_verification
       from sentinel.pr_assessments assessment
       join sentinel.applications application
         on application.id = assessment.application_id
       join sentinel.onboarding_configurations onboarding
         on onboarding.application_id = application.id
        and onboarding.operator_id = $1::uuid
       join sentinel.artifacts artifact
         on artifact.id = assessment.report_artifact_id
        and artifact.application_id = application.id
        and artifact.artifact_type = 'assessment_report_markdown'
        and artifact.mime_type = 'text/markdown'
        and artifact.deleted_at is null
       join storage.buckets bucket
         on bucket.id = artifact.bucket and bucket.public = false
       left join lateral (
         select item.payload
         from sentinel.report_verification_enrichments item
         where item.assessment_id = assessment.id
           and item.report_id = assessment.report_id
         order by item.version desc
         limit 1
       ) enrichment on true
       where assessment.id = $2::uuid
         and assessment.report_id is not null
       limit 1`,
      [z.uuid().parse(input.operatorId), z.uuid().parse(input.assessmentId)]
    )
    if (rows[0] === undefined) return null
    const row = ownedRowSchema.parse(rows[0])
    const view = assessmentReportViewSchema.parse(row.report_view)
    if (
      view.assessmentId !== row.assessment_id ||
      view.applicationId !== row.application_stable_id
    ) {
      throw new Error("Owned report projection conflicts with stored identity")
    }
    return {
      assessmentId: row.assessment_id,
      applicationDatabaseId: row.application_database_id,
      artifactId: row.report_artifact_stable_key,
      view,
      verificationEnrichment:
        row.latest_verification === null
          ? null
          : reportVerificationEnrichmentSchema.parse(row.latest_verification),
    }
  }

  async appendVerification(
    inputValue: ReportVerificationEnrichment
  ): Promise<boolean> {
    const input = reportVerificationEnrichmentSchema.parse(inputValue)
    const rows = await this.database.query<{ appended: boolean }>(
      `select sentinel.append_report_verification_enrichment(
         $1::uuid, $2, $3, $4::text::jsonb, $5::timestamptz
       ) as appended`,
      [
        input.assessmentId,
        input.reportId,
        input.version,
        JSON.stringify(input),
        new Date(input.appendedAt),
      ]
    )
    return rows[0]?.appended === true
  }
}
