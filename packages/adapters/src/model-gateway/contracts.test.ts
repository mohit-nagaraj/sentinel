import { describe, expect, it } from "vitest"

import {
  assertModelSafeValue,
  ModelGatewayError,
  modelCallLimitsSchema,
  parseModelSafeText,
} from "./contracts.ts"

describe("model gateway contracts", () => {
  it("defines bounded per-call limits", () => {
    expect(() =>
      modelCallLimitsSchema.parse({
        maxInputCharacters: 1,
        maxOutputTokens: 4_097,
        maxTools: 1,
        maxToolCalls: 1,
        maxToolOutputCharacters: 1,
        timeoutMs: 1,
        maxRetries: 0,
      })
    ).toThrow()
  })

  it("rejects secret-shaped prompts without echoing them", () => {
    const secret = "authorization: Bearer must-not-escape"
    let captured: unknown
    try {
      parseModelSafeText(secret, 1_000)
    } catch (error) {
      captured = error
    }
    expect(captured).toBeInstanceOf(ModelGatewayError)
    expect(String(captured)).not.toContain(secret)
  })

  it("rejects nested sensitive tool data", () => {
    for (const key of [
      "api_key_value",
      "apiKeyValue",
      "APIKeyValue",
      "accessTokenValue",
      "clientSecretValue",
      "passwordConfirmation",
      "privateKeyPem",
    ]) {
      expect(() =>
        assertModelSafeValue({ result: { [key]: "plaintext" } })
      ).toThrowError(
        expect.objectContaining({
          code: "invalid_request",
          retryable: false,
        })
      )
    }
  })
})
