import type { DatabaseExecutor } from "./database.ts"
import {
  applicationIdSchema,
  applicationStatusSchema,
  commitShaSchema,
  publicHttpUrlSchema,
  shortTextSchema,
} from "@sentinel/contracts"
import { z } from "zod"

const applicationRowSchema = z.object({
  id: z.uuid(),
  stable_key: z.string().min(1),
  name: z.string().min(1).max(512),
  deployment_url: z.url({ protocol: /^https?$/ }),
  status: applicationStatusSchema,
  indexed_commit_sha: commitShaSchema.nullable(),
  graph_revision: z.coerce.number().int().nonnegative(),
  refreshed_at: z.coerce.date().nullable(),
})
type ApplicationRow = z.infer<typeof applicationRowSchema> &
  Record<string, unknown>

export interface ApplicationRecord {
  readonly id: string
  readonly stableKey: string
  readonly name: string
  readonly deploymentUrl: string
  readonly status: string
  readonly indexedCommitSha: string | null
  readonly graphRevision: number
  readonly refreshedAt: Date | null
}

function mapApplication(row: ApplicationRow): ApplicationRecord {
  const parsed = applicationRowSchema.parse(row)
  return {
    id: parsed.id,
    stableKey: parsed.stable_key,
    name: parsed.name,
    deploymentUrl: parsed.deployment_url,
    status: parsed.status,
    indexedCommitSha: parsed.indexed_commit_sha,
    graphRevision: parsed.graph_revision,
    refreshedAt: parsed.refreshed_at,
  }
}

export class ApplicationRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async upsert(input: {
    readonly stableKey: string
    readonly name: string
    readonly deploymentUrl: string
    readonly status: string
  }): Promise<ApplicationRecord> {
    const stableKey = applicationIdSchema.parse(input.stableKey)
    const name = shortTextSchema.parse(input.name)
    const deploymentUrl = publicHttpUrlSchema.parse(input.deploymentUrl)
    const status = applicationStatusSchema.parse(input.status)
    const rows = await this.database.query<ApplicationRow>(
      `insert into sentinel.applications (stable_key, name, deployment_url, status)
       values ($1, $2, $3, $4)
       on conflict (stable_key) do update
       set name = excluded.name,
           deployment_url = excluded.deployment_url,
           status = excluded.status
       returning *`,
      [stableKey, name, deploymentUrl, status]
    )
    const row = rows[0]
    if (row === undefined) {
      throw new Error("Application upsert returned no row")
    }
    return mapApplication(row)
  }

  async activateGraphRevision(input: {
    readonly applicationId: string
    readonly expectedRevision: number
    readonly indexedCommitSha: string
  }): Promise<ApplicationRecord | null> {
    const applicationId = z.uuid().parse(input.applicationId)
    const expectedRevision = z
      .number()
      .int()
      .nonnegative()
      .parse(input.expectedRevision)
    const indexedCommitSha = commitShaSchema.parse(input.indexedCommitSha)
    const rows = await this.database.query<ApplicationRow>(
      `update sentinel.applications
       set graph_revision = graph_revision + 1,
           indexed_commit_sha = $3,
           refreshed_at = now(),
           status = 'ready'
       where id = $1::uuid and graph_revision = $2
       returning *`,
      [applicationId, expectedRevision, indexedCommitSha]
    )
    return rows[0] === undefined ? null : mapApplication(rows[0])
  }
}
