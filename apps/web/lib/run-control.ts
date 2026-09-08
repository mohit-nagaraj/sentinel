import "server-only"

import {
  controlReadinessSchema,
  databaseApplicationIdSchema,
  databaseRunIdSchema,
  interruptResponseCommandSchema,
  pageLimitSchema,
  retryRunCommandSchema,
  runCommandSchema,
  runCursorSchema,
  type HumanDecision,
  type PublicRun,
  type PublicRunInterrupt,
  type RunCommand,
  type RunCursor,
} from "@sentinel/contracts"
import { createPostgresDatabase, RunRepository } from "@sentinel/storage"
import { z } from "zod"

export interface RunControlStore {
  enqueueControl(
    operatorId: string,
    command: RunCommand
  ): Promise<{ readonly run: PublicRun; readonly created: boolean }>
  getOwned(operatorId: string, runId: string): Promise<PublicRun | null>
  listOwned(input: {
    readonly operatorId: string
    readonly applicationId?: string
    readonly cursor?: RunCursor
    readonly limit?: number
  }): Promise<{
    readonly items: readonly PublicRun[]
    readonly nextCursor?: RunCursor
  }>
  listOwnedEvents(input: {
    readonly operatorId: string
    readonly runId: string
    readonly after?: number
    readonly limit?: number
  }): Promise<{
    readonly items: readonly { sequence: number; event: unknown }[]
    readonly nextCursor?: number
  } | null>
  requestOwnedCancellation(
    operatorId: string,
    runId: string
  ): Promise<PublicRun | null>
  retryOwned(
    operatorId: string,
    runId: string,
    idempotencyKey: string
  ): Promise<{ readonly run: PublicRun; readonly idempotent: boolean }>
  respondInterrupt(input: {
    readonly operatorId: string
    readonly runId: string
    readonly decisionId: string
    readonly response: HumanDecision
  }): Promise<{
    readonly interrupt: PublicRunInterrupt
    readonly idempotent: boolean
  }>
  getOwnedPendingInterrupt(
    operatorId: string,
    runId: string
  ): Promise<PublicRunInterrupt | null>
  ready(): Promise<boolean>
}

export interface ReadinessEnvironment {
  readonly SENTINEL_WORKER_HEALTH_URL?: string | undefined
  readonly AZURE_OPENAI_ENDPOINT?: string | undefined
  readonly AZURE_OPENAI_API_KEY?: string | undefined
  readonly AZURE_OPENAI_DEPLOYMENT?: string | undefined
  readonly GITHUB_APP_ID?: string | undefined
  readonly GITHUB_APP_PRIVATE_KEY_PATH?: string | undefined
}

function runtimeReadinessEnvironment(): ReadinessEnvironment {
  return {
    SENTINEL_WORKER_HEALTH_URL: process.env["SENTINEL_WORKER_HEALTH_URL"],
    AZURE_OPENAI_ENDPOINT: process.env["AZURE_OPENAI_ENDPOINT"],
    AZURE_OPENAI_API_KEY: process.env["AZURE_OPENAI_API_KEY"],
    AZURE_OPENAI_DEPLOYMENT: process.env["AZURE_OPENAI_DEPLOYMENT"],
    GITHUB_APP_ID: process.env["GITHUB_APP_ID"],
    GITHUB_APP_PRIVATE_KEY_PATH: process.env["GITHUB_APP_PRIVATE_KEY_PATH"],
  }
}

export class RunControlService {
  private readonly operatorId: string

  constructor(
    operatorId: string,
    private readonly store: RunControlStore,
    private readonly environment: ReadinessEnvironment = runtimeReadinessEnvironment(),
    private readonly fetcher: typeof fetch = fetch
  ) {
    this.operatorId = z.uuid().parse(operatorId)
  }

  async command(input: unknown) {
    const command = runCommandSchema.parse(input)
    return this.store.enqueueControl(this.operatorId, command)
  }

  async get(runId: string) {
    return this.store.getOwned(
      this.operatorId,
      databaseRunIdSchema.parse(runId)
    )
  }

  async list(input: {
    readonly applicationId?: string
    readonly cursor?: unknown
    readonly limit?: unknown
  }) {
    return this.store.listOwned({
      operatorId: this.operatorId,
      ...(input.applicationId === undefined
        ? {}
        : {
            applicationId: databaseApplicationIdSchema.parse(
              input.applicationId
            ),
          }),
      ...(input.cursor === undefined
        ? {}
        : { cursor: runCursorSchema.parse(input.cursor) }),
      limit: pageLimitSchema.parse(input.limit),
    })
  }

  async events(input: { runId: string; after?: unknown; limit?: unknown }) {
    return this.store.listOwnedEvents({
      operatorId: this.operatorId,
      runId: databaseRunIdSchema.parse(input.runId),
      after: z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(input.after ?? 0),
      limit: pageLimitSchema.parse(input.limit),
    })
  }

  async cancel(runId: string) {
    return this.store.requestOwnedCancellation(
      this.operatorId,
      databaseRunIdSchema.parse(runId)
    )
  }

  async retry(runId: string, input: unknown) {
    const command = retryRunCommandSchema.parse({
      ...z.record(z.string(), z.unknown()).parse(input),
      runId,
    })
    return this.store.retryOwned(
      this.operatorId,
      command.runId,
      command.idempotencyKey
    )
  }

  async respond(runId: string, decisionId: string, input: unknown) {
    const command = interruptResponseCommandSchema.parse({
      ...z.record(z.string(), z.unknown()).parse(input),
      runId,
      decisionId,
    })
    return this.store.respondInterrupt({
      operatorId: this.operatorId,
      runId: command.runId,
      decisionId: command.decisionId,
      response: command.response,
    })
  }

  async pendingInterrupt(runId: string) {
    return this.store.getOwnedPendingInterrupt(
      this.operatorId,
      databaseRunIdSchema.parse(runId)
    )
  }

  async readiness() {
    const storageReady = await this.store.ready()
    const worker = await this.workerReadiness()
    const modelConfigured = [
      this.environment.AZURE_OPENAI_ENDPOINT,
      this.environment.AZURE_OPENAI_API_KEY,
      this.environment.AZURE_OPENAI_DEPLOYMENT,
    ].every((value) => value !== undefined && value.length > 0)
    const githubConfigured =
      this.environment.GITHUB_APP_ID !== undefined &&
      this.environment.GITHUB_APP_ID.length > 0 &&
      this.environment.GITHUB_APP_PRIVATE_KEY_PATH !== undefined &&
      this.environment.GITHUB_APP_PRIVATE_KEY_PATH.length > 0
    return controlReadinessSchema.parse({
      schemaVersion: 1,
      service: "control-plane",
      status: storageReady && worker === "ready" ? "ready" : "degraded",
      dependencies: [
        { name: "storage", status: storageReady ? "ready" : "degraded" },
        { name: "worker", status: worker },
        { name: "model", status: modelConfigured ? "ready" : "unconfigured" },
        { name: "browser", status: "ready" },
        { name: "github", status: githubConfigured ? "ready" : "unconfigured" },
      ],
    })
  }

  private async workerReadiness(): Promise<
    "ready" | "degraded" | "unconfigured"
  > {
    const value = this.environment.SENTINEL_WORKER_HEALTH_URL
    if (value === undefined || value.length === 0) return "unconfigured"
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return "degraded"
    }
    if (!new Set(["http:", "https:"]).has(url.protocol)) return "degraded"
    try {
      const response = await this.fetcher(url, {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(2_000),
      })
      return response.ok ? "ready" : "degraded"
    } catch {
      return "degraded"
    }
  }
}

interface RunControlGlobalState {
  service?: RunControlService
}

const globalState = globalThis as typeof globalThis & {
  __sentinelRunControl?: RunControlGlobalState
}

export function getRunControlService(): RunControlService {
  const state = (globalState.__sentinelRunControl ??= {})
  if (state.service !== undefined) return state.service
  const operatorId = z.uuid().parse(process.env["SENTINEL_OPERATOR_ID"])
  const databaseUrl = z
    .url({ protocol: /^postgres(?:ql)?$/ })
    .parse(process.env["SUPABASE_DB_URL"])
  const database = createPostgresDatabase(databaseUrl)
  state.service = new RunControlService(
    operatorId,
    new RunRepository(database),
    runtimeReadinessEnvironment()
  )
  return state.service
}
