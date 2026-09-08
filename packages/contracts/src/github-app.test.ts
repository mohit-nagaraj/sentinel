import { describe, expect, it } from "vitest"

import {
  githubAppRegistrationSchema,
  githubAssessmentEnqueueResultSchema,
  githubCheckRequestSchema,
  githubManualAssessmentTriggerSchema,
  githubWebhookAssessmentTriggerSchema,
  manualGithubAssessmentRequestSchema,
  SENTINEL_GITHUB_APP_REGISTRATION,
} from "./github-app.ts"

const assessmentId = "11111111-1111-4111-8111-111111111111"
const runId = "22222222-2222-4222-8222-222222222222"
const operatorId = "33333333-3333-4333-8333-333333333333"
const applicationId = "44444444-4444-4444-8444-444444444444"
const baseSha = "a".repeat(40)
const headSha = "b".repeat(40)
const common = {
  schemaVersion: 1 as const,
  installationId: "1234",
  repositoryId: "5678",
  repository: { host: "github.com", owner: "Owner", name: "Repo" },
  pullRequestId: "9012",
  pullRequestNumber: 7,
  pullRequestUrl: "https://github.com/owner/repo/pull/7",
  baseSha,
  headSha,
  providerUpdatedAt: "2026-09-08T12:00:00.000Z",
}

describe("GitHub App contracts", () => {
  it("normalizes durable provider IDs and GitHub repository identity", () => {
    expect(
      githubWebhookAssessmentTriggerSchema.parse({
        ...common,
        source: "webhook",
        event: "pull_request",
        action: "synchronize",
        deliveryId: "01234567-89ab-cdef-0123-456789abcdef",
        sender: { id: 42, login: "octocat", type: "User" },
      })
    ).toMatchObject({
      installationId: "1234",
      repositoryId: "5678",
      repository: { owner: "owner", name: "repo" },
      sender: { id: "42" },
    })
  })

  it("keeps webhook and manual authentication fields separate", () => {
    expect(
      githubManualAssessmentTriggerSchema.safeParse({
        ...common,
        source: "manual",
        operatorId,
        applicationId,
        deliveryId: "must-not-cross-the-boundary",
      }).success
    ).toBe(false)
    expect(
      githubWebhookAssessmentTriggerSchema.safeParse({
        ...common,
        source: "webhook",
        event: "pull_request",
        action: "closed",
        deliveryId: "delivery-1",
        sender: { id: "42", login: "octocat", type: "User" },
      }).success
    ).toBe(false)
  })

  it("accepts only canonical credential-free GitHub PR URLs", () => {
    expect(
      manualGithubAssessmentRequestSchema.parse({
        schemaVersion: 1,
        applicationId,
        pullRequestUrl: "https://github.com/owner/repo/pull/7",
      }).pullRequestUrl
    ).toBe("https://github.com/owner/repo/pull/7")
    for (const pullRequestUrl of [
      "http://github.com/owner/repo/pull/7",
      "https://token@github.com/owner/repo/pull/7",
      "https://example.com/owner/repo/pull/7",
      "https://github.com/owner/repo/issues/7",
    ]) {
      expect(
        manualGithubAssessmentRequestSchema.safeParse({
          schemaVersion: 1,
          applicationId,
          pullRequestUrl,
        }).success
      ).toBe(false)
    }
  })

  it("enforces current run identity for accepted results", () => {
    const accepted = {
      schemaVersion: 1 as const,
      disposition: "created" as const,
      assessmentId,
      runId,
      installationId: "1234",
      repository: common.repository,
      pullRequestNumber: 7,
      headSha,
      isCurrent: true,
      checkRunId: null,
    }
    expect(githubAssessmentEnqueueResultSchema.parse(accepted).runId).toBe(
      runId
    )
    expect(
      githubAssessmentEnqueueResultSchema.safeParse({
        ...accepted,
        disposition: "stale",
      }).success
    ).toBe(false)
  })

  it("binds safe details URLs and redacted summaries to an assessment", () => {
    const request = {
      schemaVersion: 1 as const,
      assessmentId,
      headSha,
      detailsUrl: `https://sentinel.example/assessments/${assessmentId}`,
      lifecycle: {
        state: "completed" as const,
        outcome: "predicted_risk" as const,
        title: "Sentinel assessment complete",
        summary: "Predicted impact requires review.",
        completedAt: "2026-09-08T12:01:00.000Z",
      },
    }
    expect(githubCheckRequestSchema.parse(request)).toEqual(request)
    expect(
      githubCheckRequestSchema.safeParse({
        ...request,
        detailsUrl: `https://sentinel.example/assessments/${runId}`,
      }).success
    ).toBe(false)
    expect(
      githubCheckRequestSchema.safeParse({
        ...request,
        lifecycle: {
          ...request.lifecycle,
          summary: "authorization: Bearer exposed-value",
        },
      }).success
    ).toBe(false)
  })

  it("locks registration to read source/PR and write checks only", () => {
    expect(SENTINEL_GITHUB_APP_REGISTRATION).toEqual({
      permissions: {
        contents: "read",
        pullRequests: "read",
        checks: "write",
      },
      events: ["pull_request"],
    })
    expect(
      githubAppRegistrationSchema.safeParse({
        permissions: {
          contents: "write",
          pullRequests: "read",
          checks: "write",
          issues: "write",
        },
        events: ["pull_request", "issues"],
      }).success
    ).toBe(false)
  })
})
