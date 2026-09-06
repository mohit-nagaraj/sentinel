import { describe, expect, it, vi } from "vitest"

import { createWorker } from "./worker.ts"

describe("worker startup", () => {
  it("initializes an injected adapter and reports health", async () => {
    const initialize = vi.fn<() => Promise<void>>().mockResolvedValue()
    const worker = createWorker({ initialize })

    await expect(worker.start()).resolves.toEqual({
      service: "worker",
      status: "ok",
    })
    expect(initialize).toHaveBeenCalledOnce()
    expect(worker.health()).toEqual({ service: "worker", status: "ok" })
  })
})
