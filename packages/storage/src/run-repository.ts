import {
  controlMutationResultSchema,
  createRunRequestFingerprint,
  databaseApplicationIdSchema,
  databaseRunIdSchema,
  eventCursorSchema,
  executionBudgetSchema,
  hashCanonical,
  humanDecisionSchema,
  idempotencyKeySchema,
  pageLimitSchema,
  parseRunEvent,
  persistedTextSchema,
  publicErrorSchema,
  publicRunInterruptSchema,
  publicRunSchema,
  reasonCodeSchema,
  runCommandSchema,
  runStatusSchema,
  runTerminalPublicationSchema,
  runTypeSchema,
  type HumanDecision,
  type MissionBudget,
  type PublicRun,
  type PublicRunInterrupt,
  type RunCommand,
  type RunCursor,
  type RunEvent,
  type RunTerminalPublication,
} from "@sentinel/contracts"
import { z } from "zod"

import type { DatabaseExecutor, SqlParameter } from "./database.ts"

const operatorIdSchema = z.uuid()
const ownerSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9:._-]+$/)

const runRowSchema = z.object({
  id: databaseRunIdSchema,
  application_id: databaseApplicationIdSchema,
  run_type: runTypeSchema,
  status: runStatusSchema,
  idempotency_key: idempotencyKeySchema,
  budget: executionBudgetSchema,
  request: z.unknown(),
  request_fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  retry_of: databaseRunIdSchema.nullable(),
  resume_decision_id: reasonCodeSchema.nullable(),
  configuration_fingerprint: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .nullable(),
  lease_owner: z.string().nullable(),
  lease_expires_at: z.coerce.date().nullable(),
  attempt_count: z.coerce.number().int().nonnegative(),
  cancel_requested_at: z.coerce.date().nullable(),
  error_category: publicErrorSchema.shape.category.nullable(),
  error_code: reasonCodeSchema.nullable(),
  error_retryable: z.boolean().nullable(),
  created_at: z.coerce.date(),
  started_at: z.coerce.date().nullable(),
  finished_at: z.coerce.date().nullable(),
})
type RunRow = z.infer<typeof runRowSchema> & Record<string, unknown>

const interruptRowSchema = z.object({
  id: z.uuid(),
  run_id: databaseRunIdSchema,
  decision_id: reasonCodeSchema,
  prompt: persistedTextSchema.max(4_096),
  status: z.enum(["pending", "responded"]),
  response: z.unknown().nullable(),
  response_fingerprint: z.string().nullable(),
  created_at: z.coerce.date(),
  responded_at: z.coerce.date().nullable(),
})

const knownErrorCodes = [
  "active_run_conflict",
  "application_not_found",
  "assessment_not_ready",
  "cancellation_not_allowed",
  "idempotency_conflict",
  "interrupt_conflict",
  "interrupt_not_found",
  "invalid_budget",
  "invalid_application_state",
  "knowledge_not_ready",
  "lease_lost",
  "onboarding_not_confirmed",
  "publication_conflict",
  "retry_not_allowed",
  "run_not_found",
] as const
export type RunControlRepositoryErrorCode =
  (typeof knownErrorCodes)[number] | "storage_unavailable"

export class RunControlRepositoryError extends Error {
  constructor(
    readonly code: RunControlRepositoryErrorCode,
    options?: ErrorOptions
  ) {
    super(code, options)
    this.name = "RunControlRepositoryError"
  }
}

function throwControlError(error: unknown): never {
  const message = error instanceof Error ? error.message : ""
  const code = knownErrorCodes.find((candidate) => message.includes(candidate))
  throw new RunControlRepositoryError(code ?? "storage_unavailable", {
    cause: error,
  })
}

export interface RunRecord {
  readonly id: string
  readonly applicationId: string
  readonly runType: RunCommand["type"]
  readonly status: z.infer<typeof runStatusSchema>
  readonly idempotencyKey: string
  readonly budget: MissionBudget
  readonly request: unknown
  readonly requestFingerprint: string
  readonly retryOf: string | null
  readonly resumeDecisionId: string | null
  readonly configurationFingerprint: string | null
  readonly leaseOwner: string | null
  readonly leaseExpiresAt: Date | null
  readonly attemptCount: number
  readonly cancelRequestedAt: Date | null
  readonly errorCategory: z.infer<typeof publicErrorSchema>["category"] | null
  readonly errorCode: string | null
  readonly errorRetryable: boolean | null
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
    request: parsed.request,
    requestFingerprint: parsed.request_fingerprint,
    retryOf: parsed.retry_of,
    resumeDecisionId: parsed.resume_decision_id,
    configurationFingerprint: parsed.configuration_fingerprint,
    leaseOwner: parsed.lease_owner,
    leaseExpiresAt: parsed.lease_expires_at,
    attemptCount: parsed.attempt_count,
    cancelRequestedAt: parsed.cancel_requested_at,
    errorCategory: parsed.error_category,
    errorCode: parsed.error_code,
    errorRetryable: parsed.error_retryable,
    createdAt: parsed.created_at,
    startedAt: parsed.started_at,
    finishedAt: parsed.finished_at,
  }
}

const safeFailureMessages = {
  validation: "The run request is invalid.",
  configuration: "The run configuration is incomplete.",
  authorization: "The run was not authorized.",
  rate_limit: "A provider rate limit stopped the run.",
  timeout: "The run exceeded a dependency timeout.",
  provider: "A provider dependency failed.",
  storage: "A storage dependency failed.",
  cancelled: "The run was cancelled.",
  unknown: "The run failed unexpectedly.",
} as const

export function toPublicRun(run: RunRecord): PublicRun {
  const error =
    run.errorCategory === null || run.errorCode === null
      ? undefined
      : {
          category: run.errorCategory,
          code: run.errorCode,
          message: safeFailureMessages[run.errorCategory],
          retryable: run.errorRetryable ?? false,
        }
  return publicRunSchema.parse({
    schemaVersion: 1,
    id: run.id,
    applicationId: run.applicationId,
    type: run.runType,
    status: run.status,
    attemptCount: run.attemptCount,
    ...(run.retryOf === null ? {} : { retryOf: run.retryOf }),
    createdAt: run.createdAt.toISOString(),
    ...(run.startedAt === null
      ? {}
      : { startedAt: run.startedAt.toISOString() }),
    ...(run.finishedAt === null
      ? {}
      : { finishedAt: run.finishedAt.toISOString() }),
    ...(run.cancelRequestedAt === null
      ? {}
      : { cancelRequestedAt: run.cancelRequestedAt.toISOString() }),
    ...(error === undefined ? {} : { error }),
  })
}

function mapInterrupt(row: Record<string, unknown>): PublicRunInterrupt {
  const parsed = interruptRowSchema.parse(row)
  return publicRunInterruptSchema.parse({
    schemaVersion: 1,
    id: parsed.id,
    runId: parsed.run_id,
    decisionId: parsed.decision_id,
    prompt: parsed.prompt,
    status: parsed.status,
    createdAt: parsed.created_at.toISOString(),
    ...(parsed.responded_at === null
      ? {}
      : { respondedAt: parsed.responded_at.toISOString() }),
  })
}

export class RunRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  private async controlQuery<Row extends Record<string, unknown>>(
    statement: string,
    parameters: readonly SqlParameter[] = []
  ): Promise<readonly Row[]> {
    try {
      return await this.database.query<Row>(statement, parameters)
    } catch (error) {
      throwControlError(error)
    }
  }

  async enqueue(input: {
    readonly applicationId: string
    readonly runType: string
    readonly idempotencyKey: string
    readonly budget: MissionBudget
  }): Promise<RunRecord> {
    const applicationId = databaseApplicationIdSchema.parse(input.applicationId)
    const runType = runTypeSchema.parse(input.runType)
    const idempotencyKey = persistedTextSchema.parse(input.idempotencyKey)
    const budget = executionBudgetSchema.parse(input.budget)
    const rows = await this.database.query<RunRow>(
      "select * from sentinel.enqueue_run($1::uuid, $2, $3, $4::text::jsonb)",
      [applicationId, runType, idempotencyKey, JSON.stringify(budget)]
    )
    const row = rows[0]
    if (row === undefined) throw new Error("Run enqueue returned no row")
    return mapRun(row)
  }

  async enqueueControl(operatorIdInput: string, commandInput: unknown) {
    const operatorId = operatorIdSchema.parse(operatorIdInput)
    const command = runCommandSchema.parse(commandInput)
    const fingerprint = createRunRequestFingerprint(command)
    try {
      const rows = await this.database.query<RunRow & { created: boolean }>(
        `select (control.result).*, control.created
         from sentinel.enqueue_control_run(
           $1::uuid, $2::uuid, $3, $4, $5::text::jsonb,
           $6::text::jsonb, $7
         ) control`,
        [
          operatorId,
          command.applicationId,
          command.type,
          command.idempotencyKey,
          JSON.stringify(command.budget),
          JSON.stringify(command.payload),
          fingerprint,
        ]
      )
      const row = rows[0]
      if (row === undefined) throw new Error("Run enqueue returned no row")
      return {
        run: toPublicRun(mapRun(row)),
        created: z.boolean().parse(row.created),
      }
    } catch (error) {
      throwControlError(error)
    }
  }

  async claim(owner: string, leaseSeconds = 60): Promise<RunRecord | null> {
    const leaseOwner = ownerSchema.parse(owner)
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
    const rows = await this.database.query<{ heartbeat_run: boolean }>(
      "select sentinel.heartbeat_run($1::uuid, $2, $3) as heartbeat_run",
      [
        databaseRunIdSchema.parse(runId),
        ownerSchema.parse(owner),
        z.number().int().min(5).max(3600).parse(leaseSeconds),
      ]
    )
    return rows[0]?.heartbeat_run ?? false
  }

  async controlState(
    runId: string,
    owner: string
  ): Promise<"active" | "cancelled" | "lease_lost"> {
    const leaseOwner = ownerSchema.parse(owner)
    const rows = await this.controlQuery<{
      status: z.infer<typeof runStatusSchema>
      lease_owner: string | null
      lease_valid: boolean
      cancel_requested: boolean
    }>(
      `select status, lease_owner, lease_expires_at > now() as lease_valid,
              cancel_requested_at is not null as cancel_requested
       from sentinel.runs where id = $1::uuid`,
      [databaseRunIdSchema.parse(runId)]
    )
    const row = rows[0]
    if (
      row === undefined ||
      row.lease_owner !== leaseOwner ||
      !row.lease_valid
    ) {
      return "lease_lost"
    }
    return row.cancel_requested || row.status === "cancelling"
      ? "cancelled"
      : "active"
  }

  async finish(input: {
    readonly runId: string
    readonly owner: string
    readonly status: "succeeded" | "failed" | "cancelled"
    readonly errorCategory?: string
    readonly errorCode?: string
    readonly retryable?: boolean
    readonly publication?: RunTerminalPublication
  }): Promise<boolean> {
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
    const publication =
      input.status === "succeeded"
        ? runTerminalPublicationSchema.parse(input.publication)
        : null
    if (input.status !== "succeeded" && input.publication !== undefined) {
      throw new Error("Only succeeded runs can publish terminal output")
    }
    const policyRetryable = [
      "rate_limit",
      "timeout",
      "provider",
      "storage",
      "unknown",
    ].includes(errorCategory ?? "")
    if (
      input.status === "failed" &&
      input.retryable === true &&
      !policyRetryable
    ) {
      throw new Error("Failure retryability must match the category policy")
    }
    const retryable =
      input.status === "failed" ? (input.retryable ?? policyRetryable) : null
    try {
      const rows = await this.database.query<{ finish_control_run: boolean }>(
        "select sentinel.finish_control_run($1::uuid, $2, $3, $4, $5, $6, $7::text::jsonb) as finish_control_run",
        [
          databaseRunIdSchema.parse(input.runId),
          ownerSchema.parse(input.owner),
          input.status,
          errorCategory,
          errorCode,
          retryable,
          publication === null ? null : JSON.stringify(publication),
        ]
      )
      return (
        rows[0]?.finish_control_run ??
        (rows[0] as { finish_run?: boolean } | undefined)?.finish_run ??
        false
      )
    } catch (error) {
      throwControlError(error)
    }
  }

  async requestCancellation(runId: string): Promise<string | null> {
    const rows = await this.database.query<{
      request_run_cancellation: string | null
    }>(
      "select sentinel.request_run_cancellation($1::uuid) as request_run_cancellation",
      [databaseRunIdSchema.parse(runId)]
    )
    return rows[0]?.request_run_cancellation ?? null
  }

  async requestOwnedCancellation(
    operatorId: string,
    runId: string
  ): Promise<PublicRun | null> {
    try {
      const rows = await this.database.query<{
        cancel_control_run: string | null
      }>(
        "select sentinel.cancel_control_run($1::uuid, $2::uuid) as cancel_control_run",
        [operatorIdSchema.parse(operatorId), databaseRunIdSchema.parse(runId)]
      )
      if (rows[0]?.cancel_control_run === null || rows[0] === undefined) {
        return null
      }
      return this.getOwned(operatorId, runId)
    } catch (error) {
      throwControlError(error)
    }
  }

  async retryOwned(operatorId: string, runId: string, idempotencyKey: string) {
    try {
      const rows = await this.database.query<RunRow & { created: boolean }>(
        `select (control.result).*, control.created
         from sentinel.retry_control_run($1::uuid, $2::uuid, $3) control`,
        [
          operatorIdSchema.parse(operatorId),
          databaseRunIdSchema.parse(runId),
          idempotencyKeySchema.parse(idempotencyKey),
        ]
      )
      const row = rows[0]
      if (row === undefined) throw new Error("Run retry returned no row")
      return controlMutationResultSchema.parse({
        schemaVersion: 1,
        run: toPublicRun(mapRun(row)),
        idempotent: !z.boolean().parse(row.created),
      })
    } catch (error) {
      throwControlError(error)
    }
  }

  async getOwned(operatorId: string, runId: string): Promise<PublicRun | null> {
    const rows = await this.controlQuery<RunRow>(
      `select run.* from sentinel.runs run
       join sentinel.onboarding_configurations onboarding
         on onboarding.application_id = run.application_id
        and onboarding.operator_id = $1::uuid
       where run.id = $2::uuid`,
      [operatorIdSchema.parse(operatorId), databaseRunIdSchema.parse(runId)]
    )
    return rows[0] === undefined ? null : toPublicRun(mapRun(rows[0]))
  }

  async listOwned(input: {
    readonly operatorId: string
    readonly applicationId?: string
    readonly cursor?: RunCursor
    readonly limit?: number
  }): Promise<{
    readonly items: readonly PublicRun[]
    readonly nextCursor?: RunCursor
  }> {
    const cursor = input.cursor
    const limit = pageLimitSchema.parse(input.limit)
    const rows = await this.controlQuery<RunRow>(
      `select run.* from sentinel.runs run
       join sentinel.onboarding_configurations onboarding
         on onboarding.application_id = run.application_id
        and onboarding.operator_id = $1::uuid
       where ($2::uuid is null or run.application_id = $2::uuid)
         and ($3::timestamptz is null or (
           date_trunc('milliseconds', run.created_at), run.id
         ) < ($3::timestamptz, $4::uuid))
       order by date_trunc('milliseconds', run.created_at) desc, run.id desc
       limit $5`,
      [
        operatorIdSchema.parse(input.operatorId),
        input.applicationId === undefined
          ? null
          : databaseApplicationIdSchema.parse(input.applicationId),
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      ]
    )
    const page = rows.slice(0, limit).map((row) => toPublicRun(mapRun(row)))
    const tail = rows.length > limit ? page.at(-1) : undefined
    return {
      items: page,
      ...(tail === undefined
        ? {}
        : { nextCursor: { createdAt: tail.createdAt, id: tail.id } }),
    }
  }

  async recordInterrupt(input: {
    readonly runId: string
    readonly owner: string
    readonly decisionId: string
    readonly prompt: string
  }): Promise<PublicRunInterrupt> {
    try {
      const rows = await this.database.query<Record<string, unknown>>(
        `select interrupt.*
         from sentinel.mark_run_interrupted($1::uuid, $2, $3, $4) interrupt`,
        [
          databaseRunIdSchema.parse(input.runId),
          ownerSchema.parse(input.owner),
          reasonCodeSchema.parse(input.decisionId),
          persistedTextSchema.max(4_096).parse(input.prompt),
        ]
      )
      const row = rows[0]
      if (row === undefined) throw new Error("Run interrupt returned no row")
      return mapInterrupt(row)
    } catch (error) {
      throwControlError(error)
    }
  }

  async respondInterrupt(input: {
    readonly operatorId: string
    readonly runId: string
    readonly decisionId: string
    readonly response: HumanDecision
  }): Promise<{
    readonly interrupt: PublicRunInterrupt
    readonly idempotent: boolean
  }> {
    const response = humanDecisionSchema.parse(input.response)
    const fingerprint = hashCanonical({ kind: "human_decision", response })
    try {
      const rows = await this.database.query<
        Record<string, unknown> & { idempotent: boolean }
      >(
        `select (control.result).*, control.idempotent
         from sentinel.respond_run_interrupt(
           $1::uuid, $2::uuid, $3, $4::text::jsonb, $5
         ) control`,
        [
          operatorIdSchema.parse(input.operatorId),
          databaseRunIdSchema.parse(input.runId),
          reasonCodeSchema.parse(input.decisionId),
          JSON.stringify(response),
          fingerprint,
        ]
      )
      const row = rows[0]
      if (row === undefined) {
        throw new Error("Interrupt response returned no row")
      }
      return {
        interrupt: mapInterrupt(row),
        idempotent: z.boolean().parse(row.idempotent),
      }
    } catch (error) {
      throwControlError(error)
    }
  }

  async getOwnedPendingInterrupt(
    operatorId: string,
    runId: string
  ): Promise<PublicRunInterrupt | null> {
    const rows = await this.controlQuery<Record<string, unknown>>(
      `select interrupt.* from sentinel.run_interrupts interrupt
       join sentinel.runs run on run.id = interrupt.run_id
       join sentinel.onboarding_configurations onboarding
         on onboarding.application_id = run.application_id
        and onboarding.operator_id = $1::uuid
       where interrupt.run_id = $2::uuid and interrupt.status = 'pending'
       order by interrupt.created_at desc limit 1`,
      [operatorIdSchema.parse(operatorId), databaseRunIdSchema.parse(runId)]
    )
    return rows[0] === undefined ? null : mapInterrupt(rows[0])
  }

  async getResumeDecision(
    runId: string,
    owner: string
  ): Promise<{
    readonly decisionId: string
    readonly response: HumanDecision
  } | null> {
    const rows = await this.controlQuery<{
      decision_id: string
      response: unknown
    }>(
      `select interrupt.decision_id, interrupt.response
       from sentinel.run_interrupts interrupt
       join sentinel.runs run on run.id = interrupt.run_id
       where run.id = $1::uuid and run.lease_owner = $2
         and run.lease_expires_at > now() and interrupt.status = 'responded'
         and interrupt.decision_id = run.resume_decision_id`,
      [databaseRunIdSchema.parse(runId), ownerSchema.parse(owner)]
    )
    const row = rows[0]
    return row === undefined
      ? null
      : {
          decisionId: reasonCodeSchema.parse(row.decision_id),
          response: humanDecisionSchema.parse(row.response),
        }
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
    const databaseRunId = databaseRunIdSchema.parse(
      event.runId.slice("run:".length)
    )
    const rows = await this.controlQuery<{
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
    if (row === undefined) throw new Error("Run event append returned no row")
    return {
      sequence: z.coerce.number().int().positive().parse(row.sequence),
      event: parseRunEvent(row.event),
    }
  }

  async listEvents(runId: string): Promise<readonly RunEvent[]> {
    const rows = await this.database.query<{ event: unknown }>(
      "select event from sentinel.run_events where run_id = $1::uuid order by sequence",
      [databaseRunIdSchema.parse(runId)]
    )
    return rows.map((row) => parseRunEvent(row.event))
  }

  async listOwnedEvents(input: {
    readonly operatorId: string
    readonly runId: string
    readonly after?: number
    readonly limit?: number
  }): Promise<{
    readonly items: readonly { sequence: number; event: RunEvent }[]
    readonly nextCursor?: number
  } | null> {
    const after = eventCursorSchema.parse(input.after ?? 0)
    const limit = pageLimitSchema.parse(input.limit)
    const rows = await this.controlQuery<{
      sequence: number
      event: unknown
    }>(
      `select event.sequence, event.event from sentinel.run_events event
       join sentinel.runs run on run.id = event.run_id
       join sentinel.onboarding_configurations onboarding
         on onboarding.application_id = run.application_id
        and onboarding.operator_id = $1::uuid
       where run.id = $2::uuid and event.sequence > $3
       order by event.sequence limit $4`,
      [
        operatorIdSchema.parse(input.operatorId),
        databaseRunIdSchema.parse(input.runId),
        after,
        limit + 1,
      ]
    )
    if (
      rows.length === 0 &&
      (await this.getOwned(input.operatorId, input.runId)) === null
    ) {
      return null
    }
    const page = rows.slice(0, limit).map((row) => ({
      sequence: z.coerce.number().int().positive().parse(row.sequence),
      event: parseRunEvent(row.event),
    }))
    return {
      items: page,
      ...(rows.length > limit && page.at(-1) !== undefined
        ? { nextCursor: page.at(-1)!.sequence }
        : {}),
    }
  }

  async ready(): Promise<boolean> {
    try {
      const rows = await this.database.query<{ ready: boolean }>(
        `select (
           to_regclass('sentinel.runs') is not null
           and to_regclass('sentinel.run_interrupts') is not null
           and to_regprocedure(
             'sentinel.enqueue_control_run(uuid,uuid,text,text,jsonb,jsonb,text)'
           ) is not null
           and to_regprocedure(
             'sentinel.finish_control_run(uuid,text,text,text,text,boolean,jsonb)'
           ) is not null
         ) as ready`
      )
      return rows[0]?.ready === true
    } catch {
      return false
    }
  }
}
