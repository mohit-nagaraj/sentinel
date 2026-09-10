import { NextResponse } from "next/server"

import {
  createOperatorSession,
  isOperatorAuthConfigured,
  isOperatorTokenAuthorized,
  operatorSessionCookieName,
} from "@/lib/operator-auth"

const maximumBodyBytes = 8 * 1_024

function safeReturnPath(value: FormDataEntryValue | null): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return "/"
  }
  const parsed = new URL(value, "http://sentinel.internal")
  return parsed.origin === "http://sentinel.internal" &&
    parsed.pathname !== "/sign-in"
    ? `${parsed.pathname}${parsed.search}`
    : "/"
}

function firstForwardedValue(value: string | null): string | undefined {
  const first = value?.split(",", 1)[0]?.trim()
  return first === "" ? undefined : first
}

function publicRequestOrigin(request: Request): string | undefined {
  const requestUrl = new URL(request.url)
  const host =
    firstForwardedValue(request.headers.get("x-forwarded-host")) ??
    request.headers.get("host") ??
    requestUrl.host
  const forwardedProtocol = firstForwardedValue(
    request.headers.get("x-forwarded-proto")
  )
  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? forwardedProtocol
      : requestUrl.protocol.slice(0, -1)
  try {
    return new URL(`${protocol}://${host}`).origin
  } catch {
    return undefined
  }
}

function relativeRedirect(location: string) {
  return new NextResponse(null, {
    status: 303,
    headers: {
      "cache-control": "private, no-store",
      location,
    },
  })
}

function signInRedirect(error: "invalid" | "unavailable", next: string) {
  const parameters = new URLSearchParams({ error })
  if (next !== "/") parameters.set("next", next)
  return relativeRedirect(`/sign-in?${parameters}`)
}

export async function POST(request: Request) {
  const next = safeReturnPath(new URL(request.url).searchParams.get("next"))
  if (!isOperatorAuthConfigured(process.env)) {
    return signInRedirect("unavailable", next)
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0)
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength > maximumBodyBytes
  ) {
    return signInRedirect("invalid", next)
  }
  const origin = request.headers.get("origin")
  if (origin !== null && origin !== publicRequestOrigin(request)) {
    return signInRedirect("invalid", next)
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return signInRedirect("invalid", next)
  }
  const submittedNext = safeReturnPath(formData.get("next"))
  const token = formData.get("token")
  if (
    typeof token !== "string" ||
    !isOperatorTokenAuthorized(token, process.env)
  ) {
    return signInRedirect("invalid", submittedNext)
  }
  const session = createOperatorSession(process.env)
  if (session === undefined) {
    return signInRedirect("unavailable", submittedNext)
  }

  const response = relativeRedirect(submittedNext)
  response.cookies.set({
    name: operatorSessionCookieName,
    value: session.value,
    httpOnly: true,
    secure: new URL(request.url).protocol === "https:",
    sameSite: "strict",
    path: "/",
    expires: session.expiresAt,
    maxAge: session.maxAge,
  })
  return response
}
