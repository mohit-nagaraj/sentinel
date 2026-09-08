import { createServer, type Server } from "node:http"

import { createHealthReport } from "@sentinel/contracts"

export interface WorkerHealthServer {
  listen(): Promise<number>
  close(): Promise<void>
}

export function createWorkerHealthServer(input: {
  readonly host: string
  readonly port: number
  readonly ready: () => boolean | Promise<boolean>
}): WorkerHealthServer {
  let server: Server | undefined
  return {
    listen: async () => {
      if (server !== undefined)
        throw new Error("Worker health server is active")
      server = createServer(async (request, response) => {
        response.setHeader("cache-control", "no-store")
        response.setHeader("content-type", "application/json; charset=utf-8")
        if (request.method === "GET" && request.url === "/health") {
          response.statusCode = 200
          response.end(JSON.stringify(createHealthReport("worker")))
          return
        }
        if (request.method === "GET" && request.url === "/readiness") {
          let ready = false
          try {
            ready = await input.ready()
          } catch {
            ready = false
          }
          response.statusCode = ready ? 200 : 503
          response.end(
            JSON.stringify({
              schemaVersion: 1,
              service: "worker",
              status: ready ? "ready" : "degraded",
            })
          )
          return
        }
        response.statusCode = 404
        response.end(JSON.stringify({ error: "not_found" }))
      })
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject)
        server!.listen(input.port, input.host, () => {
          server!.off("error", reject)
          resolve()
        })
      })
      const address = server.address()
      if (address === null || typeof address === "string") {
        throw new Error("Worker health server address is unavailable")
      }
      return address.port
    },
    close: async () => {
      if (server === undefined) return
      const current = server
      server = undefined
      await new Promise<void>((resolve, reject) => {
        current.close((error) =>
          error === undefined ? resolve() : reject(error)
        )
      })
    },
  }
}
