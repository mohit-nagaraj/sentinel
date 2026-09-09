// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import {
  RunRealtimeConfigurationError,
  createRealtimeBootstrapProvider,
  createRunRealtimeSubscription,
  type RealtimeClientFactory,
} from "./realtime-client"

const runId = "33333333-3333-4333-8333-333333333333"

function bootstrap(expiresAt = "2026-09-09T00:04:00.000Z") {
  return {
    schemaVersion: 1,
    runId,
    topic: `run:${runId}`,
    supabaseUrl: "http://127.0.0.1:54321",
    publishableKey: "publishable-key-that-is-long-enough",
    accessToken: "x".repeat(64),
    expiresAt,
  }
}

describe("private run realtime client", () => {
  it("caches valid tokens and refreshes inside the expiry window", async () => {
    let now = new Date("2026-09-09T00:00:00.000Z")
    const fetcher = vi.fn(async () => Response.json(bootstrap()))
    const provider = createRealtimeBootstrapProvider({
      runId,
      fetcher,
      now: () => now,
    })
    await provider()
    await provider()
    expect(fetcher).toHaveBeenCalledTimes(1)
    now = new Date("2026-09-09T00:03:31.000Z")
    await provider()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("joins a private topic and wakes only for the matching run", async () => {
    const statuses: string[] = []
    const wakes: (number | undefined)[] = []
    const broadcasts = new Map<string, (payload: unknown) => void>()
    let subscription: ((status: string) => void) | undefined
    const removeChannel = vi.fn().mockResolvedValue(undefined)
    const channel = {
      on: vi.fn(
        (
          _type: string,
          filter: { event: string },
          callback: (payload: unknown) => void
        ) => {
          broadcasts.set(filter.event, callback)
          return channel
        }
      ),
      subscribe: vi.fn((callback: (status: string) => void) => {
        subscription = callback
        return channel
      }),
    }
    const clientFactory = vi.fn(() => ({
      channel: vi.fn().mockReturnValue(channel),
      removeChannel,
    })) as unknown as RealtimeClientFactory
    const realtime = createRunRealtimeSubscription({
      runId,
      onWake: (sequence) => wakes.push(sequence),
      onStatus: (status) => statuses.push(status),
      fetcher: vi.fn(async () => Response.json(bootstrap())),
      now: () => new Date("2026-09-09T00:00:00.000Z"),
      clientFactory,
    })

    await realtime.start()
    expect(clientFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:54321",
        publishableKey: "publishable-key-that-is-long-enough",
      })
    )
    expect(channel.on).toHaveBeenCalledWith(
      "broadcast",
      { event: "run_event" },
      expect.any(Function)
    )
    expect(channel.on).toHaveBeenCalledWith(
      "broadcast",
      { event: "run_state" },
      expect.any(Function)
    )
    subscription?.("SUBSCRIBED")
    broadcasts.get("run_event")?.({
      event: "run_event",
      payload: { id: crypto.randomUUID(), runId, sequence: 7 },
    })
    broadcasts.get("run_event")?.({
      event: "run_event",
      payload: { runId: "44444444-4444-4444-8444-444444444444", sequence: 8 },
    })
    broadcasts.get("run_state")?.({
      event: "run_state",
      payload: { id: crypto.randomUUID(), runId },
    })
    broadcasts.get("run_state")?.({
      event: "run_state",
      payload: { runId: "44444444-4444-4444-8444-444444444444" },
    })
    expect(wakes).toEqual([7, undefined])
    expect(statuses).toEqual(["connecting", "live"])
    await realtime.stop()
    expect(removeChannel).toHaveBeenCalledWith(channel)
    expect(statuses.at(-1)).toBe("offline")
  })

  it("fails closed for an invalid or cross-run bootstrap", async () => {
    for (const payload of [
      { ...bootstrap(), runId: "44444444-4444-4444-8444-444444444444" },
      { ...bootstrap(), accessToken: "short" },
      bootstrap("2026-09-08T00:00:00.000Z"),
    ]) {
      const provider = createRealtimeBootstrapProvider({
        runId,
        fetcher: vi.fn(async () => Response.json(payload)),
        now: () => new Date("2026-09-09T00:00:00.000Z"),
      })
      await expect(provider()).rejects.toThrow(RunRealtimeConfigurationError)
    }
  })

  it("does not create a channel when stop wins an in-flight bootstrap", async () => {
    let release: ((response: Response) => void) | undefined
    const pending = new Promise<Response>((resolve) => {
      release = resolve
    })
    const clientFactory = vi.fn() as unknown as RealtimeClientFactory
    const realtime = createRunRealtimeSubscription({
      runId,
      onWake: vi.fn(),
      onStatus: vi.fn(),
      fetcher: vi.fn(async () => pending),
      now: () => new Date("2026-09-09T00:00:00.000Z"),
      clientFactory,
    })

    const starting = realtime.start()
    await realtime.stop()
    release?.(Response.json(bootstrap()))
    await starting
    expect(clientFactory).not.toHaveBeenCalled()
  })
})
