import {
  browserObservationSchema,
  codeToolObservationSchema,
  documentTreeObservationSchema,
  hashCanonical,
  missionIdSchema,
  type MissionBudget,
} from "@sentinel/contracts"
import {
  ApplicationExplorerSpecialistStoreConflictError,
  SpecialistToolDeniedError,
  applicationExplorerSpecialistRecordSchema,
  hashSpecialistToolRequest,
  type StoredCodeExplorerToolResult,
  type StoredDocumentationExplorerToolResult,
} from "@sentinel/orchestration"
import { describe, expect, it, vi } from "vitest"

import type {
  DatabaseClient,
  DatabaseExecutor,
  SqlParameter,
} from "./database.ts"
import {
  PostgresApplicationExplorerSpecialistStore,
  PostgresCodeExplorerSpecialistStore,
  PostgresDocumentationExplorerSpecialistStore,
  PostgresSpecialistToolExecutionCoordinator,
  type SpecialistStoreScope,
} from "./specialist-store.ts"

const applicationDatabaseId = "123e4567-e89b-42d3-a456-426614174010"
const runDatabaseId = "123e4567-e89b-42d3-a456-426614174011"
const applicationStableId = `application:v1:${"a".repeat(64)}`
const runStableId = `run:${runDatabaseId}`
const missionId = missionIdSchema.parse(`mission:v1:${"b".repeat(64)}`)

const scope: SpecialistStoreScope = {
  applicationDatabaseId,
  applicationStableId,
  runDatabaseId,
  runStableId,
}

const usage: MissionBudget = {
  toolCalls: 1,
  contentBytes: 0,
  documentBytes: 0,
  documentPages: 0,
  documentSections: 0,
  sourceLines: 0,
  repositoryBytes: 0,
  repositoryFiles: 0,
  browserActions: 0,
  modelCalls: 0,
  modelInputTokens: 0,
  modelOutputTokens: 0,
  reconciliationRounds: 0,
  elapsedMs: 1,
}

interface StoredRow extends Record<string, unknown> {
  payload: unknown
}

class MemoryDatabase implements DatabaseClient {
  readonly drafts = new Map<string, StoredRow>()
  readonly results = new Map<string, StoredRow>()
  readonly applicationRecords = new Map<string, StoredRow>()
  readonly executions = new Map<string, StoredRow>()
  readonly statements: string[] = []

  transaction<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
    return work(this)
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  async query<Row extends Record<string, unknown>>(
    statement: string,
    parameters: readonly SqlParameter[] = []
  ): Promise<readonly Row[]> {
    this.statements.push(statement)
    if (statement.includes("pg_advisory_xact_lock")) return []

    if (statement.startsWith("insert into sentinel.specialist_tool_drafts")) {
      const key = `${parameters[2]}:${parameters[3]}`
      if (!this.drafts.has(key)) {
        this.drafts.set(key, {
          mission_id: parameters[2],
          draft_id: parameters[3],
          record_hash: parameters[4],
          payload: JSON.parse(String(parameters[5])) as unknown,
        })
      }
      return []
    }
    if (statement.includes("from sentinel.specialist_tool_drafts")) {
      const row = this.drafts.get(`${parameters[2]}:${parameters[3]}`)
      return (row === undefined ? [] : [row]) as unknown as Row[]
    }

    if (statement.includes("coalesce(max(sequence)")) {
      const prefix = `${parameters[2]}:${parameters[3]}:`
      const maximum = [...this.results.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .reduce((value, [, row]) => Math.max(value, Number(row["sequence"])), 0)
      return [{ next_sequence: maximum + 1 }] as unknown as Row[]
    }
    if (statement.startsWith("insert into sentinel.specialist_tool_results")) {
      const key = `${parameters[2]}:${parameters[3]}:${parameters[5]}`
      this.results.set(key, {
        mission_id: parameters[3],
        sequence: parameters[4],
        call_id: parameters[5],
        request_hash: parameters[6],
        record_hash: parameters[7],
        payload: JSON.parse(String(parameters[8])) as unknown,
      })
      return []
    }
    if (statement.includes("from sentinel.specialist_tool_results")) {
      const prefix = `${parameters[2]}:${parameters[3]}:`
      const rows = [...this.results.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .filter(([, row]) =>
          statement.includes("and call_id = $5")
            ? row["call_id"] === parameters[4]
            : true
        )
        .map(([, row]) => row)
        .sort(
          (left, right) => Number(left["sequence"]) - Number(right["sequence"])
        )
      return rows as unknown as Row[]
    }

    if (
      statement.startsWith(
        "insert into sentinel.application_specialist_records"
      )
    ) {
      const key = String(parameters[2])
      if (!this.applicationRecords.has(key)) {
        this.applicationRecords.set(key, {
          mission_id: parameters[2],
          revision: parameters[3],
          record_hash: parameters[4],
          payload: JSON.parse(String(parameters[5])) as unknown,
        })
      }
      return []
    }
    if (
      statement.startsWith("update sentinel.application_specialist_records")
    ) {
      const key = String(parameters[2])
      const current = this.applicationRecords.get(key)
      if (current?.["revision"] === parameters[6]) {
        this.applicationRecords.set(key, {
          mission_id: parameters[2],
          revision: parameters[3],
          record_hash: parameters[4],
          payload: JSON.parse(String(parameters[5])) as unknown,
        })
        return [{ mission_id: parameters[2] }] as unknown as Row[]
      }
      return []
    }
    if (statement.includes("from sentinel.application_specialist_records")) {
      const row = this.applicationRecords.get(String(parameters[2]))
      return (row === undefined ? [] : [row]) as unknown as Row[]
    }

    if (
      statement.startsWith("insert into sentinel.specialist_tool_executions")
    ) {
      const key = `${parameters[2]}:${parameters[3]}`
      this.executions.set(key, {
        request_hash: parameters[4],
        outcome: parameters[5],
        result_hash: parameters[6],
        payload: JSON.parse(String(parameters[7])) as unknown,
      })
      return []
    }
    if (statement.includes("from sentinel.specialist_tool_executions")) {
      const row = this.executions.get(`${parameters[2]}:${parameters[3]}`)
      return (row === undefined ? [] : [row]) as unknown as Row[]
    }
    throw new Error(`Unexpected test query: ${statement}`)
  }
}

function documentationResult(
  sequence = 1,
  callId = "documentation_call_1"
): StoredDocumentationExplorerToolResult {
  const toolName = "list_document_tree" as const
  const request = { toolName, arguments: {} }
  const argumentsHash = hashCanonical({ toolName, arguments: {} })
  const decisionId = `documentation_decision_${sequence}`
  const execution = {
    kind: "observation" as const,
    observation: documentTreeObservationSchema.parse({
      schemaVersion: 1 as const,
      toolName,
      summary: "Listed the bounded documentation tree.",
      pages: [],
      sections: [],
      metrics: {
        contentBytes: 0,
        documentBytes: 0,
        documentPages: 0,
        documentSections: 0,
        resultItems: 0,
      },
    }),
  }
  return {
    missionId,
    sequence,
    callId,
    decisionId,
    requestHash: hashSpecialistToolRequest({
      missionId,
      callId,
      decisionId,
      agent: "documentation",
      toolName,
      arguments: {},
    }),
    argumentsHash,
    toolName,
    request,
    payloadHash: hashCanonical({ execution }),
    execution,
    usage,
  }
}

function codeResult(): StoredCodeExplorerToolResult {
  const execution = {
    kind: "observation" as const,
    observation: codeToolObservationSchema.parse({
      schemaVersion: 1 as const,
      toolName: "list_repository_modules" as const,
      summary: "Listed admitted repository modules.",
      entities: [],
      edges: [],
      sourceSlices: [],
      evidence: [],
      unresolved: [],
      metrics: {
        sourceLines: 0,
        contentBytes: 0,
        resultItems: 0,
        traversalHops: 0,
      },
    }),
  }
  return {
    missionId,
    sequence: 1,
    callId: "code_call_1",
    decisionId: "code_decision_1",
    requestHash: hashCanonical({ kind: "code request" }),
    argumentsHash: hashCanonical({ kind: "code arguments" }),
    toolName: "list_repository_modules",
    payloadHash: hashCanonical({ execution }),
    execution,
    usage,
  }
}

function applicationRecord(revision = 0) {
  const observation = browserObservationSchema.parse({
    schemaVersion: 1,
    evidenceId: `evidence:v1:${"c".repeat(64)}`,
    applicationId: applicationStableId,
    runId: runStableId,
    url: "https://fixture.test/",
    normalizedRoute: "/",
    title: "Fixture",
    headings: ["Fixture"],
    controls: [],
    dialogs: [],
    selectedText: [],
    candidates: [],
    stateFingerprint: `sha256:${"d".repeat(64)}`,
    errors: [],
    observedAt: "2026-09-10T00:00:00.000Z",
  })
  return applicationExplorerSpecialistRecordSchema.parse({
    schemaVersion: 1,
    revision,
    missionId,
    runId: runStableId,
    applicationId: applicationStableId,
    missionFingerprint: `sha256:${"e".repeat(64)}`,
    observation,
    checkpoint: {
      schemaVersion: 1,
      applicationId: applicationStableId,
      missionId,
      runId: runStableId,
      currentObservationEvidenceId: observation.evidenceId,
      currentStateFingerprint: observation.stateFingerprint,
      path: [],
      frontier: [],
      visits: [],
      replayBoundary: {
        schemaVersion: 1,
        recipe: {
          schemaVersion: 1,
          applicationId: applicationStableId,
          sourceRunId: runStableId,
          entryUrl: "https://fixture.test/",
          steps: [],
          createdAt: "2026-09-10T00:00:00.000Z",
        },
        replaySafePathLength: 0,
        checkpointPathLength: 0,
        requiresHumanReview: false,
      },
      budgetUsed: { ...usage, toolCalls: 0, elapsedMs: 0 },
      observedRuntimeRequestCount: 0,
      consecutiveNoProgress: 0,
      startedAt: "2026-09-10T00:00:00.000Z",
      updatedAt: `2026-09-10T00:00:0${revision}.000Z`,
    },
    transitions: [],
    priorEvidenceClaims: [],
    blockers: [],
    requestedTerminal: null,
    review: null,
    output: null,
    result: null,
  })
}

describe("Postgres specialist stores", () => {
  it("replays documentation drafts and ordered results across store instances", async () => {
    const database = new MemoryDatabase()
    const first = new PostgresDocumentationExplorerSpecialistStore(
      database,
      scope
    )
    const request = {
      toolName: "search_documentation" as const,
      arguments: { query: "checkout" },
    }
    const draft = {
      missionId,
      draftId: hashCanonical({
        kind: "documentation_tool_draft",
        missionId,
        request,
        version: 1,
      }),
      request,
    }
    await first.putToolDraft(draft)
    await first.putToolResult(documentationResult())

    const restarted = new PostgresDocumentationExplorerSpecialistStore(
      database,
      scope
    )
    await expect(
      restarted.getToolDraft(missionId, draft.draftId)
    ).resolves.toEqual(draft)
    await expect(restarted.listToolResults(missionId)).resolves.toEqual([
      documentationResult(),
    ])
    await expect(restarted.putToolDraft(draft)).resolves.toBeUndefined()
    await expect(
      restarted.putToolResult(documentationResult())
    ).resolves.toBeUndefined()
    await expect(
      restarted.putToolResult(documentationResult(3, "documentation_call_3"))
    ).rejects.toThrow("sequence is not monotonic")
  })

  it("persists code results and rejects a corrupted stored payload", async () => {
    const database = new MemoryDatabase()
    const store = new PostgresCodeExplorerSpecialistStore(database, scope)
    await store.putToolResult(codeResult())
    await expect(store.listToolResults(missionId)).resolves.toEqual([
      codeResult(),
    ])

    const row = database.results.get(`code:${missionId}:code_call_1`)
    expect(row).toBeDefined()
    row!["record_hash"] = hashCanonical({ corrupted: true })
    await expect(store.listToolResults(missionId)).rejects.toThrow(
      "integrity check failed"
    )
  })

  it("uses idempotent optimistic application record revisions", async () => {
    const database = new MemoryDatabase()
    const first = new PostgresApplicationExplorerSpecialistStore(
      database,
      scope
    )
    await first.create(applicationRecord())
    const revisionOne = applicationRecord(1)
    await first.replace(revisionOne, 0)

    const restarted = new PostgresApplicationExplorerSpecialistStore(
      database,
      scope
    )
    await expect(restarted.load(missionId)).resolves.toEqual(revisionOne)
    await expect(restarted.replace(revisionOne, 0)).resolves.toBeUndefined()
    const conflictingRevisionOne =
      applicationExplorerSpecialistRecordSchema.parse({
        ...revisionOne,
        missionFingerprint: hashCanonical({ changed: true }),
      })
    await expect(
      restarted.replace(conflictingRevisionOne, 0)
    ).rejects.toBeInstanceOf(ApplicationExplorerSpecialistStoreConflictError)
  })

  it("replays completed tool executions and denies hash conflicts", async () => {
    const database = new MemoryDatabase()
    const first = new PostgresSpecialistToolExecutionCoordinator(
      database,
      scope
    )
    const execute = vi.fn(async () => ({ count: 1 }))
    const identity = {
      missionId,
      callId: "shared_call_1",
      requestHash: hashCanonical({ request: 1 }),
    }
    await expect(first.executeOnce(identity, execute)).resolves.toEqual({
      kind: "returned",
      value: { count: 1 },
    })

    const restarted = new PostgresSpecialistToolExecutionCoordinator(
      database,
      scope
    )
    await expect(restarted.executeOnce(identity, execute)).resolves.toEqual({
      kind: "returned",
      value: { count: 1 },
    })
    expect(execute).toHaveBeenCalledTimes(1)
    await expect(
      restarted.executeOnce(
        { ...identity, requestHash: hashCanonical({ request: 2 }) },
        execute
      )
    ).rejects.toBeInstanceOf(SpecialistToolDeniedError)

    const stored = database.executions.get(`${missionId}:shared_call_1`)
    expect(stored).toBeDefined()
    stored!["payload"] = { value: { count: 2 } }
    await expect(restarted.executeOnce(identity, execute)).rejects.toThrow(
      "integrity check failed"
    )

    const throws = vi.fn(async (): Promise<never> => {
      throw new Error("provider failed")
    })
    const throwingIdentity = {
      ...identity,
      callId: "shared_call_2",
      requestHash: hashCanonical({ request: "throws" }),
    }
    await expect(
      restarted.executeOnce(throwingIdentity, throws)
    ).resolves.toEqual({ kind: "threw" })
    await expect(
      new PostgresSpecialistToolExecutionCoordinator(
        database,
        scope
      ).executeOnce(throwingIdentity, throws)
    ).resolves.toEqual({ kind: "threw" })
    expect(throws).toHaveBeenCalledTimes(1)
  })
})
