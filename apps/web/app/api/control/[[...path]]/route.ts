import {
  databaseApplicationIdSchema,
  databaseRunIdSchema,
  pageLimitSchema,
  runCursorSchema,
} from "@sentinel/contracts"
import {
  RunControlRepositoryError,
  type RunControlRepositoryErrorCode,
} from "@sentinel/storage"
import { z } from "zod"

import {
  isOperatorAuthConfigured,
  isOperatorRequestAuthorized,
  type OperatorAuthEnvironment,
} from "@/lib/operator-auth"
import {
  RunActivityConfigurationError,
  getRunControlService,
  type RunControlService,
} from "@/lib/run-control"

export const dynamic = "force-dynamic"

type ControlService = Pick<
  RunControlService,
  | "cancel"
  | "artifact"
  | "command"
  | "events"
  | "get"
  | "list"
  | "pause"
  | "pendingInterrupt"
  | "readiness"
  | "realtime"
  | "respond"
  | "retry"
>

class ControlHttpError extends Error {
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

const MAX_BODY_BYTES = 64 * 1_024

async function readJson(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length")
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new ControlHttpError(
      400,
      "validation",
      "request_too_large",
      "The request body exceeds the allowed size."
    )
  }
  const reader = request.body?.getReader()
  if (reader === undefined) {
    throw new ControlHttpError(
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
    if (total > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new ControlHttpError(
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
    throw new ControlHttpError(
      400,
      "validation",
      "invalid_json",
      "The request body must be valid JSON."
    )
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

function publicError(error: ControlHttpError): Response {
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
  RunControlRepositoryErrorCode,
  readonly [
    status: number,
    category: ControlHttpError["category"],
    message: string,
  ]
> = {
  active_run_conflict: [
    409,
    "configuration",
    "Another application mutation is active.",
  ],
  application_not_found: [404, "validation", "The application was not found."],
  assessment_not_ready: [
    409,
    "configuration",
    "The pull request assessment is not ready for verification.",
  ],
  cancellation_not_allowed: [
    409,
    "validation",
    "This run cannot be cancelled in its current state.",
  ],
  idempotency_conflict: [
    409,
    "validation",
    "The idempotency key identifies different work.",
  ],
  interrupt_conflict: [
    409,
    "validation",
    "The interrupt already has a different response.",
  ],
  interrupt_not_found: [404, "validation", "The interrupt was not found."],
  invalid_budget: [
    400,
    "validation",
    "The requested execution budget exceeds the allowed limits.",
  ],
  invalid_application_state: [
    409,
    "configuration",
    "The application cannot start this run in its current state.",
  ],
  knowledge_not_ready: [
    409,
    "configuration",
    "The application knowledge is not ready.",
  ],
  lease_lost: [409, "storage", "The worker lease is no longer active."],
  onboarding_not_confirmed: [
    409,
    "configuration",
    "Application onboarding is not confirmed.",
  ],
  pause_not_allowed: [
    409,
    "validation",
    "This run cannot be paused in its current state.",
  ],
  publication_conflict: [
    409,
    "configuration",
    "The run output no longer matches current application state.",
  ],
  retry_not_allowed: [409, "validation", "This run cannot be retried."],
  run_not_found: [404, "validation", "The run was not found."],
  storage_unavailable: [503, "storage", "Run control storage is unavailable."],
}

function mapFailure(error: unknown): Response {
  if (error instanceof ControlHttpError) return publicError(error)
  if (error instanceof z.ZodError) {
    return publicError(
      new ControlHttpError(
        400,
        "validation",
        "invalid_request",
        "The request does not match the run control contract."
      )
    )
  }
  if (error instanceof RunControlRepositoryError) {
    const [status, category, message] = repositoryErrors[error.code]
    return publicError(
      new ControlHttpError(
        status,
        category,
        error.code,
        message,
        error.code === "storage_unavailable"
      )
    )
  }
  if (error instanceof RunActivityConfigurationError) {
    return publicError(
      new ControlHttpError(
        503,
        "configuration",
        "run_activity_unavailable",
        "Live run activity is unavailable.",
        true
      )
    )
  }
  return publicError(
    new ControlHttpError(
      500,
      "unknown",
      "control_request_failed",
      "The run control request failed unexpectedly."
    )
  )
}

function notFound(code: "run_not_found" | "interrupt_not_found"): never {
  const [, category, message] = repositoryErrors[code]
  throw new ControlHttpError(404, category, code, message)
}

function authorized(
  request: Request,
  environment: OperatorAuthEnvironment
): Response | undefined {
  if (!isOperatorAuthConfigured(environment)) {
    return publicError(
      new ControlHttpError(
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
      new ControlHttpError(
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

export async function handleControlRequest(
  request: Request,
  path: readonly string[],
  service: ControlService,
  environment: OperatorAuthEnvironment
): Promise<Response> {
  const rejection = authorized(request, environment)
  if (rejection !== undefined) return rejection
  try {
    const method = request.method.toUpperCase()
    if (method === "POST") {
      const origin = request.headers.get("origin")
      const fetchSite = request.headers.get("sec-fetch-site")
      if (
        (origin !== null && origin !== new URL(request.url).origin) ||
        fetchSite === "cross-site"
      ) {
        throw new ControlHttpError(
          403,
          "authorization",
          "cross_origin_mutation_rejected",
          "Cross-origin control mutations are not allowed."
        )
      }
      const bodylessControl =
        path.length === 3 &&
        path[0] === "runs" &&
        new Set(["cancel", "pause"]).has(path[2] ?? "")
      if (
        !bodylessControl &&
        !request.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("application/json")
      ) {
        throw new ControlHttpError(
          415,
          "validation",
          "json_content_type_required",
          "Control mutations require an application/json body."
        )
      }
    }
    if (method === "POST" && path.length === 1 && path[0] === "runs") {
      const result = await service.command(await readJson(request))
      return response(
        { schemaVersion: 1, run: result.run, idempotent: !result.created },
        result.created ? 202 : 200
      )
    }
    if (method === "GET" && path.length === 1 && path[0] === "runs") {
      const url = new URL(request.url)
      const cursorCreatedAt = url.searchParams.get("cursorCreatedAt")
      const cursorId = url.searchParams.get("cursorId")
      if ((cursorCreatedAt === null) !== (cursorId === null)) {
        throw new ControlHttpError(
          400,
          "validation",
          "invalid_cursor",
          "Both cursor fields are required."
        )
      }
      const cursor =
        cursorCreatedAt === null || cursorId === null
          ? undefined
          : runCursorSchema.parse({ createdAt: cursorCreatedAt, id: cursorId })
      const page = await service.list({
        ...(url.searchParams.get("applicationId") === null
          ? {}
          : {
              applicationId: databaseApplicationIdSchema.parse(
                url.searchParams.get("applicationId")
              ),
            }),
        ...(cursor === undefined ? {} : { cursor }),
        limit: pageLimitSchema.parse(
          url.searchParams.get("limit") ?? undefined
        ),
      })
      return response({ schemaVersion: 1, ...page })
    }
    if (method === "GET" && path.length === 1 && path[0] === "readiness") {
      const readiness = await service.readiness()
      return response(readiness, readiness.status === "ready" ? 200 : 503)
    }

    const runId = databaseRunIdSchema.parse(path[1])
    if (path[0] !== "runs") {
      throw new ControlHttpError(
        404,
        "validation",
        "route_not_found",
        "The control route was not found."
      )
    }
    if (method === "GET" && path.length === 2) {
      const run = await service.get(runId)
      return response(run ?? notFound("run_not_found"))
    }
    if (method === "GET" && path.length === 3 && path[2] === "events") {
      const url = new URL(request.url)
      const page = await service.events({
        runId,
        after: url.searchParams.get("after") ?? undefined,
        limit: url.searchParams.get("limit") ?? undefined,
      })
      return response(
        page === null
          ? notFound("run_not_found")
          : { schemaVersion: 1, ...page }
      )
    }
    if (method === "GET" && path.length === 3 && path[2] === "realtime") {
      const bootstrap = await service.realtime(runId)
      return response(bootstrap ?? notFound("run_not_found"))
    }
    if (method === "GET" && path.length === 4 && path[2] === "artifacts") {
      const artifact = await service.artifact(runId, path[3] ?? "")
      if (artifact === null) {
        throw new ControlHttpError(
          404,
          "validation",
          "artifact_not_found",
          "The run screenshot was not found."
        )
      }
      return response(artifact)
    }
    if (method === "GET" && path.length === 3 && path[2] === "interrupt") {
      const interrupt = await service.pendingInterrupt(runId)
      return response(interrupt ?? notFound("interrupt_not_found"))
    }
    if (method === "POST" && path.length === 3 && path[2] === "cancel") {
      const run = await service.cancel(runId)
      return response(
        run === null ? notFound("run_not_found") : { schemaVersion: 1, run },
        202
      )
    }
    if (method === "POST" && path.length === 3 && path[2] === "pause") {
      const run = await service.pause(runId)
      return response({ schemaVersion: 1, run }, 202)
    }
    if (method === "POST" && path.length === 3 && path[2] === "retry") {
      const result = await service.retry(runId, await readJson(request))
      return response(
        { schemaVersion: 1, ...result },
        result.idempotent ? 200 : 202
      )
    }
    if (
      method === "POST" &&
      path.length === 5 &&
      path[2] === "interrupts" &&
      path[4] === "respond"
    ) {
      const decisionId = z
        .string()
        .regex(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/)
        .parse(path[3])
      const result = await service.respond(
        runId,
        decisionId,
        await readJson(request)
      )
      return response(
        { schemaVersion: 1, ...result },
        result.idempotent ? 200 : 202
      )
    }
    throw new ControlHttpError(
      404,
      "validation",
      "route_not_found",
      "The control route was not found."
    )
  } catch (error) {
    return mapFailure(error)
  }
}

type ControlRouteContext = {
  readonly params: Promise<{ readonly path?: readonly string[] }>
}

async function dispatch(request: Request, context: ControlRouteContext) {
  const { path = [] } = await context.params
  const rejection = authorized(request, process.env)
  if (rejection !== undefined) return rejection
  return handleControlRequest(
    request,
    path,
    getRunControlService(),
    process.env
  )
}

export const GET = dispatch
export const POST = dispatch
