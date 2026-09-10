import { afterEach, describe, expect, it, vi } from "vitest"

import { operatorSessionCookieName } from "@/lib/operator-auth"

import { POST } from "./route"

const token = "operator-control-token-that-is-long-enough"

function request(
  submittedToken: string,
  next = "/",
  options: {
    readonly url?: string
    readonly headers?: Readonly<Record<string, string>>
  } = {}
) {
  const body = new FormData()
  body.set("token", submittedToken)
  body.set("next", next)
  return new Request(options.url ?? "https://sentinel.test/api/auth/session", {
    method: "POST",
    headers: {
      origin: "https://sentinel.test",
      ...options.headers,
    },
    body,
  })
}

afterEach(() => vi.unstubAllEnvs())

describe("operator session route", () => {
  it("sets a protected session cookie and returns to the requested page", async () => {
    vi.stubEnv("SENTINEL_OPERATOR_TOKEN", token)

    const response = await POST(
      request(token, "/applications/example?tab=activity", {
        url: "https://localhost:3000/api/auth/session",
        headers: {
          origin: "https://animate-paralegal-impaired.ngrok-free.dev",
          "x-forwarded-host": "animate-paralegal-impaired.ngrok-free.dev",
          "x-forwarded-proto": "https",
        },
      })
    )

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(
      "/applications/example?tab=activity"
    )
    const cookie = response.headers.get("set-cookie")
    expect(cookie).toContain(`${operatorSessionCookieName}=`)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
    expect(cookie).toContain("SameSite=strict")
  })

  it("returns invalid credentials to the sign-in page without setting a cookie", async () => {
    vi.stubEnv("SENTINEL_OPERATOR_TOKEN", token)

    const response = await POST(request("wrong-token", "https://evil.test/"))

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/sign-in?error=invalid")
    expect(response.headers.get("set-cookie")).toBeNull()
  })
})
