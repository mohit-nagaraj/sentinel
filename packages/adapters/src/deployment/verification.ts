import { z } from "zod"

import {
  deploymentProviderProofSchema,
  deploymentValidationRequestSchema,
  deploymentValidationResultSchema,
  type DeploymentProviderProof,
  type DeploymentRegistration,
  type DeploymentValidationRequest,
  type DeploymentValidationResult,
} from "@sentinel/contracts"

import type { UrlReadinessProbe } from "../onboarding/compatibility.ts"

export interface DeploymentAttestor {
  attest(
    registration: DeploymentRegistration,
    signal?: AbortSignal
  ): Promise<DeploymentProviderProof>
}

export interface DeploymentReadinessProbe {
  check(
    registration: DeploymentRegistration,
    signal?: AbortSignal
  ): Promise<{ readonly finalUrl: string; readonly status: number }>
}

export interface VerificationCredentialGate {
  authorize(
    registration: DeploymentRegistration,
    signal?: AbortSignal
  ): Promise<void>
}

export class DeploymentAttestationError extends Error {
  constructor(
    readonly code: "provider_unreachable" | "provider_identity_unknown",
    message: string
  ) {
    super(message)
    this.name = "DeploymentAttestationError"
  }
}

export interface DeploymentValidationServiceOptions {
  readonly attestor: DeploymentAttestor
  readonly readiness: DeploymentReadinessProbe
  readonly credentials?: VerificationCredentialGate
  readonly now?: () => Date
}

const actionByReason: Record<
  Exclude<DeploymentValidationResult["reason"], "deployment_ready">,
  string
> = {
  deployment_expired:
    "Register a current deployment of the expected commit and retry verification",
  deployment_cleanup_overdue:
    "Remove the expired disposable environment before registering a replacement",
  provider_unreachable:
    "Restore Render API access and retry deployment identity validation",
  provider_identity_unknown:
    "Register a Render service and deploy with inspectable repository and commit metadata",
  provider_deploy_not_live:
    "Wait for the registered Render deploy to become live or register a successful deploy",
  deployment_role_mismatch:
    "Register the expected baseline or PR-head deployment role for this verification purpose",
  deployment_service_mismatch:
    "Register the exact Render service and deploy pair intended for this run",
  deployment_commit_mismatch:
    "Deploy the expected immutable commit and register its Render deploy identifier",
  deployment_repository_mismatch:
    "Register a deployment built from the assessed repository",
  deployment_url_mismatch:
    "Use the public URL owned by the attested Render service",
  deployment_compatibility_mismatch:
    "Re-register after aligning application, authentication, test-data, and browser policy configuration",
  deployment_readiness_failed:
    "Restore the registered deployment health endpoint and approved public origin",
  credential_authorization_failed:
    "Restore scoped test credential authorization without exposing credentials to the preview service",
}

function sameRepository(
  left: DeploymentValidationRequest["expectedRepository"],
  right: DeploymentValidationRequest["expectedRepository"]
): boolean {
  return (
    left.host === right.host &&
    left.owner === right.owner &&
    left.name === right.name
  )
}

function sameOrigin(left: string, right: string): boolean {
  return new URL(left).origin === new URL(right).origin
}

function failureResult(input: {
  readonly request: DeploymentValidationRequest
  readonly identityState: DeploymentValidationResult["identityState"]
  readonly trustState: DeploymentValidationResult["trustState"]
  readonly readinessState?: DeploymentValidationResult["readinessState"]
  readonly reason: Exclude<
    DeploymentValidationResult["reason"],
    "deployment_ready"
  >
  readonly proof?: DeploymentProviderProof
  readonly now: Date
}): DeploymentValidationResult {
  return deploymentValidationResultSchema.parse({
    schemaVersion: 1,
    applicationId: input.request.applicationId,
    registrationId: input.request.registration.id,
    purpose: input.request.purpose,
    ...(input.request.assessmentId === undefined
      ? {}
      : { assessmentId: input.request.assessmentId }),
    ...(input.request.pullRequestId === undefined
      ? {}
      : { pullRequestId: input.request.pullRequestId }),
    expectedCommitSha: input.request.expectedCommitSha,
    identityState: input.identityState,
    trustState: input.trustState,
    readinessState: input.readinessState ?? "not_checked",
    browserAccessAllowed: false,
    credentialAccessAllowed: false,
    reason: input.reason,
    actionRequired: actionByReason[input.reason],
    ...(input.proof === undefined ? {} : { proof: input.proof }),
    validatedAt: input.now.toISOString(),
  })
}

export class DeploymentValidationService {
  private readonly now: () => Date

  constructor(private readonly options: DeploymentValidationServiceOptions) {
    this.now = options.now ?? (() => new Date())
  }

  async validate(
    input: DeploymentValidationRequest,
    signal?: AbortSignal
  ): Promise<DeploymentValidationResult> {
    const request = deploymentValidationRequestSchema.parse(input)
    const now = this.now()
    const registration = request.registration

    if (now.getTime() >= Date.parse(registration.cleanupBy)) {
      return failureResult({
        request,
        identityState: "stale",
        trustState: "stale",
        reason: "deployment_cleanup_overdue",
        now,
      })
    }
    if (now.getTime() >= Date.parse(registration.expiresAt)) {
      return failureResult({
        request,
        identityState: "stale",
        trustState: "stale",
        reason: "deployment_expired",
        now,
      })
    }

    const expectedRole =
      request.purpose === "pr_head_verification" ? "pr_head" : "baseline"
    if (registration.role !== expectedRole) {
      return failureResult({
        request,
        identityState: "mismatch",
        trustState: "untrusted",
        reason: "deployment_role_mismatch",
        now,
      })
    }

    let proof: DeploymentProviderProof
    try {
      proof = deploymentProviderProofSchema.parse(
        await this.options.attestor.attest(registration, signal)
      )
    } catch (error) {
      const code =
        error instanceof DeploymentAttestationError
          ? error.code
          : "provider_unreachable"
      return failureResult({
        request,
        identityState:
          code === "provider_identity_unknown" ? "unknown" : "unreachable",
        trustState:
          code === "provider_identity_unknown" ? "unknown" : "unreachable",
        reason: code,
        now,
      })
    }

    if (
      proof.serviceId !== registration.provider.serviceId ||
      proof.deployId !== registration.provider.deployId
    ) {
      return failureResult({
        request,
        identityState: "mismatch",
        trustState: "untrusted",
        reason: "deployment_service_mismatch",
        proof,
        now,
      })
    }
    if (proof.status !== "live") {
      const pending = [
        "created",
        "queued",
        "build_in_progress",
        "pre_deploy_in_progress",
        "update_in_progress",
      ].includes(proof.status)
      return failureResult({
        request,
        identityState: pending ? "unknown" : "unreachable",
        trustState: pending ? "unknown" : "unreachable",
        reason: "provider_deploy_not_live",
        proof,
        now,
      })
    }
    if (
      proof.repository === undefined ||
      proof.commitSha === undefined ||
      proof.publicUrl === undefined
    ) {
      return failureResult({
        request,
        identityState: "unknown",
        trustState: "unknown",
        reason: "provider_identity_unknown",
        proof,
        now,
      })
    }
    if (
      !sameRepository(proof.repository, registration.repository) ||
      !sameRepository(proof.repository, request.expectedRepository)
    ) {
      return failureResult({
        request,
        identityState: "mismatch",
        trustState: "untrusted",
        reason: "deployment_repository_mismatch",
        proof,
        now,
      })
    }
    if (
      proof.commitSha !== registration.commitSha ||
      proof.commitSha !== request.expectedCommitSha
    ) {
      return failureResult({
        request,
        identityState: "mismatch",
        trustState: "untrusted",
        reason: "deployment_commit_mismatch",
        proof,
        now,
      })
    }
    if (!sameOrigin(proof.publicUrl, registration.publicUrl)) {
      return failureResult({
        request,
        identityState: "mismatch",
        trustState: "untrusted",
        reason: "deployment_url_mismatch",
        proof,
        now,
      })
    }
    if (
      registration.applicationId !== request.applicationId ||
      registration.compatibility.fingerprint !==
        request.expectedCompatibilityFingerprint
    ) {
      return failureResult({
        request,
        identityState: "exact",
        trustState: "untrusted",
        reason: "deployment_compatibility_mismatch",
        proof,
        now,
      })
    }

    try {
      const readiness = await this.options.readiness.check(registration, signal)
      if (
        readiness.status < 200 ||
        readiness.status >= 400 ||
        !sameOrigin(readiness.finalUrl, registration.publicUrl)
      ) {
        throw new Error("Deployment readiness did not remain on its origin")
      }
    } catch {
      return failureResult({
        request,
        identityState: "exact",
        trustState: "unreachable",
        readinessState: "failed",
        reason: "deployment_readiness_failed",
        proof,
        now,
      })
    }

    try {
      if (registration.compatibility.authenticationReferences.length > 0) {
        if (this.options.credentials === undefined) {
          throw new Error("Credential authorization is not configured")
        }
        await this.options.credentials.authorize(registration, signal)
      }
    } catch {
      return failureResult({
        request,
        identityState: "exact",
        trustState: "untrusted",
        readinessState: "ready",
        reason: "credential_authorization_failed",
        proof,
        now,
      })
    }

    return deploymentValidationResultSchema.parse({
      schemaVersion: 1,
      applicationId: request.applicationId,
      registrationId: registration.id,
      purpose: request.purpose,
      ...(request.assessmentId === undefined
        ? {}
        : { assessmentId: request.assessmentId }),
      ...(request.pullRequestId === undefined
        ? {}
        : { pullRequestId: request.pullRequestId }),
      expectedCommitSha: request.expectedCommitSha,
      identityState: "exact",
      trustState: "trusted",
      readinessState: "ready",
      browserAccessAllowed: true,
      credentialAccessAllowed: true,
      reason: "deployment_ready",
      proof,
      validatedAt: now.toISOString(),
    })
  }
}

const renderServiceSchema = z.object({
  id: z.string().min(1),
  repo: z.string().optional(),
  serviceDetails: z.object({ url: z.string().optional() }).optional(),
})

const renderDeploySchema = z.object({
  id: z.string().min(1),
  commit: z.object({ id: z.string().optional() }).optional(),
  status: z.string(),
})

function parseGitHubRepository(value: string | undefined) {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    const parts = url.pathname
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean)
    if (url.hostname !== "github.com" || parts.length !== 2) return undefined
    return { host: "github.com", owner: parts[0]!, name: parts[1]! }
  } catch {
    return undefined
  }
}

export class RenderApiDeploymentAttestor implements DeploymentAttestor {
  private readonly baseUrl: URL
  private readonly now: () => Date

  constructor(
    private readonly options: {
      readonly apiKey: string
      readonly fetch?: typeof fetch
      readonly baseUrl?: string
      readonly now?: () => Date
    }
  ) {
    if (options.apiKey.trim().length === 0) {
      throw new Error("Render API key is required")
    }
    this.baseUrl = new URL(options.baseUrl ?? "https://api.render.com/v1/")
    this.now = options.now ?? (() => new Date())
  }

  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(
        new URL(path, this.baseUrl),
        {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.options.apiKey}`,
          },
          ...(signal === undefined ? {} : { signal }),
        }
      )
    } catch {
      throw new DeploymentAttestationError(
        "provider_unreachable",
        "Render API request failed"
      )
    }
    if (!response.ok) {
      throw new DeploymentAttestationError(
        response.status === 404
          ? "provider_identity_unknown"
          : "provider_unreachable",
        "Render API did not return the registered resource"
      )
    }
    try {
      return await response.json()
    } catch {
      throw new DeploymentAttestationError(
        "provider_identity_unknown",
        "Render API response was not valid JSON"
      )
    }
  }

  async attest(
    registration: DeploymentRegistration,
    signal?: AbortSignal
  ): Promise<DeploymentProviderProof> {
    const serviceId = encodeURIComponent(registration.provider.serviceId)
    const deployId = encodeURIComponent(registration.provider.deployId)
    const [serviceValue, deployValue] = await Promise.all([
      this.get(`services/${serviceId}`, signal),
      this.get(`services/${serviceId}/deploys/${deployId}`, signal),
    ])
    const service = renderServiceSchema.safeParse(serviceValue)
    const deploy = renderDeploySchema.safeParse(deployValue)
    if (!service.success || !deploy.success) {
      throw new DeploymentAttestationError(
        "provider_identity_unknown",
        "Render API response omitted required identity fields"
      )
    }
    const status = z
      .enum([
        "created",
        "queued",
        "build_in_progress",
        "pre_deploy_in_progress",
        "update_in_progress",
        "live",
        "deactivated",
        "build_failed",
        "pre_deploy_failed",
        "update_failed",
        "canceled",
      ])
      .safeParse(deploy.data.status)
    if (!status.success) {
      throw new DeploymentAttestationError(
        "provider_identity_unknown",
        "Render deploy status is unknown"
      )
    }
    const repository = parseGitHubRepository(service.data.repo)
    return deploymentProviderProofSchema.parse({
      schemaVersion: 1,
      provider: "render",
      serviceId: service.data.id,
      deployId: deploy.data.id,
      ...(repository === undefined ? {} : { repository }),
      ...(deploy.data.commit?.id === undefined
        ? {}
        : { commitSha: deploy.data.commit.id }),
      ...(service.data.serviceDetails?.url === undefined
        ? {}
        : { publicUrl: service.data.serviceDetails.url }),
      status: status.data,
      observedAt: this.now().toISOString(),
    })
  }
}

export class PublicDeploymentReadinessProbe implements DeploymentReadinessProbe {
  constructor(private readonly probe: UrlReadinessProbe) {}

  async check(registration: DeploymentRegistration, signal?: AbortSignal) {
    const healthUrl = new URL(
      registration.healthPath,
      registration.publicUrl
    ).toString()
    const result = await this.probe.check(healthUrl, signal)
    return { finalUrl: result.finalUrl, status: result.status }
  }
}
