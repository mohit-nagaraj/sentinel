import {
  assessmentReportViewSchema,
  artifactIdSchema,
  commitShaSchema,
  contentHashSchema,
  reportVerificationSchema,
  reportVerificationEnrichmentSchema,
  runStatusSchema,
  timestampSchema,
  type AssessmentReportView,
  type ReportVerification,
  type ReportVerificationEnrichment,
} from "@sentinel/contracts"
import { z } from "zod"

import type { DatabaseExecutor } from "./database.ts"

const finalizeRowSchema = z.object({
  disposition: z.enum(["published", "existing", "superseded"]),
  report_id: contentHashSchema.nullable(),
  report_artifact_id: artifactIdSchema.nullable(),
})

const currentHeadRowSchema = z.object({ current: z.boolean() })

const appendCurrentRowSchema = z.object({
  disposition: z.enum(["published", "existing", "superseded"]),
  version: z.number().int().positive().nullable(),
  report_id: contentHashSchema.nullable(),
})

const ownedRowSchema = z.object({
  assessment_id: z.uuid(),
  application_database_id: z.uuid(),
  application_stable_id: z.string().regex(/^application:v1:[a-f0-9]{64}$/),
  report_artifact_stable_key: z.string().regex(/^artifact:v1:[a-f0-9]{64}$/),
  report_view: z.unknown(),
  latest_verification: z.unknown().nullable(),
})

const ownedStatusRowSchema = z.object({
  assessment_id: z.uuid(),
  application_database_id: z.uuid(),
  run_id: z.uuid(),
  run_status: runStatusSchema,
  pull_request_number: z.coerce.number().int().positive(),
  repository_owner: z.string().trim().min(1),
  repository_name: z.string().trim().min(1),
  error_category: z.string().nullable(),
  error_code: z.string().nullable(),
  error_retryable: z.boolean().nullable(),
})

export interface OwnedAssessmentReport {
  readonly assessmentId: string
  readonly applicationDatabaseId: string
  readonly artifactId: string
  readonly view: AssessmentReportView
  readonly verificationEnrichment: ReportVerificationEnrichment | null
}

export type OwnedAssessmentStatus = ReturnType<typeof mapOwnedAssessmentStatus>

function mapOwnedAssessmentStatus(value: unknown) {
  const row = ownedStatusRowSchema.parse(value)
  return {
    assessmentId: row.assessment_id,
    applicationDatabaseId: row.application_database_id,
    runId: row.run_id,
    runStatus: row.run_status,
    pullRequestNumber: row.pull_request_number,
    repositoryOwner: row.repository_owner,
    repositoryName: row.repository_name,
    error:
      row.error_category === null || row.error_code === null
        ? null
        : {
            category: row.error_category,
            code: row.error_code,
            retryable: row.error_retryable ?? false,
          },
  }
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
  }): Promise<{
    readonly disposition: "published" | "existing" | "superseded"
    readonly artifactId: string | null
  }> {
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
    if (row.disposition === "published" && row.report_id !== report.id) {
      throw new Error("Finalized report identity changed")
    }
    if (row.disposition === "published" && row.report_artifact_id === null) {
      throw new Error("Finalized report artifact is missing")
    }
    if (
      row.disposition === "existing" &&
      (row.report_id === null || row.report_artifact_id === null)
    ) {
      throw new Error("Existing report identity is incomplete")
    }
    return {
      disposition: row.disposition,
      artifactId: row.report_artifact_id,
    }
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

  async getOwnedStatus(input: {
    readonly operatorId: string
    readonly assessmentId: string
  }): Promise<OwnedAssessmentStatus | null> {
    const rows = await this.database.query(
      `select assessment.id as assessment_id,
              application.id as application_database_id,
              latest_run.id as run_id,
              latest_run.status as run_status,
              assessment.pull_request_number,
              assessment.repository_owner,
              assessment.repository_name,
              latest_run.error_category,
              latest_run.error_code,
              latest_run.error_retryable
         from sentinel.pr_assessments assessment
         join sentinel.applications application
           on application.id = assessment.application_id
         join sentinel.onboarding_configurations onboarding
           on onboarding.application_id = application.id
          and onboarding.operator_id = $1::uuid
         join lateral (
           with recursive retries as (
             select run.*
               from sentinel.runs run
              where run.id = assessment.run_id
             union all
             select child.*
               from sentinel.runs child
               join retries parent on child.retry_of = parent.id
           )
           select * from retries order by created_at desc, id desc limit 1
         ) latest_run on true
        where assessment.id = $2::uuid
        limit 1`,
      [z.uuid().parse(input.operatorId), z.uuid().parse(input.assessmentId)]
    )
    return rows[0] === undefined ? null : mapOwnedAssessmentStatus(rows[0])
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

  async appendCurrent(input: {
    readonly assessmentId: string
    readonly headSha: string
    readonly resultId: string
    readonly verification: Omit<ReportVerification, "version">
    readonly appendedAt: string
    readonly idempotencyKey: string
  }): Promise<{
    readonly disposition: "published" | "existing" | "superseded"
    readonly version?: number
  }> {
    const parsed = reportVerificationSchema.parse({
      ...input.verification,
      version: 1,
    })
    const { version: _version, ...verification } = parsed
    void _version
    const rows = await this.database.query(
      `select * from sentinel.append_current_report_verification(
         $1::uuid, $2, $3, $4, $5::text::jsonb, $6::timestamptz
       )`,
      [
        z.uuid().parse(input.assessmentId),
        commitShaSchema.parse(input.headSha),
        contentHashSchema.parse(input.resultId),
        contentHashSchema.parse(input.idempotencyKey),
        JSON.stringify(verification),
        new Date(timestampSchema.parse(input.appendedAt)),
      ]
    )
    const row = appendCurrentRowSchema.parse(rows[0])
    if (row.disposition === "superseded") {
      return { disposition: "superseded" }
    }
    if (row.version === null || row.report_id === null) {
      throw new Error(
        "Verification enrichment append returned incomplete state"
      )
    }
    return { disposition: row.disposition, version: row.version }
  }
}
