import runEventFixture from "../../../tests/fixtures/contracts/run-event.json" with { type: "json" }
import type { MissionBudget } from "@sentinel/contracts"
import { describe, expect, it, vi } from "vitest"

import type { DatabaseExecutor } from "./database.ts"
import { RunRepository } from "./run-repository.ts"

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
  lease_owner: null,
  lease_expires_at: null,
  attempt_count: 0,
  cancel_requested_at: null,
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

    const result = await repository.appendEvent(runEventFixture)

    expect(result.sequence).toBe(1)
    expect(result.event.kind).toBe("evidence_gained")
    expect(query.mock.calls[0]?.[1]?.[0]).toBe(runId)
  })

  it("requires typed, non-secret failure codes", async () => {
    const query = vi.fn().mockResolvedValue([{ finish_run: true }])
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
})
