import { describe, expect, it } from "vitest"

import {
  IndexBudget,
  defaultTypeScriptIndexLimits,
  resolveIndexLimits,
  typeScriptIndexLimitsSchema,
} from "./limits.ts"

describe("index limits", () => {
  it("validates the defaults and rejects unknown keys", () => {
    expect(
      typeScriptIndexLimitsSchema.parse(defaultTypeScriptIndexLimits)
    ).toStrictEqual(defaultTypeScriptIndexLimits)
    expect(() =>
      typeScriptIndexLimitsSchema.parse({
        ...defaultTypeScriptIndexLimits,
        surprise: 1,
      })
    ).toThrow()
  })

  it.each([
    ["maxFiles", 0],
    ["maxFileBytes", -1],
    ["maxTotalBytes", 1.5],
    ["maxSliceLines", 0],
    ["maxTraceDepth", 64],
    ["timeoutMs", 60 * 60_000],
  ])("rejects an out-of-range %s", (key, value) => {
    expect(() => resolveIndexLimits({ [key]: value })).toThrow()
  })

  it("merges overrides onto the defaults", () => {
    expect(resolveIndexLimits({ maxFiles: 10 })).toStrictEqual({
      ...defaultTypeScriptIndexLimits,
      maxFiles: 10,
    })
  })

  it("reports file and node exhaustion at the configured ceilings", () => {
    const budget = new IndexBudget(
      resolveIndexLimits({ maxFiles: 2, maxTotalNodes: 10 }),
      () => 0
    )

    expect(budget.exhausted).toBe(false)
    budget.countFile(100)
    expect(budget.files).toBe(1)
    expect(budget.filesExhausted).toBe(false)
    budget.countFile(100)
    expect(budget.filesExhausted).toBe(true)
    expect(budget.bytes).toBe(200)

    budget.countNodes(10)
    expect(budget.nodes).toBe(10)
    expect(budget.nodesExhausted).toBe(true)
    expect(budget.exhausted).toBe(true)
  })

  it("reports a byte overrun separately from file exhaustion", () => {
    const budget = new IndexBudget(
      resolveIndexLimits({ maxTotalBytes: 100 }),
      () => 0
    )

    budget.countFile(101)
    expect(budget.bytesExceeded).toBe(true)
    expect(budget.filesExhausted).toBe(false)
  })

  it("reports a timeout from an injected clock", () => {
    let now = 1_000
    const budget = new IndexBudget(
      resolveIndexLimits({ timeoutMs: 50 }),
      () => now
    )

    expect(budget.timedOut).toBe(false)
    now = 1_040
    expect(budget.elapsedMs).toBe(40)
    expect(budget.timedOut).toBe(false)
    now = 1_060
    expect(budget.timedOut).toBe(true)
    expect(budget.exhausted).toBe(true)
  })
})
