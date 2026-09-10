import { describe, expect, it } from "vitest"

import {
  deploymentRegistrationSchema,
  deploymentProviderProofSchema,
  deploymentValidationResultSchema,
  verificationPlanSchema,
} from "./deployment-verification.ts"

const applicationId = `application:v1:${"a".repeat(64)}`
const contentId = `sha256:${"b".repeat(64)}`
const commitSha = "c".repeat(40)

function registration() {
  return {
    schemaVersion: 1,
    id: contentId,
    policyVersion: "deployment-identity-policy-v1",
    applicationId,
    repository: {
      host: "github.com",
      owner: "hieventsdev",
      name: "hi.events",
    },
    role: "pr_head",
    commitSha,
    publicUrl: "https://preview.onrender.com",
    healthPath: "/health",
    provider: { kind: "render", serviceId: "srv-1", deployId: "dep-1" },
    compatibility: {
      fingerprint: `sha256:${"d".repeat(64)}`,
      authenticationRevision: 0,
      authenticationReferences: [],
      allowedOrigins: ["https://preview.onrender.com"],
      policyFingerprint: `sha256:${"e".repeat(64)}`,
    },
    registeredAt: "2026-09-09T09:00:00.000Z",
    expiresAt: "2026-09-10T09:00:00.000Z",
    cleanupBy: "2026-09-10T10:00:00.000Z",
  }
}

describe("deployment verification contracts", () => {
  it("requires bounded expiry, cleanup, and an allowlisted deployment origin", () => {
    expect(deploymentRegistrationSchema.safeParse(registration()).success).toBe(
      true
    )
    expect(
      deploymentRegistrationSchema.safeParse({
        ...registration(),
        cleanupBy: "2026-09-10T08:00:00.000Z",
      }).success
    ).toBe(false)
    expect(
      deploymentRegistrationSchema.safeParse({
        ...registration(),
        compatibility: {
          ...registration().compatibility,
          allowedOrigins: ["https://other.onrender.com"],
        },
      }).success
    ).toBe(false)
  })

  it("requires Railway project/environment identity and a real application or API probe", () => {
    const railway = {
      ...registration(),
      publicUrl: "https://hi-events-pr-42.up.railway.app",
      healthPath: "/up",
      readinessProbe: {
        kind: "api_json",
        path: "/api/health",
        expectedStatuses: [200],
      },
      provider: {
        kind: "railway",
        projectId: "project-1",
        environmentId: "environment-1",
        serviceId: "service-1",
        deployId: "deployment-1",
      },
      compatibility: {
        ...registration().compatibility,
        allowedOrigins: ["https://hi-events-pr-42.up.railway.app"],
      },
    }

    expect(deploymentRegistrationSchema.safeParse(railway).success).toBe(true)
    expect(
      deploymentRegistrationSchema.safeParse({
        ...railway,
        readinessProbe: undefined,
      }).success
    ).toBe(false)
    expect(
      deploymentRegistrationSchema.safeParse({
        ...railway,
        readinessProbe: { kind: "application", path: "/up" },
      }).success
    ).toBe(false)

    expect(
      deploymentProviderProofSchema.safeParse({
        schemaVersion: 1,
        provider: "railway",
        serviceId: "service-1",
        deployId: "deployment-1",
        status: "live",
        observedAt: "2026-09-09T10:00:00.000Z",
      }).success
    ).toBe(false)
  })

  it("rejects access flags that do not match exact trusted readiness", () => {
    const invalid = deploymentValidationResultSchema.safeParse({
      schemaVersion: 1,
      applicationId,
      registrationId: contentId,
      purpose: "pr_head_verification",
      assessmentId: "123e4567-e89b-42d3-a456-426614174001",
      pullRequestId: `pull-request:v1:${"1".repeat(64)}`,
      expectedCommitSha: commitSha,
      identityState: "mismatch",
      trustState: "untrusted",
      readinessState: "not_checked",
      browserAccessAllowed: true,
      credentialAccessAllowed: true,
      reason: "deployment_commit_mismatch",
      validatedAt: "2026-09-09T10:00:00.000Z",
    })
    expect(invalid.success).toBe(false)
  })

  it("requires PR and assessment identity for PR-head validation", () => {
    const result = deploymentValidationResultSchema.safeParse({
      schemaVersion: 1,
      applicationId,
      registrationId: contentId,
      purpose: "pr_head_verification",
      expectedCommitSha: commitSha,
      identityState: "unreachable",
      trustState: "unreachable",
      readinessState: "not_checked",
      browserAccessAllowed: false,
      credentialAccessAllowed: false,
      reason: "provider_unreachable",
      actionRequired: "Restore provider access",
      validatedAt: "2026-09-09T10:00:00.000Z",
    })
    expect(result.success).toBe(false)
  })

  it("rejects fabricated unavailable plans containing executable missions", () => {
    const parsed = verificationPlanSchema.safeParse({
      schemaVersion: 1,
      id: contentId,
      policyVersion: "verification-plan-policy-v1",
      applicationId,
      runId: "run:123e4567-e89b-42d3-a456-426614174000",
      assessmentId: "123e4567-e89b-42d3-a456-426614174001",
      blastRadiusResultId: `sha256:${"f".repeat(64)}`,
      status: "verification_unavailable",
      deployment: {
        schemaVersion: 1,
        applicationId,
        registrationId: contentId,
        purpose: "pr_head_verification",
        assessmentId: "123e4567-e89b-42d3-a456-426614174001",
        pullRequestId: `pull-request:v1:${"1".repeat(64)}`,
        expectedCommitSha: commitSha,
        identityState: "unreachable",
        trustState: "unreachable",
        readinessState: "not_checked",
        browserAccessAllowed: false,
        credentialAccessAllowed: false,
        reason: "provider_unreachable",
        actionRequired: "Restore Render API access",
        validatedAt: "2026-09-09T10:00:00.000Z",
      },
      missions: [{}],
      budget: {
        toolCalls: 0,
        contentBytes: 0,
        documentBytes: 0,
        documentPages: 0,
        documentSections: 0,
        sourceLines: 0,
        repositoryBytes: 0,
        repositoryFiles: 0,
        browserActions: 0,
        modelCalls: 0,
        modelInputTokens: 0,
        modelOutputTokens: 0,
        reconciliationRounds: 0,
        elapsedMs: 0,
      },
      exclusions: [],
      actionRequired: "Restore Render API access",
      createdAt: "2026-09-09T10:00:00.000Z",
    })
    expect(parsed.success).toBe(false)
  })
})
