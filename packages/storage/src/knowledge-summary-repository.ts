import {
  applicationIdSchema,
  applicationStatusSchema,
  commitShaSchema,
  contentHashSchema,
  databaseApplicationIdSchema,
  databaseInterruptIdSchema,
  databaseRunIdSchema,
  evidenceIdSchema,
  persistedTextSchema,
  reasonCodeSchema,
  sourceKindSchema,
  stableEntityIdSchema,
} from "@sentinel/contracts"
import { z } from "zod"

import type { DatabaseClient, DatabaseExecutor } from "./database.ts"

const operatorIdSchema = z.uuid()

const ownedApplicationRowSchema = z.object({
  id: databaseApplicationIdSchema,
  stable_key: applicationIdSchema,
  name: z.string().trim().min(1).max(512),
  deployment_url: z.url({ protocol: /^https?$/ }),
  status: applicationStatusSchema,
  indexed_commit_sha: commitShaSchema.nullable(),
  graph_revision: z.coerce.number().int().nonnegative(),
  refreshed_at: z.coerce.date().nullable(),
  knowledge_stale: z.boolean(),
})

const sourceRowSchema = z.object({
  stable_key: stableEntityIdSchema,
  kind: sourceKindSchema,
  uri: z.string().trim().min(1).max(4_096),
  status: z.enum(["pending", "ready", "warning", "blocked", "failed"]),
  checked_at: z.coerce.date().nullable(),
})

const interruptRowSchema = z.object({
  id: databaseInterruptIdSchema,
  run_id: databaseRunIdSchema,
  decision_id: reasonCodeSchema,
  prompt: persistedTextSchema,
  status: z.enum(["pending", "responded"]),
  created_at: z.coerce.date(),
})

const linkReviewRowSchema = z.object({
  id: z.uuid(),
  link_stable_key: evidenceIdSchema,
  source_identity_hash: contentHashSchema,
  decision: z.enum(["accepted", "rejected"]),
  reason: persistedTextSchema,
  decided_at: z.coerce.date(),
})

export interface OwnedKnowledgeApplication {
  readonly id: string
  readonly stableKey: string
  readonly name: string
  readonly deploymentUrl: string
  readonly status: z.infer<typeof applicationStatusSchema>
  readonly indexedCommitSha: string | null
  readonly graphRevision: number
  readonly refreshedAt: Date | null
  readonly knowledgeStale: boolean
}

export interface KnowledgeSourceRecord {
  readonly stableKey: string
  readonly kind: z.infer<typeof sourceKindSchema>
  readonly uri: string
  readonly status: "pending" | "ready" | "warning" | "blocked" | "failed"
  readonly checkedAt: Date | null
}

export interface KnowledgeInterruptRecord {
  readonly id: string
  readonly runId: string
  readonly decisionId: string
  readonly prompt: string
  readonly status: "pending" | "responded"
  readonly createdAt: Date
}

export interface StoredLinkReview {
  readonly id: string
  readonly linkStableKey: string
  readonly sourceIdentityHash: string
  readonly decision: "accepted" | "rejected"
  readonly reason: string
  readonly decidedAt: Date
}

export class KnowledgeReviewConflictError extends Error {
  constructor() {
    super("The evidence link already has a different review decision")
    this.name = "KnowledgeReviewConflictError"
  }
}

function mapApplication(row: unknown): OwnedKnowledgeApplication {
  const parsed = ownedApplicationRowSchema.parse(row)
  return {
    id: parsed.id,
    stableKey: parsed.stable_key,
    name: parsed.name,
    deploymentUrl: parsed.deployment_url,
    status: parsed.status,
    indexedCommitSha: parsed.indexed_commit_sha,
    graphRevision: parsed.graph_revision,
    refreshedAt: parsed.refreshed_at,
    knowledgeStale: parsed.knowledge_stale,
  }
}

function mapSource(row: unknown): KnowledgeSourceRecord {
  const parsed = sourceRowSchema.parse(row)
  return {
    stableKey: parsed.stable_key,
    kind: parsed.kind,
    uri: parsed.uri,
    status: parsed.status,
    checkedAt: parsed.checked_at,
  }
}

function mapInterrupt(row: unknown): KnowledgeInterruptRecord {
  const parsed = interruptRowSchema.parse(row)
  return {
    id: parsed.id,
    runId: parsed.run_id,
    decisionId: parsed.decision_id,
    prompt: parsed.prompt,
    status: parsed.status,
    createdAt: parsed.created_at,
  }
}

function mapLinkReview(row: unknown): StoredLinkReview {
  const parsed = linkReviewRowSchema.parse(row)
  return {
    id: parsed.id,
    linkStableKey: parsed.link_stable_key,
    sourceIdentityHash: parsed.source_identity_hash,
    decision: parsed.decision,
    reason: parsed.reason,
    decidedAt: parsed.decided_at,
  }
}

async function selectOwnedApplication(
  database: DatabaseExecutor,
  operatorId: string,
  applicationId: string
): Promise<OwnedKnowledgeApplication | null> {
  const rows = await database.query(
    `select application.id, application.stable_key, application.name,
            application.deployment_url, application.status,
            application.indexed_commit_sha, application.graph_revision,
            application.refreshed_at, onboarding.knowledge_stale
     from sentinel.applications application
     join sentinel.onboarding_configurations onboarding
       on onboarding.application_id = application.id
      and onboarding.operator_id = $1::uuid
     where application.id = $2::uuid`,
    [
      operatorIdSchema.parse(operatorId),
      databaseApplicationIdSchema.parse(applicationId),
    ]
  )
  return rows[0] === undefined ? null : mapApplication(rows[0])
}

export class KnowledgeSummaryRepository {
  constructor(private readonly database: DatabaseClient) {}

  getOwnedApplication(
    operatorId: string,
    applicationId: string
  ): Promise<OwnedKnowledgeApplication | null> {
    return selectOwnedApplication(this.database, operatorId, applicationId)
  }

  async listOwnedSources(
    operatorIdInput: string,
    applicationIdInput: string
  ): Promise<readonly KnowledgeSourceRecord[]> {
    const operatorId = operatorIdSchema.parse(operatorIdInput)
    const applicationId = databaseApplicationIdSchema.parse(applicationIdInput)
    const rows = await this.database.query(
      `select source.stable_key, source.kind, source.uri, source.status,
              source.checked_at
       from sentinel.sources source
       join sentinel.onboarding_configurations onboarding
         on onboarding.application_id = source.application_id
        and onboarding.operator_id = $1::uuid
       where source.application_id = $2::uuid
       order by source.kind, source.stable_key`,
      [operatorId, applicationId]
    )
    return rows.map(mapSource)
  }

  async lastSuccessfulRunAt(
    operatorIdInput: string,
    applicationIdInput: string
  ): Promise<Date | null> {
    const rows = await this.database.query<{ finished_at: unknown }>(
      `select run.finished_at
       from sentinel.runs run
       join sentinel.onboarding_configurations onboarding
         on onboarding.application_id = run.application_id
        and onboarding.operator_id = $1::uuid
       where run.application_id = $2::uuid
         and run.status = 'succeeded'
         and run.run_type in ('initialize_knowledge', 'refresh_knowledge')
       order by run.finished_at desc
       limit 1`,
      [
        operatorIdSchema.parse(operatorIdInput),
        databaseApplicationIdSchema.parse(applicationIdInput),
      ]
    )
    const value = rows[0]?.finished_at
    return value === undefined || value === null
      ? null
      : z.coerce.date().parse(value)
  }

  async listOwnedPendingInterrupts(
    operatorIdInput: string,
    applicationIdInput: string,
    limitInput: unknown = 50
  ): Promise<readonly KnowledgeInterruptRecord[]> {
    const limit = z.coerce.number().int().min(1).max(50).parse(limitInput)
    const rows = await this.database.query(
      `select interrupt.id, interrupt.run_id, interrupt.decision_id,
              interrupt.prompt, interrupt.status, interrupt.created_at
       from sentinel.run_interrupts interrupt
       join sentinel.runs run on run.id = interrupt.run_id
       join sentinel.onboarding_configurations onboarding
         on onboarding.application_id = run.application_id
        and onboarding.operator_id = $1::uuid
       where run.application_id = $2::uuid
         and interrupt.status = 'pending'
       order by interrupt.created_at, interrupt.id
       limit $3`,
      [
        operatorIdSchema.parse(operatorIdInput),
        databaseApplicationIdSchema.parse(applicationIdInput),
        limit,
      ]
    )
    return rows.map(mapInterrupt)
  }

  async listOwnedLinkReviews(
    operatorIdInput: string,
    applicationIdInput: string,
    linkIdsInput: readonly string[]
  ): Promise<readonly StoredLinkReview[]> {
    const operatorId = operatorIdSchema.parse(operatorIdInput)
    const applicationId = databaseApplicationIdSchema.parse(applicationIdInput)
    const linkIds = z.array(evidenceIdSchema).max(50).parse(linkIdsInput)
    if (linkIds.length === 0) return []
    const rows = await this.database.query(
      `select review.id, review.link_stable_key,
              review.source_identity_hash, review.decision,
              review.reason, review.decided_at
       from sentinel.link_reviews review
       join sentinel.onboarding_configurations onboarding
         on onboarding.application_id = review.application_id
        and onboarding.operator_id = $1::uuid
       where review.application_id = $2::uuid
         and review.link_stable_key in (
           select jsonb_array_elements_text($3::text::jsonb)
         )
       order by review.decided_at desc, review.id desc`,
      [operatorId, applicationId, JSON.stringify(linkIds)]
    )
    return rows.map(mapLinkReview)
  }

  async recordOwnedLinkReview(input: {
    readonly operatorId: string
    readonly applicationId: string
    readonly linkStableKey: string
    readonly sourceIdentityHash: string
    readonly decision: "accepted" | "rejected"
    readonly reason: string
  }): Promise<{
    readonly review: StoredLinkReview
    readonly idempotent: boolean
  }> {
    const operatorId = operatorIdSchema.parse(input.operatorId)
    const applicationId = databaseApplicationIdSchema.parse(input.applicationId)
    const linkStableKey = evidenceIdSchema.parse(input.linkStableKey)
    const sourceIdentityHash = contentHashSchema.parse(input.sourceIdentityHash)
    const decision = z.enum(["accepted", "rejected"]).parse(input.decision)
    const reason = persistedTextSchema.min(3).parse(input.reason)
    return this.database.transaction(async (transaction) => {
      const rows = await transaction.query(
        `insert into sentinel.link_reviews (
           application_id, link_stable_key, source_identity_hash,
           decision, reason, decided_by
         )
         select $2::uuid, $3, $4, $5, $6, $1::uuid
         from sentinel.onboarding_configurations onboarding
         where onboarding.operator_id = $1::uuid
           and onboarding.application_id = $2::uuid
         on conflict (application_id, link_stable_key, source_identity_hash)
         do nothing
         returning id, link_stable_key, source_identity_hash,
                   decision, reason, decided_at`,
        [
          operatorId,
          applicationId,
          linkStableKey,
          sourceIdentityHash,
          decision,
          reason,
        ]
      )
      if (rows[0] !== undefined) {
        return { review: mapLinkReview(rows[0]), idempotent: false }
      }
      const existingRows = await transaction.query(
        `select review.id, review.link_stable_key,
                review.source_identity_hash, review.decision,
                review.reason, review.decided_at
         from sentinel.link_reviews review
         join sentinel.onboarding_configurations onboarding
           on onboarding.application_id = review.application_id
          and onboarding.operator_id = $1::uuid
         where review.application_id = $2::uuid
           and review.link_stable_key = $3
           and review.source_identity_hash = $4`,
        [operatorId, applicationId, linkStableKey, sourceIdentityHash]
      )
      const existing = existingRows[0]
      if (existing === undefined) {
        throw new Error("Owned application was not found")
      }
      const review = mapLinkReview(existing)
      if (review.decision !== decision || review.reason !== reason) {
        throw new KnowledgeReviewConflictError()
      }
      return { review, idempotent: true }
    })
  }
}
