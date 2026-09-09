import "server-only"

import {
  controlReadinessSchema,
  artifactIdSchema,
  databaseApplicationIdSchema,
  databaseRunIdSchema,
  interruptResponseCommandSchema,
  pageLimitSchema,
  retryRunCommandSchema,
  runCommandSchema,
  runCursorSchema,
  runRealtimeBootstrapSchema,
  signedRunArtifactSchema,
  type HumanDecision,
  type PublicRun,
  type PublicRunInterrupt,
  type RunCommand,
  type RunCursor,
} from "@sentinel/contracts"
import {
  ArtifactMetadataRepository,
  ArtifactService,
  createPostgresDatabase,
  loadStorageEnvironment,
  RunRepository,
  S3PrivateObjectStore,
} from "@sentinel/storage"
import { z } from "zod"

import {
  createRealtimeTokenIssuer,
  type RealtimeTokenIssuer,
} from "./realtime-token"

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
  requestOwnedPause(operatorId: string, runId: string): Promise<PublicRun>
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

export interface RunArtifactUrlService {
  signedRunDownloadUrl(
    applicationId: string,
    runId: string,
    artifactId: string,
    expiresInSeconds: number
  ): Promise<string | null>
}

export interface RunActivityDependencies {
  readonly supabaseUrl?: string
  readonly publishableKey?: string
  readonly tokenIssuer?: RealtimeTokenIssuer
  readonly artifacts?: RunArtifactUrlService
  readonly now?: () => Date
}

export class RunActivityConfigurationError extends Error {
  constructor() {
    super("Run activity service is unavailable")
    this.name = "RunActivityConfigurationError"
  }
}

export interface ReadinessEnvironment {
  readonly SENTINEL_WORKER_HEALTH_URL?: string | undefined
  readonly SENTINEL_MODEL_HEALTH_URL?: string | undefined
  readonly SENTINEL_BROWSER_HEALTH_URL?: string | undefined
  readonly SENTINEL_GITHUB_HEALTH_URL?: string | undefined
}

function runtimeReadinessEnvironment(): ReadinessEnvironment {
  return {
    SENTINEL_WORKER_HEALTH_URL: process.env["SENTINEL_WORKER_HEALTH_URL"],
    SENTINEL_MODEL_HEALTH_URL: process.env["SENTINEL_MODEL_HEALTH_URL"],
    SENTINEL_BROWSER_HEALTH_URL: process.env["SENTINEL_BROWSER_HEALTH_URL"],
    SENTINEL_GITHUB_HEALTH_URL: process.env["SENTINEL_GITHUB_HEALTH_URL"],
  }
}

export class RunControlService {
  private readonly operatorId: string

  constructor(
    operatorId: string,
    private readonly store: RunControlStore,
    private readonly environment: ReadinessEnvironment = runtimeReadinessEnvironment(),
    private readonly fetcher: typeof fetch = fetch,
    private readonly activity: RunActivityDependencies = {}
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

  async pause(runId: string) {
    return this.store.requestOwnedPause(
      this.operatorId,
      databaseRunIdSchema.parse(runId)
    )
  }

  async realtime(runIdInput: string) {
    const runId = databaseRunIdSchema.parse(runIdInput)
    const run = await this.store.getOwned(this.operatorId, runId)
    if (run === null) return null
    if (
      this.activity.supabaseUrl === undefined ||
      this.activity.publishableKey === undefined ||
      this.activity.tokenIssuer === undefined
    ) {
      throw new RunActivityConfigurationError()
    }
    let issued: Awaited<ReturnType<RealtimeTokenIssuer["issue"]>>
    try {
      issued = await this.activity.tokenIssuer.issue({
        operatorId: this.operatorId,
        runId,
      })
    } catch {
      throw new RunActivityConfigurationError()
    }
    return runRealtimeBootstrapSchema.parse({
      schemaVersion: 1,
      runId,
      topic: `run:${runId}`,
      supabaseUrl: this.activity.supabaseUrl,
      publishableKey: this.activity.publishableKey,
      ...issued,
    })
  }

  async artifact(runIdInput: string, artifactIdInput: string) {
    const runId = databaseRunIdSchema.parse(runIdInput)
    const artifactId = artifactIdSchema.parse(artifactIdInput)
    const run = await this.store.getOwned(this.operatorId, runId)
    if (run === null) return null
    if (this.activity.artifacts === undefined) {
      throw new RunActivityConfigurationError()
    }
    const expiresInSeconds = 300
    let url: string | null
    try {
      url = await this.activity.artifacts.signedRunDownloadUrl(
        run.applicationId,
        run.id,
        artifactId,
        expiresInSeconds
      )
    } catch {
      throw new RunActivityConfigurationError()
    }
    if (url === null) return null
    const now = this.activity.now ?? (() => new Date())
    return signedRunArtifactSchema.parse({
      schemaVersion: 1,
      runId,
      artifactId,
      url,
      expiresAt: new Date(
        now().getTime() + expiresInSeconds * 1_000
      ).toISOString(),
    })
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
    const [worker, model, browser, github] = await Promise.all([
      this.probeReadiness(this.environment.SENTINEL_WORKER_HEALTH_URL),
      this.probeReadiness(this.environment.SENTINEL_MODEL_HEALTH_URL),
      this.probeReadiness(this.environment.SENTINEL_BROWSER_HEALTH_URL),
      this.probeReadiness(this.environment.SENTINEL_GITHUB_HEALTH_URL),
    ])
    const dependencies = [
      {
        name: "storage" as const,
        status: storageReady ? ("ready" as const) : ("degraded" as const),
      },
      { name: "worker" as const, status: worker },
      { name: "model" as const, status: model },
      { name: "browser" as const, status: browser },
      { name: "github" as const, status: github },
    ]
    return controlReadinessSchema.parse({
      schemaVersion: 1,
      service: "control-plane",
      status: dependencies.every((dependency) => dependency.status === "ready")
        ? "ready"
        : "degraded",
      dependencies,
    })
  }

  private async probeReadiness(
    value: string | undefined
  ): Promise<"ready" | "degraded" | "unconfigured"> {
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
      if (
        !response.ok ||
        Number(response.headers.get("content-length") ?? "0") > 4_096
      ) {
        return "degraded"
      }
      const payload = z
        .object({ status: z.enum(["ok", "ready"]) })
        .safeParse(await response.json())
      return payload.success ? "ready" : "degraded"
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
  let artifacts: ArtifactService | undefined
  try {
    const storage = loadStorageEnvironment(process.env)
    artifacts = new ArtifactService(
      storage.SUPABASE_STORAGE_BUCKET,
      new S3PrivateObjectStore(storage),
      new ArtifactMetadataRepository(database)
    )
  } catch {
    artifacts = undefined
  }
  let tokenIssuer: RealtimeTokenIssuer | undefined
  try {
    tokenIssuer = createRealtimeTokenIssuer({
      NODE_ENV: process.env["NODE_ENV"],
      SUPABASE_URL: process.env["SUPABASE_URL"],
      SUPABASE_REALTIME_SIGNING_JWK:
        process.env["SUPABASE_REALTIME_SIGNING_JWK"],
      SUPABASE_JWT_SECRET: process.env["SUPABASE_JWT_SECRET"],
    })
  } catch {
    tokenIssuer = undefined
  }
  state.service = new RunControlService(
    operatorId,
    new RunRepository(database),
    runtimeReadinessEnvironment(),
    fetch,
    {
      ...(process.env["SUPABASE_URL"] === undefined
        ? {}
        : { supabaseUrl: process.env["SUPABASE_URL"] }),
      ...(process.env["SUPABASE_PUBLISHABLE_KEY"] === undefined
        ? {}
        : { publishableKey: process.env["SUPABASE_PUBLISHABLE_KEY"] }),
      ...(tokenIssuer === undefined ? {} : { tokenIssuer }),
      ...(artifacts === undefined ? {} : { artifacts }),
    }
  )
  return state.service
}
