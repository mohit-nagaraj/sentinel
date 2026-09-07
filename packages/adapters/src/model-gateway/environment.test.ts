import { describe, expect, it } from "vitest"

import {
  AzureOpenAIConfigurationError,
  loadAzureCompatibilityEnvironment,
  loadAzureOpenAIEnvironment,
} from "./environment.ts"

const valid = {
  AZURE_OPENAI_ENDPOINT: "https://sentinel.openai.azure.com/openai/v1/",
  AZURE_OPENAI_API_KEY: "azure-key-must-never-appear",
  AZURE_OPENAI_DEPLOYMENT: "sentinel-model-1",
}

describe("Azure OpenAI environment", () => {
  it("accepts the versionless Azure v1 endpoint and deployment", () => {
    expect(loadAzureOpenAIEnvironment(valid)).toEqual(valid)
    expect(
      loadAzureOpenAIEnvironment({
        ...valid,
        AZURE_OPENAI_ENDPOINT:
          "https://sentinel.services.ai.azure.com/openai/v1/",
      }).AZURE_OPENAI_ENDPOINT
    ).toContain("services.ai.azure.com")
  })

  it("rejects wrong endpoint shapes and reports fields only", () => {
    for (const endpoint of [
      "http://sentinel.openai.azure.com/openai/v1/",
      "https://sentinel.openai.azure.com/",
      "https://user:password@sentinel.openai.azure.com/openai/v1/",
      "https://sentinel.openai.azure.com/openai/v1/?api-version=guessed",
      "https://attacker.example/openai/v1/",
    ]) {
      expect(() =>
        loadAzureOpenAIEnvironment({
          ...valid,
          AZURE_OPENAI_ENDPOINT: endpoint,
        })
      ).toThrow(AzureOpenAIConfigurationError)
    }

    let captured: unknown
    try {
      loadAzureOpenAIEnvironment({ ...valid, AZURE_OPENAI_API_KEY: "" })
    } catch (error) {
      captured = error
    }
    expect(String(captured)).toContain("AZURE_OPENAI_API_KEY")
    expect(String(captured)).not.toContain(valid.AZURE_OPENAI_API_KEY)
  })

  it("requires a separate live-probe opt-in and strict token cap", () => {
    expect(() => loadAzureCompatibilityEnvironment({})).toThrow(
      AzureOpenAIConfigurationError
    )
    expect(
      loadAzureCompatibilityEnvironment({
        RUN_AZURE_OPENAI_COMPATIBILITY: "1",
        AZURE_OPENAI_COMPATIBILITY_MAX_TOKENS: "64",
      })
    ).toEqual({
      RUN_AZURE_OPENAI_COMPATIBILITY: "1",
      AZURE_OPENAI_COMPATIBILITY_MAX_TOKENS: 64,
    })
  })
})
