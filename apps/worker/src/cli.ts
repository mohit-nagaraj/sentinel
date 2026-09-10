import { hostname } from "node:os"
import { isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  createRunDispatcher,
  createRunGraphRegistry,
  type RunGraphRegistry,
} from "@sentinel/orchestration/run-dispatch"
import { createPostgresDatabase, RunRepository } from "@sentinel/storage"

import { createWorker } from "./worker.ts"
import { createWorkerDependencyProbes } from "./dependency-health.ts"
import { createWorkerHealthServer } from "./health-server.ts"
import { logWorkerError, workerLog } from "./logger.ts"

interface WorkerGraphModule {
  createRunGraphs(input: {
    readonly databaseUrl: string
    readonly workerId: string
  }): Promise<RunGraphRegistry> | RunGraphRegistry
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing worker configuration: ${name}`)
  }
  return value
}

function moduleSpecifier(input: string): string {
  return input.startsWith(".") || isAbsolute(input)
    ? pathToFileURL(resolve(input)).href
    : input
}

async function loadGraphModule(input: string): Promise<WorkerGraphModule> {
  const imported = (await import(
    moduleSpecifier(input)
  )) as Partial<WorkerGraphModule>
  if (typeof imported.createRunGraphs !== "function") {
    throw new Error(
      "Worker graph module must export createRunGraphs({ databaseUrl, workerId })"
    )
  }
  return imported as WorkerGraphModule
}

const databaseUrl = required("SUPABASE_DB_URL")
const parsedDatabaseUrl = new URL(databaseUrl)
if (!new Set(["postgres:", "postgresql:"]).has(parsedDatabaseUrl.protocol)) {
  throw new Error("Invalid worker configuration: SUPABASE_DB_URL")
}
const workerId =
  process.env["SENTINEL_WORKER_ID"]?.trim() ||
  `worker:${hostname().replace(/[^A-Za-z0-9._-]/g, "_")}:${process.pid}`
const database = createPostgresDatabase(databaseUrl, { maxConnections: 1 })
const runs = new RunRepository(database)
let graphReady = false
const healthServer = createWorkerHealthServer({
  host: process.env["SENTINEL_WORKER_HEALTH_HOST"]?.trim() || "127.0.0.1",
  port: Number.parseInt(
    process.env["SENTINEL_WORKER_HEALTH_PORT"]?.trim() || "8788",
    10
  ),
  ready: async () => graphReady && (await runs.ready()),
  dependencies: createWorkerDependencyProbes(process.env),
})
const shutdown = new AbortController()
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdown.abort())
}

const reportError = (error: unknown) => {
  logWorkerError("worker_iteration_failed", error, { workerId })
}

try {
  await healthServer.warm()
  await healthServer.listen()
  workerLog("info", "worker_health_listening", { workerId })
  try {
    const graphModule = await loadGraphModule(
      required("SENTINEL_WORKER_GRAPH_MODULE")
    )
    const registry = createRunGraphRegistry(
      await graphModule.createRunGraphs({ databaseUrl, workerId })
    )
    graphReady = true
    workerLog("info", "worker_graphs_ready", { workerId })
    const worker = createWorker({
      owner: workerId,
      store: runs,
      dispatcher: createRunDispatcher(registry),
      onError: reportError,
    })
    await worker.run(shutdown.signal)
  } catch (error) {
    graphReady = false
    logWorkerError("worker_graph_initialization_failed", error, { workerId })
    reportError(error)
    await new Promise<void>((resolve) => {
      if (shutdown.signal.aborted) resolve()
      else
        shutdown.signal.addEventListener("abort", () => resolve(), {
          once: true,
        })
    })
  }
} finally {
  await healthServer.close()
  await database.close()
}
