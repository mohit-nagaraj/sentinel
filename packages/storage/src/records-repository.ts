import {
  canonicalSerialize,
  contentHashSchema,
  persistedTextSchema,
  redactPersistedText,
  shortTextSchema,
} from "@sentinel/contracts"
import { z } from "zod"

import type { DatabaseExecutor } from "./database.ts"

const sensitiveDetailKeys = new Set([
  "apikey",
  "auth",
  "authorization",
  "clientsecret",
  "connectsid",
  "cookie",
  "credential",
  "laravelsession",
  "password",
  "phpsessid",
  "privatekey",
  "secret",
  "sessionid",
  "sid",
  "token",
])

function assertSecretSafeDetails(value: unknown, path = "$"): void {
  if (typeof value === "string") {
    const result = persistedTextSchema.safeParse(value)
    if (!result.success) {
      throw new Error(`Eval details contain secret-shaped text at ${path}`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertSecretSafeDetails(item, `${path}[${index}]`)
    )
    return
  }
  if (value === null || typeof value !== "object") return

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase()
    if (
      sensitiveDetailKeys.has(normalizedKey) &&
      child !== null &&
      child !== "[REDACTED]"
    ) {
      throw new Error(
        `Eval details contain a sensitive field at ${path}.${key}`
      )
    }
    assertSecretSafeDetails(child, `${path}.${key}`)
  }
}

export class RecordsRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async addAssessmentFinding(input: {
    readonly assessmentId: string
    readonly stableKey: string
    readonly risk: "high" | "medium" | "low" | "unknown"
    readonly evidenceStrength: "A" | "B" | "C" | "D"
    readonly title: string
    readonly summary: string
    readonly verificationStatus:
      | "passed"
      | "failed"
      | "behavior_changed"
      | "blocked"
      | "not_run"
      | "verification_unavailable"
    readonly evidencePathCount: number
  }): Promise<string> {
    const assessmentId = z.uuid().parse(input.assessmentId)
    const stableKey = z.string().trim().min(1).max(512).parse(input.stableKey)
    const title = shortTextSchema.parse(input.title)
    const summary = persistedTextSchema.parse(input.summary)
    const evidencePathCount = z
      .number()
      .int()
      .positive()
      .parse(input.evidencePathCount)
    const rows = await this.database.query<{ id: string }>(
      `insert into sentinel.assessment_findings (
         assessment_id, stable_key, risk, evidence_strength, title, summary,
         verification_status, evidence_path_count
       ) values ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
       on conflict (assessment_id, stable_key) do update
       set risk = excluded.risk,
           evidence_strength = excluded.evidence_strength,
           title = excluded.title,
           summary = excluded.summary,
           verification_status = excluded.verification_status,
           evidence_path_count = excluded.evidence_path_count
       returning id`,
      [
        assessmentId,
        stableKey,
        input.risk,
        input.evidenceStrength,
        title,
        summary,
        input.verificationStatus,
        evidencePathCount,
      ]
    )
    const id = rows[0]?.id
    if (id === undefined) throw new Error("Finding write returned no row")
    return z.uuid().parse(id)
  }

  async recordLinkReview(input: {
    readonly applicationId: string
    readonly linkStableKey: string
    readonly sourceIdentityHash: string
    readonly decision: "accepted" | "rejected"
    readonly reason: string
    readonly decidedBy: string
  }): Promise<string> {
    const applicationId = z.uuid().parse(input.applicationId)
    const sourceIdentityHash = contentHashSchema.parse(input.sourceIdentityHash)
    const reason = persistedTextSchema.parse(input.reason)
    const decidedBy = z.uuid().parse(input.decidedBy)
    const rows = await this.database.query<{ id: string }>(
      `insert into sentinel.link_reviews (
         application_id, link_stable_key, source_identity_hash, decision,
         reason, decided_by
       ) values ($1::uuid, $2, $3, $4, $5, $6::uuid)
       on conflict (application_id, link_stable_key, source_identity_hash)
       do update set decision = excluded.decision,
                     reason = excluded.reason,
                     decided_by = excluded.decided_by,
                     decided_at = now()
       returning id`,
      [
        applicationId,
        input.linkStableKey,
        sourceIdentityHash,
        input.decision,
        reason,
        decidedBy,
      ]
    )
    const id = rows[0]?.id
    if (id === undefined) throw new Error("Link review write returned no row")
    return z.uuid().parse(id)
  }

  async recordEvalResult(input: {
    readonly applicationId: string
    readonly runId: string | null
    readonly fixtureKey: string
    readonly metricKey: string
    readonly outcome: "passed" | "failed" | "blocked"
    readonly value: number | null
    readonly details: Readonly<Record<string, unknown>>
  }): Promise<string> {
    const applicationId = z.uuid().parse(input.applicationId)
    const runId = input.runId === null ? null : z.uuid().parse(input.runId)
    const fixtureKey = z.string().trim().min(1).max(256).parse(input.fixtureKey)
    const metricKey = z.string().trim().min(1).max(256).parse(input.metricKey)
    assertSecretSafeDetails(input.details)
    const details = canonicalSerialize(input.details)
    if (redactPersistedText(details) !== details) {
      throw new Error("Eval details contain secret-shaped syntax")
    }
    const rows = await this.database.query<{ id: string }>(
      `insert into sentinel.eval_results (
         application_id, run_id, fixture_key, metric_key, outcome, value, details
       ) values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::text::jsonb)
       on conflict (application_id, run_id, fixture_key, metric_key) do update
       set application_id = excluded.application_id,
           outcome = excluded.outcome,
           value = excluded.value,
           details = excluded.details
       returning id`,
      [
        applicationId,
        runId,
        fixtureKey,
        metricKey,
        input.outcome,
        input.value,
        details,
      ]
    )
    const id = rows[0]?.id
    if (id === undefined) throw new Error("Eval result write returned no row")
    return z.uuid().parse(id)
  }
}
