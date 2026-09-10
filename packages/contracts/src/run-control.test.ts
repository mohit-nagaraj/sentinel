import { describe, expect, it } from "vitest"

import {
  createRunRequestFingerprint,
  humanDecisionSchema,
  publicRunSchema,
  runCommandSchema,
  runTerminalPublicationSchema,
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
    expect(() =>
      runCommandSchema.parse({
        schemaVersion: 1,
        applicationId,
        type: "run_eval",
        idempotencyKey: "unbounded:budget",
        budget: { ...budget, modelCalls: 251 },
        payload: { fixtureKey: "smoke" },
      })
    ).toThrow()
  })

  it("exposes assessment identity only for a succeeded assessment run", () => {
    const assessmentId = "00000000-0000-4000-8000-000000000029"
    const completed = {
      schemaVersion: 1,
      id: "00000000-0000-4000-8000-000000000024",
      applicationId,
      type: "assess_pr",
      status: "succeeded",
      attemptCount: 0,
      assessmentId,
      assessment: {
        id: assessmentId,
        repository: { host: "github.com", owner: "sentinel", name: "demo" },
        pullRequestNumber: 29,
        baseSha: "1".repeat(40),
        headSha: "2".repeat(40),
        reportAvailable: true,
      },
      createdAt: "2026-09-08T00:00:00.000Z",
      finishedAt: "2026-09-08T00:01:00.000Z",
    }

    expect(publicRunSchema.parse(completed).assessmentId).toBe(assessmentId)
    expect(
      publicRunSchema.safeParse({ ...completed, assessmentId: undefined })
        .success
    ).toBe(true)
    expect(
      publicRunSchema.safeParse({ ...completed, status: "running" }).success
    ).toBe(false)
    expect(
      publicRunSchema.safeParse({
        ...completed,
        type: "initialize_knowledge",
      }).success
    ).toBe(false)
  })

  it("binds inspection publications to one bounded report fingerprint", () => {
    const fingerprint = `sha256:${"a".repeat(64)}`
    const evidence = {
      capability: "repository_resolved" as const,
      status: "detected" as const,
      code: "repository_resolved",
      summary: "Repository resolved",
      source: "repository" as const,
      references: ["composer.json"],
    }
    const report = {
      schemaVersion: 1 as const,
      inputFingerprint: fingerprint,
      status: "supported" as const,
      resolvedCommitSha: "a".repeat(40),
      selectedAdapters: ["php_laravel"],
      evidence: [evidence],
      findings: [],
      humanActions: [],
      proposedScope: {
        repositoryPaths: ["src"],
        documentationSources: [],
        applicationOrigins: ["https://app.example.com"],
        allowedActionCategories: ["safe_read"],
        maxActions: 10,
        maxScreens: 10,
        maxDurationSeconds: 60,
      },
      inspectedAt: "2026-09-08T00:00:00.000Z",
    }
    expect(() =>
      runTerminalPublicationSchema.parse({
        kind: "inspection",
        inputFingerprint: `sha256:${"b".repeat(64)}`,
        report,
      })
    ).toThrow("fingerprint")
    expect(() =>
      runTerminalPublicationSchema.parse({
        kind: "inspection",
        inputFingerprint: fingerprint,
        report: {
          ...report,
          evidence: Array.from({ length: 100 }, () => ({
            ...evidence,
            references: Array.from({ length: 20 }, () => "x".repeat(2_048)),
          })),
        },
      })
    ).toThrow("persisted report limit")
  })
})
