import {
  lstat,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { z } from "zod"

import { SourceConnectorError } from "./errors.ts"

const LEASE_FILE = ".sentinel-checkout-lease.json"
const leaseSchema = z.strictObject({
  version: z.literal(1),
  createdAt: z.iso.datetime({ offset: true }),
  ownerPid: z.number().int().positive(),
  heartbeatIntervalMs: z
    .number()
    .int()
    .positive()
    .max(60 * 60_000)
    .default(60_000),
})

export interface CheckoutLease {
  readonly path: string
  cleanup(): Promise<void>
}

export interface CheckoutLeaseRegistryOptions {
  readonly rootDirectory?: string
  readonly now?: () => Date
  readonly heartbeatIntervalMs?: number
  readonly removeDirectory?: (path: string) => Promise<void>
}

async function ensureDirectoryIsSafe(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  let status = await lstat(path)
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new SourceConnectorError(
      "unsafe_repository",
      "Checkout registry root must be a real directory"
    )
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new SourceConnectorError(
      "unsafe_repository",
      "Checkout registry root is not owned by the worker user"
    )
  }
  await chmod(path, 0o700)
  status = await lstat(path)
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (process.platform !== "win32" && (status.mode & 0o077) !== 0)
  ) {
    throw new SourceConnectorError(
      "unsafe_repository",
      "Checkout registry root permissions are not private"
    )
  }
  return await realpath(path)
}

function defaultRootDirectory(): string {
  const owner =
    typeof process.getuid === "function"
      ? String(process.getuid())
      : userInfo()
          .username.replace(/[^A-Za-z0-9._-]/g, "_")
          .slice(0, 64)
  return join(tmpdir(), `sentinel-checkouts-${owner || "user"}`)
}

export class CheckoutLeaseRegistry {
  private readonly configuredRoot: string
  private readonly active = new Map<string, NodeJS.Timeout | undefined>()
  private readonly now: () => Date
  private readonly heartbeatIntervalMs: number
  private readonly removeDirectory: (path: string) => Promise<void>
  private resolvedRoot: string | undefined

  constructor(options: CheckoutLeaseRegistryOptions = {}) {
    this.configuredRoot = resolve(
      /* turbopackIgnore: true */ options.rootDirectory ??
        defaultRootDirectory()
    )
    this.now = options.now ?? (() => new Date())
    this.heartbeatIntervalMs = z
      .number()
      .int()
      .positive()
      .max(60 * 60_000)
      .parse(options.heartbeatIntervalMs ?? 60_000)
    this.removeDirectory =
      options.removeDirectory ??
      (async (path) => {
        await rm(path, { recursive: true, force: true, maxRetries: 3 })
      })
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
    const leaseFilePath = join(leasePath, LEASE_FILE)
    try {
      const createdAt = this.now()
      await writeFile(
        leaseFilePath,
        JSON.stringify({
          version: 1,
          createdAt: createdAt.toISOString(),
          ownerPid: process.pid,
          heartbeatIntervalMs: this.heartbeatIntervalMs,
        }),
        { encoding: "utf8", flag: "wx", mode: 0o600 }
      )
      await utimes(leaseFilePath, createdAt, createdAt)
    } catch {
      try {
        await rm(leasePath, { recursive: true, force: true, maxRetries: 3 })
      } catch {
        // The startup reclaimer can recover a failed lease-directory cleanup.
      }
      throw new SourceConnectorError(
        "provider_unavailable",
        "Unable to create a checkout lease",
        { retryable: true }
      )
    }
    const heartbeat = setInterval(() => {
      const heartbeatAt = this.now()
      void utimes(leaseFilePath, heartbeatAt, heartbeatAt).catch(
        () => undefined
      )
    }, this.heartbeatIntervalMs)
    heartbeat.unref()
    this.active.set(leasePath, heartbeat)
    let cleaned = false
    let cleanupPromise: Promise<void> | undefined
    return {
      path: leasePath,
      cleanup: async () => {
        if (cleaned) return
        const activeHeartbeat = this.active.get(leasePath)
        if (activeHeartbeat !== undefined) clearInterval(activeHeartbeat)
        this.active.set(leasePath, undefined)
        cleanupPromise ??= this.removeOwned(leasePath)
          .then(() => {
            cleaned = true
            this.active.delete(leasePath)
          })
          .catch((error: unknown) => {
            cleanupPromise = undefined
            throw error
          })
        await cleanupPromise
      },
    }
  }

  private async removeOwned(candidate: string): Promise<void> {
    const owned = await this.assertOwnedPath(candidate)
    try {
      await this.removeDirectory(owned)
    } catch {
      throw new SourceConnectorError(
        "provider_unavailable",
        "Unable to remove an ephemeral checkout",
        { retryable: true }
      )
    }
  }

  async cleanupAll(): Promise<void> {
    const paths = [...this.active.keys()]
    await Promise.all(
      paths.map(async (path) => {
        const heartbeat = this.active.get(path)
        if (heartbeat !== undefined) clearInterval(heartbeat)
        this.active.set(path, undefined)
        await this.removeOwned(path)
        this.active.delete(path)
      })
    )
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
      let heartbeatStatus
      try {
        lease = leaseSchema.parse(
          JSON.parse(await readFile(join(candidate, LEASE_FILE), "utf8"))
        )
        heartbeatStatus = await lstat(join(candidate, LEASE_FILE))
      } catch {
        let status
        try {
          status = await lstat(candidate)
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            continue
          }
          throw new SourceConnectorError(
            "provider_unavailable",
            "Unable to inspect an incomplete checkout lease",
            { retryable: true }
          )
        }
        if (this.now().getTime() - status.mtimeMs >= olderThanMs) {
          await this.removeOwned(candidate)
          reclaimed += 1
        }
        continue
      }
      const lastHeartbeat = Math.max(
        Date.parse(lease.createdAt),
        heartbeatStatus.mtimeMs
      )
      const safeStaleAge = Math.max(olderThanMs, lease.heartbeatIntervalMs * 3)
      if (this.now().getTime() - lastHeartbeat < safeStaleAge) continue
      await this.removeOwned(candidate)
      reclaimed += 1
    }
    return reclaimed
  }
}
