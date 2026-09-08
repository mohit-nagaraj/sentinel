import { NextRequest } from "next/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import { proxy } from "./proxy"

const token = "operator-control-token-that-is-long-enough"

afterEach(() => vi.unstubAllEnvs())

describe("control-plane proxy", () => {
  it("fails closed when operator authentication is not configured", () => {
    vi.stubEnv("SENTINEL_OPERATOR_TOKEN", "")

    const response = proxy(new NextRequest("http://sentinel.test/"))

    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("challenges unauthenticated requests and admits a valid operator", () => {
    vi.stubEnv("SENTINEL_OPERATOR_TOKEN", token)
    const rejected = proxy(new NextRequest("http://sentinel.test/"))
    const accepted = proxy(
      new NextRequest("http://sentinel.test/", {
        headers: { authorization: `Bearer ${token}` },
      })
    )

    expect(rejected.status).toBe(401)
    expect(rejected.headers.get("www-authenticate")).toContain("Basic")
    expect(accepted.status).toBe(200)
  })
})
