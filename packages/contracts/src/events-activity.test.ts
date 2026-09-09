import runEventFixture from "../../../tests/fixtures/contracts/run-event.json" with { type: "json" }
import { describe, expect, it } from "vitest"

import { parseRunEvent } from "./parsers.ts"

const screenshotArtifactId =
  "artifact:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

describe("run activity event display", () => {
  it("accepts bounded action, request, coverage, and screenshot metadata", () => {
    const event = parseRunEvent({
      ...runEventFixture,
      activity: {
        category: "transition",
        detail: "Checkout advanced to attendee details",
        action: {
          kind: "click",
          label: "Continue",
          status: "completed",
        },
        request: { method: "POST", route: "/api/orders/{id}", status: 201 },
        coverageDelta: 1,
        screenshotArtifactId,
      },
    })
    expect(event.activity).toMatchObject({
      category: "transition",
      screenshotArtifactId,
    })
  })

  it("rejects query-bearing requests, selectors, secrets, and oversized detail", () => {
    for (const activity of [
      {
        category: "request",
        request: { method: "GET", route: "/orders?token=private" },
      },
      { category: "action", detail: "Authorization: Bearer private" },
      { category: "action", detail: "x".repeat(2_049) },
      { category: "action", selector: "#checkout button" },
      {
        category: "request",
        request: {
          method: "GET",
          route: `/auth/callback/${"eyJhbGciOiJIUzI1NiJ9"}.${"a".repeat(24)}.${"b".repeat(24)}`,
        },
      },
      {
        category: "request",
        request: { method: "GET", route: "/reset/token-value" },
      },
      {
        category: "request",
        request: {
          method: "GET",
          route: "/orders/11111111-1111-4111-8111-111111111111",
        },
      },
    ]) {
      expect(() => parseRunEvent({ ...runEventFixture, activity })).toThrow()
    }
  })
})
