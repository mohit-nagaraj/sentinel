import { afterEach, describe, expect, it } from "vitest"

import {
  createWorkerHealthServer,
  type WorkerHealthServer,
} from "./health-server.ts"

describe("worker health server", () => {
  let server: WorkerHealthServer | undefined

  afterEach(async () => server?.close())

  it("separates liveness from readiness without exposing details", async () => {
    let ready = false
    server = createWorkerHealthServer({
      host: "127.0.0.1",
      port: 0,
      ready: () => ready,
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
      ready: async () => {
        throw new Error("database credentials are private")
      },
    })
    const port = await server.listen()
    const response = await fetch(`http://127.0.0.1:${port}/readiness`)
    expect(response.status).toBe(503)
    expect(JSON.stringify(await response.json())).not.toContain("credentials")
  })
})
