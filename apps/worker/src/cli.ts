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
const graphModule = await loadGraphModule(
  required("SENTINEL_WORKER_GRAPH_MODULE")
)
const registry = createRunGraphRegistry(
  await graphModule.createRunGraphs({ databaseUrl, workerId })
)
const database = createPostgresDatabase(databaseUrl, { maxConnections: 4 })
const shutdown = new AbortController()
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdown.abort())
}

const worker = createWorker({
  owner: workerId,
  store: new RunRepository(database),
  dispatcher: createRunDispatcher(registry),
  onError: () => process.stderr.write("worker_iteration_failed\n"),
})

try {
  await worker.run(shutdown.signal)
} finally {
  await database.close()
}
