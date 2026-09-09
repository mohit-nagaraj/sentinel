import {
  GithubAppError,
  MAX_GITHUB_WEBHOOK_BYTES,
} from "@sentinel/adapters/github-app"
import {
  GithubAssessmentRepositoryError,
  type GithubAssessmentRepositoryErrorCode,
} from "@sentinel/storage"
import { z } from "zod"

import {
  GithubAssessmentServiceError,
  getGithubAssessmentService,
  type GithubAssessmentService,
} from "@/lib/github-assessments"
import {
  isOperatorAuthConfigured,
  isOperatorRequestAuthorized,
  type OperatorAuthEnvironment,
} from "@/lib/operator-auth"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const MAX_MANUAL_BODY_BYTES = 64 * 1_024

type GithubService = Pick<
  GithubAssessmentService,
  "receiveWebhook" | "submitManual"
>

export interface GithubRouteEnvironment extends OperatorAuthEnvironment {
  readonly SENTINEL_OPERATOR_ID?: string | undefined
}

class GithubHttpError extends Error {
  constructor(
    readonly status: number,
    readonly category:
      | "validation"
      | "configuration"
      | "authorization"
      | "provider"
      | "storage"
      | "unknown",
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message)
  }
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  })
}

function publicError(error: GithubHttpError): Response {
  return response(
    {
      schemaVersion: 1,
      error: {
        category: error.category,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
    },
    error.status
  )
}

const repositoryErrors: Record<
  GithubAssessmentRepositoryErrorCode,
  readonly [
    status: number,
    category: GithubHttpError["category"],
    message: string,
  ]
> = {
  active_run_conflict: [
    409,
    "configuration",
    "Another application mutation is active.",
  ],
  assessment_idempotency_conflict: [
    409,
    "validation",
    "The pull request head identifies conflicting assessment metadata.",
  ],
  delivery_idempotency_conflict: [
    409,
    "validation",
    "The GitHub delivery identifier was reused for different work.",
  ],
  github_identity_conflict: [
    409,
    "configuration",
    "The configured repository identity conflicts with prior deliveries.",
  ],
  github_installation_not_found: [
    404,
    "configuration",
    "No confirmed application matches this GitHub installation and repository.",
  ],
  invalid_budget: [
    500,
    "configuration",
    "The configured assessment budget is invalid.",
  ],
  invalid_check_lease: [
    500,
    "configuration",
    "The check synchronization lease is invalid.",
  ],
  invalid_check_run_id: [
    502,
    "provider",
    "GitHub returned an invalid check identifier.",
  ],
  invalid_github_assessment: [
    400,
    "validation",
    "The GitHub assessment request is invalid.",
  ],
  invalid_application_state: [
    409,
    "configuration",
    "The application cannot start a PR assessment in its current state.",
  ],
  knowledge_not_ready: [
    409,
    "configuration",
    "Current application knowledge is required before PR assessment.",
  ],
  onboarding_not_confirmed: [
    409,
    "configuration",
    "Application onboarding must be confirmed before PR assessment.",
  ],
  stale_assessment: [
    409,
    "configuration",
    "The assessment no longer owns the current pull request head.",
  ],
  storage_unavailable: [
    503,
    "storage",
    "Assessment storage is temporarily unavailable.",
  ],
}

function mapFailure(error: unknown): Response {
  if (error instanceof GithubHttpError) return publicError(error)
  if (error instanceof z.ZodError) {
    return publicError(
      new GithubHttpError(
        400,
        "validation",
        "invalid_request",
        "The request does not match the GitHub assessment contract."
      )
    )
  }
  if (error instanceof GithubAssessmentRepositoryError) {
    const [status, category, message] = repositoryErrors[error.code]
    return publicError(
      new GithubHttpError(
        status,
        category,
        error.code,
        message,
        error.code === "storage_unavailable"
      )
    )
  }
  if (error instanceof GithubAppError) {
    const mapped = {
      configuration_invalid: [
        503,
        "configuration",
        "github_app_unavailable",
        "GitHub App configuration is unavailable.",
      ],
      payload_invalid: [
        400,
        "validation",
        "invalid_github_payload",
        "The GitHub delivery payload is invalid.",
      ],
      provider_unavailable: [
        503,
        "provider",
        "github_provider_unavailable",
        "GitHub is temporarily unavailable.",
      ],
      signature_invalid: [
        401,
        "authorization",
        "invalid_webhook_signature",
        "GitHub webhook authentication failed.",
      ],
      stale_check: [
        409,
        "configuration",
        "stale_check",
        "The check no longer owns the current pull request head.",
      ],
    } satisfies Record<
      GithubAppError["code"],
      readonly [number, GithubHttpError["category"], string, string]
    >
    const [status, category, code, message] = mapped[error.code]
    return publicError(
      new GithubHttpError(status, category, code, message, error.retryable)
    )
  }
  if (error instanceof GithubAssessmentServiceError) {
    const mapped = {
      application_not_found: [
        404,
        "configuration",
        "application_not_found",
        "The configured GitHub App application was not found.",
      ],
      check_sync_failed: [
        503,
        "provider",
        "check_sync_failed",
        "The GitHub check could not be synchronized.",
      ],
      pull_request_closed: [
        409,
        "validation",
        "pull_request_closed",
        "Only open pull requests can be assessed.",
      ],
    } satisfies Record<
      GithubAssessmentServiceError["code"],
      readonly [number, GithubHttpError["category"], string, string]
    >
    const [status, category, code, message] = mapped[error.code]
    return publicError(new GithubHttpError(status, category, code, message))
  }
  return publicError(
    new GithubHttpError(
      500,
      "unknown",
      "github_assessment_failed",
      "The GitHub assessment request failed unexpectedly."
    )
  )
}

function unauthorized(
  request: Request,
  environment: GithubRouteEnvironment
): Response | undefined {
  if (!isOperatorAuthConfigured(environment)) {
    return publicError(
      new GithubHttpError(
        503,
        "configuration",
        "operator_auth_unavailable",
        "Control-plane authentication is unavailable."
      )
    )
  }
  if (
    !isOperatorRequestAuthorized(
      request.headers.get("authorization"),
      environment
    )
  ) {
    const result = publicError(
      new GithubHttpError(
        401,
        "authorization",
        "authentication_required",
        "Operator authentication is required."
      )
    )
    result.headers.set(
      "www-authenticate",
      'Basic realm="Sentinel", charset="UTF-8"'
    )
    return result
  }
  return undefined
}

async function readBytes(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length")
  if (declared !== null) {
    const parsed = Number(declared)
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > limit) {
      throw new GithubHttpError(
        413,
        "validation",
        "request_too_large",
        "The request body exceeds the allowed size."
      )
    }
  }
  const reader = request.body?.getReader()
  if (reader === undefined) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const part = await reader.read()
    if (part.done) break
    total += part.value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new GithubHttpError(
        413,
        "validation",
        "request_too_large",
        "The request body exceeds the allowed size."
      )
    }
    chunks.push(part.value)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function assertManualMutation(
  request: Request,
  environment: GithubRouteEnvironment
): Response | undefined {
  const rejection = unauthorized(request, environment)
  if (rejection !== undefined) return rejection
  if (!z.uuid().safeParse(environment.SENTINEL_OPERATOR_ID).success) {
    return publicError(
      new GithubHttpError(
        503,
        "configuration",
        "operator_identity_unavailable",
        "Control-plane operator identity is unavailable."
      )
    )
  }
  const origin = request.headers.get("origin")
  const fetchSite = request.headers.get("sec-fetch-site")
  if (
    (origin !== null && origin !== new URL(request.url).origin) ||
    fetchSite === "cross-site"
  ) {
    return publicError(
      new GithubHttpError(
        403,
        "authorization",
        "cross_origin_mutation_rejected",
        "Cross-origin control mutations are not allowed."
      )
    )
  }
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return publicError(
      new GithubHttpError(
        415,
        "validation",
        "json_content_type_required",
        "Manual assessment requests require an application/json body."
      )
    )
  }
  return undefined
}

export async function handleGithubRequest(
  request: Request,
  path: readonly string[],
  service: GithubService,
  environment: GithubRouteEnvironment
): Promise<Response> {
  try {
    if (request.method.toUpperCase() !== "POST" || path.length !== 1) {
      throw new GithubHttpError(
        404,
        "validation",
        "route_not_found",
        "The GitHub route was not found."
      )
    }
    if (path[0] === "webhooks") {
      const body = await readBytes(request, MAX_GITHUB_WEBHOOK_BYTES)
      const result = await service.receiveWebhook({
        body,
        signature: request.headers.get("x-hub-signature-256"),
        deliveryId: request.headers.get("x-github-delivery"),
        event: request.headers.get("x-github-event"),
      })
      return response(
        result,
        result.status === "accepted" && result.duplicate ? 200 : 202
      )
    }
    if (path[0] === "assessments") {
      const rejection = assertManualMutation(request, environment)
      if (rejection !== undefined) return rejection
      const body = await readBytes(request, MAX_MANUAL_BODY_BYTES)
      let input: unknown
      try {
        input = JSON.parse(new TextDecoder().decode(body)) as unknown
      } catch {
        throw new GithubHttpError(
          400,
          "validation",
          "invalid_json",
          "The request body must be valid JSON."
        )
      }
      const result = await service.submitManual(
        z.uuid().parse(environment.SENTINEL_OPERATOR_ID),
        input
      )
      return response(
        result,
        result.status === "accepted" && result.duplicate ? 200 : 202
      )
    }
    throw new GithubHttpError(
      404,
      "validation",
      "route_not_found",
      "The GitHub route was not found."
    )
  } catch (error) {
    return mapFailure(error)
  }
}

function runtimeEnvironment(): GithubRouteEnvironment {
  return {
    NODE_ENV: process.env["NODE_ENV"],
    SENTINEL_CONTROL_PLANE_FIXTURE:
      process.env["SENTINEL_CONTROL_PLANE_FIXTURE"],
    SENTINEL_OPERATOR_ID: process.env["SENTINEL_OPERATOR_ID"],
    SENTINEL_OPERATOR_TOKEN: process.env["SENTINEL_OPERATOR_TOKEN"],
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ path?: string[] }> }
): Promise<Response> {
  const path = (await params).path ?? []
  const environment = runtimeEnvironment()
  if (
    path.length !== 1 ||
    !new Set(["webhooks", "assessments"]).has(path[0]!)
  ) {
    return mapFailure(
      new GithubHttpError(
        404,
        "validation",
        "route_not_found",
        "The GitHub route was not found."
      )
    )
  }
  if (path[0] === "assessments") {
    const rejection = unauthorized(request, environment)
    if (rejection !== undefined) return rejection
  }
  try {
    return await handleGithubRequest(
      request,
      path,
      await getGithubAssessmentService(),
      environment
    )
  } catch (error) {
    return mapFailure(error)
  }
}
