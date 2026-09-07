import { describe, expect, it } from "vitest"

import {
  canonicalizeDocumentationUrl,
  DocumentationUrlPolicy,
  isPublicAddress,
} from "./url-policy.ts"

describe("documentation URL policy", () => {
  it("canonicalizes approved URLs without widening path or protocol scope", () => {
    const policy = new DocumentationUrlPolicy({
      roots: ["https://docs.example.com/guide/"],
    })
    expect(
      policy.canonicalize(
        "../start?utm_source=test&b=2&a=1#install",
        "https://docs.example.com/guide/reference/"
      )
    ).toBe("https://docs.example.com/guide/start?a=1&b=2")
    for (const unsafe of [
      "https://docs.example.com/admin",
      "http://docs.example.com/guide",
      "https://cdn.example.com/guide",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "mailto:test@example.com",
    ]) {
      expect(() => policy.canonicalize(unsafe)).toThrow(/Documentation/)
    }
  })

  it("rejects credentialed, traversal, private, reserved, and mapped addresses", () => {
    expect(() =>
      canonicalizeDocumentationUrl("https://user:pass@example.com/docs")
    ).toThrow(/credentials/)
    expect(() =>
      canonicalizeDocumentationUrl("https://example.com/docs?token=secret")
    ).toThrow(/credential/)
    expect(() =>
      canonicalizeDocumentationUrl("https://example.com/docs/%2e%2e/private")
    ).toThrow(/traversal/)
    for (const ambiguous of [
      "https://example.com/docs/..%2fprivate",
      "https://example.com/docs/%252e%252e/private",
      "https://example.com/docs\\..\\private",
    ]) {
      expect(() => canonicalizeDocumentationUrl(ambiguous)).toThrow(
        /ambiguous|traversal/
      )
    }
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "::1",
      "fc00::1",
      "::ffff:127.0.0.1",
      "2001:db8::1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false)
    }
    expect(isPublicAddress("8.8.8.8")).toBe(true)
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true)
  })
})
