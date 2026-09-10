import { describe, expect, it } from "vitest"

import {
  canonicalizeAllowedOrigin,
  classifyBrowserAction,
  createBrowserPolicy,
  isAllowedBrowserUrl,
  isAllowedBrowserWebSocketUrl,
  normalizeRoute,
  toPublicBrowserUrl,
} from "./policy.ts"

describe("browser policy", () => {
  const policy = createBrowserPolicy({
    allowedOrigins: ["https://app.example.test"],
  })

  it("requires exact HTTPS origins by default", () => {
    expect(isAllowedBrowserUrl("https://app.example.test/path", policy)).toBe(
      true
    )
    expect(isAllowedBrowserUrl("https://cdn.example.test/path", policy)).toBe(
      false
    )
    expect(isAllowedBrowserUrl("http://app.example.test/path", policy)).toBe(
      false
    )
    expect(() =>
      canonicalizeAllowedOrigin("https://example.test/path")
    ).toThrow(/origin/i)
  })

  it("permits HTTP only for explicitly enabled loopback fixtures", () => {
    const fixture = createBrowserPolicy({
      allowedOrigins: ["http://127.0.0.1:4312"],
      allowInsecureLocalhost: true,
    })
    expect(isAllowedBrowserUrl("http://127.0.0.1:4312/form", fixture)).toBe(
      true
    )
    expect(() =>
      createBrowserPolicy({
        allowedOrigins: ["http://example.test"],
        allowInsecureLocalhost: true,
      })
    ).toThrow(/HTTPS/)
  })

  it.each([
    ["Delete account", "destructive"],
    ["Place order", "payment"],
    ["Send invitation", "external_message"],
    ["Make administrator", "account_privilege"],
    ["Refund customer", "destructive"],
    ["Promote user", "account_privilege"],
    ["Post comment", "external_message"],
    ["Close account", "destructive"],
    ["Close registration", "destructive"],
  ] as const)("denies %s as %s", (name, category) => {
    expect(
      classifyBrowserAction({ kind: "click", name }, policy)
    ).toMatchObject({ category, allowed: false, replaySafe: false })
  })

  it("denies unknown submissions and external navigation", () => {
    expect(
      classifyBrowserAction(
        { kind: "click", name: "Submit", submit: true },
        policy
      ).category
    ).toBe("unknown_submission")
    expect(
      classifyBrowserAction(
        {
          kind: "navigate",
          name: "External",
          targetUrl: "https://other.example.test/",
        },
        policy
      ).category
    ).toBe("external_navigation")
    expect(
      classifyBrowserAction({ kind: "click", name: "Save profile" }, policy)
    ).toMatchObject({ category: "unknown_submission", allowed: false })
    expect(
      classifyBrowserAction({ kind: "click", name: "Do something" }, policy)
    ).toMatchObject({ category: "unknown_submission", allowed: false })
    for (const name of [
      "Open sales",
      "Refresh subscription",
      "Dismiss invoice",
    ]) {
      expect(
        classifyBrowserAction({ kind: "click", name }, policy)
      ).toMatchObject({ category: "unknown_submission", allowed: false })
    }
  })

  it("allows bounded semantic navigation and named inputs", () => {
    expect(
      classifyBrowserAction({ kind: "click", name: "Details" }, policy)
    ).toMatchObject({ category: "safe_read", replaySafe: true })
    const progress = classifyBrowserAction(
      { kind: "click", name: "Continue", submit: true },
      policy
    )
    expect(progress).toMatchObject({
      category: "unknown_submission",
      allowed: false,
      replaySafe: false,
    })
    expect(
      classifyBrowserAction(
        { kind: "fill", name: "Email", inputSlot: "account_email" },
        policy
      )
    ).toMatchObject({ category: "credential_entry", replaySafe: true })
    expect(classifyBrowserAction({ kind: "back" }, policy).replaySafe).toBe(
      false
    )
    const downloadPolicy = createBrowserPolicy({
      allowedOrigins: ["https://app.example.test"],
      allowedCategories: [...policy.allowedCategories, "download"],
    })
    expect(
      classifyBrowserAction(
        { kind: "navigate", name: "Download", download: true },
        downloadPolicy
      )
    ).toMatchObject({ category: "download", allowed: true, replaySafe: false })
  })

  it("maps WebSocket protocols onto the exact HTTP origin allowlist", () => {
    expect(
      isAllowedBrowserWebSocketUrl("wss://app.example.test/events", policy)
    ).toBe(true)
    expect(
      isAllowedBrowserWebSocketUrl("wss://other.example.test/events", policy)
    ).toBe(false)
    expect(
      isAllowedBrowserWebSocketUrl("ws://app.example.test/events", policy)
    ).toBe(false)
  })

  it("normalizes dynamic routes and strips public URL queries", () => {
    expect(
      normalizeRoute("https://app.example.test/orders/123?token=secret")
    ).toBe("/orders/{id}")
    expect(
      toPublicBrowserUrl(
        "https://app.example.test/orders/123?email=a%40b.test#x"
      )
    ).toBe("https://app.example.test/orders/123")
  })

  it("validates bounded budgets", () => {
    expect(() =>
      createBrowserPolicy({
        allowedOrigins: ["https://app.example.test"],
        budgets: { maxActions: 0 },
      })
    ).toThrow()
  })
})
