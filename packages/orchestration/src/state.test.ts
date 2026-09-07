import { describe, expect, it } from "vitest"

import {
  assertCompactCheckpointState,
  isBudgetAvailable,
  parseSyntheticState,
} from "./state.ts"
import { createSyntheticInitialState } from "./synthetic.ts"

const runId = "run:11111111-1111-4111-8111-111111111111"
const applicationId =
  "application:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const budget = {
  toolCalls: 2,
  contentBytes: 1_000,
  documentBytes: 1_000,
  documentPages: 1,
  documentSections: 1,
  sourceLines: 100,
  repositoryBytes: 1_000,
  repositoryFiles: 10,
  browserActions: 1,
  modelCalls: 2,
  modelInputTokens: 100,
  modelOutputTokens: 100,
  reconciliationRounds: 1,
  elapsedMs: 10_000,
}

describe("compact checkpoint state", () => {
  it("accepts the reference-only synthetic state", () => {
    const state = createSyntheticInitialState({ runId, applicationId, budget })
    expect(parseSyntheticState(state)).toEqual(state)
  })

  it.each([
    { browser: { goto: () => undefined } },
    { rawDocument: "x" },
    { sourceCode: "const secret = true" },
    { password: "plaintext" },
    { apiKeyValue: "plaintext" },
    { access_token: "plaintext" },
    { note: "authorization: Bearer must-not-persist" },
    { nested: { value: "x".repeat(4_097) } },
  ])("rejects live, bulky, or secret state %#", (input) => {
    expect(() => assertCompactCheckpointState(input)).toThrow()
  })

  it("does not strip unknown checkpoint fields", () => {
    const state = createSyntheticInitialState({ runId, applicationId, budget })
    expect(() =>
      parseSyntheticState({ ...state, unexpected: "value" })
    ).toThrow("Unrecognized key")
  })

  it("rejects checkpoints over 64 KiB", () => {
    expect(() =>
      assertCompactCheckpointState({
        values: Array.from({ length: 32 }, () => "x".repeat(3_000)),
      })
    ).toThrow("64 KiB")
  })

  it("checks tool, model, and reconciliation budgets without mutation", () => {
    const state = createSyntheticInitialState({ runId, applicationId, budget })
    expect(
      isBudgetAvailable(state, {
        toolCalls: 2,
        modelCalls: 2,
        reconciliationRounds: 1,
      })
    ).toBe(true)
    expect(isBudgetAvailable(state, { reconciliationRounds: 2 })).toBe(false)
  })
})
