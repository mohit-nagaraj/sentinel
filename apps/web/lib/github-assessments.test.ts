// @vitest-environment node

import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"

import { GithubAppError } from "@sentinel/adapters/github-app"
import {
  githubAssessmentEnqueueResultSchema,
  githubCheckTargetSchema,
} from "@sentinel/contracts"
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  DEFAULT_GITHUB_ASSESSMENT_BUDGET,
  GithubAssessmentService,
  type GithubAssessmentProvider,
  type GithubAssessmentStore,
} from "./github-assessments"

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../tests/fixtures/github/pull-request-events.json",
      import.meta.url
    ),
    "utf8"
  )
) as Record<string, unknown>
const secret = "a-high-entropy-webhook-secret-value"
const operatorId = "11111111-1111-4111-8111-111111111111"
const applicationId = "22222222-2222-4222-8222-222222222222"
const assessmentId = "33333333-3333-4333-8333-333333333333"
const runId = "44444444-4444-4444-8444-444444444444"
const leaseToken = "55555555-5555-4555-8555-555555555555"
const baseSha = "a".repeat(40)
const headSha = "b".repeat(40)
const repository = { host: "github.com" as const, owner: "owner", name: "repo" }
const enqueueResult = githubAssessmentEnqueueResultSchema.parse({
  schemaVersion: 1,
  disposition: "created",
  assessmentId,
  runId,
  installationId: "1234",
  repository,
  pullRequestNumber: 7,
  headSha,
  isCurrent: true,
  checkRunId: "777",
})
const checkTarget = githubCheckTargetSchema.parse({
  schemaVersion: 1,
  assessmentId,
  installationId: "1234",
  repository,
  pullRequestNumber: 7,
  headSha,
  isCurrent: true,
  checkRunId: null,
  syncLeaseToken: leaseToken,
  recovering: false,
})
const resolved = {
  installationId: "1234",
  repositoryId: "5678",
  repository,
  pullRequestId: "9012",
  pullRequestNumber: 7,
  pullRequestUrl: "https://github.com/owner/repo/pull/7",
  baseSha,
  headSha,
  providerUpdatedAt: "2026-09-08T12:00:00Z",
  draft: false,
  state: "open" as const,
}

function webhookBody(name = "opened"): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(fixture[name]))
}

function signature(body: Uint8Array): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}

function store(overrides: Partial<GithubAssessmentStore> = {}) {
  return {
    getManualTarget: vi.fn().mockResolvedValue({
      applicationId,
      installationId: "1234",
      repository,
    }),
    enqueue: vi.fn().mockResolvedValue(enqueueResult),
    claimCheck: vi.fn().mockResolvedValue(null),
    bindCheck: vi.fn().mockResolvedValue(true),
    releaseCheck: vi.fn().mockResolvedValue(true),
    getCurrentCheck: vi.fn().mockResolvedValue(null),
    ...overrides,
  } satisfies GithubAssessmentStore
}

function provider(overrides: Partial<GithubAssessmentProvider> = {}) {
  return {
    resolvePullRequest: vi.fn().mockResolvedValue(resolved),
    ensureQueuedCheck: vi.fn().mockResolvedValue("777"),
    assessmentDetailsUrl: vi
      .fn()
      .mockImplementation(
        (id: string) => `https://sentinel.example/assessments/${id}`
      ),
    updateCheck: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } satisfies GithubAssessmentProvider
}

describe("GithubAssessmentService", () => {
  it("rejects invalid signatures before parsing or persistence", async () => {
    const target = store()
    const github = provider()
    const service = new GithubAssessmentService(target, github, secret)
    await expect(
      service.receiveWebhook({
        body: new TextEncoder().encode("not json"),
        signature: "sha256=" + "0".repeat(64),
        deliveryId: "delivery-1",
        event: "pull_request",
      })
    ).rejects.toMatchObject({ code: "signature_invalid" })
    expect(target.enqueue).not.toHaveBeenCalled()
    expect(github.resolvePullRequest).not.toHaveBeenCalled()
  })

  it("ignores unsupported and draft deliveries without side effects", async () => {
    const target = store()
    const service = new GithubAssessmentService(target, provider(), secret)
    for (const [name, expected] of [
      ["closed", "unsupported_action"],
      ["draft_opened", "draft_pull_request"],
    ] as const) {
      const body = webhookBody(name)
      await expect(
        service.receiveWebhook({
          body,
          signature: signature(body),
          deliveryId: `delivery-${name}`,
          event: "pull_request",
        })
      ).resolves.toEqual({
        schemaVersion: 1,
        status: "ignored",
        reason: expected,
      })
    }
    expect(target.enqueue).not.toHaveBeenCalled()
  })

  it("returns the durable run and skips check creation when already bound", async () => {
    const target = store()
    const github = provider()
    const service = new GithubAssessmentService(target, github, secret)
    const body = webhookBody()
    await expect(
      service.receiveWebhook({
        body,
        signature: signature(body),
        deliveryId: "delivery-1",
        event: "pull_request",
      })
    ).resolves.toEqual({
      schemaVersion: 1,
      status: "accepted",
      assessmentId,
      runId,
      headSha,
      duplicate: false,
      check: "queued",
    })
    expect(target.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ source: "webhook", headSha }),
      DEFAULT_GITHUB_ASSESSMENT_BUDGET
    )
    expect(github.ensureQueuedCheck).not.toHaveBeenCalled()
  })

  it("ignores a signed delivery whose head is no longer current on GitHub", async () => {
    const target = store()
    const github = provider({
      resolvePullRequest: vi.fn().mockResolvedValue({
        ...resolved,
        headSha: "c".repeat(40),
        providerUpdatedAt: "2026-09-08T12:01:00Z",
      }),
    })
    const service = new GithubAssessmentService(target, github, secret)
    const body = webhookBody()
    await expect(
      service.receiveWebhook({
        body,
        signature: signature(body),
        deliveryId: "delivery-delayed",
        event: "pull_request",
      })
    ).resolves.toEqual({
      schemaVersion: 1,
      status: "ignored",
      reason: "stale_delivery",
    })
    expect(target.enqueue).not.toHaveBeenCalled()
  })

  it("uses one normalized assessment contract for webhook and manual entry", async () => {
    const triggers: unknown[] = []
    const target = store({
      enqueue: vi.fn(async (trigger) => {
        triggers.push(trigger)
        return enqueueResult
      }),
    })
    const service = new GithubAssessmentService(target, provider(), secret)
    const body = webhookBody()
    await service.receiveWebhook({
      body,
      signature: signature(body),
      deliveryId: "delivery-1",
      event: "pull_request",
    })
    await service.submitManual(operatorId, {
      schemaVersion: 1,
      applicationId,
      pullRequestUrl: "https://github.com/owner/repo/pull/7",
    })
    expect(triggers).toHaveLength(2)
    for (const field of [
      "installationId",
      "repositoryId",
      "repository",
      "pullRequestId",
      "pullRequestNumber",
      "pullRequestUrl",
      "baseSha",
      "headSha",
      "providerUpdatedAt",
    ]) {
      expect((triggers[0] as Record<string, unknown>)[field]).toEqual(
        (triggers[1] as Record<string, unknown>)[field]
      )
    }
  })

  it("claims, creates, and binds one queued check", async () => {
    const target = store({
      enqueue: vi.fn().mockResolvedValue({
        ...enqueueResult,
        checkRunId: null,
      }),
      claimCheck: vi.fn().mockResolvedValue(checkTarget),
    })
    const github = provider()
    const service = new GithubAssessmentService(target, github, secret)
    const body = webhookBody()
    await expect(
      service.receiveWebhook({
        body,
        signature: signature(body),
        deliveryId: "delivery-1",
        event: "pull_request",
      })
    ).resolves.toMatchObject({ check: "queued" })
    expect(github.ensureQueuedCheck).toHaveBeenCalledWith(checkTarget)
    expect(target.bindCheck).toHaveBeenCalledWith({
      assessmentId,
      headSha,
      syncLeaseToken: leaseToken,
      checkRunId: "777",
    })
  })

  it("releases the durable check claim when GitHub synchronization fails", async () => {
    const target = store({
      enqueue: vi.fn().mockResolvedValue({
        ...enqueueResult,
        checkRunId: null,
      }),
      claimCheck: vi.fn().mockResolvedValue(checkTarget),
    })
    const github = provider({
      ensureQueuedCheck: vi.fn().mockRejectedValue(
        new GithubAppError("provider_unavailable", "GitHub unavailable", {
          retryable: true,
        })
      ),
    })
    const service = new GithubAssessmentService(target, github, secret)
    const body = webhookBody()
    await expect(
      service.receiveWebhook({
        body,
        signature: signature(body),
        deliveryId: "delivery-1",
        event: "pull_request",
      })
    ).rejects.toMatchObject({ code: "provider_unavailable" })
    expect(target.releaseCheck).toHaveBeenCalledWith({
      assessmentId,
      headSha,
      syncLeaseToken: leaseToken,
    })
  })

  it("releases a check claim when binding loses current-head ownership", async () => {
    const target = store({
      enqueue: vi.fn().mockResolvedValue({
        ...enqueueResult,
        checkRunId: null,
      }),
      claimCheck: vi.fn().mockResolvedValue(checkTarget),
      bindCheck: vi.fn().mockResolvedValue(false),
    })
    const service = new GithubAssessmentService(target, provider(), secret)
    const body = webhookBody()
    await expect(
      service.receiveWebhook({
        body,
        signature: signature(body),
        deliveryId: "delivery-1",
        event: "pull_request",
      })
    ).resolves.toMatchObject({ check: "sync_pending" })
    expect(target.releaseCheck).toHaveBeenCalledWith({
      assessmentId,
      headSha,
      syncLeaseToken: leaseToken,
    })
  })

  it("refuses stale publication and updates only the exact current head", async () => {
    const getCurrentCheck = vi.fn().mockResolvedValue(null)
    const target = store({ getCurrentCheck })
    const github = provider()
    const service = new GithubAssessmentService(target, github, secret)
    await expect(
      service.publishCheck({
        assessmentId,
        headSha,
        lifecycle: { state: "running", startedAt: "2026-09-09T00:00:00Z" },
      })
    ).resolves.toBe(false)
    expect(github.updateCheck).not.toHaveBeenCalled()

    getCurrentCheck.mockResolvedValue({
      ...checkTarget,
      checkRunId: "777",
      syncLeaseToken: null,
    })
    await expect(
      service.publishCheck({
        assessmentId,
        headSha,
        lifecycle: { state: "running", startedAt: "2026-09-09T00:00:00Z" },
      })
    ).resolves.toBe(true)
    expect(github.updateCheck).toHaveBeenCalledWith(
      expect.objectContaining({ assessmentId, headSha, checkRunId: "777" }),
      expect.objectContaining({ assessmentId, headSha })
    )
  })

  it("recovers a missing queued check before publishing its lifecycle", async () => {
    const boundTarget = {
      ...checkTarget,
      checkRunId: "777",
      syncLeaseToken: null,
    }
    const getCurrentCheck = vi
      .fn()
      .mockResolvedValueOnce({
        ...checkTarget,
        syncLeaseToken: null,
      })
      .mockResolvedValueOnce(boundTarget)
    const target = store({
      getCurrentCheck,
      claimCheck: vi.fn().mockResolvedValue(checkTarget),
    })
    const github = provider()
    const service = new GithubAssessmentService(target, github, secret)
    await expect(
      service.publishCheck({
        assessmentId,
        headSha,
        lifecycle: { state: "running", startedAt: "2026-09-09T00:00:00Z" },
      })
    ).resolves.toBe(true)
    expect(github.ensureQueuedCheck).toHaveBeenCalledWith(checkTarget)
    expect(target.bindCheck).toHaveBeenCalledWith({
      assessmentId,
      headSha,
      syncLeaseToken: leaseToken,
      checkRunId: "777",
    })
    expect(github.updateCheck).toHaveBeenCalledWith(
      boundTarget,
      expect.objectContaining({ assessmentId, headSha })
    )
  })
})
