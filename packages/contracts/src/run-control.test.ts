import { describe, expect, it } from "vitest"

import {
  createRunRequestFingerprint,
  humanDecisionSchema,
  publicRunSchema,
  runCommandSchema,
} from "./run-control.ts"

const budget = {
  toolCalls: 1,
  contentBytes: 2,
  documentBytes: 3,
  documentPages: 4,
  documentSections: 5,
  sourceLines: 6,
  repositoryBytes: 7,
  repositoryFiles: 8,
  browserActions: 9,
  modelCalls: 10,
  modelInputTokens: 11,
  modelOutputTokens: 12,
  reconciliationRounds: 13,
  elapsedMs: 14,
}
const applicationId = "11111111-1111-4111-8111-111111111111"

describe("run control contracts", () => {
  it("parses every supported command with a strict type-specific payload", () => {
    const cases = [
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
      ["run_eval", { fixtureKey: "smoke_fixture" }],
    ] as const

    for (const [type, payload] of cases) {
      expect(
        runCommandSchema.parse({
          schemaVersion: 1,
          applicationId,
          type,
          idempotencyKey: `test:${type}`,
          budget,
          payload,
        }).type
      ).toBe(type)
    }
    expect(() =>
      runCommandSchema.parse({
        schemaVersion: 1,
        applicationId,
        type: "inspect_application",
        idempotencyKey: "test:inspect",
        budget,
        payload: { token: "secret" },
      })
    ).toThrow()
  })

  it("fingerprints canonical work independently of key delivery", () => {
    const command = {
      schemaVersion: 1 as const,
      applicationId,
      type: "inspect_application" as const,
      idempotencyKey: "delivery:one",
      budget,
      payload: {},
    }
    expect(createRunRequestFingerprint(command)).toBe(
      createRunRequestFingerprint({
        ...command,
        idempotencyKey: "delivery:two",
      })
    )
    expect(createRunRequestFingerprint(command)).not.toBe(
      createRunRequestFingerprint({
        ...command,
        budget: { ...budget, elapsedMs: 15 },
      })
    )
  })

  it("keeps public runs and decisions bounded and secret-safe", () => {
    expect(() =>
      publicRunSchema.parse({
        schemaVersion: 1,
        id: applicationId,
        applicationId,
        type: "inspect_application",
        status: "failed",
        attemptCount: 1,
        createdAt: "2026-09-08T00:00:00.000Z",
        error: {
          category: "provider",
          code: "provider_timeout",
          message: "Authorization: Bearer secret",
          retryable: true,
        },
      })
    ).toThrow()
    expect(() =>
      humanDecisionSchema.parse({ approved: true, note: "x".repeat(4_097) })
    ).toThrow()
  })
})
