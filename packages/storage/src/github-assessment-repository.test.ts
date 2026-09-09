import { describe, expect, it, vi } from "vitest"

import type { DatabaseExecutor } from "./database.ts"
import {
  GithubAssessmentRepository,
  GithubAssessmentRepositoryError,
} from "./github-assessment-repository.ts"

const applicationId = "11111111-1111-4111-8111-111111111111"
const operatorId = "22222222-2222-4222-8222-222222222222"
const assessmentId = "33333333-3333-4333-8333-333333333333"
const runId = "44444444-4444-4444-8444-444444444444"
const leaseToken = "55555555-5555-4555-8555-555555555555"
const baseSha = "a".repeat(40)
const headSha = "b".repeat(40)
const repository = { host: "github.com", owner: "owner", name: "repo" }
const budget = {
  toolCalls: 25,
  contentBytes: 100_000,
  documentBytes: 0,
  documentPages: 0,
  documentSections: 0,
  sourceLines: 50_000,
  repositoryBytes: 500_000_000,
  repositoryFiles: 50_000,
  browserActions: 0,
  modelCalls: 20,
  modelInputTokens: 100_000,
  modelOutputTokens: 20_000,
  reconciliationRounds: 3,
  elapsedMs: 900_000,
}
const webhookTrigger = {
  schemaVersion: 1 as const,
  source: "webhook" as const,
  event: "pull_request" as const,
  action: "opened" as const,
  deliveryId: "delivery-1",
  installationId: "1234",
  repositoryId: "5678",
  repository,
  pullRequestId: "9012",
  pullRequestNumber: 7,
  pullRequestUrl: "https://github.com/owner/repo/pull/7",
  baseSha,
  headSha,
  providerUpdatedAt: "2026-09-08T12:00:00Z",
  sender: { id: "42", login: "octocat", type: "User" },
}
const enqueueRow = {
  disposition: "created",
  assessment_id: assessmentId,
  run_id: runId,
  installation_id: "1234",
  repository_host: "github.com",
  repository_owner: "owner",
  repository_name: "repo",
  pull_request_number: 7,
  head_sha: headSha,
  is_current: true,
  check_run_id: null,
}
const checkRow = {
  assessment_id: assessmentId,
  installation_id: "1234",
  repository_host: "github.com",
  repository_owner: "owner",
  repository_name: "repo",
  pull_request_number: 7,
  head_sha: headSha,
  is_current: true,
  check_run_id: null,
  sync_lease_token: leaseToken,
  recovering: false,
}

function database(query: ReturnType<typeof vi.fn>): DatabaseExecutor {
  return { query: query as DatabaseExecutor["query"] }
}

describe("GithubAssessmentRepository", () => {
  it("resolves only the operator-owned configured App target", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        application_id: applicationId,
        installation_id: "1234",
        repository_host: "github.com",
        repository_owner: "Owner",
        repository_name: "Repo",
      },
    ])
    const repository = new GithubAssessmentRepository(database(query))
    await expect(
      repository.getManualTarget(operatorId, applicationId)
    ).resolves.toEqual({
      applicationId,
      installationId: "1234",
      repository: { host: "github.com", owner: "Owner", name: "Repo" },
    })
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("get_manual_github_assessment_target"),
      [operatorId, applicationId]
    )
  })

  it("passes normalized webhook identity and budget to one transaction call", async () => {
    const query = vi.fn().mockResolvedValue([enqueueRow])
    const repository = new GithubAssessmentRepository(database(query))
    await expect(repository.enqueue(webhookTrigger, budget)).resolves.toEqual({
      schemaVersion: 1,
      disposition: "created",
      assessmentId,
      runId,
      installationId: "1234",
      repository: { host: "github.com", owner: "owner", name: "repo" },
      pullRequestNumber: 7,
      headSha,
      isCurrent: true,
      checkRunId: null,
    })
    const parameters = query.mock.calls[0]?.[1]
    expect(parameters).toEqual([
      "webhook",
      "delivery-1",
      null,
      null,
      "1234",
      "5678",
      "owner",
      "repo",
      "9012",
      7,
      baseSha,
      headSha,
      new Date("2026-09-08T12:00:00Z"),
      "opened",
      JSON.stringify(budget),
    ])
    expect(JSON.stringify(parameters)).not.toContain("octocat")
  })

  it("uses the same transaction for manual triggers without a delivery", async () => {
    const query = vi.fn().mockResolvedValue([{ ...enqueueRow }])
    const repository = new GithubAssessmentRepository(database(query))
    await repository.enqueue(
      {
        schemaVersion: 1,
        source: "manual",
        applicationId,
        operatorId,
        installationId: webhookTrigger.installationId,
        repositoryId: webhookTrigger.repositoryId,
        repository: webhookTrigger.repository,
        pullRequestId: webhookTrigger.pullRequestId,
        pullRequestNumber: webhookTrigger.pullRequestNumber,
        pullRequestUrl: webhookTrigger.pullRequestUrl,
        baseSha: webhookTrigger.baseSha,
        headSha: webhookTrigger.headSha,
        providerUpdatedAt: webhookTrigger.providerUpdatedAt,
      },
      budget
    )
    expect(query.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["manual", null, operatorId, applicationId])
    )
    expect(query.mock.calls[0]?.[1]?.[13]).toBe("manual")
  })

  it("claims, binds, releases, and reads assessment-bound checks", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([checkRow])
      .mockResolvedValueOnce([{ bound: true }])
      .mockResolvedValueOnce([{ released: true }])
      .mockResolvedValueOnce([
        {
          ...checkRow,
          check_run_id: "777",
          sync_lease_token: null,
        },
      ])
    const repository = new GithubAssessmentRepository(database(query))
    await expect(
      repository.claimCheck(assessmentId, headSha, 30)
    ).resolves.toMatchObject({
      assessmentId,
      syncLeaseToken: leaseToken,
      recovering: false,
    })
    await expect(
      repository.bindCheck({
        assessmentId,
        headSha,
        syncLeaseToken: leaseToken,
        checkRunId: "777",
      })
    ).resolves.toBe(true)
    await expect(
      repository.releaseCheck({
        assessmentId,
        headSha,
        syncLeaseToken: leaseToken,
      })
    ).resolves.toBe(true)
    await expect(
      repository.getCurrentCheck(assessmentId, headSha)
    ).resolves.toMatchObject({ checkRunId: "777" })
  })

  it("returns null when another worker owns check sync", async () => {
    const repository = new GithubAssessmentRepository(
      database(vi.fn().mockResolvedValue([]))
    )
    await expect(
      repository.claimCheck(assessmentId, headSha)
    ).resolves.toBeNull()
  })

  it("maps known database failures without exposing provider details", async () => {
    const repository = new GithubAssessmentRepository(
      database(
        vi
          .fn()
          .mockRejectedValue(
            new Error("delivery_idempotency_conflict: private database detail")
          )
      )
    )
    const error = await repository
      .enqueue(webhookTrigger, budget)
      .catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(GithubAssessmentRepositoryError)
    expect(error).toMatchObject({
      code: "delivery_idempotency_conflict",
      message: "delivery_idempotency_conflict",
    })
  })
})
