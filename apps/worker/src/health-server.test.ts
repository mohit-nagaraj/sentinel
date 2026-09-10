import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createWorkerHealthServer,
  type WorkerHealthServer,
} from "./health-server.ts"

function dependencies(
  input: {
    readonly model?: () => boolean | Promise<boolean>
    readonly browser?: () => boolean | Promise<boolean>
    readonly github?: () => boolean | Promise<boolean>
  } = {}
) {
  return {
    model: () => input.model?.() ?? true,
    browser: () => input.browser?.() ?? true,
    github: () => input.github?.() ?? true,
  }
}

describe("worker health server", () => {
  let server: WorkerHealthServer | undefined

  afterEach(async () => server?.close())

  it("separates liveness from readiness without exposing details", async () => {
    let ready = false
    server = createWorkerHealthServer({
      host: "127.0.0.1",
      port: 0,
      ready: () => ready,
      dependencies: dependencies(),
    })
    const port = await server.listen()
    const liveness = await fetch(`http://127.0.0.1:${port}/health`)
    expect(liveness.status).toBe(200)
    await expect(liveness.json()).resolves.toEqual({
      service: "worker",
      status: "ok",
    })
    const degraded = await fetch(`http://127.0.0.1:${port}/readiness`)
    expect(degraded.status).toBe(503)
    ready = true
    const available = await fetch(`http://127.0.0.1:${port}/readiness`)
    expect(available.status).toBe(200)
    expect(JSON.stringify(await available.json())).not.toContain("error")
  })

  it("degrades readiness when the storage probe fails", async () => {
    server = createWorkerHealthServer({
      host: "127.0.0.1",
      port: 0,
      dependencies: dependencies(),
      ready: async () => {
        throw new Error("database credentials are private")
      },
    })
    const port = await server.listen()
    const response = await fetch(`http://127.0.0.1:${port}/readiness`)
    expect(response.status).toBe(503)
    expect(JSON.stringify(await response.json())).not.toContain("credentials")
  })

  it("serves truthful cached dependency health and includes it in readiness", async () => {
    let modelReady = false
    let modelCalls = 0
    server = createWorkerHealthServer({
      host: "127.0.0.1",
      port: 0,
      ready: () => true,
      dependencies: dependencies({
        model: () => {
          modelCalls += 1
          return modelReady
        },
      }),
      dependencyCacheMs: 60_000,
    })
    const port = await server.listen()

    const degraded = await fetch(`http://127.0.0.1:${port}/health/model`)
    expect(degraded.status).toBe(503)
    await expect(degraded.json()).resolves.toEqual({
      schemaVersion: 1,
      service: "worker:model",
      status: "degraded",
    })
    modelReady = true
    expect((await fetch(`http://127.0.0.1:${port}/health/model`)).status).toBe(
      503
    )
    expect(modelCalls).toBe(1)
    expect((await fetch(`http://127.0.0.1:${port}/readiness`)).status).toBe(503)
  })

  it("reports all dependency paths and coalesces concurrent probes", async () => {
    let releaseModel: ((ready: boolean) => void) | undefined
    let modelCalls = 0
    server = createWorkerHealthServer({
      host: "127.0.0.1",
      port: 0,
      ready: () => true,
      dependencies: dependencies({
        model: async () => {
          modelCalls += 1
          return new Promise<boolean>((resolve) => {
            releaseModel = resolve
          })
        },
      }),
    })
    const port = await server.listen()
    const first = fetch(`http://127.0.0.1:${port}/health/model`)
    const second = fetch(`http://127.0.0.1:${port}/health/model`)
    while (releaseModel === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    releaseModel(true)
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    expect(modelCalls).toBe(1)

    for (const name of ["browser", "github"] as const) {
      const response = await fetch(`http://127.0.0.1:${port}/health/${name}`)
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ status: "ready" })
    }
    expect((await fetch(`http://127.0.0.1:${port}/readiness`)).status).toBe(200)
  })

  it("bounds dependency checks and never reflects provider failures", async () => {
    server = createWorkerHealthServer({
      host: "127.0.0.1",
      port: 0,
      ready: () => true,
      dependencies: dependencies({
        model: () => new Promise<boolean>(() => undefined),
        github: async () => {
          throw new Error("github credential ghp_private_value")
        },
      }),
      dependencyTimeoutMs: 10,
    })
    const port = await server.listen()
    const startedAt = Date.now()
    const model = await fetch(`http://127.0.0.1:${port}/health/model`)
    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(model.status).toBe(503)
    const github = await fetch(`http://127.0.0.1:${port}/health/github`)
    expect(github.status).toBe(503)
    expect(JSON.stringify(await github.json())).not.toContain("private_value")
  })

  it("warms dependency results before listening", async () => {
    const model = vi.fn().mockResolvedValue(true)
    server = createWorkerHealthServer({
      host: "127.0.0.1",
      port: 0,
      ready: () => true,
      dependencies: dependencies({ model }),
    })
    await server.warm()
    const port = await server.listen()
    expect((await fetch(`http://127.0.0.1:${port}/health/model`)).status).toBe(
      200
    )
    expect(model).toHaveBeenCalledOnce()
  })
})
