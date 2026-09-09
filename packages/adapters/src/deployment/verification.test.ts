import { describe, expect, it, vi } from "vitest"

import {
  applicationIdSchema,
  commitShaSchema,
  contentHashSchema,
  deploymentProviderProofSchema,
  deploymentRegistrationSchema,
  deploymentValidationRequestSchema,
  type DeploymentProviderProof,
  type DeploymentRegistration,
} from "@sentinel/contracts"

import {
  DeploymentAttestationError,
  DeploymentValidationService,
  RenderApiDeploymentAttestor,
} from "./verification.ts"

const applicationId = applicationIdSchema.parse(
  `application:v1:${"a".repeat(64)}`
)
const registrationId = contentHashSchema.parse(`sha256:${"b".repeat(64)}`)
const compatibilityFingerprint = contentHashSchema.parse(
  `sha256:${"c".repeat(64)}`
)
const policyFingerprint = contentHashSchema.parse(`sha256:${"d".repeat(64)}`)
const headSha = commitShaSchema.parse("e".repeat(40))
const otherSha = commitShaSchema.parse("f".repeat(40))
const assessmentId = "123e4567-e89b-42d3-a456-426614174001"
const pullRequestId = `pull-request:v1:${"3".repeat(64)}`

function registration(
  overrides: Partial<DeploymentRegistration> = {}
): DeploymentRegistration {
  return deploymentRegistrationSchema.parse({
    schemaVersion: 1,
    id: registrationId,
    policyVersion: "deployment-identity-policy-v1",
    applicationId,
    repository: { host: "github.com", owner: "HiEventsDev", name: "Hi.Events" },
    role: "pr_head",
    commitSha: headSha,
    publicUrl: "https://hi-events-pr-42.onrender.com",
    healthPath: "/health",
    provider: {
      kind: "render",
      serviceId: "srv-head-42",
      deployId: "dep-head-42",
    },
    compatibility: {
      fingerprint: compatibilityFingerprint,
      authenticationRevision: 1,
      authenticationReferences: [`secret-ref:v1:${"1".repeat(64)}`],
      testDataSetupReference: "Seed isolated event fixture",
      testDataResetReference: "Reset isolated event fixture",
      allowedOrigins: ["https://hi-events-pr-42.onrender.com"],
      policyFingerprint,
    },
    registeredAt: "2026-09-09T09:00:00.000Z",
    expiresAt: "2026-09-10T09:00:00.000Z",
    cleanupBy: "2026-09-10T10:00:00.000Z",
    ...overrides,
  })
}

function proof(overrides: Partial<DeploymentProviderProof> = {}) {
  return deploymentProviderProofSchema.parse({
    schemaVersion: 1 as const,
    provider: "render" as const,
    serviceId: "srv-head-42",
    deployId: "dep-head-42",
    repository: {
      host: "github.com",
      owner: "hieventsdev",
      name: "hi.events",
    },
    commitSha: headSha,
    publicUrl: "https://hi-events-pr-42.onrender.com/",
    status: "live" as const,
    observedAt: "2026-09-09T10:00:00.000Z",
    ...overrides,
  })
}

function request(registrationValue = registration()) {
  return deploymentValidationRequestSchema.parse({
    schemaVersion: 1,
    applicationId,
    purpose: "pr_head_verification",
    assessmentId,
    pullRequestId,
    expectedRepository: {
      host: "github.com",
      owner: "HiEventsDev",
      name: "Hi.Events",
    },
    expectedCommitSha: headSha,
    expectedCompatibilityFingerprint: compatibilityFingerprint,
    registration: registrationValue,
  })
}

function service(input: {
  readonly proof?: DeploymentProviderProof
  readonly attestationError?: DeploymentAttestationError
  readonly readinessError?: Error
  readonly now?: string
  readonly events?: string[]
}) {
  const events = input.events ?? []
  return new DeploymentValidationService({
    now: () => new Date(input.now ?? "2026-09-09T10:00:00.000Z"),
    attestor: {
      attest: async () => {
        events.push("attest")
        if (input.attestationError !== undefined) {
          throw input.attestationError
        }
        return input.proof ?? proof()
      },
    },
    readiness: {
      check: async () => {
        events.push("readiness")
        if (input.readinessError !== undefined) throw input.readinessError
        return {
          finalUrl: "https://hi-events-pr-42.onrender.com/health",
          status: 200,
        }
      },
    },
    credentials: {
      authorize: async () => {
        events.push("credentials")
      },
    },
  })
}

describe("DeploymentValidationService", () => {
  it("accepts exact provider identity and releases credentials only after readiness", async () => {
    const events: string[] = []
    const result = await service({ events }).validate(request())

    expect(result).toMatchObject({
      identityState: "exact",
      trustState: "trusted",
      readinessState: "ready",
      browserAccessAllowed: true,
      credentialAccessAllowed: true,
      reason: "deployment_ready",
    })
    expect(events).toEqual(["attest", "readiness", "credentials"])
  })

  it.each([
    ["commit", proof({ commitSha: otherSha }), "deployment_commit_mismatch"],
    [
      "repository",
      proof({
        repository: {
          host: "github.com",
          owner: "someone-else",
          name: "hi.events",
        },
      }),
      "deployment_repository_mismatch",
    ],
    [
      "url",
      proof({ publicUrl: "https://other-preview.onrender.com" }),
      "deployment_url_mismatch",
    ],
  ])(
    "rejects a mismatched %s before readiness or credentials",
    async (_label, providerProof, reason) => {
      const events: string[] = []
      const result = await service({ proof: providerProof, events }).validate(
        request()
      )
      expect(result).toMatchObject({
        identityState: "mismatch",
        trustState: "untrusted",
        reason,
        browserAccessAllowed: false,
      })
      expect(events).toEqual(["attest"])
    }
  )

  it("classifies stale, unreachable, and unknown identity without credential access", async () => {
    const staleEvents: string[] = []
    const stale = await service({
      now: "2026-09-10T09:30:00.000Z",
      events: staleEvents,
    }).validate(request())
    const unreachable = await service({
      attestationError: new DeploymentAttestationError(
        "provider_unreachable",
        "offline"
      ),
    }).validate(request())
    const { commitSha: _commitSha, ...unknownProof } = proof()
    void _commitSha
    const unknown = await service({ proof: unknownProof }).validate(request())

    expect(stale).toMatchObject({
      identityState: "stale",
      trustState: "stale",
      reason: "deployment_expired",
    })
    expect(staleEvents).toEqual([])
    expect(unreachable).toMatchObject({
      identityState: "unreachable",
      trustState: "unreachable",
      reason: "provider_unreachable",
    })
    expect(unknown).toMatchObject({
      identityState: "unknown",
      trustState: "unknown",
      reason: "provider_identity_unknown",
    })
  })

  it("refuses a baseline label and a failed readiness probe before credentials", async () => {
    const baselineEvents: string[] = []
    const baseline = await service({ events: baselineEvents }).validate(
      request(registration({ role: "baseline" }))
    )
    const readinessEvents: string[] = []
    const notReady = await service({
      readinessError: new Error("503"),
      events: readinessEvents,
    }).validate(request())

    expect(baseline.reason).toBe("deployment_role_mismatch")
    expect(baselineEvents).toEqual([])
    expect(notReady).toMatchObject({
      identityState: "exact",
      readinessState: "failed",
      reason: "deployment_readiness_failed",
    })
    expect(readinessEvents).toEqual(["attest", "readiness"])
  })

  it("flags overdue cleanup and isolates concurrent head registrations", async () => {
    const overdue = await service({
      now: "2026-09-10T10:00:00.000Z",
    }).validate(request())
    const headTwo = registration({
      id: contentHashSchema.parse(`sha256:${"2".repeat(64)}`),
      commitSha: otherSha,
      provider: {
        kind: "render",
        serviceId: "srv-head-43",
        deployId: "dep-head-43",
      },
    })
    const wrongProof = proof({
      serviceId: "srv-head-42",
      deployId: "dep-head-42",
      commitSha: otherSha,
    })
    const isolated = await service({ proof: wrongProof }).validate(
      deploymentValidationRequestSchema.parse({
        ...request(headTwo),
        expectedCommitSha: otherSha,
      })
    )

    expect(overdue.reason).toBe("deployment_cleanup_overdue")
    expect(isolated.reason).toBe("deployment_service_mismatch")
  })
})

describe("RenderApiDeploymentAttestor", () => {
  it("builds proof from authenticated Render service and deploy responses", async () => {
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, _init?: RequestInit) => {
        void _init
        const url = String(input)
        return new Response(
          JSON.stringify(
            url.endsWith("/deploys/dep-head-42")
              ? { id: "dep-head-42", commit: { id: headSha }, status: "live" }
              : {
                  id: "srv-head-42",
                  repo: "https://github.com/HiEventsDev/Hi.Events.git",
                  serviceDetails: {
                    url: "https://hi-events-pr-42.onrender.com",
                  },
                }
          ),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      }
    )
    const attestor = new RenderApiDeploymentAttestor({
      apiKey: "render-test-key",
      fetch: fetchMock as typeof fetch,
      now: () => new Date("2026-09-09T10:00:00.000Z"),
    })

    const result = await attestor.attest(registration())

    expect(result).toMatchObject({
      serviceId: "srv-head-42",
      deployId: "dep-head-42",
      commitSha: headSha,
      status: "live",
      repository: {
        host: "github.com",
        owner: "hieventsdev",
        name: "hi.events",
      },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.headers).toMatchObject({
        Accept: "application/json",
        Authorization: "Bearer render-test-key",
      })
    }
  })

  it("fails closed when Render no longer knows the registered deploy", async () => {
    const attestor = new RenderApiDeploymentAttestor({
      apiKey: "render-test-key",
      fetch: vi.fn(
        async () => new Response("not found", { status: 404 })
      ) as typeof fetch,
    })
    await expect(attestor.attest(registration())).rejects.toMatchObject({
      code: "provider_identity_unknown",
    })
  })
})
