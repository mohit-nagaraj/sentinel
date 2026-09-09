import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

import {
  isOperatorAuthConfigured,
  isOperatorRequestAuthorized,
} from "@/lib/operator-auth"

const publicPaths = new Set(["/api/health", "/api/github/webhooks"])

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
    !isOperatorRequestAuthorized(
      request.headers.get("authorization"),
      process.env
    )
  ) {
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": 'Basic realm="Sentinel", charset="UTF-8"',
      },
    })
  }
  return NextResponse.next()
}

export const config = {
  matcher: [
    "/((?!api/health|api/github/webhooks|_next/static|_next/image|favicon.ico).*)",
  ],
}
