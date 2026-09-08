// @vitest-environment node

import { runCommandSchema } from "@sentinel/contracts"
import { RunControlRepositoryError } from "@sentinel/storage"
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import type { RunControlService } from "@/lib/run-control"

import { handleControlRequest } from "./route"

const token = "operator-control-token-that-is-long-enough"
const environment = { SENTINEL_OPERATOR_TOKEN: token }
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

function service(
  overrides: Partial<Record<keyof RunControlService, unknown>> = {}
) {
  return {
    command: vi.fn().mockResolvedValue({ run: publicRun, created: true }),
    get: vi.fn().mockResolvedValue(publicRun),
    list: vi.fn().mockResolvedValue({ items: [publicRun] }),
    events: vi.fn().mockResolvedValue({ items: [] }),
    cancel: vi.fn().mockResolvedValue({ ...publicRun, status: "cancelled" }),
    retry: vi.fn().mockResolvedValue({ run: publicRun, idempotent: false }),
    respond: vi.fn().mockResolvedValue({
      interrupt: { decisionId: "approve_scope" },
      idempotent: false,
    }),
    pendingInterrupt: vi
      .fn()
      .mockResolvedValue({ decisionId: "approve_scope" }),
    readiness: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      service: "control-plane",
      status: "ready",
      dependencies: [{ name: "storage", status: "ready" }],
    }),
    ...overrides,
  } as unknown as RunControlService
}

function request(
  method: string,
  path: string,
  body?: unknown,
  authorization = `Bearer ${token}`
) {
  return new Request(`http://sentinel.test/api/control/${path}`, {
    method,
    headers: {
      authorization,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe("run control route", () => {
  it("independently rejects unauthenticated requests", async () => {
    const target = service()
    const result = await handleControlRequest(
      request("GET", "runs", undefined, "Bearer wrong"),
      ["runs"],
      target,
      environment
    )
    expect(result.status).toBe(401)
    expect(result.headers.get("www-authenticate")).toContain("Basic")
    expect(target.list).not.toHaveBeenCalled()
  })

  it("accepts all six command payloads and returns immediately", async () => {
    const commands = [
      ["inspect_application", {}],
      ["initialize_knowledge", {}],
      ["refresh_knowledge", {}],
      [
        "assess_pr",
        {
          pullRequestNumber: 17,
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
        },
      ],
      ["verify_pr", { assessmentId: applicationId }],
      ["run_eval", { fixtureKey: "smoke" }],
    ] as const
    for (const [type, payload] of commands) {
      const target = service()
      const result = await handleControlRequest(
        request("POST", "runs", {
          schemaVersion: 1,
          applicationId,
          type,
          idempotencyKey: `command:${type}`,
          budget,
          payload,
        }),
        ["runs"],
        target,
        environment
      )
      expect(result.status).toBe(202)
      await expect(result.json()).resolves.toMatchObject({
        schemaVersion: 1,
        run: { id: runId },
        idempotent: false,
      })
    }
  })

  it("serves owner-filtered history, control actions, and readiness", async () => {
    const target = service()
    const cases = [
      [request("GET", "runs?limit=10"), ["runs"], 200],
      [request("GET", `runs/${runId}`), ["runs", runId], 200],
      [request("GET", `runs/${runId}/events`), ["runs", runId, "events"], 200],
      [
        request("GET", `runs/${runId}/interrupt`),
        ["runs", runId, "interrupt"],
        200,
      ],
      [request("POST", `runs/${runId}/cancel`), ["runs", runId, "cancel"], 202],
      [
        request("POST", `runs/${runId}/retry`, {
          schemaVersion: 1,
          idempotencyKey: "retry:test",
        }),
        ["runs", runId, "retry"],
        202,
      ],
      [
        request("POST", `runs/${runId}/interrupts/approve_scope/respond`, {
          schemaVersion: 1,
          response: { approved: true },
        }),
        ["runs", runId, "interrupts", "approve_scope", "respond"],
        202,
      ],
      [request("GET", "readiness"), ["readiness"], 200],
    ] as const
    for (const [incoming, path, status] of cases) {
      const result = await handleControlRequest(
        incoming,
        path,
        target,
        environment
      )
      expect(result.status).toBe(status)
      expect(result.headers.get("cache-control")).toContain("no-store")
    }
  })

  it("maps validation, conflicts, absence, and storage errors without details", async () => {
    const malformed = await handleControlRequest(
      request("POST", "runs", { token: "private" }),
      ["runs"],
      service({
        command: vi
          .fn()
          .mockImplementation(async (input) => runCommandSchema.parse(input)),
      }),
      environment
    )
    expect(malformed.status).toBe(400)
    expect(JSON.stringify(await malformed.json())).not.toContain("private")

    const conflict = await handleControlRequest(
      request("POST", "runs", {}),
      ["runs"],
      service({
        command: vi.fn().mockRejectedValue(
          new RunControlRepositoryError("idempotency_conflict", {
            cause: new Error("token=private"),
          })
        ),
      }),
      environment
    )
    expect(conflict.status).toBe(409)
    const serialized = JSON.stringify(await conflict.json())
    expect(serialized).toContain("idempotency_conflict")
    expect(serialized).not.toContain("private")

    const missing = await handleControlRequest(
      request("GET", `runs/${runId}`),
      ["runs", runId],
      service({ get: vi.fn().mockResolvedValue(null) }),
      environment
    )
    expect(missing.status).toBe(404)
  })

  it("rejects partial cursors and oversized bodies", async () => {
    const partial = await handleControlRequest(
      request("GET", "runs?cursorId=33333333-3333-4333-8333-333333333333"),
      ["runs"],
      service(),
      environment
    )
    expect(partial.status).toBe(400)
    const oversized = await handleControlRequest(
      new Request("http://sentinel.test/api/control/runs", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-length": String(65 * 1_024),
        },
        body: "{}",
      }),
      ["runs"],
      service(),
      environment
    )
    expect(oversized.status).toBe(400)
  })
})
