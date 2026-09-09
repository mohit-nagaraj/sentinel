"use client"

import {
  databaseRunIdSchema,
  runRealtimeBootstrapSchema,
} from "@sentinel/contracts"
import { createClient } from "@supabase/supabase-js"
import { z as zod } from "zod"

import type { ActivityConnectionState } from "./activity-feed"

type RunRealtimeBootstrap = zod.infer<typeof runRealtimeBootstrapSchema>
type BootstrapFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>

interface RealtimeChannelLike {
  on(
    type: "broadcast",
    filter: { readonly event: "run_event" | "run_state" },
    callback: (payload: unknown) => void
  ): RealtimeChannelLike
  subscribe(callback: (status: string) => void): RealtimeChannelLike
}

interface RealtimeClientLike {
  channel(
    topic: string,
    options: {
      readonly config: {
        readonly private: true
        readonly broadcast: { readonly ack: false; readonly self: false }
      }
    }
  ): RealtimeChannelLike
  removeChannel(channel: RealtimeChannelLike): Promise<unknown>
}

export type RealtimeClientFactory = (input: {
  readonly url: string
  readonly publishableKey: string
  readonly accessToken: () => Promise<string>
}) => RealtimeClientLike

const wakeEnvelopeSchema = zod.object({
  event: zod.literal("run_event"),
  payload: zod.object({
    runId: databaseRunIdSchema,
    sequence: zod.number().int().positive(),
  }),
})
const stateWakeEnvelopeSchema = zod.object({
  event: zod.literal("run_state"),
  payload: zod.object({ runId: databaseRunIdSchema }),
})

function defaultClientFactory(input: {
  readonly url: string
  readonly publishableKey: string
  readonly accessToken: () => Promise<string>
}): RealtimeClientLike {
  return createClient(input.url, input.publishableKey, {
    accessToken: input.accessToken,
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  }) as unknown as RealtimeClientLike
}

export class RunRealtimeConfigurationError extends Error {
  constructor() {
    super("Live activity is unavailable.")
    this.name = "RunRealtimeConfigurationError"
  }
}

export function createRealtimeBootstrapProvider(input: {
  readonly runId: string
  readonly fetcher?: BootstrapFetcher
  readonly now?: () => Date
}) {
  const runId = databaseRunIdSchema.parse(input.runId)
  const fetcher = input.fetcher ?? fetch
  const now = input.now ?? (() => new Date())
  let cached: RunRealtimeBootstrap | undefined
  let authority:
    | Pick<RunRealtimeBootstrap, "publishableKey" | "supabaseUrl" | "topic">
    | undefined

  return async (): Promise<RunRealtimeBootstrap> => {
    if (
      cached !== undefined &&
      new Date(cached.expiresAt).getTime() - now().getTime() > 30_000
    ) {
      return cached
    }
    const response = await fetcher(
      `/api/control/runs/${encodeURIComponent(runId)}/realtime`,
      {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      }
    )
    if (!response.ok) throw new RunRealtimeConfigurationError()
    const parsed = runRealtimeBootstrapSchema.safeParse(await response.json())
    if (
      !parsed.success ||
      parsed.data.runId !== runId ||
      parsed.data.topic !== `run:${runId}` ||
      new Date(parsed.data.expiresAt).getTime() - now().getTime() <= 10_000 ||
      (authority !== undefined &&
        (parsed.data.supabaseUrl !== authority.supabaseUrl ||
          parsed.data.publishableKey !== authority.publishableKey ||
          parsed.data.topic !== authority.topic))
    ) {
      throw new RunRealtimeConfigurationError()
    }
    authority ??= {
      supabaseUrl: parsed.data.supabaseUrl,
      publishableKey: parsed.data.publishableKey,
      topic: parsed.data.topic,
    }
    cached = parsed.data
    return parsed.data
  }
}

export function createRunRealtimeSubscription(input: {
  readonly runId: string
  readonly onWake: (sequence?: number) => void
  readonly onStatus: (status: ActivityConnectionState) => void
  readonly fetcher?: BootstrapFetcher
  readonly now?: () => Date
  readonly clientFactory?: RealtimeClientFactory
}) {
  const runId = databaseRunIdSchema.parse(input.runId)
  const bootstrap = createRealtimeBootstrapProvider({
    runId,
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  const clientFactory = input.clientFactory ?? defaultClientFactory
  let client: RealtimeClientLike | undefined
  let channel: RealtimeChannelLike | undefined
  let stopped = false

  return {
    async start(): Promise<void> {
      if (stopped) return
      input.onStatus("connecting")
      try {
        const initial = await bootstrap()
        if (stopped) return
        client = clientFactory({
          url: initial.supabaseUrl,
          publishableKey: initial.publishableKey,
          accessToken: async () => (await bootstrap()).accessToken,
        })
        channel = client
          .channel(initial.topic, {
            config: {
              private: true,
              broadcast: { ack: false, self: false },
            },
          })
          .on("broadcast", { event: "run_event" }, (payload) => {
            if (stopped) return
            const parsed = wakeEnvelopeSchema.safeParse(payload)
            if (parsed.success && parsed.data.payload.runId === runId) {
              input.onWake(parsed.data.payload.sequence)
            }
          })
          .on("broadcast", { event: "run_state" }, (payload) => {
            if (stopped) return
            const parsed = stateWakeEnvelopeSchema.safeParse(payload)
            if (parsed.success && parsed.data.payload.runId === runId) {
              input.onWake()
            }
          })
          .subscribe((status) => {
            if (stopped) return
            if (status === "SUBSCRIBED") input.onStatus("live")
            else if (status === "CLOSED") input.onStatus("offline")
            else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
              input.onStatus("reconnecting")
            }
          })
      } catch (error) {
        input.onStatus("error")
        throw error
      }
    },
    async stop(): Promise<void> {
      stopped = true
      if (client !== undefined && channel !== undefined) {
        await client.removeChannel(channel)
      }
      channel = undefined
      client = undefined
      input.onStatus("offline")
    },
  }
}
