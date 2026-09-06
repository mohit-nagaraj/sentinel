import { describe, expect, it, vi } from "vitest"

import type { DatabaseExecutor } from "./database.ts"
import { RecordsRepository } from "./records-repository.ts"

const applicationId = "11111111-1111-4111-8111-111111111111"
const recordId = "22222222-2222-4222-8222-222222222222"

describe("records repository", () => {
  it("rejects secret fields recursively before executing SQL", async () => {
    const query = vi.fn().mockResolvedValue([{ id: recordId }])
    const repository = new RecordsRepository({
      query: query as DatabaseExecutor["query"],
    })

    await expect(
      repository.recordEvalResult({
        applicationId,
        runId: null,
        fixtureKey: "credential-redaction",
        metricKey: "leak-count",
        outcome: "failed",
        value: 1,
        details: { nested: { password: "plaintext-value" } },
      })
    ).rejects.toThrow("sensitive field")
    expect(query).not.toHaveBeenCalled()
  })

  it("writes canonical secret-free eval details with bound parameters", async () => {
    const query = vi.fn().mockResolvedValue([{ id: recordId }])
    const repository = new RecordsRepository({
      query: query as DatabaseExecutor["query"],
    })

    await expect(
      repository.recordEvalResult({
        applicationId,
        runId: null,
        fixtureKey: "stable-identity",
        metricKey: "repeatability",
        outcome: "passed",
        value: 1,
        details: { z: true, a: "deterministic" },
      })
    ).resolves.toBe(recordId)
    expect(query.mock.calls[0]?.[1]?.[6]).toBe('{"a":"deterministic","z":true}')
  })
})
