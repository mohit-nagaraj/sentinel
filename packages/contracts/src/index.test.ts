import { describe, expect, it } from "vitest"

import { createHealthReport, loadEnvironment } from "@sentinel/contracts"

describe("workspace contracts", () => {
  it("resolves the package export and creates a health report", () => {
    expect(createHealthReport("contracts")).toEqual({
      service: "contracts",
      status: "ok",
    })
  })

  it("does not expose unowned environment values", () => {
    expect(loadEnvironment({ PROVIDER_SECRET: "not-exported" })).toEqual({})
  })
})
