import { NextRequest } from "next/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import { proxy } from "./proxy"
import {
  createOperatorSession,
  operatorSessionCookieName,
} from "./lib/operator-auth"

const token = "operator-control-token-that-is-long-enough"

afterEach(() => vi.unstubAllEnvs())

describe("control-plane proxy", () => {
  it("fails closed when operator authentication is not configured", () => {
    vi.stubEnv("SENTINEL_OPERATOR_TOKEN", "")

    const response = proxy(new NextRequest("http://sentinel.test/"))

    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("admits signed GitHub webhook deliveries without operator authentication", () => {
    vi.stubEnv("SENTINEL_OPERATOR_TOKEN", "")

    const response = proxy(
      new NextRequest("http://sentinel.test/api/github/webhooks", {
        method: "POST",
      })
    )

    expect(response.status).toBe(200)
  })

  it("redirects unauthenticated pages without issuing a native challenge", () => {
    vi.stubEnv("SENTINEL_OPERATOR_TOKEN", token)
    const rejected = proxy(new NextRequest("http://sentinel.test/"))

    expect(rejected.status).toBe(307)
    expect(rejected.headers.get("location")).toBe(
      "http://sentinel.test/sign-in?next=%2F"
    )
    expect(rejected.headers.get("cache-control")).toBe("private, no-store")
    expect(rejected.headers.get("www-authenticate")).toBeNull()
  })

  it("returns an unchallenged 401 for unauthenticated API requests", async () => {
    vi.stubEnv("SENTINEL_OPERATOR_TOKEN", token)
    const rejected = proxy(
      new NextRequest("http://sentinel.test/api/control/runs")
    )

    expect(rejected.status).toBe(401)
    expect(rejected.headers.get("www-authenticate")).toBeNull()
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "authentication_required" },
    })
  })

  it("admits authorization headers and signed operator sessions", () => {
    vi.stubEnv("SENTINEL_OPERATOR_TOKEN", token)
    const accepted = proxy(
      new NextRequest("http://sentinel.test/", {
        headers: { authorization: `Bearer ${token}` },
      })
    )
    const session = createOperatorSession(process.env)
    const sessionAccepted = proxy(
      new NextRequest("http://sentinel.test/", {
        headers: {
          cookie: `${operatorSessionCookieName}=${session?.value}`,
        },
      })
    )

    expect(accepted.status).toBe(200)
    expect(sessionAccepted.status).toBe(200)
    expect(
      sessionAccepted.headers.get("x-middleware-request-authorization")
    ).toBe(`Bearer ${token}`)
  })

  it("keeps the sign-in page and session endpoint public", () => {
    vi.stubEnv("SENTINEL_OPERATOR_TOKEN", token)

    expect(proxy(new NextRequest("http://sentinel.test/sign-in")).status).toBe(
      200
    )
    expect(
      proxy(
        new NextRequest("http://sentinel.test/api/auth/session", {
          method: "POST",
        })
      ).status
    ).toBe(200)
  })
})
