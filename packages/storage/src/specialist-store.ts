import {
  applicationIdSchema,
  contentHashSchema,
  hashCanonical,
  missionIdSchema,
  runIdSchema,
  type CodeMissionResult,
  type DocumentationMissionResult,
} from "@sentinel/contracts"
import {
  ApplicationExplorerSpecialistStoreConflictError,
  SpecialistToolDeniedError,
  applicationExplorerSpecialistRecordSchema,
  parseStoredCodeExplorerToolResult,
  parseStoredDocumentationExplorerToolDraft,
  parseStoredDocumentationExplorerToolResult,
  type ApplicationExplorerSpecialistRecord,
  type ApplicationExplorerSpecialistStore,
  type CodeExplorerSpecialistStore,
  type CoordinatedSpecialistToolExecution,
  type DocumentationExplorerSpecialistStore,
  type SpecialistToolExecutionCoordinator,
  type SpecialistToolExecutionIdentity,
  type StoredCodeExplorerToolResult,
  type StoredDocumentationExplorerToolDraft,
  type StoredDocumentationExplorerToolResult,
} from "@sentinel/orchestration"
import { z } from "zod"

import type {
  DatabaseClient,
  DatabaseExecutor,
  SqlParameter,
} from "./database.ts"

const databaseIdSchema = z.uuid()
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024

export interface SpecialistStoreScope {
  readonly applicationDatabaseId: string
  readonly applicationStableId: string
  readonly runDatabaseId: string
  readonly runStableId: string
}

interface ParsedSpecialistStoreScope {
  readonly applicationDatabaseId: string
  readonly applicationStableId: string
  readonly runDatabaseId: string
  readonly runStableId: string
}

const draftRowSchema = z.object({
  mission_id: missionIdSchema,
  draft_id: contentHashSchema,
  record_hash: contentHashSchema,
  payload: z.unknown(),
})

const resultRowSchema = z.object({
  mission_id: missionIdSchema,
  sequence: z.coerce.number().int().positive().max(128),
  call_id: z.string().min(1).max(128),
  request_hash: contentHashSchema,
  record_hash: contentHashSchema,
  payload: z.unknown(),
})

const applicationRowSchema = z.object({
  mission_id: missionIdSchema,
  revision: z.coerce.number().int().nonnegative(),
  record_hash: contentHashSchema,
  payload: z.unknown(),
})

const executionRowSchema = z.object({
  request_hash: contentHashSchema,
  outcome: z.enum(["returned", "threw"]),
  result_hash: contentHashSchema,
  payload: z.unknown(),
})

function parseScope(scope: SpecialistStoreScope): ParsedSpecialistStoreScope {
  const parsed = {
    applicationDatabaseId: databaseIdSchema.parse(scope.applicationDatabaseId),
    applicationStableId: applicationIdSchema.parse(scope.applicationStableId),
    runDatabaseId: databaseIdSchema.parse(scope.runDatabaseId),
    runStableId: runIdSchema.parse(scope.runStableId),
  }
  if (parsed.runStableId !== `run:${parsed.runDatabaseId}`) {
    throw new Error("Specialist run identities do not match")
  }
  return parsed
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error("Stored specialist payload is not valid JSON")
  }
}

function serializePayload(value: unknown): string {
  const payload = JSON.stringify(value)
  if (payload === undefined) {
    throw new Error("Specialist payload is not JSON serializable")
  }
  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("Specialist payload exceeds the storage byte limit")
  }
  return payload
}

function scopeParameters(scope: ParsedSpecialistStoreScope): SqlParameter[] {
  return [scope.applicationDatabaseId, scope.runDatabaseId]
}

async function lockMission(
  database: DatabaseExecutor,
  scope: ParsedSpecialistStoreScope,
  category: string,
  missionId: string
): Promise<void> {
  await database.query(
    "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
    [
      [
        "sentinel-specialist",
        scope.applicationDatabaseId,
        scope.runDatabaseId,
        category,
        missionId,
      ].join(":"),
    ]
  )
}

function assertApplicationScope(
  scope: ParsedSpecialistStoreScope,
  record: ApplicationExplorerSpecialistRecord
): void {
  if (
    record.applicationId !== scope.applicationStableId ||
    record.runId !== scope.runStableId
  ) {
    throw new Error("Application specialist record crosses its storage scope")
  }
}

type StoredToolResult =
  StoredDocumentationExplorerToolResult | StoredCodeExplorerToolResult

class PostgresSpecialistToolResultStore<T extends StoredToolResult> {
  constructor(
    private readonly database: DatabaseClient,
    private readonly scope: ParsedSpecialistStoreScope,
    private readonly kind: "documentation" | "code",
    private readonly parse: (input: T) => T
  ) {}

  private parameters(...rest: SqlParameter[]): SqlParameter[] {
    return [...scopeParameters(this.scope), this.kind, ...rest]
  }

  private async find(
    database: DatabaseExecutor,
    missionId: string,
    callId: string
  ): Promise<T | null> {
    const rows = await database.query(
      `select mission_id, sequence, call_id, request_hash, record_hash, payload
       from sentinel.specialist_tool_results
       where application_id = $1::uuid and run_id = $2::uuid
         and specialist_kind = $3 and mission_id = $4 and call_id = $5`,
      this.parameters(missionId, callId)
    )
    const row = rows[0]
    if (row === undefined) return null
    const parsedRow = resultRowSchema.parse(row)
    const record = this.parse(parseJson(parsedRow.payload) as T)
    if (
      parsedRow.mission_id !== record.missionId ||
      parsedRow.sequence !== record.sequence ||
      parsedRow.call_id !== record.callId ||
      parsedRow.request_hash !== record.requestHash ||
      parsedRow.record_hash !== hashCanonical(record)
    ) {
      throw new Error("Stored specialist tool result integrity check failed")
    }
    return record
  }

  async put(input: T): Promise<void> {
    const record = this.parse(input)
    const recordHash = hashCanonical(record)
    const payload = serializePayload(record)
    await this.database.transaction(async (transaction) => {
      await lockMission(
        transaction,
        this.scope,
        `${this.kind}-result`,
        record.missionId
      )
      const existing = await this.find(
        transaction,
        record.missionId,
        record.callId
      )
      if (existing !== null) {
        if (hashCanonical(existing) !== recordHash) {
          throw new Error(`Conflicting ${this.kind} specialist tool result`)
        }
        return
      }
      const sequenceRows = await transaction.query<{ next_sequence: unknown }>(
        `select coalesce(max(sequence), 0) + 1 as next_sequence
         from sentinel.specialist_tool_results
         where application_id = $1::uuid and run_id = $2::uuid
           and specialist_kind = $3 and mission_id = $4`,
        this.parameters(record.missionId)
      )
      const nextSequence = z.coerce
        .number()
        .int()
        .positive()
        .parse(sequenceRows[0]?.next_sequence)
      if (record.sequence !== nextSequence) {
        throw new Error(
          `${this.kind} specialist tool result sequence is not monotonic`
        )
      }
      await transaction.query(
        `insert into sentinel.specialist_tool_results (
           application_id, run_id, specialist_kind, mission_id, sequence,
           call_id, request_hash, record_hash, payload
         ) values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::text::jsonb)`,
        this.parameters(
          record.missionId,
          record.sequence,
          record.callId,
          record.requestHash,
          recordHash,
          payload
        )
      )
    })
  }

  async list(missionIdInput: string): Promise<readonly T[]> {
    const missionId = missionIdSchema.parse(missionIdInput)
    const rows = await this.database.query(
      `select mission_id, sequence, call_id, request_hash, record_hash, payload
       from sentinel.specialist_tool_results
       where application_id = $1::uuid and run_id = $2::uuid
         and specialist_kind = $3 and mission_id = $4
       order by sequence`,
      this.parameters(missionId)
    )
    const records = rows.map((row) => {
      const parsedRow = resultRowSchema.parse(row)
      const record = this.parse(parseJson(parsedRow.payload) as T)
      if (
        parsedRow.mission_id !== record.missionId ||
        parsedRow.sequence !== record.sequence ||
        parsedRow.call_id !== record.callId ||
        parsedRow.request_hash !== record.requestHash ||
        parsedRow.record_hash !== hashCanonical(record)
      ) {
        throw new Error("Stored specialist tool result integrity check failed")
      }
      return record
    })
    if (records.some((record, index) => record.sequence !== index + 1)) {
      throw new Error(`${this.kind} specialist tool result sequence is invalid`)
    }
    return records
  }
}

export class PostgresDocumentationExplorerSpecialistStore implements DocumentationExplorerSpecialistStore {
  private readonly scope: ParsedSpecialistStoreScope
  private readonly results: PostgresSpecialistToolResultStore<StoredDocumentationExplorerToolResult>

  constructor(
    private readonly database: DatabaseClient,
    scope: SpecialistStoreScope
  ) {
    this.scope = parseScope(scope)
    this.results = new PostgresSpecialistToolResultStore(
      database,
      this.scope,
      "documentation",
      parseStoredDocumentationExplorerToolResult
    )
  }

  async putToolDraft(
    input: StoredDocumentationExplorerToolDraft
  ): Promise<void> {
    const draft = parseStoredDocumentationExplorerToolDraft(input)
    const recordHash = hashCanonical(draft)
    await this.database.query(
      `insert into sentinel.specialist_tool_drafts (
         application_id, run_id, specialist_kind, mission_id, draft_id,
         record_hash, payload
       ) values ($1::uuid, $2::uuid, 'documentation', $3, $4, $5, $6::text::jsonb)
       on conflict (application_id, run_id, specialist_kind, mission_id, draft_id)
       do nothing`,
      [
        ...scopeParameters(this.scope),
        draft.missionId,
        draft.draftId,
        recordHash,
        serializePayload(draft),
      ]
    )
    const stored = await this.getToolDraft(draft.missionId, draft.draftId)
    if (stored === undefined) {
      throw new Error("Documentation specialist draft was not persisted")
    }
    if (hashCanonical(stored) !== recordHash) {
      throw new Error("Conflicting documentation specialist tool draft")
    }
  }

  async getToolDraft(
    missionIdInput: string,
    draftIdInput: string
  ): Promise<StoredDocumentationExplorerToolDraft | undefined> {
    const missionId = missionIdSchema.parse(missionIdInput)
    const draftId = contentHashSchema.parse(draftIdInput)
    const rows = await this.database.query(
      `select mission_id, draft_id, record_hash, payload
       from sentinel.specialist_tool_drafts
       where application_id = $1::uuid and run_id = $2::uuid
         and specialist_kind = 'documentation'
         and mission_id = $3 and draft_id = $4`,
      [...scopeParameters(this.scope), missionId, draftId]
    )
    const row = rows[0]
    if (row === undefined) return undefined
    const parsedRow = draftRowSchema.parse(row)
    const draft = parseStoredDocumentationExplorerToolDraft(
      parseJson(parsedRow.payload) as StoredDocumentationExplorerToolDraft
    )
    if (
      parsedRow.mission_id !== draft.missionId ||
      parsedRow.draft_id !== draft.draftId ||
      parsedRow.record_hash !== hashCanonical(draft)
    ) {
      throw new Error(
        "Stored documentation specialist draft integrity check failed"
      )
    }
    return draft
  }

  putToolResult(result: StoredDocumentationExplorerToolResult): Promise<void> {
    return this.results.put(result)
  }

  listToolResults(
    missionId: string
  ): Promise<readonly StoredDocumentationExplorerToolResult[]> {
    return this.results.list(missionId)
  }

  async getMissionResult(
    missionId: string
  ): Promise<DocumentationMissionResult | undefined> {
    const records = await this.listToolResults(missionId)
    return [...records].reverse().find((record) => record.result !== undefined)
      ?.result
  }
}

export class PostgresCodeExplorerSpecialistStore implements CodeExplorerSpecialistStore {
  private readonly results: PostgresSpecialistToolResultStore<StoredCodeExplorerToolResult>

  constructor(database: DatabaseClient, scope: SpecialistStoreScope) {
    this.results = new PostgresSpecialistToolResultStore(
      database,
      parseScope(scope),
      "code",
      parseStoredCodeExplorerToolResult
    )
  }

  putToolResult(result: StoredCodeExplorerToolResult): Promise<void> {
    return this.results.put(result)
  }

  listToolResults(
    missionId: string
  ): Promise<readonly StoredCodeExplorerToolResult[]> {
    return this.results.list(missionId)
  }

  async getMissionResult(
    missionId: string
  ): Promise<CodeMissionResult | undefined> {
    const records = await this.listToolResults(missionId)
    return [...records].reverse().find((record) => record.result !== undefined)
      ?.result
  }
}

export class PostgresApplicationExplorerSpecialistStore implements ApplicationExplorerSpecialistStore {
  private readonly scope: ParsedSpecialistStoreScope

  constructor(
    private readonly database: DatabaseClient,
    scope: SpecialistStoreScope
  ) {
    this.scope = parseScope(scope)
  }

  private async loadFrom(
    database: DatabaseExecutor,
    missionIdInput: string
  ): Promise<ApplicationExplorerSpecialistRecord | null> {
    const missionId = missionIdSchema.parse(missionIdInput)
    const rows = await database.query(
      `select mission_id, revision, record_hash, payload
       from sentinel.application_specialist_records
       where application_id = $1::uuid and run_id = $2::uuid
         and mission_id = $3`,
      [...scopeParameters(this.scope), missionId]
    )
    const row = rows[0]
    if (row === undefined) return null
    const parsedRow = applicationRowSchema.parse(row)
    const record = applicationExplorerSpecialistRecordSchema.parse(
      parseJson(parsedRow.payload)
    )
    assertApplicationScope(this.scope, record)
    if (
      parsedRow.mission_id !== record.missionId ||
      parsedRow.revision !== record.revision ||
      parsedRow.record_hash !== hashCanonical(record)
    ) {
      throw new Error(
        "Stored application specialist record integrity check failed"
      )
    }
    return record
  }

  load(missionId: string): Promise<ApplicationExplorerSpecialistRecord | null> {
    return this.loadFrom(this.database, missionId)
  }

  async create(input: ApplicationExplorerSpecialistRecord): Promise<void> {
    const record = applicationExplorerSpecialistRecordSchema.parse(input)
    assertApplicationScope(this.scope, record)
    const recordHash = hashCanonical(record)
    await this.database.query(
      `insert into sentinel.application_specialist_records (
         application_id, run_id, mission_id, revision, record_hash, payload
       ) values ($1::uuid, $2::uuid, $3, $4, $5, $6::text::jsonb)
       on conflict (application_id, run_id, mission_id) do nothing`,
      [
        ...scopeParameters(this.scope),
        record.missionId,
        record.revision,
        recordHash,
        serializePayload(record),
      ]
    )
    const stored = await this.load(record.missionId)
    if (stored === null) {
      throw new Error("Application specialist record was not persisted")
    }
    if (hashCanonical(stored) !== recordHash) {
      throw new Error("Application specialist record already exists")
    }
  }

  async replace(
    input: ApplicationExplorerSpecialistRecord,
    expectedRevisionInput: number
  ): Promise<void> {
    const record = applicationExplorerSpecialistRecordSchema.parse(input)
    const expectedRevision = z
      .number()
      .int()
      .nonnegative()
      .parse(expectedRevisionInput)
    assertApplicationScope(this.scope, record)
    if (record.revision !== expectedRevision + 1) {
      throw new Error(
        "Application specialist record revision must advance once"
      )
    }
    const recordHash = hashCanonical(record)
    await this.database.transaction(async (transaction) => {
      await lockMission(
        transaction,
        this.scope,
        "application-record",
        record.missionId
      )
      const current = await this.loadFrom(transaction, record.missionId)
      if (
        current !== null &&
        current.revision === record.revision &&
        hashCanonical(current) === recordHash
      ) {
        return
      }
      if (current === null || current.revision !== expectedRevision) {
        throw new ApplicationExplorerSpecialistStoreConflictError()
      }
      const updated = await transaction.query<{ mission_id: unknown }>(
        `update sentinel.application_specialist_records
         set revision = $4, record_hash = $5, payload = $6::text::jsonb
         where application_id = $1::uuid and run_id = $2::uuid
           and mission_id = $3 and revision = $7
         returning mission_id`,
        [
          ...scopeParameters(this.scope),
          record.missionId,
          record.revision,
          recordHash,
          serializePayload(record),
          expectedRevision,
        ]
      )
      if (updated[0] === undefined) {
        throw new ApplicationExplorerSpecialistStoreConflictError()
      }
    })
  }
}

export class PostgresSpecialistToolExecutionCoordinator implements SpecialistToolExecutionCoordinator {
  private readonly scope: ParsedSpecialistStoreScope

  constructor(
    private readonly database: DatabaseClient,
    scope: SpecialistStoreScope
  ) {
    this.scope = parseScope(scope)
  }

  async executeOnce(
    identityInput: SpecialistToolExecutionIdentity,
    execute: () => Promise<unknown>
  ): Promise<CoordinatedSpecialistToolExecution> {
    const identity = {
      missionId: missionIdSchema.parse(identityInput.missionId),
      callId: z.string().min(1).max(128).parse(identityInput.callId),
      requestHash: contentHashSchema.parse(identityInput.requestHash),
    }
    return this.database.transaction(async (transaction) => {
      await lockMission(
        transaction,
        this.scope,
        "tool-execution",
        `${identity.missionId}:${identity.callId}`
      )
      const rows = await transaction.query(
        `select request_hash, outcome, result_hash, payload
         from sentinel.specialist_tool_executions
         where application_id = $1::uuid and run_id = $2::uuid
           and mission_id = $3 and call_id = $4`,
        [...scopeParameters(this.scope), identity.missionId, identity.callId]
      )
      const existing = rows[0]
      if (existing !== undefined) {
        const row = executionRowSchema.parse(existing)
        if (row.request_hash !== identity.requestHash) {
          throw new SpecialistToolDeniedError(
            "duplicate_call",
            `Tool call ${identity.callId} conflicts with a completed execution`
          )
        }
        const storedPayload = parseJson(row.payload)
        if (
          row.result_hash !==
          hashCanonical({ outcome: row.outcome, payload: storedPayload })
        ) {
          throw new Error(
            "Stored specialist tool execution integrity check failed"
          )
        }
        if (row.outcome === "threw") return { kind: "threw" }
        const payload = z
          .object({ value: z.unknown().optional() })
          .parse(storedPayload)
        return { kind: "returned", value: payload.value }
      }

      let execution: CoordinatedSpecialistToolExecution
      try {
        execution = { kind: "returned", value: await execute() }
      } catch (error) {
        if (process.env["SENTINEL_WORKER_DEBUG"] === "1") {
          console.error("specialist_tool_execution_failed", error)
        }
        execution = { kind: "threw" }
      }
      const serializedPayload =
        execution.kind === "returned"
          ? serializePayload({ value: execution.value })
          : "{}"
      const payload = parseJson(serializedPayload)
      const resultHash = hashCanonical({ outcome: execution.kind, payload })
      if (execution.kind === "returned") {
        execution = {
          kind: "returned",
          value: z.object({ value: z.unknown().optional() }).parse(payload)
            .value,
        }
      }
      await transaction.query(
        `insert into sentinel.specialist_tool_executions (
           application_id, run_id, mission_id, call_id, request_hash,
           outcome, result_hash, payload
         ) values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::text::jsonb)`,
        [
          ...scopeParameters(this.scope),
          identity.missionId,
          identity.callId,
          identity.requestHash,
          execution.kind,
          resultHash,
          serializedPayload,
        ]
      )
      return execution
    })
  }
}
