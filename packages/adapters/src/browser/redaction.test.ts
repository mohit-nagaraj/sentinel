import { describe, expect, it } from "vitest"

import {
  BrowserEvidenceRedactor,
  SCREENSHOT_PII_PATTERNS,
  SCREENSHOT_MASK_SELECTOR,
} from "./redaction.ts"

describe("browser evidence redaction", () => {
  const redactor = new BrowserEvidenceRedactor([
    "correct horse battery staple",
    "slot-secret@example.test",
  ])

  it("removes exact slots, secret shapes, PII, and payment data", () => {
    const result = redactor.redactText(
      "password=correct horse battery staple email user@example.test card 4242 4242 4242 4242 phone +1 (415) 555-0123 bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature"
    )
    expect(result).not.toContain("correct horse")
    expect(result).not.toContain("user@example.test")
    expect(result).not.toContain("4242 4242")
    expect(result).not.toContain("555-0123")
    expect(result).not.toContain("eyJhbGci")
  })

  it("strips query, fragment, credentials, and PII path segments from URLs", () => {
    expect(
      redactor.redactUrl(
        "https://user:pass@app.example.test/users/slot-secret%40example.test?token=abc#secret"
      )
    ).toBe("https://app.example.test/users/redacted")
  })

  it("bounds and normalizes observed text", () => {
    expect(redactor.redactText("  one\n\t two  ")).toBe("one two")
    expect(redactor.redactText("x".repeat(100), 20)).toHaveLength(20)
  })

  it("removes Playwright locator details from public errors", () => {
    expect(
      redactor.errorMessage(
        new Error("locator('form > button:nth-child(2)') timed out")
      )
    ).toBe("[INTERNAL_TARGET] timed out")
  })

  it("masks every editable control in screenshots", () => {
    expect(SCREENSHOT_MASK_SELECTOR).toContain("input")
    expect(SCREENSHOT_MASK_SELECTOR).toContain("textarea")
    expect(SCREENSHOT_MASK_SELECTOR).toContain("select")
    expect(
      SCREENSHOT_PII_PATTERNS.some((pattern) =>
        pattern.test("buyer@example.test")
      )
    ).toBe(true)
  })
})
