import {
  contentHashSchema,
  secretReferenceSchema,
  sourceUriSchema,
  sourceKindSchema,
} from "@sentinel/contracts"
import { z } from "zod"

import type { DatabaseExecutor } from "./database.ts"

const sourceRowSchema = z.object({
  id: z.uuid(),
  application_id: z.uuid(),
  stable_key: z.string().min(1),
  kind: sourceKindSchema,
  uri: z.string().min(1),
  status: z.enum(["pending", "ready", "warning", "blocked", "failed"]),
  content_hash: contentHashSchema.nullable(),
  secret_reference: secretReferenceSchema.nullable(),
  checked_at: z.coerce.date().nullable(),
})
type SourceRow = z.infer<typeof sourceRowSchema> & Record<string, unknown>

export interface SourceRecord {
  readonly id: string
  readonly applicationId: string
  readonly stableKey: string
  readonly kind: string
  readonly uri: string
  readonly status: string
  readonly contentHash: string | null
  readonly secretReference: string | null
  readonly checkedAt: Date | null
}

function mapSource(row: SourceRow): SourceRecord {
  const parsed = sourceRowSchema.parse(row)
  return {
    id: parsed.id,
    applicationId: parsed.application_id,
    stableKey: parsed.stable_key,
    kind: parsed.kind,
    uri: parsed.uri,
    status: parsed.status,
    contentHash: parsed.content_hash,
    secretReference: parsed.secret_reference,
    checkedAt: parsed.checked_at,
  }
}

export class SourceRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async upsert(input: {
    readonly applicationId: string
    readonly stableKey: string
    readonly kind: "repository" | "documentation" | "application"
    readonly uri: string
    readonly status: "pending" | "ready" | "warning" | "blocked" | "failed"
    readonly contentHash: string | null
    readonly secretReference: string | null
  }): Promise<SourceRecord> {
    const applicationId = z.uuid().parse(input.applicationId)
    const stableKey = z.string().trim().min(1).max(512).parse(input.stableKey)
    const kind = sourceKindSchema.parse(input.kind)
    const uri = sourceUriSchema.parse(input.uri)
    const status = z
      .enum(["pending", "ready", "warning", "blocked", "failed"])
      .parse(input.status)
    const contentHash =
      input.contentHash === null
        ? null
        : contentHashSchema.parse(input.contentHash)
    const secretReference =
      input.secretReference === null
        ? null
        : secretReferenceSchema.parse(input.secretReference)
    const rows = await this.database.query<SourceRow>(
      `insert into sentinel.sources (
         application_id, stable_key, kind, uri, status, content_hash,
         secret_reference, checked_at
       ) values ($1::uuid, $2, $3, $4, $5, $6, $7, now())
       on conflict (application_id, stable_key) do update
       set kind = excluded.kind,
           uri = excluded.uri,
           status = excluded.status,
           content_hash = excluded.content_hash,
           secret_reference = excluded.secret_reference,
           checked_at = excluded.checked_at
       returning *`,
      [
        applicationId,
        stableKey,
        kind,
        uri,
        status,
        contentHash,
        secretReference,
      ]
    )
    const row = rows[0]
    if (row === undefined) throw new Error("Source upsert returned no row")
    return mapSource(row)
  }
}
