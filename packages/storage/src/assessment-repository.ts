import {
  commitShaSchema,
  contentHashSchema,
  repositoryIdentitySchema,
} from "@sentinel/contracts"
import { z } from "zod"

import type { DatabaseExecutor } from "./database.ts"

const assessmentRowSchema = z.object({
  id: z.uuid(),
  application_id: z.uuid(),
  repository_host: z.string().min(1),
  repository_owner: z.string().min(1),
  repository_name: z.string().min(1),
  pull_request_number: z.number().int().positive(),
  base_sha: commitShaSchema,
  head_sha: commitShaSchema,
  diff_hash: contentHashSchema,
  baseline_status: z.enum([
    "compatible",
    "warning",
    "refresh_required",
    "blocked",
  ]),
  is_current: z.boolean(),
  superseded_by_id: z.uuid().nullable(),
  created_at: z.coerce.date(),
})
type AssessmentRow = z.infer<typeof assessmentRowSchema> &
  Record<string, unknown>

export interface AssessmentRecord {
  readonly id: string
  readonly applicationId: string
  readonly repository: {
    readonly host: string
    readonly owner: string
    readonly name: string
  }
  readonly pullRequestNumber: number
  readonly baseSha: string
  readonly headSha: string
  readonly diffHash: string
  readonly baselineStatus: string
  readonly isCurrent: boolean
  readonly supersededById: string | null
  readonly createdAt: Date
}

function mapAssessment(row: AssessmentRow): AssessmentRecord {
  const parsed = assessmentRowSchema.parse(row)
  return {
    id: parsed.id,
    applicationId: parsed.application_id,
    repository: {
      host: parsed.repository_host,
      owner: parsed.repository_owner,
      name: parsed.repository_name,
    },
    pullRequestNumber: parsed.pull_request_number,
    baseSha: parsed.base_sha,
    headSha: parsed.head_sha,
    diffHash: parsed.diff_hash,
    baselineStatus: parsed.baseline_status,
    isCurrent: parsed.is_current,
    supersededById: parsed.superseded_by_id,
    createdAt: parsed.created_at,
  }
}

export class AssessmentRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async createOrGet(input: {
    readonly applicationId: string
    readonly repository: {
      readonly host: string
      readonly owner: string
      readonly name: string
    }
    readonly pullRequestNumber: number
    readonly baseSha: string
    readonly headSha: string
    readonly diffHash: string
    readonly baselineStatus: string
  }): Promise<AssessmentRecord> {
    const applicationId = z.uuid().parse(input.applicationId)
    const repository = repositoryIdentitySchema.parse(input.repository)
    const pullRequestNumber = z
      .number()
      .int()
      .positive()
      .parse(input.pullRequestNumber)
    const baseSha = commitShaSchema.parse(input.baseSha)
    const headSha = commitShaSchema.parse(input.headSha)
    const diffHash = contentHashSchema.parse(input.diffHash)
    const baselineStatus = z
      .enum(["compatible", "warning", "refresh_required", "blocked"])
      .parse(input.baselineStatus)
    const rows = await this.database.query<AssessmentRow>(
      "select * from sentinel.create_pr_assessment($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)",
      [
        applicationId,
        repository.host,
        repository.owner,
        repository.name,
        pullRequestNumber,
        baseSha,
        headSha,
        diffHash,
        baselineStatus,
      ]
    )
    const row = rows[0]
    if (row === undefined) {
      throw new Error("Assessment creation returned no row")
    }
    return mapAssessment(row)
  }
}
