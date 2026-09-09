import {
  commitShaSchema,
  githubAssessmentEnqueueResultSchema,
  githubAssessmentTriggerSchema,
  githubCheckRunIdSchema,
  githubCheckTargetSchema,
  runControlBudgetSchema,
  type GithubAssessmentEnqueueResult,
  type GithubAssessmentTrigger,
  type GithubCheckTarget,
} from "@sentinel/contracts"
import { z } from "zod"

import type { DatabaseExecutor } from "./database.ts"

const manualTargetRowSchema = z.object({
  application_id: z.uuid(),
  installation_id: z.string().regex(/^[1-9][0-9]{0,19}$/),
  repository_host: z.literal("github.com"),
  repository_owner: z.string().trim().min(1).max(100),
  repository_name: z.string().trim().min(1).max(100),
})

const enqueueRowSchema = z.object({
  disposition: z.enum(["created", "duplicate", "stale"]),
  assessment_id: z.uuid(),
  run_id: z.uuid().nullable(),
  installation_id: z.string().regex(/^[1-9][0-9]{0,19}$/),
  repository_host: z.literal("github.com"),
  repository_owner: z.string().trim().min(1).max(100),
  repository_name: z.string().trim().min(1).max(100),
  pull_request_number: z.number().int().positive(),
  head_sha: commitShaSchema,
  is_current: z.boolean(),
  check_run_id: githubCheckRunIdSchema.nullable(),
})

const checkTargetRowSchema = z.object({
  assessment_id: z.uuid(),
  installation_id: z.string().regex(/^[1-9][0-9]{0,19}$/),
  repository_host: z.literal("github.com"),
  repository_owner: z.string().trim().min(1).max(100),
  repository_name: z.string().trim().min(1).max(100),
  pull_request_number: z.number().int().positive(),
  head_sha: commitShaSchema,
  is_current: z.boolean(),
  check_run_id: githubCheckRunIdSchema.nullable(),
  sync_lease_token: z.uuid().nullable(),
  recovering: z.boolean(),
})

const knownErrorCodes = [
  "active_run_conflict",
  "assessment_idempotency_conflict",
  "delivery_idempotency_conflict",
  "github_identity_conflict",
  "github_installation_not_found",
  "invalid_budget",
  "invalid_check_lease",
  "invalid_check_run_id",
  "invalid_github_assessment",
  "invalid_application_state",
  "knowledge_not_ready",
  "onboarding_not_confirmed",
  "stale_assessment",
] as const

export type GithubAssessmentRepositoryErrorCode =
  (typeof knownErrorCodes)[number] | "storage_unavailable"

export class GithubAssessmentRepositoryError extends Error {
  constructor(
    readonly code: GithubAssessmentRepositoryErrorCode,
    options?: ErrorOptions
  ) {
    super(code, options)
    this.name = "GithubAssessmentRepositoryError"
  }
}

function throwRepositoryError(error: unknown): never {
  const message = error instanceof Error ? error.message : ""
  const code = knownErrorCodes.find((candidate) => message.includes(candidate))
  throw new GithubAssessmentRepositoryError(code ?? "storage_unavailable", {
    cause: error,
  })
}

function mapEnqueue(row: unknown): GithubAssessmentEnqueueResult {
  const parsed = enqueueRowSchema.parse(row)
  return githubAssessmentEnqueueResultSchema.parse({
    schemaVersion: 1,
    disposition: parsed.disposition,
    assessmentId: parsed.assessment_id,
    runId: parsed.run_id,
    installationId: parsed.installation_id,
    repository: {
      host: parsed.repository_host,
      owner: parsed.repository_owner,
      name: parsed.repository_name,
    },
    pullRequestNumber: parsed.pull_request_number,
    headSha: parsed.head_sha,
    isCurrent: parsed.is_current,
    checkRunId: parsed.check_run_id,
  })
}

function mapCheckTarget(row: unknown): GithubCheckTarget {
  const parsed = checkTargetRowSchema.parse(row)
  return githubCheckTargetSchema.parse({
    schemaVersion: 1,
    assessmentId: parsed.assessment_id,
    installationId: parsed.installation_id,
    repository: {
      host: parsed.repository_host,
      owner: parsed.repository_owner,
      name: parsed.repository_name,
    },
    pullRequestNumber: parsed.pull_request_number,
    headSha: parsed.head_sha,
    isCurrent: parsed.is_current,
    checkRunId: parsed.check_run_id,
    syncLeaseToken: parsed.sync_lease_token,
    recovering: parsed.recovering,
  })
}

export interface ManualGithubAssessmentTarget {
  readonly applicationId: string
  readonly installationId: string
  readonly repository: {
    readonly host: "github.com"
    readonly owner: string
    readonly name: string
  }
}

export class GithubAssessmentRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async getManualTarget(
    operatorIdInput: string,
    applicationIdInput: string
  ): Promise<ManualGithubAssessmentTarget | null> {
    const operatorId = z.uuid().parse(operatorIdInput)
    const applicationId = z.uuid().parse(applicationIdInput)
    try {
      const rows = await this.database.query(
        "select * from sentinel.get_manual_github_assessment_target($1::uuid, $2::uuid)",
        [operatorId, applicationId]
      )
      const row = rows[0]
      if (row === undefined) return null
      const parsed = manualTargetRowSchema.parse(row)
      return {
        applicationId: parsed.application_id,
        installationId: parsed.installation_id,
        repository: {
          host: parsed.repository_host,
          owner: parsed.repository_owner,
          name: parsed.repository_name,
        },
      }
    } catch (error) {
      throwRepositoryError(error)
    }
  }

  async enqueue(
    triggerInput: GithubAssessmentTrigger | unknown,
    budgetInput: unknown
  ): Promise<GithubAssessmentEnqueueResult> {
    const trigger = githubAssessmentTriggerSchema.parse(triggerInput)
    const budget = runControlBudgetSchema.parse(budgetInput)
    try {
      const rows = await this.database.query(
        `select * from sentinel.enqueue_github_pr_assessment(
           $1, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10,
           $11, $12, $13::timestamptz, $14, $15::text::jsonb
         )`,
        [
          trigger.source,
          trigger.source === "webhook" ? trigger.deliveryId : null,
          trigger.source === "manual" ? trigger.operatorId : null,
          trigger.source === "manual" ? trigger.applicationId : null,
          trigger.installationId,
          trigger.repositoryId,
          trigger.repository.owner,
          trigger.repository.name,
          trigger.pullRequestId,
          trigger.pullRequestNumber,
          trigger.baseSha,
          trigger.headSha,
          new Date(trigger.providerUpdatedAt),
          trigger.source === "webhook" ? trigger.action : "manual",
          JSON.stringify(budget),
        ]
      )
      const row = rows[0]
      if (row === undefined) {
        throw new Error("GitHub assessment enqueue returned no row")
      }
      return mapEnqueue(row)
    } catch (error) {
      if (error instanceof z.ZodError) throw error
      throwRepositoryError(error)
    }
  }

  async claimCheck(
    assessmentIdInput: string,
    headShaInput: string,
    leaseSeconds = 30
  ): Promise<GithubCheckTarget | null> {
    const assessmentId = z.uuid().parse(assessmentIdInput)
    const headSha = commitShaSchema.parse(headShaInput)
    const duration = z.number().int().min(5).max(120).parse(leaseSeconds)
    try {
      const rows = await this.database.query(
        "select * from sentinel.claim_github_assessment_check($1::uuid, $2, $3)",
        [assessmentId, headSha, duration]
      )
      return rows[0] === undefined ? null : mapCheckTarget(rows[0])
    } catch (error) {
      throwRepositoryError(error)
    }
  }

  async bindCheck(input: {
    readonly assessmentId: string
    readonly headSha: string
    readonly syncLeaseToken: string
    readonly checkRunId: string
  }): Promise<boolean> {
    try {
      const rows = await this.database.query<{ bound: boolean }>(
        `select sentinel.bind_github_assessment_check(
           $1::uuid, $2, $3::uuid, $4::bigint
         ) as bound`,
        [
          z.uuid().parse(input.assessmentId),
          commitShaSchema.parse(input.headSha),
          z.uuid().parse(input.syncLeaseToken),
          githubCheckRunIdSchema.parse(input.checkRunId),
        ]
      )
      return rows[0]?.bound === true
    } catch (error) {
      throwRepositoryError(error)
    }
  }

  async releaseCheck(input: {
    readonly assessmentId: string
    readonly headSha: string
    readonly syncLeaseToken: string
  }): Promise<boolean> {
    try {
      const rows = await this.database.query<{ released: boolean }>(
        `select sentinel.release_github_assessment_check(
           $1::uuid, $2, $3::uuid
         ) as released`,
        [
          z.uuid().parse(input.assessmentId),
          commitShaSchema.parse(input.headSha),
          z.uuid().parse(input.syncLeaseToken),
        ]
      )
      return rows[0]?.released === true
    } catch (error) {
      throwRepositoryError(error)
    }
  }

  async getCurrentCheck(
    assessmentIdInput: string,
    headShaInput: string
  ): Promise<GithubCheckTarget | null> {
    try {
      const rows = await this.database.query(
        "select * from sentinel.get_current_github_assessment_check($1::uuid, $2)",
        [z.uuid().parse(assessmentIdInput), commitShaSchema.parse(headShaInput)]
      )
      return rows[0] === undefined ? null : mapCheckTarget(rows[0])
    } catch (error) {
      throwRepositoryError(error)
    }
  }
}
