import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

import {
  isOperatorAuthConfigured,
  isOperatorRequestAuthorized,
  isOperatorSessionAuthorized,
  operatorSessionCookieName,
} from "@/lib/operator-auth"

const publicPaths = new Set([
  "/api/auth/session",
  "/api/health",
  "/api/github/webhooks",
  "/sign-in",
])

function authenticationRequired(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      {
        schemaVersion: 1,
        error: {
          category: "authorization",
          code: "authentication_required",
          message: "Operator authentication is required.",
          retryable: false,
        },
      },
      { status: 401, headers: { "cache-control": "private, no-store" } }
    )
  }
  const signInUrl = new URL("/sign-in", request.url)
  signInUrl.searchParams.set(
    "next",
    `${request.nextUrl.pathname}${request.nextUrl.search}`
  )
  const response = NextResponse.redirect(signInUrl)
  response.headers.set("cache-control", "private, no-store")
  return response
}

export function proxy(request: NextRequest) {
  if (publicPaths.has(request.nextUrl.pathname)) {
    return NextResponse.next()
  }
  if (!isOperatorAuthConfigured(process.env)) {
    return new NextResponse("Control-plane authentication is unavailable", {
      status: 503,
      headers: { "cache-control": "no-store" },
    })
  }
  if (
    isOperatorRequestAuthorized(
      request.headers.get("authorization"),
      process.env
    )
  ) {
    return NextResponse.next()
  }
  if (
    !isOperatorSessionAuthorized(
      request.cookies.get(operatorSessionCookieName)?.value,
      process.env
    )
  ) {
    return authenticationRequired(request)
  }
  const token = process.env["SENTINEL_OPERATOR_TOKEN"]
  if (token === undefined) return authenticationRequired(request)
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("authorization", `Bearer ${token}`)
  return NextResponse.next({ request: { headers: requestHeaders } })
}

export const config = {
  matcher: [
    "/((?!api/health|api/github/webhooks|_next/static|_next/image|favicon.ico).*)",
  ],
}
