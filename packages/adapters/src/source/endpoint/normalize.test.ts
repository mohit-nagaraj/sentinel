import { applicationIdSchema } from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import {
  createEndpointTemplate,
  EndpointNormalizationError,
  normalizeEndpointPath,
  normalizeHttpMethod,
} from "./normalize.ts"
import { ENDPOINT_NORMALIZATION_VERSION } from "./schema.ts"

const applicationId = applicationIdSchema.parse(
  `application:v1:${"a".repeat(64)}`
)

describe("endpoint path normalization", () => {
  it.each([
    ["events", "/events"],
    ["/events/", "/events"],
    ["//events///{event_id}/orders/", "/events/{param}/orders"],
    ["/events/:eventId/orders", "/events/{param}/orders"],
    ["/events/${eventId}/orders", "/events/{param}/orders"],
    ["/events/[eventId]/orders", "/events/{param}/orders"],
    ["/events/%7eactive/%2f", "/events/~active/%2F"],
    [
      "https://api.example.test/api/events/42?token=secret#part",
      "/api/events/42",
    ],
    ["/", "/"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeEndpointPath(input)).toBe(expected)
  })

  it("normalizes parameter names by position", () => {
    expect(normalizeEndpointPath("/events/{event_id}/orders/{order}")).toBe(
      normalizeEndpointPath("/events/{id}/orders/{order_id}")
    )
  })

  it("applies base paths and strips only configured prefixes", () => {
    expect(normalizeEndpointPath("/events/{id}", { basePath: "/api/v1" })).toBe(
      "/api/v1/events/{param}"
    )
    expect(
      normalizeEndpointPath("/api/v1/events/{id}", {
        stripPrefixes: ["/api", "/api/v1"],
      })
    ).toBe("/events/{param}")
    expect(normalizeEndpointPath("/v2/events/{id}")).toBe("/v2/events/{param}")
  })

  it("normalizes and validates HTTP methods", () => {
    expect(normalizeHttpMethod(" post ")).toBe("POST")
    expect(() => normalizeHttpMethod("trace")).toThrow(
      new EndpointNormalizationError("invalid_method")
    )
  })

  it("does not reflect an invalid path in its error", () => {
    const secret = "super-secret-value"
    let error: unknown
    try {
      normalizeEndpointPath(`http://[invalid/${secret}`)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(EndpointNormalizationError)
    expect(String(error)).not.toContain(secret)
  })
})

describe("endpoint identity", () => {
  it("is stable across equivalent source syntax", () => {
    const first = createEndpointTemplate({
      applicationId,
      method: "get",
      path: "/events/{event_id}/orders",
    })
    const second = createEndpointTemplate({
      applicationId,
      method: "GET",
      path: "https://api.example.test/events/{id}/orders?key=secret",
    })

    expect(first).toStrictEqual(second)
    expect(first.normalizationVersion).toBe(ENDPOINT_NORMALIZATION_VERSION)
    expect(first.id).toMatch(/^api-endpoint:v1:[a-f0-9]{64}$/)
  })

  it("keeps method and version prefixes in the identity", () => {
    const get = createEndpointTemplate({
      applicationId,
      method: "GET",
      path: "/v1/events/{id}",
    })
    const post = createEndpointTemplate({
      applicationId,
      method: "POST",
      path: "/v1/events/{id}",
    })
    const v2 = createEndpointTemplate({
      applicationId,
      method: "GET",
      path: "/v2/events/{id}",
    })

    expect(get.id).not.toBe(post.id)
    expect(get.id).not.toBe(v2.id)
  })
})
