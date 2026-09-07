import { access, mkdir, mkdtemp, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { CheckoutLeaseRegistry } from "./lease-registry.ts"
import { EphemeralCheckoutManager } from "./checkout.ts"
import { startGitHubSourceConnector } from "./connector.ts"

describe("CheckoutLeaseRegistry", () => {
  it("cleans leases idempotently", async () => {
    const parent = await mkdtemp(join(tmpdir(), "sentinel-lease-test-"))
    const registry = new CheckoutLeaseRegistry({
      rootDirectory: join(parent, "leases"),
    })
    const lease = await registry.create()
    await lease.cleanup()
    await lease.cleanup()
    await expect(access(lease.path)).rejects.toThrow()
    await rm(parent, { recursive: true, force: true })
  })

  it("reclaims only stale Sentinel-owned lease directories", async () => {
    const parent = await mkdtemp(join(tmpdir(), "sentinel-stale-test-"))
    const rootDirectory = join(parent, "leases")
    const oldRegistry = new CheckoutLeaseRegistry({
      rootDirectory,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    })
    const stale = await oldRegistry.create()
    const currentRegistry = new CheckoutLeaseRegistry({
      rootDirectory,
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    })
    await expect(currentRegistry.reclaimStale(60_000)).resolves.toBe(1)
    await expect(access(stale.path)).rejects.toThrow()
    await stale.cleanup()
    await rm(parent, { recursive: true, force: true })
  })

  it("reclaims stale leases through the connector startup entry point", async () => {
    const parent = await mkdtemp(join(tmpdir(), "sentinel-startup-test-"))
    const rootDirectory = join(parent, "leases")
    const staleRegistry = new CheckoutLeaseRegistry({
      rootDirectory,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    })
    const stale = await staleRegistry.create()
    const startupRegistry = new CheckoutLeaseRegistry({
      rootDirectory,
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    })
    await startGitHubSourceConnector({
      checkouts: new EphemeralCheckoutManager({ registry: startupRegistry }),
      staleLeaseAgeMs: 60_000,
    })
    await expect(access(stale.path)).rejects.toThrow()
    await stale.cleanup()
    await rm(parent, { recursive: true, force: true })
  })

  it("does not reclaim an old lease with a fresh heartbeat", async () => {
    const parent = await mkdtemp(join(tmpdir(), "sentinel-live-lease-test-"))
    const rootDirectory = join(parent, "leases")
    const ownerRegistry = new CheckoutLeaseRegistry({
      rootDirectory,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      heartbeatIntervalMs: 60 * 60_000,
    })
    const lease = await ownerRegistry.create()
    await utimes(
      join(lease.path, ".sentinel-checkout-lease.json"),
      new Date("2026-01-02T00:00:00.000Z"),
      new Date("2026-01-02T00:00:00.000Z")
    )
    const reclaimer = new CheckoutLeaseRegistry({
      rootDirectory,
      now: () => new Date("2026-01-02T00:00:30.000Z"),
    })
    await expect(reclaimer.reclaimStale(10_000)).resolves.toBe(0)
    await expect(access(lease.path)).resolves.toBeUndefined()
    await lease.cleanup()
    await rm(parent, { recursive: true, force: true })
  })

  it("retries a checkout removal that fails transiently", async () => {
    const parent = await mkdtemp(join(tmpdir(), "sentinel-cleanup-retry-test-"))
    let attempts = 0
    const registry = new CheckoutLeaseRegistry({
      rootDirectory: join(parent, "leases"),
      removeDirectory: async (path) => {
        attempts += 1
        if (attempts === 1) throw new Error("locked")
        await rm(path, { recursive: true, force: true })
      },
    })
    const lease = await registry.create()
    await expect(lease.cleanup()).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: true,
    })
    await expect(access(lease.path)).resolves.toBeUndefined()
    await expect(lease.cleanup()).resolves.toBeUndefined()
    await expect(access(lease.path)).rejects.toThrow()
    await rm(parent, { recursive: true, force: true })
  })

  it("reclaims an old incomplete lease directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "sentinel-incomplete-test-"))
    const rootDirectory = join(parent, "leases")
    const incomplete = join(rootDirectory, "checkout-incomplete")
    await mkdir(incomplete, { recursive: true })
    await utimes(
      incomplete,
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-01-01T00:00:00.000Z")
    )
    const registry = new CheckoutLeaseRegistry({
      rootDirectory,
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    })
    await expect(registry.reclaimStale(60_000)).resolves.toBe(1)
    await expect(access(incomplete)).rejects.toThrow()
    await rm(parent, { recursive: true, force: true })
  })
})
