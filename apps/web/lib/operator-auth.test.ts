import { describe, expect, it } from "vitest"

import {
  isControlPlaneFixture,
  isOperatorAuthConfigured,
  isOperatorRequestAuthorized,
} from "./operator-auth"

const token = "operator-control-token-that-is-long-enough"

describe("single-operator request authorization", () => {
  it("requires a configured high-entropy production token", () => {
    expect(isOperatorAuthConfigured({ NODE_ENV: "production" })).toBe(false)
    expect(
      isOperatorAuthConfigured({
        NODE_ENV: "production",
        SENTINEL_OPERATOR_TOKEN: "too-short",
      })
    ).toBe(false)
    expect(
      isOperatorAuthConfigured({
        NODE_ENV: "production",
        SENTINEL_OPERATOR_TOKEN: token,
      })
    ).toBe(true)
  })

  it("accepts exact Bearer and HTTP Basic credentials only", () => {
    const environment = {
      NODE_ENV: "production",
      SENTINEL_OPERATOR_TOKEN: token,
    }
    const basic = Buffer.from(`operator:${token}`).toString("base64")

    expect(isOperatorRequestAuthorized(`Bearer ${token}`, environment)).toBe(
      true
    )
    expect(isOperatorRequestAuthorized(`Basic ${basic}`, environment)).toBe(
      true
    )
    expect(isOperatorRequestAuthorized("Bearer wrong-token", environment)).toBe(
      false
    )
    expect(isOperatorRequestAuthorized(null, environment)).toBe(false)
  })

  it("allows fixture bypass only outside production", () => {
    expect(
      isControlPlaneFixture({
        NODE_ENV: "test",
        SENTINEL_CONTROL_PLANE_FIXTURE: "1",
      })
    ).toBe(true)
    expect(
      isOperatorRequestAuthorized(null, {
        NODE_ENV: "development",
        SENTINEL_CONTROL_PLANE_FIXTURE: "1",
      })
    ).toBe(true)
    expect(
      isOperatorRequestAuthorized(null, {
        NODE_ENV: "production",
        SENTINEL_CONTROL_PLANE_FIXTURE: "1",
      })
    ).toBe(false)
  })
})
