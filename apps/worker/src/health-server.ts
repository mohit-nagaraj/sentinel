import { createServer, type Server } from "node:http"

import { createHealthReport } from "@sentinel/contracts"

import {
  type WorkerDependencyName,
  type WorkerDependencyProbe,
  type WorkerDependencyProbes,
} from "./dependency-health.ts"

export interface WorkerHealthServer {
  warm(): Promise<void>
  listen(): Promise<number>
  close(): Promise<void>
}

interface ProbeState {
  readonly ready: boolean
  readonly expiresAt: number
}

const dependencyNames = ["model", "browser", "github"] as const

function statusPayload(service: string, ready: boolean) {
  return {
    schemaVersion: 1,
    service,
    status: ready ? ("ready" as const) : ("degraded" as const),
  }
}

function boundedProbe(
  probe: WorkerDependencyProbe,
  timeoutMs: number
): Promise<boolean> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<false>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort()
      resolve(false)
    }, timeoutMs)
  })
  const attempted = Promise.resolve()
    .then(() => probe(controller.signal))
    .then((ready) => ready === true)
    .catch(() => false)
  return Promise.race([attempted, expired]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout)
  })
}

export function createWorkerHealthServer(input: {
  readonly host: string
  readonly port: number
  readonly ready: () => boolean | Promise<boolean>
  readonly dependencies: WorkerDependencyProbes
  readonly dependencyTimeoutMs?: number
  readonly dependencyCacheMs?: number
}): WorkerHealthServer {
  let server: Server | undefined
  const cache = new Map<WorkerDependencyName, ProbeState>()
  const pending = new Map<WorkerDependencyName, Promise<boolean>>()
  const dependencyTimeoutMs = input.dependencyTimeoutMs ?? 5_000
  const dependencyCacheMs = input.dependencyCacheMs ?? 30_000
  if (dependencyTimeoutMs < 1 || dependencyCacheMs < 0) {
    throw new RangeError("Worker dependency health intervals are invalid")
  }

  const refreshDependency = (name: WorkerDependencyName): Promise<boolean> => {
    const active = pending.get(name)
    if (active !== undefined) return active
    const probe = boundedProbe(
      input.dependencies[name],
      dependencyTimeoutMs
    ).then((ready) => {
      cache.set(name, { ready, expiresAt: Date.now() + dependencyCacheMs })
      return ready
    })
    pending.set(name, probe)
    void probe.finally(() => pending.delete(name))
    return probe
  }

  const probeDependency = (name: WorkerDependencyName): Promise<boolean> => {
    const cached = cache.get(name)
    if (cached === undefined) return refreshDependency(name)
    if (cached.expiresAt <= Date.now()) void refreshDependency(name)
    return Promise.resolve(cached.ready)
  }

  return {
    warm: async () => {
      await Promise.all(dependencyNames.map((name) => refreshDependency(name)))
    },
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
          let storageReady = false
          try {
            storageReady = await input.ready()
          } catch {
            storageReady = false
          }
          const dependencyResults = await Promise.all(
            dependencyNames.map((name) => probeDependency(name))
          )
          const ready =
            storageReady && dependencyResults.every((result) => result === true)
          response.statusCode = ready ? 200 : 503
          response.end(JSON.stringify(statusPayload("worker", ready)))
          return
        }
        const dependency = dependencyNames.find(
          (name) =>
            request.method === "GET" && request.url === `/health/${name}`
        )
        if (dependency !== undefined) {
          const ready = await probeDependency(dependency)
          response.statusCode = ready ? 200 : 503
          response.end(
            JSON.stringify(statusPayload(`worker:${dependency}`, ready))
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
