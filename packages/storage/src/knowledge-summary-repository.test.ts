import { describe, expect, it } from "vitest"

import type {
  DatabaseClient,
  DatabaseExecutor,
  SqlParameter,
} from "./database.ts"
import {
  KnowledgeReviewConflictError,
  KnowledgeSummaryRepository,
} from "./knowledge-summary-repository.ts"

const operatorId = "11111111-1111-4111-8111-111111111111"
const applicationId = "22222222-2222-4222-8222-222222222222"
const stableApplicationId = `application:v1:${"a".repeat(64)}`
const linkId = `evidence:v1:${"b".repeat(64)}`
const sourceHash = `sha256:${"c".repeat(64)}`
const reviewId = "33333333-3333-4333-8333-333333333333"

interface Call {
  readonly statement: string
  readonly parameters: readonly SqlParameter[]
}

class ScriptedDatabase implements DatabaseClient {
  readonly calls: Call[] = []
  constructor(
    private readonly results: readonly (readonly Record<string, unknown>[])[]
  ) {}

  query<Row extends Record<string, unknown>>(
    statement: string,
    parameters: readonly SqlParameter[] = []
  ): Promise<readonly Row[]> {
    this.calls.push({ statement, parameters })
    return Promise.resolve(
      (this.results[this.calls.length - 1] ?? []) as readonly Row[]
    )
  }

  transaction<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
    return work(this)
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

function storedReview(overrides: Record<string, unknown> = {}) {
  return {
    id: reviewId,
    link_stable_key: linkId,
    source_identity_hash: sourceHash,
    decision: "accepted",
    reason: "Runtime and route evidence agree.",
    decided_at: new Date("2026-09-09T01:00:00.000Z"),
    ...overrides,
  }
}

describe("knowledge summary repository", () => {
  it("owner-scopes application, source, and interrupt reads", async () => {
    const database = new ScriptedDatabase([
      [
        {
          id: applicationId,
          stable_key: stableApplicationId,
          name: "Checkout",
          deployment_url: "https://checkout.example.test/",
          status: "ready",
          indexed_commit_sha: "d".repeat(40),
          graph_revision: 2,
          refreshed_at: new Date("2026-09-09T00:00:00.000Z"),
          knowledge_stale: false,
        },
      ],
      [
        {
          stable_key: stableApplicationId,
          kind: "application",
          uri: "https://checkout.example.test/",
          status: "ready",
          checked_at: new Date("2026-09-09T00:00:00.000Z"),
        },
      ],
      [
        {
          id: "44444444-4444-4444-8444-444444444444",
          run_id: "55555555-5555-4555-8555-555555555555",
          decision_id: "confirm_checkout",
          prompt: "Confirm the checkout mapping.",
          status: "pending",
          created_at: new Date("2026-09-09T01:00:00.000Z"),
        },
      ],
    ])
    const repository = new KnowledgeSummaryRepository(database)
    await expect(
      repository.getOwnedApplication(operatorId, applicationId)
    ).resolves.toMatchObject({ stableKey: stableApplicationId })
    await expect(
      repository.listOwnedSources(operatorId, applicationId)
    ).resolves.toHaveLength(1)
    await expect(
      repository.listOwnedPendingInterrupts(operatorId, applicationId)
    ).resolves.toHaveLength(1)
    for (const call of database.calls) {
      expect(call.statement).toContain("onboarding.operator_id = $1::uuid")
      expect(call.parameters.slice(0, 2)).toEqual([operatorId, applicationId])
    }
  })

  it("stores an immutable review and treats an exact replay as idempotent", async () => {
    const createdDatabase = new ScriptedDatabase([[storedReview()]])
    const created = await new KnowledgeSummaryRepository(
      createdDatabase
    ).recordOwnedLinkReview({
      operatorId,
      applicationId,
      linkStableKey: linkId,
      sourceIdentityHash: sourceHash,
      decision: "accepted",
      reason: "Runtime and route evidence agree.",
    })
    expect(created.idempotent).toBe(false)
    expect(createdDatabase.calls[0]?.statement).toContain("do nothing")
    expect(createdDatabase.calls[0]?.statement).toContain(
      "onboarding.operator_id = $1::uuid"
    )

    const replayDatabase = new ScriptedDatabase([[], [storedReview()]])
    const replay = await new KnowledgeSummaryRepository(
      replayDatabase
    ).recordOwnedLinkReview({
      operatorId,
      applicationId,
      linkStableKey: linkId,
      sourceIdentityHash: sourceHash,
      decision: "accepted",
      reason: "Runtime and route evidence agree.",
    })
    expect(replay.idempotent).toBe(true)
    expect(replay.review.id).toBe(reviewId)
  })

  it("rejects a conflicting duplicate decision", async () => {
    const database = new ScriptedDatabase([
      [],
      [storedReview({ decision: "rejected", reason: "Evidence conflicts." })],
    ])
    await expect(
      new KnowledgeSummaryRepository(database).recordOwnedLinkReview({
        operatorId,
        applicationId,
        linkStableKey: linkId,
        sourceIdentityHash: sourceHash,
        decision: "accepted",
        reason: "Runtime and route evidence agree.",
      })
    ).rejects.toBeInstanceOf(KnowledgeReviewConflictError)
  })
})
