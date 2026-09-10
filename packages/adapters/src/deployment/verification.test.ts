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
  PublicDeploymentReadinessProbe,
  RailwayApiDeploymentAttestor,
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

function railwayRegistration(): DeploymentRegistration {
  return deploymentRegistrationSchema.parse({
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
      projectId: "project-head-42",
      environmentId: "environment-head-42",
      serviceId: "service-head-42",
      deployId: "deployment-head-42",
    },
    compatibility: {
      ...registration().compatibility,
      allowedOrigins: ["https://hi-events-pr-42.up.railway.app"],
    },
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

function railwayProof(
  overrides: Partial<
    Extract<DeploymentProviderProof, { readonly provider: "railway" }>
  > = {}
): DeploymentProviderProof {
  return deploymentProviderProofSchema.parse({
    schemaVersion: 1,
    provider: "railway",
    projectId: "project-head-42",
    environmentId: "environment-head-42",
    serviceId: "service-head-42",
    deployId: "deployment-head-42",
    repository: {
      host: "github.com",
      owner: "hieventsdev",
      name: "hi.events",
    },
    commitSha: headSha,
    publicUrl: "https://hi-events-pr-42.up.railway.app",
    status: "live",
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

  it("accepts a trusted baseline-role deployment for post-deployment refresh", async () => {
    const baseline = registration({ role: "baseline" })
    const current = request(baseline)
    const {
      assessmentId: _assessmentId,
      pullRequestId: _pullRequestId,
      purpose: _purpose,
      ...shared
    } = current
    void _assessmentId
    void _pullRequestId
    void _purpose
    const result = await service({}).validate(
      deploymentValidationRequestSchema.parse({
        ...shared,
        purpose: "post_deployment_refresh",
      })
    )

    expect(result).toMatchObject({
      purpose: "post_deployment_refresh",
      identityState: "exact",
      trustState: "trusted",
      readinessState: "ready",
      reason: "deployment_ready",
    })
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

  it("rejects a Railway deployment from a different project or environment", async () => {
    const railway = railwayRegistration()
    const result = await service({
      proof: railwayProof({ environmentId: "environment-other" }),
    }).validate(request(railway))

    expect(result).toMatchObject({
      identityState: "mismatch",
      trustState: "untrusted",
      reason: "deployment_service_mismatch",
      browserAccessAllowed: false,
      credentialAccessAllowed: false,
    })
    expect(result.actionRequired).toContain("Railway")
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

describe("RailwayApiDeploymentAttestor", () => {
  it("attests exact Railway project, service, environment, commit, repository, and domain evidence", async () => {
    const fetchMock = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          readonly query: string
          readonly variables: Record<string, string>
        }
        const data = request.query.includes("SentinelRailwayDeployment")
          ? {
              deployment: {
                id: "deployment-head-42",
                projectId: "project-head-42",
                serviceId: "service-head-42",
                environmentId: "environment-head-42",
                status: "SUCCESS",
                staticUrl: "hi-events-pr-42.up.railway.app",
                url: null,
                meta: { commitHash: headSha, branch: "pr-42" },
              },
            }
          : {
              serviceInstance: {
                serviceId: "service-head-42",
                environmentId: "environment-head-42",
                source: { repo: "HiEventsDev/Hi.Events" },
                domains: {
                  serviceDomains: [
                    { domain: "hi-events-pr-42.up.railway.app" },
                  ],
                  customDomains: [],
                },
              },
            }
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
    )
    const attestor = new RailwayApiDeploymentAttestor({
      token: "railway-test-token",
      fetch: fetchMock as typeof fetch,
      now: () => new Date("2026-09-09T10:00:00.000Z"),
    })

    await expect(attestor.attest(railwayRegistration())).resolves.toMatchObject(
      {
        provider: "railway",
        projectId: "project-head-42",
        environmentId: "environment-head-42",
        serviceId: "service-head-42",
        deployId: "deployment-head-42",
        commitSha: headSha,
        repository: {
          host: "github.com",
          owner: "hieventsdev",
          name: "hi.events",
        },
        publicUrl: "https://hi-events-pr-42.up.railway.app/",
        status: "live",
      }
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.method).toBe("POST")
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer railway-test-token",
        "Content-Type": "application/json",
      })
    }
  })

  it("uses project-token auth and fails closed on GraphQL identity errors", async () => {
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        void input
        void init
        return Response.json({
          errors: [
            {
              message: "Deployment not found",
              extensions: { code: "NOT_FOUND" },
            },
          ],
          data: null,
        })
      }
    )
    const attestor = new RailwayApiDeploymentAttestor({
      token: "railway-project-token",
      tokenType: "project",
      fetch: fetchMock as typeof fetch,
    })

    await expect(attestor.attest(railwayRegistration())).rejects.toMatchObject({
      code: "provider_identity_unknown",
    })
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "Project-Access-Token": "railway-project-token",
    })
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      "Authorization"
    )
  })
})

describe("PublicDeploymentReadinessProbe", () => {
  it("probes the configured JSON API instead of the static Railway uptime path", async () => {
    const urls: string[] = []
    const readiness = new PublicDeploymentReadinessProbe({
      check: async (url) => {
        urls.push(url)
        return {
          finalUrl: url,
          status: 200,
          contentType: "application/health+json; charset=utf-8",
        }
      },
    })

    await expect(readiness.check(railwayRegistration())).resolves.toEqual({
      finalUrl: "https://hi-events-pr-42.up.railway.app/api/health",
      status: 200,
    })
    expect(urls).toEqual(["https://hi-events-pr-42.up.railway.app/api/health"])
  })

  it("supports a browser application probe and rejects non-JSON API responses", async () => {
    const applicationChecks: string[] = []
    const appRegistration = deploymentRegistrationSchema.parse({
      ...railwayRegistration(),
      readinessProbe: { kind: "application", path: "/events/demo" },
    })
    const readiness = new PublicDeploymentReadinessProbe(
      {
        check: async (url) => ({
          finalUrl: url,
          status: 200,
          contentType: "text/html",
        }),
      },
      {
        application: {
          check: async (url, origins) => {
            applicationChecks.push(url)
            expect(origins).toEqual(["https://hi-events-pr-42.up.railway.app/"])
            return { finalUrl: url, title: "Hi.Events" }
          },
        },
      }
    )

    await expect(readiness.check(appRegistration)).resolves.toEqual({
      finalUrl: "https://hi-events-pr-42.up.railway.app/events/demo",
      status: 200,
    })
    expect(applicationChecks).toEqual([
      "https://hi-events-pr-42.up.railway.app/events/demo",
    ])
    await expect(readiness.check(railwayRegistration())).rejects.toThrow(
      "did not return JSON"
    )
  })
})
