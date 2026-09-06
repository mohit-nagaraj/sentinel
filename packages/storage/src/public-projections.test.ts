import { artifactIdSchema, contentHashSchema } from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import {
  toPublicApplicationSummary,
  toPublicArtifactSummary,
  toPublicRunSummary,
  toPublicSourceSummary,
} from "./public-projections.ts"

const now = new Date("2026-09-07T00:00:00.000Z")

describe("public storage projections", () => {
  it("omits queue ownership, object keys, and secret references", () => {
    const application = toPublicApplicationSummary({
      id: "11111111-1111-4111-8111-111111111111",
      stableKey: "application:v1:fixture",
      name: "Hi.Events",
      deploymentUrl: "https://fixture.example.com",
      status: "ready",
      indexedCommitSha: null,
      graphRevision: 1,
      refreshedAt: now,
    })
    const run = toPublicRunSummary({
      id: "22222222-2222-4222-8222-222222222222",
      applicationId: application.id,
      runType: "initialize_knowledge",
      status: "running",
      idempotencyKey: "private-idempotency-key",
      budget: {
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
      },
      leaseOwner: "private-worker",
      leaseExpiresAt: now,
      attemptCount: 1,
      cancelRequestedAt: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
    })
    const source = toPublicSourceSummary({
      id: "33333333-3333-4333-8333-333333333333",
      applicationId: application.id,
      stableKey: "source:v1:fixture",
      kind: "application",
      uri: "https://fixture.example.com",
      status: "ready",
      contentHash: null,
      secretReference:
        "secret-ref:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      checkedAt: now,
    })
    const artifact = toPublicArtifactSummary({
      id: artifactIdSchema.parse(
        "artifact:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      ),
      databaseId: "44444444-4444-4444-8444-444444444444",
      applicationId: application.id,
      runId: run.id,
      artifactType: "screenshot",
      bucket: "private-bucket",
      objectKey: "private/object/key",
      contentHash: contentHashSchema.parse(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ),
      mimeType: "image/png",
      sizeBytes: 100,
      referenceCount: 1,
      retainUntil: now,
    })

    const serialized = JSON.stringify({ application, artifact, run, source })
    expect(serialized).not.toContain("private-worker")
    expect(serialized).not.toContain("private-idempotency-key")
    expect(serialized).not.toContain("private/object/key")
    expect(serialized).not.toContain("secret-ref:")
  })
})
