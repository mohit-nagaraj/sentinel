import { z } from "zod"

import {
  getAssessmentReportService,
  type AssessmentReportWebService,
} from "@/lib/assessment-report-service"
import {
  isOperatorAuthConfigured,
  isOperatorRequestAuthorized,
  type OperatorAuthEnvironment,
} from "@/lib/operator-auth"

export const dynamic = "force-dynamic"

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  })
}

function authorize(request: Request, environment: OperatorAuthEnvironment) {
  if (!isOperatorAuthConfigured(environment)) {
    return json(
      {
        schemaVersion: 1,
        error: {
          category: "configuration",
          code: "operator_auth_unavailable",
          message: "Report authentication is unavailable.",
          retryable: false,
        },
      },
      503
    )
  }
  if (
    !isOperatorRequestAuthorized(
      request.headers.get("authorization"),
      environment
    )
  ) {
    const response = json(
      {
        schemaVersion: 1,
        error: {
          category: "authorization",
          code: "authentication_required",
          message: "Operator authentication is required.",
          retryable: false,
        },
      },
      401
    )
    response.headers.set(
      "www-authenticate",
      'Basic realm="Sentinel", charset="UTF-8"'
    )
    return response
  }
}

export async function handleAssessmentReportRequest(
  request: Request,
  path: readonly string[],
  reports: AssessmentReportWebService,
  environment: OperatorAuthEnvironment
) {
  const rejection = authorize(request, environment)
  if (rejection !== undefined) return rejection
  try {
    const assessmentId = z.uuid().parse(path[0])
    if (request.method === "GET" && path.length === 1) {
      const report = await reports.get(assessmentId)
      return report === null
        ? json({ schemaVersion: 1, error: { code: "report_not_found" } }, 404)
        : json(report)
    }
    if (
      request.method === "GET" &&
      path.length === 2 &&
      path[1] === "download"
    ) {
      const download = await reports.download(assessmentId, 300)
      if (download === null) {
        return json(
          { schemaVersion: 1, error: { code: "report_not_found" } },
          404
        )
      }
      return download.kind === "content"
        ? new Response(download.body, {
            status: 200,
            headers: {
              "cache-control": "private, no-store",
              "content-disposition": `attachment; filename="${download.filename}"`,
              "content-type": "text/markdown; charset=utf-8",
              "x-content-type-options": "nosniff",
            },
          })
        : new Response(null, {
            status: 307,
            headers: {
              location: download.url,
              "cache-control": "private, no-store",
              "referrer-policy": "no-referrer",
            },
          })
    }
    if (
      request.method === "GET" &&
      path.length === 4 &&
      path[1] === "artifacts" &&
      path[3] === "excerpt"
    ) {
      const excerpt = await reports.artifactExcerpt(assessmentId, path[2] ?? "")
      return excerpt === null
        ? json({ schemaVersion: 1, error: { code: "artifact_not_found" } }, 404)
        : json(excerpt)
    }
    return json({ schemaVersion: 1, error: { code: "route_not_found" } }, 404)
  } catch (error) {
    return error instanceof z.ZodError
      ? json({ schemaVersion: 1, error: { code: "invalid_request" } }, 400)
      : json(
          {
            schemaVersion: 1,
            error: { code: "report_request_failed", retryable: true },
          },
          500
        )
  }
}

type Context = {
  readonly params: Promise<{ readonly path?: readonly string[] }>
}

export async function GET(request: Request, context: Context) {
  const { path = [] } = await context.params
  return handleAssessmentReportRequest(
    request,
    path,
    getAssessmentReportService(),
    process.env
  )
}
