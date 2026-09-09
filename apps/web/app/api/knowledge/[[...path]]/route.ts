import {
  databaseApplicationIdSchema,
  evidenceIdSchema,
  knowledgeCursorSchema,
  knowledgePageLimitSchema,
  stableEntityIdSchema,
} from "@sentinel/contracts"
import { KnowledgeReviewConflictError } from "@sentinel/storage"
import { z } from "zod"

import {
  getKnowledgeService,
  KnowledgeNotFoundError,
  KnowledgeSourceChangedError,
  type KnowledgeService,
} from "@/lib/knowledge-service"
import {
  isOperatorAuthConfigured,
  isOperatorRequestAuthorized,
  type OperatorAuthEnvironment,
} from "@/lib/operator-auth"

export const dynamic = "force-dynamic"

type KnowledgeApi = Pick<
  KnowledgeService,
  | "artifactExcerpt"
  | "coverage"
  | "evidencePath"
  | "overview"
  | "reviewInterrupt"
  | "reviewLink"
  | "reviews"
  | "workflows"
>

class KnowledgeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly category:
      "validation" | "configuration" | "authorization" | "storage" | "unknown",
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
    },
  })
}

function publicError(error: KnowledgeHttpError): Response {
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

function mapFailure(error: unknown): Response {
  if (error instanceof KnowledgeHttpError) return publicError(error)
  if (error instanceof z.ZodError) {
    return publicError(
      new KnowledgeHttpError(
        400,
        "validation",
        "invalid_request",
        "The request does not match the knowledge API contract."
      )
    )
  }
  if (error instanceof KnowledgeNotFoundError) {
    return publicError(
      new KnowledgeHttpError(
        404,
        "validation",
        `${error.resource}_not_found`,
        `The requested knowledge ${error.resource} was not found.`
      )
    )
  }
  if (error instanceof KnowledgeSourceChangedError) {
    return publicError(
      new KnowledgeHttpError(
        409,
        "validation",
        "source_identity_changed",
        "The evidence source changed. Reload before reviewing this link."
      )
    )
  }
  if (error instanceof KnowledgeReviewConflictError) {
    return publicError(
      new KnowledgeHttpError(
        409,
        "validation",
        "review_conflict",
        "This item already has a different review decision."
      )
    )
  }
  return publicError(
    new KnowledgeHttpError(
      500,
      "unknown",
      "knowledge_request_failed",
      "The knowledge request failed unexpectedly.",
      true
    )
  )
}

function authorized(
  request: Request,
  environment: OperatorAuthEnvironment
): Response | undefined {
  if (!isOperatorAuthConfigured(environment)) {
    return publicError(
      new KnowledgeHttpError(
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
      new KnowledgeHttpError(
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

async function readJson(request: Request): Promise<unknown> {
  const maximumBytes = 16 * 1_024
  const declared = request.headers.get("content-length")
  if (declared !== null && Number(declared) > maximumBytes) {
    throw new KnowledgeHttpError(
      400,
      "validation",
      "request_too_large",
      "The request body exceeds the allowed size."
    )
  }
  const reader = request.body?.getReader()
  if (reader === undefined) {
    throw new KnowledgeHttpError(
      400,
      "validation",
      "request_body_required",
      "A JSON request body is required."
    )
  }
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const part = await reader.read()
    if (part.done) break
    total += part.value.byteLength
    if (total > maximumBytes) {
      await reader.cancel()
      throw new KnowledgeHttpError(
        400,
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
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown
  } catch {
    throw new KnowledgeHttpError(
      400,
      "validation",
      "invalid_json",
      "The request body must be valid JSON."
    )
  }
}

function assertSameOriginMutation(request: Request): void {
  const fetchSite = request.headers.get("sec-fetch-site")
  const origin = request.headers.get("origin")
  if (
    (fetchSite !== null &&
      fetchSite !== "same-origin" &&
      fetchSite !== "none") ||
    (fetchSite === null &&
      origin !== null &&
      origin !== new URL(request.url).origin)
  ) {
    throw new KnowledgeHttpError(
      403,
      "authorization",
      "cross_origin_mutation_rejected",
      "Cross-origin knowledge mutations are not allowed."
    )
  }
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    throw new KnowledgeHttpError(
      415,
      "validation",
      "json_content_type_required",
      "Knowledge mutations require an application/json body."
    )
  }
}

export async function handleKnowledgeRequest(
  request: Request,
  path: readonly string[],
  service: KnowledgeApi,
  environment: OperatorAuthEnvironment
): Promise<Response> {
  const rejection = authorized(request, environment)
  if (rejection !== undefined) return rejection
  try {
    const method = request.method.toUpperCase()
    if (method === "POST") assertSameOriginMutation(request)
    if (path[0] !== "applications" || path.length < 3) {
      throw new KnowledgeHttpError(
        404,
        "validation",
        "route_not_found",
        "The knowledge route was not found."
      )
    }
    const applicationId = databaseApplicationIdSchema.parse(path[1])
    const url = new URL(request.url)

    if (method === "GET" && path.length === 3 && path[2] === "overview") {
      return response(await service.overview(applicationId))
    }
    if (method === "GET" && path.length === 3 && path[2] === "coverage") {
      return response(
        await service.coverage(applicationId, {
          status: url.searchParams.get("status") ?? undefined,
          query: url.searchParams.get("query") ?? undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
          limit: knowledgePageLimitSchema.parse(
            url.searchParams.get("limit") ?? undefined
          ),
        })
      )
    }
    if (method === "GET" && path.length === 3 && path[2] === "workflows") {
      return response(
        await service.workflows(applicationId, {
          cursor: url.searchParams.get("cursor") ?? undefined,
          limit: knowledgePageLimitSchema.parse(
            url.searchParams.get("limit") ?? undefined
          ),
        })
      )
    }
    if (method === "GET" && path.length === 4 && path[2] === "paths") {
      const requirementId = stableEntityIdSchema
        .refine((value) => value.startsWith("requirement:v1:"))
        .parse(path[3])
      return response(await service.evidencePath(applicationId, requirementId))
    }
    if (method === "GET" && path.length === 3 && path[2] === "reviews") {
      const cursor = url.searchParams.get("cursor")
      return response(
        await service.reviews(applicationId, {
          ...(cursor === null
            ? {}
            : { cursor: knowledgeCursorSchema.parse(cursor) }),
          limit: knowledgePageLimitSchema.parse(
            url.searchParams.get("limit") ?? undefined
          ),
        })
      )
    }
    if (
      method === "GET" &&
      path.length === 5 &&
      path[2] === "artifacts" &&
      path[4] === "excerpt"
    ) {
      return response(
        await service.artifactExcerpt(applicationId, path[3] ?? "")
      )
    }
    if (
      method === "POST" &&
      path.length === 5 &&
      path[2] === "reviews" &&
      path[3] === "links"
    ) {
      const result = await service.reviewLink(
        applicationId,
        evidenceIdSchema.parse(path[4]),
        await readJson(request)
      )
      return response(result, result.idempotent ? 200 : 201)
    }
    if (
      method === "POST" &&
      path.length === 6 &&
      path[2] === "reviews" &&
      path[3] === "interrupts"
    ) {
      const runId = z.uuid().parse(path[4])
      const decisionId = z
        .string()
        .regex(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/)
        .parse(path[5])
      const result = await service.reviewInterrupt(
        applicationId,
        runId,
        decisionId,
        await readJson(request)
      )
      return response(result, result.idempotent ? 200 : 202)
    }
    throw new KnowledgeHttpError(
      404,
      "validation",
      "route_not_found",
      "The knowledge route was not found."
    )
  } catch (error) {
    return mapFailure(error)
  }
}

type KnowledgeRouteContext = {
  readonly params: Promise<{ readonly path?: readonly string[] }>
}

async function dispatch(request: Request, context: KnowledgeRouteContext) {
  const { path = [] } = await context.params
  const rejection = authorized(request, process.env)
  if (rejection !== undefined) return rejection
  return handleKnowledgeRequest(
    request,
    path,
    getKnowledgeService(),
    process.env
  )
}

export const GET = dispatch
export const POST = dispatch
