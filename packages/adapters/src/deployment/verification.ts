import { z } from "zod"

import {
  deploymentProviderProofSchema,
  deploymentValidationRequestSchema,
  deploymentValidationResultSchema,
  type DeploymentProvider,
  type DeploymentProviderProof,
  type DeploymentRegistration,
  type DeploymentValidationRequest,
  type DeploymentValidationResult,
} from "@sentinel/contracts"

import type {
  ApplicationReadinessProbe,
  UrlReadinessProbe,
} from "../onboarding/compatibility.ts"

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

const sharedActionByReason: Record<
  Exclude<
    DeploymentValidationResult["reason"],
    | "deployment_ready"
    | "provider_unreachable"
    | "provider_identity_unknown"
    | "provider_deploy_not_live"
    | "deployment_service_mismatch"
    | "deployment_commit_mismatch"
    | "deployment_url_mismatch"
  >,
  string
> = {
  deployment_expired:
    "Register a current deployment of the expected commit and retry verification",
  deployment_cleanup_overdue:
    "Remove the expired disposable environment before registering a replacement",
  deployment_role_mismatch:
    "Register the expected baseline or PR-head deployment role for this verification purpose",
  deployment_repository_mismatch:
    "Register a deployment built from the assessed repository",
  deployment_compatibility_mismatch:
    "Re-register after aligning application, authentication, test-data, and browser policy configuration",
  deployment_readiness_failed:
    "Restore the registered deployment health endpoint and approved public origin",
  credential_authorization_failed:
    "Restore scoped test credential authorization without exposing credentials to the preview service",
}

function providerLabel(provider: DeploymentProvider): string {
  return provider === "railway" ? "Railway" : "Render"
}

function actionForReason(
  reason: Exclude<DeploymentValidationResult["reason"], "deployment_ready">,
  provider: DeploymentProvider
): string {
  const label = providerLabel(provider)
  switch (reason) {
    case "provider_unreachable":
      return `Restore ${label} API access and retry deployment identity validation`
    case "provider_identity_unknown":
      return `Register a ${label} service and deploy with inspectable repository and commit metadata`
    case "provider_deploy_not_live":
      return `Wait for the registered ${label} deploy to become live or register a successful deploy`
    case "deployment_service_mismatch":
      return `Register the exact ${label} project, service, environment, and deploy intended for this run`
    case "deployment_commit_mismatch":
      return `Deploy the expected immutable commit and register its ${label} deploy identifier`
    case "deployment_url_mismatch":
      return `Use a public URL owned by the attested ${label} service environment`
    default:
      return sharedActionByReason[reason]
  }
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
    actionRequired: actionForReason(
      input.reason,
      input.request.registration.provider.kind
    ),
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

    const providerIdentityMismatch =
      proof.provider !== registration.provider.kind ||
      proof.serviceId !== registration.provider.serviceId ||
      proof.deployId !== registration.provider.deployId ||
      (proof.provider === "railway" &&
        registration.provider.kind === "railway" &&
        (proof.projectId !== registration.provider.projectId ||
          proof.environmentId !== registration.provider.environmentId))
    if (providerIdentityMismatch) {
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
  const slugParts = value
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean)
  if (!value.includes("://") && slugParts.length === 2) {
    return {
      host: "github.com",
      owner: slugParts[0]!,
      name: slugParts[1]!,
    }
  }
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
    if (registration.provider.kind !== "render") {
      throw new DeploymentAttestationError(
        "provider_identity_unknown",
        "Render attestation requires a Render registration"
      )
    }
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

const railwayDeploymentStatusSchema = z.enum([
  "BUILDING",
  "CRASHED",
  "DEPLOYING",
  "FAILED",
  "INITIALIZING",
  "NEEDS_APPROVAL",
  "QUEUED",
  "REMOVED",
  "REMOVING",
  "SKIPPED",
  "SLEEPING",
  "SUCCESS",
  "WAITING",
])

const railwayDeploymentSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  serviceId: z.string().min(1),
  environmentId: z.string().min(1),
  status: railwayDeploymentStatusSchema,
  staticUrl: z.string().nullish(),
  url: z.string().nullish(),
  meta: z.record(z.string(), z.unknown()).nullish(),
})

const railwayServiceInstanceSchema = z.object({
  serviceId: z.string().min(1),
  environmentId: z.string().min(1),
  source: z
    .object({
      repo: z.string().nullish(),
    })
    .nullish(),
  domains: z.object({
    serviceDomains: z.array(z.object({ domain: z.string().min(1) })),
    customDomains: z.array(z.object({ domain: z.string().min(1) })),
  }),
})

const railwayGraphqlEnvelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(
      z.object({
        message: z.string(),
        extensions: z.object({ code: z.string().optional() }).optional(),
      })
    )
    .optional(),
})

const railwayDeploymentDataSchema = z.object({
  deployment: railwayDeploymentSchema.nullable(),
})

const railwayServiceInstanceDataSchema = z.object({
  serviceInstance: railwayServiceInstanceSchema.nullable(),
})

const RAILWAY_DEPLOYMENT_QUERY = `
  query SentinelRailwayDeployment($id: String!) {
    deployment(id: $id) {
      id
      projectId
      serviceId
      environmentId
      status
      staticUrl
      url
      meta
    }
  }
`

const RAILWAY_SERVICE_INSTANCE_QUERY = `
  query SentinelRailwayServiceInstance(
    $serviceId: String!
    $environmentId: String!
  ) {
    serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
      serviceId
      environmentId
      source { repo }
      domains {
        serviceDomains { domain }
        customDomains { domain }
      }
    }
  }
`

function normalizeRailwayStatus(
  status: z.infer<typeof railwayDeploymentStatusSchema>
): DeploymentProviderProof["status"] {
  switch (status) {
    case "SUCCESS":
      return "live"
    case "BUILDING":
      return "build_in_progress"
    case "DEPLOYING":
    case "INITIALIZING":
      return "update_in_progress"
    case "NEEDS_APPROVAL":
    case "WAITING":
    case "QUEUED":
      return "queued"
    case "FAILED":
      return "build_failed"
    case "CRASHED":
      return "update_failed"
    case "REMOVED":
    case "REMOVING":
    case "SLEEPING":
      return "deactivated"
    case "SKIPPED":
      return "canceled"
  }
}

function publicUrlForRailwayDomains(
  registeredUrl: string,
  domains: readonly string[]
): string | undefined {
  const registeredOrigin = new URL(registeredUrl).origin
  const origins: string[] = []
  for (const value of domains) {
    const domain = value.trim().toLowerCase()
    if (domain.length === 0 || domain.includes("/")) continue
    try {
      origins.push(new URL(`https://${domain}`).origin)
    } catch {
      continue
    }
  }
  if (origins.includes(registeredOrigin)) return registeredOrigin
  return origins[0]
}

export class RailwayApiDeploymentAttestor implements DeploymentAttestor {
  private readonly baseUrl: URL
  private readonly now: () => Date

  constructor(
    private readonly options: {
      readonly token: string
      readonly tokenType?: "bearer" | "project"
      readonly fetch?: typeof fetch
      readonly baseUrl?: string
      readonly now?: () => Date
    }
  ) {
    if (options.token.trim().length === 0) {
      throw new Error("Railway API token is required")
    }
    this.baseUrl = new URL(
      options.baseUrl ?? "https://backboard.railway.com/graphql/v2"
    )
    this.now = options.now ?? (() => new Date())
  }

  private async query(
    query: string,
    variables: Readonly<Record<string, string>>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const token = this.options.token
    const authentication =
      this.options.tokenType === "project"
        ? { "Project-Access-Token": token }
        : { Authorization: `Bearer ${token}` }
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(this.baseUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...authentication,
        },
        body: JSON.stringify({ query, variables }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch {
      throw new DeploymentAttestationError(
        "provider_unreachable",
        "Railway API request failed"
      )
    }
    if (!response.ok) {
      throw new DeploymentAttestationError(
        response.status === 404
          ? "provider_identity_unknown"
          : "provider_unreachable",
        "Railway API did not return the registered resource"
      )
    }

    let value: unknown
    try {
      value = await response.json()
    } catch {
      throw new DeploymentAttestationError(
        "provider_identity_unknown",
        "Railway API response was not valid JSON"
      )
    }
    const envelope = railwayGraphqlEnvelopeSchema.safeParse(value)
    if (!envelope.success) {
      throw new DeploymentAttestationError(
        "provider_identity_unknown",
        "Railway API response omitted the GraphQL envelope"
      )
    }
    const errors = envelope.data.errors ?? []
    if (errors.length > 0) {
      const unknown = errors.some(
        (error) =>
          error.extensions?.code === "NOT_FOUND" ||
          /\bnot found\b/i.test(error.message)
      )
      throw new DeploymentAttestationError(
        unknown ? "provider_identity_unknown" : "provider_unreachable",
        "Railway API rejected the attestation query"
      )
    }
    if (envelope.data.data === undefined || envelope.data.data === null) {
      throw new DeploymentAttestationError(
        "provider_identity_unknown",
        "Railway API returned no attestation data"
      )
    }
    return envelope.data.data
  }

  async attest(
    registration: DeploymentRegistration,
    signal?: AbortSignal
  ): Promise<DeploymentProviderProof> {
    if (registration.provider.kind !== "railway") {
      throw new DeploymentAttestationError(
        "provider_identity_unknown",
        "Railway attestation requires a Railway registration"
      )
    }

    const deploymentData = railwayDeploymentDataSchema.safeParse(
      await this.query(
        RAILWAY_DEPLOYMENT_QUERY,
        { id: registration.provider.deployId },
        signal
      )
    )
    if (!deploymentData.success || deploymentData.data.deployment === null) {
      throw new DeploymentAttestationError(
        "provider_identity_unknown",
        "Railway API response omitted the registered deployment"
      )
    }
    const deployment = deploymentData.data.deployment
    const instanceData = railwayServiceInstanceDataSchema.safeParse(
      await this.query(
        RAILWAY_SERVICE_INSTANCE_QUERY,
        {
          serviceId: deployment.serviceId,
          environmentId: deployment.environmentId,
        },
        signal
      )
    )
    if (!instanceData.success || instanceData.data.serviceInstance === null) {
      throw new DeploymentAttestationError(
        "provider_identity_unknown",
        "Railway API response omitted the deployment service instance"
      )
    }
    const instance = instanceData.data.serviceInstance
    if (
      instance.serviceId !== deployment.serviceId ||
      instance.environmentId !== deployment.environmentId
    ) {
      throw new DeploymentAttestationError(
        "provider_identity_unknown",
        "Railway service instance did not match the deployment identity"
      )
    }
    const meta = deployment.meta ?? {}
    const commitSha =
      typeof meta["commitHash"] === "string" ? meta["commitHash"] : undefined
    const repository = parseGitHubRepository(instance.source?.repo ?? undefined)
    const publicUrl = publicUrlForRailwayDomains(registration.publicUrl, [
      ...instance.domains.serviceDomains.map(({ domain }) => domain),
      ...instance.domains.customDomains.map(({ domain }) => domain),
    ])

    return deploymentProviderProofSchema.parse({
      schemaVersion: 1,
      provider: "railway",
      projectId: deployment.projectId,
      environmentId: deployment.environmentId,
      serviceId: deployment.serviceId,
      deployId: deployment.id,
      ...(repository === undefined ? {} : { repository }),
      ...(commitSha === undefined ? {} : { commitSha }),
      ...(publicUrl === undefined ? {} : { publicUrl }),
      status: normalizeRailwayStatus(deployment.status),
      observedAt: this.now().toISOString(),
    })
  }
}

export class PublicDeploymentReadinessProbe implements DeploymentReadinessProbe {
  constructor(
    private readonly probe: UrlReadinessProbe,
    private readonly options: {
      readonly application?: ApplicationReadinessProbe
    } = {}
  ) {}

  async check(registration: DeploymentRegistration, signal?: AbortSignal) {
    const configured = registration.readinessProbe
    const path = configured?.path ?? registration.healthPath
    const readinessUrl = new URL(path, registration.publicUrl).toString()
    if (configured?.kind === "application") {
      if (this.options.application === undefined) {
        throw new Error("Application readiness probe is not configured")
      }
      const result = await this.options.application.check(
        readinessUrl,
        registration.compatibility.allowedOrigins,
        signal
      )
      return { finalUrl: result.finalUrl, status: 200 }
    }

    const result = await this.probe.check(readinessUrl, signal)
    if (configured?.kind === "api_json") {
      if (!configured.expectedStatuses.includes(result.status)) {
        throw new Error("Application API returned an unexpected status")
      }
      if (
        !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(
          result.contentType
        )
      ) {
        throw new Error("Application API did not return JSON")
      }
    }
    return { finalUrl: result.finalUrl, status: result.status }
  }
}
