import {
  executionBudgetSchema,
  parseRunEvent,
  persistedTextSchema,
  publicErrorSchema,
  reasonCodeSchema,
  runStatusSchema,
  runTypeSchema,
  type MissionBudget,
  type RunEvent,
} from "@sentinel/contracts"
import { z } from "zod"

import type { DatabaseExecutor } from "./database.ts"

const runRowSchema = z.object({
  id: z.uuid(),
  application_id: z.uuid(),
  run_type: runTypeSchema,
  status: runStatusSchema,
  idempotency_key: z.string().min(1),
  budget: executionBudgetSchema,
  lease_owner: z.string().nullable(),
  lease_expires_at: z.coerce.date().nullable(),
  attempt_count: z.number().int().nonnegative(),
  cancel_requested_at: z.coerce.date().nullable(),
  created_at: z.coerce.date(),
  started_at: z.coerce.date().nullable(),
  finished_at: z.coerce.date().nullable(),
})
type RunRow = z.infer<typeof runRowSchema> & Record<string, unknown>

export interface RunRecord {
  readonly id: string
  readonly applicationId: string
  readonly runType: string
  readonly status: string
  readonly idempotencyKey: string
  readonly budget: MissionBudget
  readonly leaseOwner: string | null
  readonly leaseExpiresAt: Date | null
  readonly attemptCount: number
  readonly cancelRequestedAt: Date | null
  readonly createdAt: Date
  readonly startedAt: Date | null
  readonly finishedAt: Date | null
}

function mapRun(row: RunRow): RunRecord {
  const parsed = runRowSchema.parse(row)
  return {
    id: parsed.id,
    applicationId: parsed.application_id,
    runType: parsed.run_type,
    status: parsed.status,
    idempotencyKey: parsed.idempotency_key,
    budget: parsed.budget,
    leaseOwner: parsed.lease_owner,
    leaseExpiresAt: parsed.lease_expires_at,
    attemptCount: parsed.attempt_count,
    cancelRequestedAt: parsed.cancel_requested_at,
    createdAt: parsed.created_at,
    startedAt: parsed.started_at,
    finishedAt: parsed.finished_at,
  }
}

export class RunRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async enqueue(input: {
    readonly applicationId: string
    readonly runType: string
    readonly idempotencyKey: string
    readonly budget: MissionBudget
  }): Promise<RunRecord> {
    const applicationId = z.uuid().parse(input.applicationId)
    const runType = runTypeSchema.parse(input.runType)
    const idempotencyKey = persistedTextSchema.parse(input.idempotencyKey)
    const budget = executionBudgetSchema.parse(input.budget)
    const rows = await this.database.query<RunRow>(
      "select * from sentinel.enqueue_run($1::uuid, $2, $3, $4::text::jsonb)",
      [applicationId, runType, idempotencyKey, JSON.stringify(budget)]
    )
    const row = rows[0]
    if (row === undefined) {
      throw new Error("Run enqueue returned no row")
    }
    return mapRun(row)
  }

  async claim(owner: string, leaseSeconds = 60): Promise<RunRecord | null> {
    const leaseOwner = z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9:._-]+$/)
      .parse(owner)
    const duration = z.number().int().min(5).max(3600).parse(leaseSeconds)
    const rows = await this.database.query<RunRow>(
      "select * from sentinel.claim_run($1, $2)",
      [leaseOwner, duration]
    )
    return rows[0] === undefined ? null : mapRun(rows[0])
  }

  async heartbeat(
    runId: string,
    owner: string,
    leaseSeconds = 60
  ): Promise<boolean> {
    const id = z.uuid().parse(runId)
    const leaseOwner = z.string().trim().min(1).max(255).parse(owner)
    const duration = z.number().int().min(5).max(3600).parse(leaseSeconds)
    const rows = await this.database.query<{ heartbeat_run: boolean }>(
      "select sentinel.heartbeat_run($1::uuid, $2, $3) as heartbeat_run",
      [id, leaseOwner, duration]
    )
    return rows[0]?.heartbeat_run ?? false
  }

  async finish(input: {
    readonly runId: string
    readonly owner: string
    readonly status: "succeeded" | "failed" | "cancelled"
    readonly errorCategory?: string
    readonly errorCode?: string
  }): Promise<boolean> {
    const runId = z.uuid().parse(input.runId)
    const owner = z.string().trim().min(1).max(255).parse(input.owner)
    const errorCategory =
      input.errorCategory === undefined
        ? null
        : publicErrorSchema.shape.category.parse(input.errorCategory)
    const errorCode =
      input.errorCode === undefined
        ? null
        : reasonCodeSchema.parse(input.errorCode)
    if (
      input.status === "failed" &&
      (errorCategory === null || errorCode === null)
    ) {
      throw new Error("Failed runs require an error category and code")
    }
    if (
      input.status !== "failed" &&
      (errorCategory !== null || errorCode !== null)
    ) {
      throw new Error("Non-failed runs cannot persist error fields")
    }
    const rows = await this.database.query<{ finish_run: boolean }>(
      "select sentinel.finish_run($1::uuid, $2, $3, $4, $5) as finish_run",
      [runId, owner, input.status, errorCategory, errorCode]
    )
    return rows[0]?.finish_run ?? false
  }

  async requestCancellation(runId: string): Promise<string | null> {
    const id = z.uuid().parse(runId)
    const rows = await this.database.query<{
      request_run_cancellation: string | null
    }>(
      "select sentinel.request_run_cancellation($1::uuid) as request_run_cancellation",
      [id]
    )
    return rows[0]?.request_run_cancellation ?? null
  }

  async appendEvent(
    eventInput: unknown,
    idempotencyKeyInput: string
  ): Promise<{
    readonly sequence: number
    readonly event: RunEvent
  }> {
    const event = parseRunEvent(eventInput)
    const idempotencyKey = z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9:._-]+$/)
      .parse(idempotencyKeyInput)
    const databaseRunId = z.uuid().parse(event.runId.slice("run:".length))
    const rows = await this.database.query<{
      sequence: number
      event: unknown
    }>(
      "select sequence, event from sentinel.append_run_event($1::uuid, $2, $3::text::jsonb, $4::timestamptz, $5)",
      [
        databaseRunId,
        event.kind,
        JSON.stringify(event),
        event.occurredAt,
        idempotencyKey,
      ]
    )
    const row = rows[0]
    if (row === undefined) {
      throw new Error("Run event append returned no row")
    }
    return {
      sequence: z.coerce.number().int().positive().parse(row.sequence),
      event: parseRunEvent(row.event),
    }
  }

  async listEvents(runId: string): Promise<readonly RunEvent[]> {
    const id = z.uuid().parse(runId)
    const rows = await this.database.query<{ event: unknown }>(
      "select event from sentinel.run_events where run_id = $1::uuid order by sequence",
      [id]
    )
    return rows.map((row) => parseRunEvent(row.event))
  }
}
