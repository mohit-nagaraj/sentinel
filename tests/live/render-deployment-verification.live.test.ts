import { describe, expect, it } from "vitest"

import {
  RenderApiDeploymentAttestor,
} from "@sentinel/adapters"
import { deploymentRegistrationSchema } from "@sentinel/contracts"

const required = [
  "RENDER_API_KEY",
  "RENDER_SERVICE_ID",
  "RENDER_DEPLOY_ID",
  "RENDER_EXPECTED_COMMIT_SHA",
  "RENDER_PREVIEW_URL",
] as const
const runSmoke =
  process.env["RUN_RENDER_DEPLOYMENT_SMOKE"] === "1" &&
  required.every((key) => process.env[key] !== undefined)

describe.runIf(runSmoke)("Render deployment identity", () => {
  it("attests the configured public Hi.Events preview at the expected commit", async () => {
    const expectedCommitSha = process.env["RENDER_EXPECTED_COMMIT_SHA"]!
    const previewUrl = process.env["RENDER_PREVIEW_URL"]!
    const registration = deploymentRegistrationSchema.parse({
      schemaVersion: 1,
      id: `sha256:${"1".repeat(64)}`,
      policyVersion: "deployment-identity-policy-v1",
      applicationId: `application:v1:${"2".repeat(64)}`,
      repository: {
        host: "github.com",
        owner: process.env["RENDER_REPOSITORY_OWNER"] ?? "mohit-nagaraj",
        name: process.env["RENDER_REPOSITORY_NAME"] ?? "Hi.Events",
      },
      role: "pr_head",
      commitSha: expectedCommitSha,
      publicUrl: previewUrl,
      healthPath: process.env["RENDER_HEALTH_PATH"] ?? "/",
      provider: {
        kind: "render",
        serviceId: process.env["RENDER_SERVICE_ID"],
        deployId: process.env["RENDER_DEPLOY_ID"],
      },
      compatibility: {
        fingerprint: `sha256:${"3".repeat(64)}`,
        authenticationRevision: 0,
        authenticationReferences: [],
        allowedOrigins: [previewUrl],
        policyFingerprint: `sha256:${"4".repeat(64)}`,
      },
      registeredAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      cleanupBy: "2030-01-02T00:00:00.000Z",
    })
    const proof = await new RenderApiDeploymentAttestor({
      apiKey: process.env["RENDER_API_KEY"]!,
    }).attest(registration)

    expect(proof.status).toBe("live")
    expect(proof.commitSha).toBe(expectedCommitSha)
    expect(proof.serviceId).toBe(process.env["RENDER_SERVICE_ID"])
    expect(new URL(proof.publicUrl!).origin).toBe(new URL(previewUrl).origin)
  })
})
