import { describe, expect, it, vi } from "vitest"

import type { DatabaseExecutor } from "./database.ts"
import { RecordsRepository } from "./records-repository.ts"

const applicationId = "11111111-1111-4111-8111-111111111111"
const recordId = "22222222-2222-4222-8222-222222222222"

describe("records repository", () => {
  it.each([
    "password",
    "access_token",
    "refreshToken",
    "id_token",
    "oauth_token",
    "api_token",
    "accessKeyId",
    "set-cookie",
    "proxy-authorization",
    "x-amz-signature",
    "aws_secret_access_key",
    "SUPABASE_S3_SECRET_ACCESS_KEY",
    "clientSecretValue",
    "password_confirmation",
    "apiKeyValue",
    "private_key_pem",
  ])(
    "rejects secret field %s recursively before executing SQL",
    async (field) => {
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
          details: {
            nested: { [field]: "opaque-value" },
          },
        })
      ).rejects.toThrow("sensitive field")
      expect(query).not.toHaveBeenCalled()
    }
  )

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

  it("rejects credential-shaped report titles before executing SQL", async () => {
    const query = vi.fn().mockResolvedValue([{ id: recordId }])
    const repository = new RecordsRepository({
      query: query as DatabaseExecutor["query"],
    })

    await expect(
      repository.addAssessmentFinding({
        assessmentId: applicationId,
        stableKey:
          "finding:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        risk: "high",
        evidenceStrength: "A",
        title: "Authorization: Bearer synthetic-secret-value",
        summary: "A secret-safe summary.",
        verificationStatus: "not_run",
        evidencePathCount: 1,
      })
    ).rejects.toThrow("secret-shaped syntax")
    expect(query).not.toHaveBeenCalled()
  })
})
