import runEventFixture from "../../../tests/fixtures/contracts/run-event.json" with { type: "json" }
import type { MissionBudget } from "@sentinel/contracts"
import { describe, expect, it, vi } from "vitest"

import type { DatabaseExecutor } from "./database.ts"
import {
  RunControlRepositoryError,
  RunRepository,
  toPublicRun,
} from "./run-repository.ts"

const runId = "11111111-1111-4111-8111-111111111111"
const applicationId = "22222222-2222-4222-8222-222222222222"
const now = new Date("2026-09-07T00:00:00.000Z")
const budget: MissionBudget = {
  toolCalls: 1,
  contentBytes: 1,
  documentBytes: 1,
  documentPages: 1,
  documentSections: 1,
  sourceLines: 1,
  repositoryBytes: 1,
  repositoryFiles: 1,
  browserActions: 1,
  modelCalls: 1,
  modelInputTokens: 1,
  modelOutputTokens: 1,
  reconciliationRounds: 1,
  elapsedMs: 1,
}
const runRow = {
  id: runId,
  application_id: applicationId,
  run_type: "initialize_knowledge",
  status: "queued",
  idempotency_key: "initialize:fixture",
  budget,
  request: {},
  request_fingerprint:
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  retry_of: null,
  resume_decision_id: null,
  configuration_fingerprint:
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  lease_owner: null,
  lease_expires_at: null,
  attempt_count: 0,
  cancel_requested_at: null,
  pause_requested_at: null,
  error_category: null,
  error_code: null,
  error_retryable: null,
  created_at: now,
  started_at: null,
  finished_at: null,
}

describe("run repository", () => {
  it("uses bound parameters for idempotent enqueue and queue claims", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([runRow])
      .mockResolvedValueOnce([
        { ...runRow, status: "running", lease_owner: "worker-a" },
      ])
    const repository = new RunRepository({
      query: query as DatabaseExecutor["query"],
    })

    const enqueued = await repository.enqueue({
      applicationId,
      runType: "initialize_knowledge",
      idempotencyKey: "initialize:fixture'; drop table sentinel.runs; --",
      budget,
    })
    const claimed = await repository.claim("worker-a", 60)

    expect(enqueued.id).toBe(runId)
    expect(claimed?.leaseOwner).toBe("worker-a")
    expect(query.mock.calls[0]?.[0]).toContain("$3")
    expect(query.mock.calls[0]?.[0]).not.toContain("drop table")
    expect(query.mock.calls[0]?.[1]?.[2]).toContain("drop table")
  })

  it("validates and appends replayable events using the database run UUID", async () => {
    const query = vi
      .fn()
      .mockResolvedValue([{ sequence: 1, event: runEventFixture }])
    const repository = new RunRepository({
      query: query as DatabaseExecutor["query"],
    })

    const idempotencyKey = `sha256:${"a".repeat(64)}`
    const result = await repository.appendEvent(runEventFixture, idempotencyKey)

    expect(result.sequence).toBe(1)
    expect(result.event.kind).toBe("evidence_gained")
    expect(query.mock.calls[0]?.[1]?.[0]).toBe(runId)
    expect(query.mock.calls[0]?.[0]).toContain("$5")
    expect(query.mock.calls[0]?.[1]?.[4]).toBe(idempotencyKey)
    await expect(
      repository.appendEvent(runEventFixture, undefined as never)
    ).rejects.toThrow()
    expect(query).toHaveBeenCalledOnce()
  })

  it("requires typed, non-secret failure codes", async () => {
    const query = vi.fn().mockResolvedValue([{ finish_control_run: true }])
    const repository = new RunRepository({
      query: query as DatabaseExecutor["query"],
    })

    await expect(
      repository.finish({
        runId,
        owner: "worker-a",
        status: "failed",
        errorCategory: "provider",
        errorCode: "Cookie: sid=secret",
      })
    ).rejects.toThrow()
    await expect(
      repository.finish({
        runId,
        owner: "worker-a",
        status: "failed",
        errorCategory: "provider",
        errorCode: "provider_timeout",
      })
    ).resolves.toBe(true)
  })

  it("uses owner-scoped control functions and returns no internal request data", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        ...runRow,
        created: true,
        request: {},
        request_fingerprint: runRow.request_fingerprint,
      },
    ])
    const repository = new RunRepository({
      query: query as DatabaseExecutor["query"],
    })
    const result = await repository.enqueueControl(applicationId, {
      schemaVersion: 1,
      applicationId,
      type: "initialize_knowledge",
      idempotencyKey: "initialize:fixture",
      budget,
      payload: {},
    })

    expect(result.created).toBe(true)
    expect(query.mock.calls[0]?.[0]).toContain("enqueue_control_run")
    expect(query.mock.calls[0]?.[1]?.[0]).toBe(applicationId)
    expect(JSON.stringify(result)).not.toContain("idempotencyKey")
    expect(JSON.stringify(result)).not.toContain("request_fingerprint")
  })

  it("requests owner-scoped pause and projects the pending timestamp", async () => {
    const pauseRequestedAt = new Date("2026-09-08T01:00:00.000Z")
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ pause_control_run: "running" }])
      .mockResolvedValueOnce([
        { ...runRow, status: "running", pause_requested_at: pauseRequestedAt },
      ])
    const repository = new RunRepository({
      query: query as DatabaseExecutor["query"],
    })

    await expect(
      repository.requestOwnedPause(applicationId, runId)
    ).resolves.toMatchObject({
      id: runId,
      status: "running",
      pauseRequestedAt: pauseRequestedAt.toISOString(),
    })
    expect(query.mock.calls[0]?.[0]).toContain("pause_control_run")
    expect(query.mock.calls[0]?.[1]).toEqual([applicationId, runId])
    expect(query.mock.calls[1]?.[0]).toContain(
      "onboarding.operator_id = $1::uuid"
    )
  })

  it("distinguishes cooperative pause from cancellation in worker control", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        status: "running",
        lease_owner: "worker-a",
        lease_valid: true,
        cancel_requested: false,
        pause_requested: true,
      },
    ])
    const repository = new RunRepository({
      query: query as DatabaseExecutor["query"],
    })
    await expect(repository.controlState(runId, "worker-a")).resolves.toBe(
      "pause_requested"
    )
  })

  it("normalizes database conflicts without reflecting database text", async () => {
    const query = vi
      .fn()
      .mockRejectedValue(
        new Error("sensitive sql context: idempotency_conflict token=private")
      )
    const repository = new RunRepository({
      query: query as DatabaseExecutor["query"],
    })
    await expect(
      repository.enqueueControl(applicationId, {
        schemaVersion: 1,
        applicationId,
        type: "inspect_application",
        idempotencyKey: "inspect:fixture",
        budget,
        payload: {},
      })
    ).rejects.toEqual(new RunControlRepositoryError("idempotency_conflict"))
  })

  it("projects only fixed public failure messages", () => {
    const projected = toPublicRun({
      ...runRow,
      id: runId,
      applicationId,
      runType: "initialize_knowledge",
      status: "failed",
      idempotencyKey: "private-key",
      request: {},
      requestFingerprint: runRow.request_fingerprint,
      retryOf: null,
      resumeDecisionId: null,
      configurationFingerprint: runRow.configuration_fingerprint,
      leaseOwner: null,
      leaseExpiresAt: null,
      attemptCount: 1,
      cancelRequestedAt: null,
      pauseRequestedAt: null,
      errorCategory: "provider",
      errorCode: "provider_timeout",
      errorRetryable: true,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
    })
    expect(projected.error).toEqual({
      category: "provider",
      code: "provider_timeout",
      message: "A provider dependency failed.",
      retryable: true,
    })
    expect(JSON.stringify(projected)).not.toContain("private-key")
  })

  it("scopes pending interrupt reads through the owning operator", async () => {
    const query = vi.fn().mockResolvedValue([])
    const repository = new RunRepository({
      query: query as DatabaseExecutor["query"],
    })
    await expect(
      repository.getOwnedPendingInterrupt(applicationId, runId)
    ).resolves.toBeNull()
    expect(query.mock.calls[0]?.[0]).toContain(
      "onboarding.operator_id = $1::uuid"
    )
    expect(query.mock.calls[0]?.[1]).toEqual([applicationId, runId])
  })

  it("normalizes run cursor ordering to JavaScript timestamp precision", async () => {
    const query = vi.fn().mockResolvedValue([])
    const repository = new RunRepository({
      query: query as DatabaseExecutor["query"],
    })
    await repository.listOwned({ operatorId: applicationId, limit: 10 })
    expect(
      query.mock.calls[0]?.[0].match(/date_trunc\('milliseconds'/g)
    ).toHaveLength(2)
  })

  it("requires the migrated run-control surface for readiness", async () => {
    const query = vi.fn().mockResolvedValue([{ ready: true }])
    const repository = new RunRepository({
      query: query as DatabaseExecutor["query"],
    })
    await expect(repository.ready()).resolves.toBe(true)
    expect(query.mock.calls[0]?.[0]).toContain("run_interrupts")
    expect(query.mock.calls[0]?.[0]).toContain("enqueue_control_run")
    expect(query.mock.calls[0]?.[0]).toContain("finish_control_run")
  })

  it("normalizes owner-scoped read failures to storage availability", async () => {
    const repository = new RunRepository({
      query: vi
        .fn()
        .mockRejectedValue(
          new Error("connection failed with password=private")
        ) as DatabaseExecutor["query"],
    })
    await expect(repository.getOwned(applicationId, runId)).rejects.toEqual(
      expect.objectContaining({
        name: "RunControlRepositoryError",
        code: "storage_unavailable",
        message: "storage_unavailable",
      })
    )
  })

  it.each([
    ["validation", false],
    ["configuration", false],
    ["authorization", false],
    ["cancelled", false],
    ["rate_limit", true],
    ["timeout", true],
    ["provider", true],
    ["storage", true],
    ["unknown", true],
  ] as const)(
    "persists the %s failure retry policy",
    async (category, retryable) => {
      const query = vi.fn().mockResolvedValue([{ finish_control_run: true }])
      const repository = new RunRepository({
        query: query as DatabaseExecutor["query"],
      })
      await repository.finish({
        runId,
        owner: "worker-a",
        status: "failed",
        errorCategory: category,
        errorCode: `${category}_failure`,
        retryable,
      })
      expect(query.mock.calls[0]?.[1]?.[5]).toBe(retryable)
      const opposite = repository.finish({
        runId,
        owner: "worker-a",
        status: "failed",
        errorCategory: category,
        errorCode: `${category}_failure`,
        retryable: !retryable,
      })
      if (retryable) await expect(opposite).resolves.toBe(true)
      else await expect(opposite).rejects.toThrow("retryability")
    }
  )
})
