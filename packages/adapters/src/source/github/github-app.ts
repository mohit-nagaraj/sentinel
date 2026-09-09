import {
  createHmac,
  createPrivateKey,
  createSign,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"

import { Octokit } from "@octokit/rest"
import {
  githubCheckLifecycleSchema,
  githubCheckRequestSchema,
  githubCheckRunIdSchema,
  githubCheckTargetSchema,
  githubDeliveryIdSchema,
  githubManualAssessmentTriggerSchema,
  githubPullRequestActionSchema,
  githubWebhookDecisionSchema,
  publicHttpUrlSchema,
  timestampSchema,
  type GithubCheckLifecycle,
  type GithubManualAssessmentTrigger,
  type GithubWebhookDecision,
} from "@sentinel/contracts"
import { z } from "zod"

import { connectorError, redactConnectorText } from "./errors.ts"
import {
  parseGitHubPullRequest,
  parseGitHubRepository,
  sameRepository,
  type GitHubRepositoryIdentity,
} from "./normalization.ts"

export const GITHUB_API_VERSION = "2026-03-10"
export const GITHUB_CHECK_NAME = "Sentinel blast radius"
export const MAX_GITHUB_WEBHOOK_BYTES = 2 * 1_024 * 1_024

const appEnvironmentSchema = z.strictObject({
  GITHUB_APP_ID: z.string().regex(/^[1-9][0-9]{0,19}$/),
  GITHUB_APP_CLIENT_ID: z
    .string()
    .trim()
    .min(10)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  GITHUB_APP_INSTALLATION_ID: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .optional(),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().trim().min(1).max(4_096),
  GITHUB_APP_WEBHOOK_SECRET: z.string().min(32).max(4_096),
  SENTINEL_PUBLIC_BASE_URL: publicHttpUrlSchema,
})

const supportedPayloadSchema = z.looseObject({
  action: githubPullRequestActionSchema,
  installation: z.looseObject({ id: z.union([z.string(), z.number()]) }),
  repository: z.looseObject({
    id: z.union([z.string(), z.number()]),
    full_name: z.string().min(3),
  }),
  sender: z.looseObject({
    id: z.union([z.string(), z.number()]),
    login: z.string().min(1),
    type: z.string().min(1),
  }),
  pull_request: z.looseObject({
    id: z.union([z.string(), z.number()]),
    number: z.number().int().positive(),
    html_url: z.string().min(1),
    draft: z.boolean().nullable(),
    updated_at: timestampSchema,
    base: z.looseObject({
      sha: z.string(),
      repo: z.looseObject({
        id: z.union([z.string(), z.number()]),
        full_name: z.string().min(3),
      }),
    }),
    head: z.looseObject({ sha: z.string() }),
  }),
})

const pullRequestResponseSchema = z.looseObject({
  id: z.union([z.string(), z.number()]),
  number: z.number().int().positive(),
  html_url: z.string().min(1),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().nullable(),
  updated_at: timestampSchema,
  base: z.looseObject({
    sha: z.string(),
    repo: z.looseObject({
      id: z.union([z.string(), z.number()]),
      full_name: z.string().min(3),
    }),
  }),
  head: z.looseObject({ sha: z.string() }),
})

const tokenResponseSchema = z.looseObject({
  token: z.string().min(20).max(2_048),
  expires_at: timestampSchema,
})

const checkRunSchema = z.looseObject({
  id: z.union([z.string(), z.number()]),
  external_id: z.string().nullable(),
  head_sha: z.string(),
  name: z.string(),
})

const checkRunsResponseSchema = z.looseObject({
  check_runs: z.array(checkRunSchema).max(100),
})

const checkRunResponseSchema = z.looseObject({
  id: z.union([z.string(), z.number()]),
})

interface GithubRequester {
  request(
    route: string,
    parameters: Record<string, unknown>
  ): Promise<{ readonly data: unknown }>
}

export type GithubRequesterFactory = (auth: string) => GithubRequester

export interface GithubAppConfiguration {
  readonly appId: string
  readonly clientId: string
  readonly defaultInstallationId?: string
  readonly privateKey: KeyObject
  readonly webhookSecret: string
  readonly publicBaseUrl: string
}

export type GithubAppErrorCode =
  | "configuration_invalid"
  | "payload_invalid"
  | "provider_unavailable"
  | "signature_invalid"
  | "stale_check"

export class GithubAppError extends Error {
  readonly retryable: boolean

  constructor(
    readonly code: GithubAppErrorCode,
    message: string,
    options: { readonly retryable?: boolean; readonly secrets?: string[] } = {}
  ) {
    super(redactConnectorText(message, options.secrets))
    this.name = "GithubAppError"
    this.retryable = options.retryable ?? false
  }
}

function invalidConfiguration(message: string): never {
  throw new GithubAppError("configuration_invalid", message)
}

export async function loadGithubAppConfiguration(
  source: Readonly<Record<string, string | undefined>>,
  fileSystem: Pick<typeof import("node:fs/promises"), "lstat" | "readFile"> = {
    lstat,
    readFile,
  }
): Promise<GithubAppConfiguration> {
  const parsed = appEnvironmentSchema.safeParse({
    GITHUB_APP_ID: source["GITHUB_APP_ID"],
    GITHUB_APP_CLIENT_ID: source["GITHUB_APP_CLIENT_ID"],
    GITHUB_APP_INSTALLATION_ID:
      source["GITHUB_APP_INSTALLATION_ID"]?.trim() || undefined,
    GITHUB_APP_PRIVATE_KEY_PATH: source["GITHUB_APP_PRIVATE_KEY_PATH"],
    GITHUB_APP_WEBHOOK_SECRET: source["GITHUB_APP_WEBHOOK_SECRET"],
    SENTINEL_PUBLIC_BASE_URL: source["SENTINEL_PUBLIC_BASE_URL"],
  })
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => String(issue.path[0]))),
    ]
    return invalidConfiguration(
      `Invalid GitHub App configuration fields: ${fields.join(", ")}`
    )
  }

  const privateKeyPath = resolve(parsed.data.GITHUB_APP_PRIVATE_KEY_PATH)
  if (!isAbsolute(parsed.data.GITHUB_APP_PRIVATE_KEY_PATH)) {
    return invalidConfiguration("GitHub App private key path must be absolute")
  }

  try {
    const metadata = await fileSystem.lstat(privateKeyPath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return invalidConfiguration(
        "GitHub App private key path must identify a regular file"
      )
    }
    if (metadata.size < 256 || metadata.size > 32 * 1_024) {
      return invalidConfiguration("GitHub App private key file size is invalid")
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      return invalidConfiguration(
        "GitHub App private key file must not be accessible by group or others"
      )
    }
    const pem = await fileSystem.readFile(privateKeyPath)
    const privateKey = createPrivateKey(pem)
    if (
      privateKey.type !== "private" ||
      privateKey.asymmetricKeyType !== "rsa"
    ) {
      return invalidConfiguration("GitHub App private key must be an RSA key")
    }
    return {
      appId: parsed.data.GITHUB_APP_ID,
      clientId: parsed.data.GITHUB_APP_CLIENT_ID,
      ...(parsed.data.GITHUB_APP_INSTALLATION_ID === undefined
        ? {}
        : {
            defaultInstallationId: parsed.data.GITHUB_APP_INSTALLATION_ID,
          }),
      privateKey,
      webhookSecret: parsed.data.GITHUB_APP_WEBHOOK_SECRET,
      publicBaseUrl: parsed.data.SENTINEL_PUBLIC_BASE_URL,
    }
  } catch {
    return invalidConfiguration("GitHub App private key could not be loaded")
  }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

export function createGithubAppJwt(
  configuration: Pick<GithubAppConfiguration, "clientId" | "privateKey">,
  now = Date.now()
): string {
  const currentSeconds = Math.floor(now / 1_000)
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" })
  const payload = base64UrlJson({
    iat: currentSeconds - 60,
    exp: currentSeconds + 9 * 60,
    iss: configuration.clientId,
  })
  const input = `${header}.${payload}`
  const signer = createSign("RSA-SHA256")
  signer.update(input)
  signer.end()
  return `${input}.${signer.sign(configuration.privateKey).toString("base64url")}`
}

export function verifyGithubWebhookSignature(
  body: Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string
): boolean {
  const expected = createHmac("sha256", secret).update(body).digest()
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signatureHeader ?? "")
  const supplied =
    match === null
      ? Buffer.alloc(expected.length)
      : Buffer.from(match[1]!, "hex")
  return timingSafeEqual(expected, supplied) && match !== null
}

function jsonObject(body: Uint8Array): Record<string, unknown> {
  if (body.byteLength === 0 || body.byteLength > MAX_GITHUB_WEBHOOK_BYTES) {
    throw new GithubAppError(
      "payload_invalid",
      "GitHub payload size is invalid"
    )
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown
    return z.record(z.string(), z.unknown()).parse(parsed)
  } catch {
    throw new GithubAppError("payload_invalid", "GitHub payload is invalid")
  }
}

function ignored(
  deliveryId: string,
  event: string,
  reason: "unsupported_event" | "unsupported_action" | "draft_pull_request",
  action?: string
): GithubWebhookDecision {
  return githubWebhookDecisionSchema.parse({
    kind: "ignored",
    deliveryId,
    event,
    ...(action === undefined ? {} : { action }),
    reason,
  })
}

function canonicalPullRequestUrl(
  repository: GitHubRepositoryIdentity,
  pullRequestNumber: number
): string {
  return `https://github.com/${repository.owner}/${repository.name}/pull/${pullRequestNumber}`
}

export function parseGithubWebhook(
  body: Uint8Array,
  headers: {
    readonly deliveryId: string | null | undefined
    readonly event: string | null | undefined
  }
): GithubWebhookDecision {
  const deliveryId = githubDeliveryIdSchema.parse(headers.deliveryId)
  const event = z.string().trim().min(1).max(128).parse(headers.event)
  const payload = jsonObject(body)
  const action =
    typeof payload["action"] === "string" ? payload["action"] : undefined
  if (event !== "pull_request") {
    return ignored(deliveryId, event, "unsupported_event", action)
  }
  if (!githubPullRequestActionSchema.safeParse(action).success) {
    return ignored(deliveryId, event, "unsupported_action", action)
  }

  const parsed = supportedPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    throw new GithubAppError("payload_invalid", "GitHub PR payload is invalid")
  }
  if (parsed.data.pull_request.draft === true) {
    return ignored(deliveryId, event, "draft_pull_request", parsed.data.action)
  }

  try {
    const repository = parseGitHubRepository(parsed.data.repository.full_name)
    const baseRepository = parseGitHubRepository(
      parsed.data.pull_request.base.repo.full_name
    )
    const pullRequest = parseGitHubPullRequest(
      parsed.data.pull_request.html_url
    )
    if (
      !sameRepository(repository, baseRepository) ||
      !sameRepository(repository, pullRequest.repository) ||
      parsed.data.pull_request.number !== pullRequest.number ||
      String(parsed.data.repository.id) !==
        String(parsed.data.pull_request.base.repo.id)
    ) {
      throw new Error("identity mismatch")
    }
    return githubWebhookDecisionSchema.parse({
      kind: "enqueue",
      trigger: {
        schemaVersion: 1,
        source: "webhook",
        event: "pull_request",
        action: parsed.data.action,
        deliveryId,
        installationId: parsed.data.installation.id,
        repositoryId: parsed.data.repository.id,
        repository,
        pullRequestId: parsed.data.pull_request.id,
        pullRequestNumber: parsed.data.pull_request.number,
        pullRequestUrl: canonicalPullRequestUrl(
          repository,
          parsed.data.pull_request.number
        ),
        baseSha: parsed.data.pull_request.base.sha.toLowerCase(),
        headSha: parsed.data.pull_request.head.sha.toLowerCase(),
        providerUpdatedAt: parsed.data.pull_request.updated_at,
        sender: parsed.data.sender,
      },
    })
  } catch {
    throw new GithubAppError(
      "payload_invalid",
      "GitHub PR payload identities are inconsistent"
    )
  }
}

function defaultRequesterFactory(timeoutMs: number): GithubRequesterFactory {
  return (auth) =>
    new Octokit({
      auth,
      userAgent: "sentinel-github-app/0.0.1",
      request: { timeout: timeoutMs },
    })
}

interface CachedToken {
  readonly token: string
  readonly expiresAt: number
}

export interface GithubAppClientOptions {
  readonly requesterFactory?: GithubRequesterFactory
  readonly now?: () => number
  readonly timeoutMs?: number
  readonly tokenRefreshMarginMs?: number
}

export interface ResolvedGithubPullRequest {
  readonly installationId: string
  readonly repositoryId: string
  readonly repository: GitHubRepositoryIdentity
  readonly pullRequestId: string
  readonly pullRequestNumber: number
  readonly pullRequestUrl: string
  readonly baseSha: string
  readonly headSha: string
  readonly providerUpdatedAt: string
  readonly draft: boolean
  readonly state: "open" | "closed"
}

export interface GithubCheckPayload {
  readonly status: "queued" | "in_progress" | "completed"
  readonly conclusion?: "success" | "neutral" | "failure" | "action_required"
  readonly started_at?: string
  readonly completed_at?: string
  readonly output: { readonly title: string; readonly summary: string }
}

type CompletedGithubCheckLifecycle = Extract<
  GithubCheckLifecycle,
  { state: "completed" }
>

export function mapGithubCheckLifecycle(
  lifecycleInput: unknown
): GithubCheckPayload {
  const lifecycle = githubCheckLifecycleSchema.parse(lifecycleInput)
  if (lifecycle.state === "queued") {
    return {
      status: "queued",
      output: {
        title: "Sentinel assessment queued",
        summary: "Blast-radius analysis is queued for this pull request head.",
      },
    }
  }
  if (lifecycle.state === "running") {
    return {
      status: "in_progress",
      started_at: lifecycle.startedAt,
      output: {
        title: "Sentinel assessment running",
        summary: "Blast-radius analysis is running for this pull request head.",
      },
    }
  }
  const conclusions: Record<
    CompletedGithubCheckLifecycle["outcome"],
    NonNullable<GithubCheckPayload["conclusion"]>
  > = {
    analysis_succeeded: "success",
    predicted_risk: "neutral",
    unknown_scope: "neutral",
    verification_unavailable: "neutral",
    verification_failed: "failure",
    action_required: "action_required",
    infrastructure_failed: "failure",
  }
  return {
    status: "completed",
    conclusion: conclusions[lifecycle.outcome],
    completed_at: lifecycle.completedAt,
    output: {
      title:
        lifecycle.outcome === "infrastructure_failed"
          ? "Sentinel analysis failed"
          : lifecycle.title,
      summary: lifecycle.summary,
    },
  }
}

export class GithubAppClient {
  private readonly requesterFactory: GithubRequesterFactory
  private readonly now: () => number
  private readonly refreshMarginMs: number
  private readonly tokens = new Map<string, CachedToken>()
  private readonly refreshes = new Map<string, Promise<CachedToken>>()

  constructor(
    private readonly configuration: GithubAppConfiguration,
    options: GithubAppClientOptions = {}
  ) {
    this.requesterFactory =
      options.requesterFactory ??
      defaultRequesterFactory(options.timeoutMs ?? 3_000)
    this.now = options.now ?? Date.now
    this.refreshMarginMs = options.tokenRefreshMarginMs ?? 2 * 60_000
  }

  private cacheKey(
    installationId: string,
    repository: GitHubRepositoryIdentity
  ): string {
    return `${installationId}:${repository.host}/${repository.owner}/${repository.name}`
  }

  private async exchangeInstallationToken(
    installationId: string,
    repository: GitHubRepositoryIdentity
  ): Promise<CachedToken> {
    const jwt = createGithubAppJwt(this.configuration, this.now())
    try {
      const response = await this.requesterFactory(jwt).request(
        "POST /app/installations/{installation_id}/access_tokens",
        {
          installation_id: installationId,
          repositories: [repository.name],
          permissions: {
            contents: "read",
            pull_requests: "read",
            checks: "write",
          },
          headers: { "X-GitHub-Api-Version": GITHUB_API_VERSION },
        }
      )
      const parsed = tokenResponseSchema.safeParse(response.data)
      if (!parsed.success) throw new Error("malformed token response")
      const expiresAt = Date.parse(parsed.data.expires_at)
      if (!Number.isFinite(expiresAt) || expiresAt <= this.now() + 60_000) {
        throw new Error("invalid token expiry")
      }
      return { token: parsed.data.token, expiresAt }
    } catch (error) {
      const mapped = connectorError(error, "provider_unavailable", [jwt])
      throw new GithubAppError("provider_unavailable", mapped.message, {
        retryable: mapped.retryable,
        secrets: [jwt],
      })
    }
  }

  async getInstallationToken(
    installationIdInput: string,
    repository: GitHubRepositoryIdentity
  ): Promise<string> {
    const installationId = z
      .string()
      .regex(/^[1-9][0-9]{0,19}$/)
      .parse(installationIdInput)
    const key = this.cacheKey(installationId, repository)
    const cached = this.tokens.get(key)
    if (
      cached !== undefined &&
      cached.expiresAt > this.now() + this.refreshMarginMs
    ) {
      return cached.token
    }
    const active = this.refreshes.get(key)
    if (active !== undefined) return (await active).token
    const refresh = this.exchangeInstallationToken(installationId, repository)
    this.refreshes.set(key, refresh)
    try {
      const token = await refresh
      this.tokens.set(key, token)
      return token.token
    } finally {
      this.refreshes.delete(key)
    }
  }

  private async installationRequest(
    installationId: string,
    repository: GitHubRepositoryIdentity,
    route: string,
    parameters: Record<string, unknown>
  ): Promise<unknown> {
    const token = await this.getInstallationToken(installationId, repository)
    try {
      return (
        await this.requesterFactory(token).request(route, {
          ...parameters,
          headers: { "X-GitHub-Api-Version": GITHUB_API_VERSION },
        })
      ).data
    } catch (error) {
      const mapped = connectorError(error, "provider_unavailable", [token])
      throw new GithubAppError("provider_unavailable", mapped.message, {
        retryable: mapped.retryable,
        secrets: [token],
      })
    }
  }

  async resolvePullRequest(input: {
    readonly installationId: string
    readonly pullRequestUrl: string
    readonly expectedRepository?: GitHubRepositoryIdentity
  }): Promise<ResolvedGithubPullRequest> {
    const identity = parseGitHubPullRequest(input.pullRequestUrl)
    if (
      input.expectedRepository !== undefined &&
      !sameRepository(identity.repository, input.expectedRepository)
    ) {
      throw new GithubAppError(
        "payload_invalid",
        "Pull request repository does not match the configured application"
      )
    }
    const response = pullRequestResponseSchema.safeParse(
      await this.installationRequest(
        input.installationId,
        identity.repository,
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          owner: identity.repository.owner,
          repo: identity.repository.name,
          pull_number: identity.number,
        }
      )
    )
    if (!response.success) {
      throw new GithubAppError(
        "provider_unavailable",
        "GitHub returned malformed pull request metadata",
        { retryable: true }
      )
    }
    const baseRepository = parseGitHubRepository(
      response.data.base.repo.full_name
    )
    if (
      !sameRepository(baseRepository, identity.repository) ||
      response.data.number !== identity.number
    ) {
      throw new GithubAppError(
        "provider_unavailable",
        "GitHub returned inconsistent pull request metadata"
      )
    }
    return {
      installationId: input.installationId,
      repositoryId: String(response.data.base.repo.id),
      repository: identity.repository,
      pullRequestId: String(response.data.id),
      pullRequestNumber: response.data.number,
      pullRequestUrl: canonicalPullRequestUrl(
        identity.repository,
        response.data.number
      ),
      baseSha: response.data.base.sha.toLowerCase(),
      headSha: response.data.head.sha.toLowerCase(),
      providerUpdatedAt: response.data.updated_at,
      draft: response.data.draft ?? false,
      state: response.data.state,
    }
  }

  assessmentDetailsUrl(assessmentId: string): string {
    return new URL(
      `/assessments/${z.uuid().parse(assessmentId)}`,
      this.configuration.publicBaseUrl
    ).toString()
  }

  async ensureQueuedCheck(targetInput: unknown): Promise<string> {
    const target = githubCheckTargetSchema.parse(targetInput)
    if (!target.isCurrent || target.syncLeaseToken === null) {
      throw new GithubAppError(
        "stale_check",
        "Assessment is not authorized to synchronize a check"
      )
    }
    if (target.checkRunId !== null) return target.checkRunId

    if (target.recovering) {
      const existing = checkRunsResponseSchema.safeParse(
        await this.installationRequest(
          target.installationId,
          target.repository,
          "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
          {
            owner: target.repository.owner,
            repo: target.repository.name,
            ref: target.headSha,
            check_name: GITHUB_CHECK_NAME,
            filter: "all",
            per_page: 100,
          }
        )
      )
      if (!existing.success) {
        throw new GithubAppError(
          "provider_unavailable",
          "GitHub returned malformed check run metadata",
          { retryable: true }
        )
      }
      const matches = existing.data.check_runs.filter(
        (check) =>
          check.name === GITHUB_CHECK_NAME &&
          check.external_id === target.assessmentId &&
          check.head_sha.toLowerCase() === target.headSha
      )
      if (matches.length > 1) {
        throw new GithubAppError(
          "provider_unavailable",
          "GitHub returned duplicate assessment checks"
        )
      }
      const match = matches[0]
      if (match !== undefined) return githubCheckRunIdSchema.parse(match.id)
    }

    const lifecycle = mapGithubCheckLifecycle({ state: "queued" })
    const created = checkRunResponseSchema.safeParse(
      await this.installationRequest(
        target.installationId,
        target.repository,
        "POST /repos/{owner}/{repo}/check-runs",
        {
          owner: target.repository.owner,
          repo: target.repository.name,
          name: GITHUB_CHECK_NAME,
          head_sha: target.headSha,
          details_url: this.assessmentDetailsUrl(target.assessmentId),
          external_id: target.assessmentId,
          ...lifecycle,
        }
      )
    )
    if (!created.success) {
      throw new GithubAppError(
        "provider_unavailable",
        "GitHub returned malformed created check metadata",
        { retryable: true }
      )
    }
    return githubCheckRunIdSchema.parse(created.data.id)
  }

  async updateCheck(
    targetInput: unknown,
    requestInput: unknown
  ): Promise<void> {
    const target = githubCheckTargetSchema.parse(targetInput)
    const request = githubCheckRequestSchema.parse(requestInput)
    if (
      !target.isCurrent ||
      target.checkRunId === null ||
      request.assessmentId !== target.assessmentId ||
      request.headSha !== target.headSha
    ) {
      throw new GithubAppError(
        "stale_check",
        "Check update does not own the current assessment head"
      )
    }
    await this.installationRequest(
      target.installationId,
      target.repository,
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      {
        owner: target.repository.owner,
        repo: target.repository.name,
        check_run_id: target.checkRunId,
        name: GITHUB_CHECK_NAME,
        details_url: request.detailsUrl,
        external_id: target.assessmentId,
        ...mapGithubCheckLifecycle(request.lifecycle),
      }
    )
  }
}

export function toManualAssessmentTrigger(input: {
  readonly resolved: ResolvedGithubPullRequest
  readonly applicationId: string
  readonly operatorId: string
}): GithubManualAssessmentTrigger {
  return githubManualAssessmentTriggerSchema.parse({
    schemaVersion: 1,
    source: "manual",
    applicationId: z.uuid().parse(input.applicationId),
    operatorId: z.uuid().parse(input.operatorId),
    installationId: input.resolved.installationId,
    repositoryId: input.resolved.repositoryId,
    repository: input.resolved.repository,
    pullRequestId: input.resolved.pullRequestId,
    pullRequestNumber: input.resolved.pullRequestNumber,
    pullRequestUrl: input.resolved.pullRequestUrl,
    baseSha: input.resolved.baseSha,
    headSha: input.resolved.headSha,
    providerUpdatedAt: input.resolved.providerUpdatedAt,
  })
}
