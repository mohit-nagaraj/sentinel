import {
  lstat,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
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
})

export interface CheckoutLease {
  readonly path: string
  cleanup(): Promise<void>
}

export interface CheckoutLeaseRegistryOptions {
  readonly rootDirectory?: string
  readonly now?: () => Date
  readonly isProcessAlive?: (pid: number) => boolean
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

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    )
  }
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
  private readonly active = new Set<string>()
  private readonly now: () => Date
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly removeDirectory: (path: string) => Promise<void>
  private resolvedRoot: string | undefined

  constructor(options: CheckoutLeaseRegistryOptions = {}) {
    this.configuredRoot = resolve(
      options.rootDirectory ?? defaultRootDirectory()
    )
    this.now = options.now ?? (() => new Date())
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessIsAlive
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
    try {
      await writeFile(
        join(leasePath, LEASE_FILE),
        JSON.stringify({
          version: 1,
          createdAt: this.now().toISOString(),
          ownerPid: process.pid,
        }),
        { encoding: "utf8", flag: "wx", mode: 0o600 }
      )
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
    this.active.add(leasePath)
    let cleaned = false
    let cleanupPromise: Promise<void> | undefined
    return {
      path: leasePath,
      cleanup: async () => {
        if (cleaned) return
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
    const paths = [...this.active]
    await Promise.all(
      paths.map(async (path) => {
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
      try {
        lease = leaseSchema.parse(
          JSON.parse(await readFile(join(candidate, LEASE_FILE), "utf8"))
        )
      } catch {
        const status = await lstat(candidate)
        if (this.now().getTime() - status.mtimeMs >= olderThanMs) {
          await this.removeOwned(candidate)
          reclaimed += 1
        }
        continue
      }
      if (this.now().getTime() - Date.parse(lease.createdAt) < olderThanMs)
        continue
      if (this.isProcessAlive(lease.ownerPid)) continue
      await this.removeOwned(candidate)
      reclaimed += 1
    }
    return reclaimed
  }
}
