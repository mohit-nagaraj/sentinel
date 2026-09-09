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
    const wakes: number[] = []
    let broadcast: ((payload: unknown) => void) | undefined
    let subscription: ((status: string) => void) | undefined
    const removeChannel = vi.fn().mockResolvedValue(undefined)
    const channel = {
      on: vi.fn(
        (
          _type: string,
          _filter: unknown,
          callback: (payload: unknown) => void
        ) => {
          broadcast = callback
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
    subscription?.("SUBSCRIBED")
    broadcast?.({ event: "run_event", payload: { runId, sequence: 7 } })
    broadcast?.({
      event: "run_event",
      payload: { runId: "44444444-4444-4444-8444-444444444444", sequence: 8 },
    })
    expect(wakes).toEqual([7])
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
})
