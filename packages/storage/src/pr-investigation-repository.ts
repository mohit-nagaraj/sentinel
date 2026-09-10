import {
  applicationIdSchema,
  codeMissionResultSchema,
  commitShaSchema,
  compatibilityReportSchema,
  contentHashSchema,
  evidenceCuratorResultSchema,
  githubInstallationIdSchema,
  hashCanonical,
  onboardingConfigurationSchema,
  prDiffAnalysisSchema,
  prInvestigationChangeGroupSchema,
  prInvestigationGraphPathSchema,
  prInvestigationOverlaySchema,
  prInvestigationResultSchema,
  prInvestigationUnknownSchema,
  repositoryIdentitySchema,
  repositoryPathSchema,
  type CodeMissionResult,
  type ApplicationId,
  type CommitSha,
  type EvidenceCuratorResult,
  type PrDiffAnalysis,
  type PrInvestigationChangeGroup,
  type PrInvestigationGraphPath,
  type PrInvestigationOverlay,
  type PrInvestigationResult,
  type PrInvestigationUnknown,
} from "@sentinel/contracts"
import {
  canonicalizeCodeMissionResult,
  type PrInvestigationPreparation,
  type PrInvestigationStore,
} from "@sentinel/orchestration"
import { z } from "zod"

import type { DatabaseExecutor } from "./database.ts"

const valueKindSchema = z.enum([
  "analysis",
  "preparation",
  "code-result",
  "graph-paths",
  "overlay",
  "curator-result",
  "result",
])
type ValueKind = z.infer<typeof valueKindSchema>

const storedValueSchema = z.object({
  stable_key: contentHashSchema,
  kind: valueKindSchema,
  value: z.unknown(),
})

const runtimeRowSchema = z.object({
  assessment_id: z.uuid(),
  application_stable_key: applicationIdSchema,
  graph_revision: z.coerce.number().int().positive(),
  graph_commit_sha: commitShaSchema,
  repository_host: z.string().min(1),
  repository_owner: z.string().min(1),
  repository_name: z.string().min(1),
  pull_request_number: z.coerce.number().int().positive(),
  base_sha: commitShaSchema,
  head_sha: commitShaSchema,
  github_installation_id: githubInstallationIdSchema,
  configuration: onboardingConfigurationSchema,
  compatibility_report: compatibilityReportSchema,
})

export interface PrAssessmentRuntimeContext {
  readonly applicationDatabaseId: string
  readonly runDatabaseId: string
  readonly assessmentId: string
  readonly applicationId: ApplicationId
  readonly graphRevision: number
  readonly graphCommitSha: CommitSha
  readonly repository: z.infer<typeof repositoryIdentitySchema>
  readonly pullRequestNumber: number
  readonly baseSha: CommitSha
  readonly headSha: CommitSha
  readonly installationId: string
  readonly repositoryPaths: readonly z.infer<typeof repositoryPathSchema>[]
}

function preparation(value: PrInvestigationPreparation) {
  return {
    groups: value.groups.map((item) =>
      prInvestigationChangeGroupSchema.parse(item)
    ),
    unknowns: value.unknowns.map((item) =>
      prInvestigationUnknownSchema.parse(item)
    ),
  }
}

export class PostgresPrInvestigationStore implements PrInvestigationStore {
  constructor(private readonly database: DatabaseExecutor) {}

  private async save(kind: ValueKind, value: unknown): Promise<string> {
    const stableKey = contentHashSchema.parse(
      hashCanonical({ kind, value, version: 1 })
    )
    const rows = await this.database.query<Record<string, unknown>>(
      `insert into sentinel.pr_investigation_values (stable_key, kind, value)
       values ($1, $2, $3::text::jsonb)
       on conflict (stable_key) do update set stable_key = excluded.stable_key
       returning stable_key, kind, value`,
      [stableKey, kind, JSON.stringify(value)]
    )
    const stored = storedValueSchema.parse(rows[0])
    if (
      stored.kind !== kind ||
      hashCanonical(stored.value) !== hashCanonical(value)
    ) {
      throw new Error("Conflicting durable PR investigation value")
    }
    return stableKey
  }

  private async load(id: string, kind: ValueKind): Promise<unknown> {
    const rows = await this.database.query<Record<string, unknown>>(
      `select stable_key, kind, value
         from sentinel.pr_investigation_values
        where stable_key = $1 and kind = $2`,
      [contentHashSchema.parse(id), kind]
    )
    const stored = storedValueSchema.safeParse(rows[0])
    if (!stored.success) {
      throw new Error(`Stored PR investigation ${kind} is missing`)
    }
    return stored.data.value
  }

  saveAnalysis(value: PrDiffAnalysis) {
    return this.save("analysis", prDiffAnalysisSchema.parse(value))
  }

  async loadAnalysis(id: string) {
    return prDiffAnalysisSchema.parse(await this.load(id, "analysis"))
  }

  savePreparation(value: PrInvestigationPreparation) {
    return this.save("preparation", preparation(value))
  }

  async loadPreparation(id: string): Promise<PrInvestigationPreparation> {
    const value = z
      .object({
        groups: z.array(prInvestigationChangeGroupSchema),
        unknowns: z.array(prInvestigationUnknownSchema),
      })
      .parse(await this.load(id, "preparation"))
    return { groups: value.groups, unknowns: value.unknowns }
  }

  saveCodeResult(value: CodeMissionResult) {
    return this.save("code-result", canonicalizeCodeMissionResult(value))
  }

  async loadCodeResults(ids: readonly string[]) {
    return Promise.all(
      ids.map(async (id) =>
        codeMissionResultSchema.parse(await this.load(id, "code-result"))
      )
    )
  }

  saveGraphPaths(value: readonly PrInvestigationGraphPath[]) {
    return this.save(
      "graph-paths",
      value.map((item) => prInvestigationGraphPathSchema.parse(item))
    )
  }

  async loadGraphPaths(id: string) {
    return z
      .array(prInvestigationGraphPathSchema)
      .parse(await this.load(id, "graph-paths"))
  }

  saveOverlay(value: PrInvestigationOverlay) {
    return this.save("overlay", prInvestigationOverlaySchema.parse(value))
  }

  async loadOverlay(id: string) {
    return prInvestigationOverlaySchema.parse(await this.load(id, "overlay"))
  }

  async findOverlayByEvidenceStateId(evidenceStateId: string) {
    const rows = await this.database.query<Record<string, unknown>>(
      `select stable_key, kind, value
         from sentinel.pr_investigation_values
        where kind = 'overlay'
          and value ->> 'curatorEvidenceStateId' = $1
        order by created_at desc
        limit 1`,
      [contentHashSchema.parse(evidenceStateId)]
    )
    const stored = storedValueSchema.safeParse(rows[0])
    return stored.success
      ? prInvestigationOverlaySchema.parse(stored.data.value)
      : null
  }

  saveCuratorResult(value: EvidenceCuratorResult) {
    return this.save(
      "curator-result",
      evidenceCuratorResultSchema.parse(value)
    )
  }

  async loadCuratorResult(id: string) {
    return evidenceCuratorResultSchema.parse(
      await this.load(id, "curator-result")
    )
  }

  saveResult(value: PrInvestigationResult) {
    return this.save("result", prInvestigationResultSchema.parse(value))
  }

  async loadResult(id: string) {
    return prInvestigationResultSchema.parse(await this.load(id, "result"))
  }
}

export class PrAssessmentRuntimeRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async resolve(input: {
    readonly applicationDatabaseId: string
    readonly runDatabaseId: string
  }): Promise<PrAssessmentRuntimeContext | null> {
    const rows = await this.database.query<Record<string, unknown>>(
      `with recursive run_lineage as (
         select id, retry_of, 0 as depth
           from sentinel.runs
          where id = $2::uuid and application_id = $1::uuid
         union all
         select parent.id, parent.retry_of, lineage.depth + 1
           from sentinel.runs parent
           join run_lineage lineage on parent.id = lineage.retry_of
          where lineage.depth < 20
       )
       select assessment.id as assessment_id,
              application.stable_key as application_stable_key,
              application.graph_revision,
              application.indexed_commit_sha as graph_commit_sha,
              assessment.repository_host, assessment.repository_owner,
              assessment.repository_name, assessment.pull_request_number,
              assessment.base_sha, assessment.head_sha,
              assessment.github_installation_id,
              onboarding.configuration, onboarding.compatibility_report
         from sentinel.pr_assessments assessment
         join sentinel.applications application
           on application.id = assessment.application_id
         join sentinel.onboarding_configurations onboarding
           on onboarding.application_id = application.id
        where assessment.application_id = $1::uuid
          and assessment.run_id in (select id from run_lineage)
          and assessment.is_current
          and application.indexed_commit_sha is not null
          and application.graph_revision > 0
          and onboarding.confirmation_fingerprint = onboarding.input_fingerprint`,
      [input.applicationDatabaseId, input.runDatabaseId]
    )
    if (rows[0] === undefined) return null
    const row = runtimeRowSchema.parse(rows[0])
    const repository = repositoryIdentitySchema.parse({
      host: row.repository_host,
      owner: row.repository_owner,
      name: row.repository_name,
    })
    return {
      applicationDatabaseId: input.applicationDatabaseId,
      runDatabaseId: input.runDatabaseId,
      assessmentId: row.assessment_id,
      applicationId: row.application_stable_key,
      graphRevision: row.graph_revision,
      graphCommitSha: row.graph_commit_sha,
      repository,
      pullRequestNumber: row.pull_request_number,
      baseSha: row.base_sha,
      headSha: row.head_sha,
      installationId: row.github_installation_id,
      repositoryPaths:
        row.compatibility_report.proposedScope.repositoryPaths,
    }
  }

  async isCurrent(input: {
    readonly assessmentId: string
    readonly headSha: string
  }): Promise<boolean> {
    const rows = await this.database.query<{ current: boolean }>(
      `select exists (
         select 1 from sentinel.pr_assessments
          where id = $1::uuid and head_sha = $2 and is_current
       ) as current`,
      [z.uuid().parse(input.assessmentId), commitShaSchema.parse(input.headSha)]
    )
    return z.boolean().parse(rows[0]?.current)
  }

  async isGraphCurrent(input: {
    readonly applicationId: string
    readonly graphRevision: number
    readonly graphCommitSha: string
  }): Promise<boolean> {
    const rows = await this.database.query<{ current: boolean }>(
      `select exists (
         select 1 from sentinel.applications
          where stable_key = $1 and graph_revision = $2
            and indexed_commit_sha = $3
       ) as current`,
      [
        applicationIdSchema.parse(input.applicationId),
        z.number().int().positive().parse(input.graphRevision),
        commitShaSchema.parse(input.graphCommitSha),
      ]
    )
    return z.boolean().parse(rows[0]?.current)
  }

  async publishCurrent(input: {
    readonly assessmentId: string
    readonly headSha: string
    readonly analysis: PrDiffAnalysis
    readonly result: PrInvestigationResult
  }): Promise<"published" | "superseded"> {
    const analysis = prDiffAnalysisSchema.parse(input.analysis)
    const result = prInvestigationResultSchema.parse(input.result)
    if (
      result.assessmentId !== input.assessmentId ||
      result.pullRequest.headSha !== input.headSha ||
      analysis.pullRequestId !== result.pullRequest.id
    ) {
      throw new Error("PR investigation publication identity conflicts")
    }
    const baselineStatus = {
      exact: "compatible",
      safe_ancestor_warning: "warning",
      stale_relevant: "refresh_required",
      unrelated_or_unknown: "blocked",
    }[analysis.baseline.status]
    const rows = await this.database.query<{ published: boolean }>(
      `update sentinel.pr_assessments
          set diff_hash = $3, baseline_status = $4,
              investigation_result_id = $5,
              investigation_result = $6::text::jsonb
        where id = $1::uuid and head_sha = $2 and is_current
        returning true as published`,
      [
        z.uuid().parse(input.assessmentId),
        commitShaSchema.parse(input.headSha),
        analysis.diffHash,
        baselineStatus,
        result.id,
        JSON.stringify(result),
      ]
    )
    return rows.length === 0 ? "superseded" : "published"
  }
}
