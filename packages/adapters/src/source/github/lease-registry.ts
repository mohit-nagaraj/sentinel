import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { z } from "zod"

import { SourceConnectorError } from "./errors.ts"

const LEASE_FILE = ".sentinel-checkout-lease.json"
const leaseSchema = z.strictObject({
  version: z.literal(1),
  createdAt: z.iso.datetime({ offset: true }),
  ownerPid: z.number().int().positive(),
})

export interface CheckoutLease {
  readonly path: string
  cleanup(): Promise<void>
}

export interface CheckoutLeaseRegistryOptions {
  readonly rootDirectory?: string
  readonly now?: () => Date
}

async function ensureDirectoryIsSafe(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const status = await lstat(path)
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new SourceConnectorError(
      "unsafe_repository",
      "Checkout registry root must be a real directory"
    )
  }
  return await realpath(path)
}

export class CheckoutLeaseRegistry {
  private readonly configuredRoot: string
  private readonly active = new Set<string>()
  private readonly now: () => Date
  private resolvedRoot: string | undefined

  constructor(options: CheckoutLeaseRegistryOptions = {}) {
    this.configuredRoot = resolve(
      options.rootDirectory ?? join(tmpdir(), "sentinel-checkouts")
    )
    this.now = options.now ?? (() => new Date())
  }

  private async root(): Promise<string> {
    this.resolvedRoot ??= await ensureDirectoryIsSafe(this.configuredRoot)
    return this.resolvedRoot
  }

  private async assertOwnedPath(candidate: string): Promise<string> {
    const root = await this.root()
    const absolute = resolve(candidate)
    if (
      !isAbsolute(absolute) ||
      dirname(absolute) !== root ||
      !absolute.startsWith(`${root}${sep}`)
    ) {
      throw new SourceConnectorError(
        "unsafe_repository",
        "Checkout lease is outside the worker-owned registry"
      )
    }
    return absolute
  }

  async create(): Promise<CheckoutLease> {
    const root = await this.root()
    const leasePath = await mkdtemp(join(root, "checkout-"))
    await writeFile(
      join(leasePath, LEASE_FILE),
      JSON.stringify({
        version: 1,
        createdAt: this.now().toISOString(),
        ownerPid: process.pid,
      }),
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    )
    this.active.add(leasePath)
    let cleaned = false
    return {
      path: leasePath,
      cleanup: async () => {
        if (cleaned) return
        cleaned = true
        this.active.delete(leasePath)
        await this.removeOwned(leasePath)
      },
    }
  }

  private async removeOwned(candidate: string): Promise<void> {
    const owned = await this.assertOwnedPath(candidate)
    await rm(owned, { recursive: true, force: true, maxRetries: 3 })
  }

  async cleanupAll(): Promise<void> {
    const paths = [...this.active]
    this.active.clear()
    await Promise.all(paths.map(async (path) => await this.removeOwned(path)))
  }

  async reclaimStale(olderThanMs: number): Promise<number> {
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) {
      throw new SourceConnectorError(
        "invalid_input",
        "Stale lease age is invalid"
      )
    }
    const root = await this.root()
    const entries = await readdir(root, { withFileTypes: true })
    let reclaimed = 0
    for (const entry of entries) {
      if (
        !entry.name.startsWith("checkout-") ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      ) {
        continue
      }
      const candidate = join(root, entry.name)
      if (this.active.has(candidate)) continue
      let lease: z.infer<typeof leaseSchema>
      try {
        lease = leaseSchema.parse(
          JSON.parse(await readFile(join(candidate, LEASE_FILE), "utf8"))
        )
      } catch {
        continue
      }
      if (this.now().getTime() - Date.parse(lease.createdAt) < olderThanMs)
        continue
      await this.removeOwned(candidate)
      reclaimed += 1
    }
    return reclaimed
  }
}
