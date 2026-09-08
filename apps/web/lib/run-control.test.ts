// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { RunControlService, type RunControlStore } from "./run-control"

const operatorId = "11111111-1111-4111-8111-111111111111"
const applicationId = "22222222-2222-4222-8222-222222222222"
const runId = "33333333-3333-4333-8333-333333333333"
const budget = {
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
const publicRun = {
  schemaVersion: 1 as const,
  id: runId,
  applicationId,
  type: "initialize_knowledge" as const,
  status: "queued" as const,
  attemptCount: 0,
  createdAt: "2026-09-08T00:00:00.000Z",
}

function store(): RunControlStore {
  return {
    enqueueControl: vi
      .fn()
      .mockResolvedValue({ run: publicRun, created: true }),
    getOwned: vi.fn().mockResolvedValue(publicRun),
    listOwned: vi.fn().mockResolvedValue({ items: [publicRun] }),
    listOwnedEvents: vi.fn().mockResolvedValue({ items: [] }),
    requestOwnedCancellation: vi.fn().mockResolvedValue({
      ...publicRun,
      status: "cancelled",
    }),
    retryOwned: vi
      .fn()
      .mockResolvedValue({ run: publicRun, idempotent: false }),
    respondInterrupt: vi.fn().mockResolvedValue({
      interrupt: {
        schemaVersion: 1,
        id: "44444444-4444-4444-8444-444444444444",
        runId,
        decisionId: "approve_scope",
        prompt: "Approve the scope?",
        status: "responded",
        createdAt: "2026-09-08T00:00:00.000Z",
        respondedAt: "2026-09-08T00:01:00.000Z",
      },
      idempotent: false,
    }),
    getOwnedPendingInterrupt: vi.fn().mockResolvedValue(null),
    ready: vi.fn().mockResolvedValue(true),
  }
}

describe("run control service", () => {
  it("validates commands before owner-scoped persistence", async () => {
    const target = store()
    const service = new RunControlService(operatorId, target)
    const command = {
      schemaVersion: 1 as const,
      applicationId,
      type: "initialize_knowledge" as const,
      idempotencyKey: "initialize:test",
      budget,
      payload: {},
    }
    await expect(service.command(command)).resolves.toMatchObject({
      created: true,
    })
    expect(target.enqueueControl).toHaveBeenCalledWith(operatorId, command)
    await expect(
      service.command({ ...command, payload: { token: "secret" } })
    ).rejects.toThrow()
  })

  it("injects run identity into retry and interrupt commands", async () => {
    const target = store()
    const service = new RunControlService(operatorId, target)
    await service.retry(runId, {
      schemaVersion: 1,
      idempotencyKey: "retry:test",
    })
    await service.respond(runId, "approve_scope", {
      schemaVersion: 1,
      response: { approved: true, note: "Reviewed." },
    })
    expect(target.retryOwned).toHaveBeenCalledWith(
      operatorId,
      runId,
      "retry:test"
    )
    expect(target.respondInterrupt).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId,
        runId,
        decisionId: "approve_scope",
      })
    )
  })

  it("reports named readiness states without reflecting probe failures", async () => {
    const target = store()
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }))
    const service = new RunControlService(
      operatorId,
      target,
      {
        SENTINEL_WORKER_HEALTH_URL: "http://worker.internal/health",
        AZURE_OPENAI_ENDPOINT: "https://models.example.com",
        AZURE_OPENAI_API_KEY: "private-model-key",
        AZURE_OPENAI_DEPLOYMENT: "sentinel",
      },
      fetcher
    )
    const readiness = await service.readiness()
    expect(readiness.status).toBe("ready")
    expect(readiness.dependencies).toEqual(
      expect.arrayContaining([
        { name: "storage", status: "ready" },
        { name: "worker", status: "ready" },
        { name: "model", status: "ready" },
      ])
    )
    expect(JSON.stringify(readiness)).not.toContain("private-model-key")
  })
})
