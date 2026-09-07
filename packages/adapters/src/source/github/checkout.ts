import { createHash } from "node:crypto"
import { lstat, mkdir } from "node:fs/promises"
import {
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path"
import { z } from "zod"

import { hashCanonical } from "@sentinel/contracts"

import { connectorError, SourceConnectorError } from "./errors.ts"
import {
  GitProcessRunner,
  type GitCredentials,
  type GitRunner,
} from "./git-runner.ts"
import { CheckoutLeaseRegistry, type CheckoutLease } from "./lease-registry.ts"
import {
  githubCloneUrl,
  normalizeCommitSha,
  normalizeGitObjectId,
  normalizeRepositoryPath,
  parseGitHubRepository,
  type GitHubRepositoryIdentity,
} from "./normalization.ts"
import {
  isVerifiedTreePreflight,
  type VerifiedTreePreflight,
} from "./tree-preflight.ts"

const checkoutLimitsSchema = z.strictObject({
  maxFiles: z.number().int().positive().max(1_000_000),
  maxTotalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxFileBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxDepth: z.number().int().positive().max(256),
  maxTargets: z.number().int().positive().max(8),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(30 * 60_000),
  maxGitOutputBytes: z
    .number()
    .int()
    .positive()
    .max(256 * 1_024 * 1_024),
})

export type CheckoutLimits = z.infer<typeof checkoutLimitsSchema>

export const defaultCheckoutLimits: CheckoutLimits = {
  maxFiles: 100_000,
  maxTotalBytes: 512 * 1_024 * 1_024,
  maxFileBytes: 8 * 1_024 * 1_024,
  maxDepth: 40,
  maxTargets: 2,
  timeoutMs: 120_000,
  maxGitOutputBytes: 64 * 1_024 * 1_024,
}

export interface CheckoutTarget {
  readonly label: string
  readonly sha: string
  readonly remoteUrl?: string
  readonly preflight?: CheckoutTreePreflight
}

export type CheckoutTreePreflight = VerifiedTreePreflight

export interface CheckoutRequest {
  readonly repository: GitHubRepositoryIdentity
  readonly targets: readonly CheckoutTarget[]
  readonly githubToken?: string
  readonly signal?: AbortSignal
}

export type CheckoutEntryKind = "file" | "symlink"

export interface CheckoutEntry {
  readonly path: string
  readonly kind: CheckoutEntryKind
  readonly mode: string
  readonly objectId: string
  readonly sizeBytes: number
}

interface ValidatedTree {
  readonly entries: readonly CheckoutEntry[]
  readonly treeObjectId: string
  readonly treeFingerprint: string
  readonly configFingerprint: string
  readonly totalBytes: number
}

export interface CheckoutSnapshotMetadata {
  readonly label: string
  readonly commitSha: string
  readonly treeObjectId: string
  readonly treeFingerprint: string
  readonly configFingerprint: string
  readonly fileCount: number
  readonly totalBytes: number
}

export interface CheckoutSnapshot {
  readonly metadata: CheckoutSnapshotMetadata
  readonly path: string
  enumerate(prefix?: string): readonly CheckoutEntry[]
  readText(path: string, maxBytes?: number): Promise<string>
}

export interface EphemeralCheckout {
  readonly leasePath: string
  readonly snapshots: ReadonlyMap<string, CheckoutSnapshot>
  dispose(): Promise<void>
}

export interface EphemeralCheckoutManagerOptions {
  readonly limits?: Partial<CheckoutLimits>
  readonly registry?: CheckoutLeaseRegistry
  readonly runner?: GitRunner
  readonly allowLocalRepositoriesForTests?: boolean
}

const labelPattern = /^[a-z][a-z0-9_-]{0,31}$/
const treeLinePattern =
  /^(\d{6}) +(blob|commit) +([a-f0-9]{40}|[a-f0-9]{64}) +(\d+|-)$/
const configBasenames = new Set([
  ".nvmrc",
  "composer.json",
  "composer.lock",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
])

function limitError(message: string): SourceConnectorError {
  return new SourceConnectorError("limit_exceeded", message, {
    compatibility: true,
  })
}

function validatePreflight(
  input: CheckoutTreePreflight,
  limits: CheckoutLimits
): CheckoutTreePreflight {
  const result = z
    .strictObject({
      treeObjectId: z.string(),
      fileCount: z.number().int().nonnegative(),
      totalBytes: z.number().int().nonnegative(),
      maxFileBytes: z.number().int().nonnegative(),
      maxDepth: z.number().int().nonnegative(),
      hasSubmodules: z.boolean(),
      truncated: z.boolean(),
    })
    .safeParse(input)
  if (!result.success) {
    throw new SourceConnectorError(
      "invalid_input",
      "Checkout tree preflight metadata is invalid"
    )
  }
  const preflight = result.data
  const treeObjectId = normalizeGitObjectId(preflight.treeObjectId)
  if (preflight.truncated) {
    throw limitError(
      "GitHub tree metadata was truncated before repository limits could be proven"
    )
  }
  if (preflight.hasSubmodules) {
    throw new SourceConnectorError(
      "unsupported_repository",
      "Repository contains submodules; the configured submodule limit is zero",
      { compatibility: true }
    )
  }
  if (preflight.fileCount > limits.maxFiles) {
    throw limitError(
      `Repository contains ${preflight.fileCount} entries; limit is ${limits.maxFiles}`
    )
  }
  if (preflight.totalBytes > limits.maxTotalBytes) {
    throw limitError(
      `Repository content exceeds the configured limit of ${limits.maxTotalBytes} bytes`
    )
  }
  if (preflight.maxFileBytes > limits.maxFileBytes) {
    throw limitError(
      `Repository file exceeds the configured limit of ${limits.maxFileBytes} bytes`
    )
  }
  if (preflight.maxDepth > limits.maxDepth) {
    throw limitError(
      `Repository path depth exceeds the configured limit of ${limits.maxDepth}`
    )
  }
  if (preflight.treeObjectId !== treeObjectId) {
    throw new SourceConnectorError(
      "invalid_input",
      "Checkout tree preflight object identity is not normalized"
    )
  }
  return input
}

function assertContained(root: string, candidate: string): void {
  const offset = relative(root, candidate)
  if (
    offset === "" ||
    (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))
  ) {
    return
  }
  throw new SourceConnectorError(
    "unsafe_path",
    "Repository path escaped its checkout"
  )
}

function validateTreePath(path: string): string {
  const normalized = normalizeRepositoryPath(path)
  if (
    normalized
      .split("/")
      .some((component) => component.toLowerCase() === ".git")
  ) {
    throw new SourceConnectorError(
      "unsafe_repository",
      "Repository tree contains a reserved Git metadata path"
    )
  }
  return normalized
}

function decodeGitText(value: Buffer, kind: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value)
  } catch {
    throw new SourceConnectorError(
      "unsupported_repository",
      `Repository ${kind} is not valid UTF-8`,
      { compatibility: true }
    )
  }
}

function parseTreeEntries(output: Buffer): readonly CheckoutEntry[] {
  const records = decodeGitText(output, "tree metadata").split("\0")
  if (records.at(-1) === "") records.pop()
  const entries = records.map((record) => {
    const separator = record.indexOf("\t")
    if (separator < 0) {
      throw new SourceConnectorError(
        "unsafe_repository",
        "Repository tree contained malformed metadata"
      )
    }
    const header = treeLinePattern.exec(record.slice(0, separator))
    if (header === null) {
      throw new SourceConnectorError(
        "unsafe_repository",
        "Repository tree contained an unsupported object"
      )
    }
    const mode = header[1] ?? ""
    const type = header[2] ?? ""
    if (mode === "160000" || type === "commit") {
      throw new SourceConnectorError(
        "unsupported_repository",
        "Repository contains submodules; the configured submodule limit is zero",
        { compatibility: true }
      )
    }
    if (type !== "blob" || !["100644", "100755", "120000"].includes(mode)) {
      throw new SourceConnectorError(
        "unsupported_repository",
        "Repository tree contains an unsupported entry type",
        { compatibility: true }
      )
    }
    const sizeBytes = Number(header[4])
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new SourceConnectorError(
        "unsafe_repository",
        "Repository tree contained an invalid object size"
      )
    }
    return Object.freeze({
      path: validateTreePath(record.slice(separator + 1)),
      kind: mode === "120000" ? "symlink" : "file",
      mode,
      objectId: header[3] ?? "",
      sizeBytes,
    })
  })
  return Object.freeze(entries)
}

function assertSafeSymlink(path: string, targetBuffer: Buffer): void {
  if (
    targetBuffer.length === 0 ||
    targetBuffer.length > 4_096 ||
    targetBuffer.includes(0)
  ) {
    throw new SourceConnectorError(
      "unsafe_repository",
      "Repository contains an invalid symbolic link"
    )
  }
  const target = decodeGitText(targetBuffer, "symbolic link target")
  if (
    target.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(target) ||
    posix.isAbsolute(target) ||
    win32.isAbsolute(target) ||
    target.split("/").includes("")
  ) {
    throw new SourceConnectorError(
      "unsafe_repository",
      "Repository symbolic link escapes or ambiguously addresses the checkout"
    )
  }
  const resolved = posix.normalize(posix.join(posix.dirname(path), target))
  if (resolved === ".." || resolved.startsWith("../")) {
    throw new SourceConnectorError(
      "unsafe_repository",
      "Repository symbolic link escapes the checkout"
    )
  }
}

function normalizedRemote(
  value: string,
  allowLocalRepositoriesForTests: boolean
): { readonly value: string; readonly local: boolean } {
  if (allowLocalRepositoriesForTests && isAbsolute(value)) {
    return { value: resolve(value), local: true }
  }
  const repository = parseGitHubRepository(value)
  return { value: githubCloneUrl(repository), local: false }
}

async function readSafeText(
  rootPath: string,
  entries: ReadonlyMap<string, CheckoutEntry>,
  pathInput: string,
  maxBytes: number,
  readBlob: (objectId: string, maxOutputBytes: number) => Promise<Buffer>
): Promise<string> {
  const path = normalizeRepositoryPath(pathInput)
  const entry = entries.get(path)
  if (entry === undefined || entry.kind !== "file") {
    throw new SourceConnectorError(
      "unsafe_path",
      "Requested repository path is not an exposed regular file"
    )
  }
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    entry.sizeBytes > maxBytes
  ) {
    throw limitError(
      "Requested repository file exceeds the configured byte limit"
    )
  }
  const root = resolve(rootPath)
  let candidate = root
  const components = path.split("/")
  for (const [index, component] of components.entries()) {
    candidate = join(candidate, component)
    assertContained(root, candidate)
    let status
    try {
      status = await lstat(candidate)
    } catch {
      throw new SourceConnectorError(
        "unsafe_path",
        "Requested repository path is unavailable"
      )
    }
    if (status.isSymbolicLink()) {
      throw new SourceConnectorError(
        "unsafe_path",
        "Symbolic links are not exposed to source adapters"
      )
    }
    if (index < components.length - 1 && !status.isDirectory()) {
      throw new SourceConnectorError(
        "unsafe_path",
        "Repository path component is not a directory"
      )
    }
    if (index === components.length - 1 && !status.isFile()) {
      throw new SourceConnectorError(
        "unsafe_path",
        "Requested repository path is not a regular file"
      )
    }
  }
  const bytes = await readBlob(
    entry.objectId,
    Math.min(entry.sizeBytes + 8_192, maxBytes + 8_192)
  )
  if (bytes.length !== entry.sizeBytes) {
    throw new SourceConnectorError(
      "unsafe_repository",
      "Git blob size did not match validated tree metadata"
    )
  }
  const algorithm = entry.objectId.length === 40 ? "sha1" : "sha256"
  const digest = createHash(algorithm)
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex")
  if (digest !== entry.objectId) {
    throw new SourceConnectorError(
      "unsafe_repository",
      "Git blob content did not match its immutable object identity"
    )
  }
  if (bytes.includes(0)) {
    throw new SourceConnectorError(
      "binary_file",
      "Binary repository files are not exposed as text"
    )
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new SourceConnectorError(
      "binary_file",
      "Repository file is not valid UTF-8 text"
    )
  }
}

export class EphemeralCheckoutManager {
  readonly limits: CheckoutLimits
  readonly registry: CheckoutLeaseRegistry
  private readonly runner: GitRunner
  private readonly allowLocalRepositoriesForTests: boolean

  constructor(options: EphemeralCheckoutManagerOptions = {}) {
    this.limits = checkoutLimitsSchema.parse({
      ...defaultCheckoutLimits,
      ...options.limits,
    })
    if (this.limits.maxFileBytes > this.limits.maxTotalBytes) {
      throw new SourceConnectorError(
        "invalid_input",
        "Per-file byte limit cannot exceed the repository byte limit"
      )
    }
    this.registry = options.registry ?? new CheckoutLeaseRegistry()
    this.runner = options.runner ?? new GitProcessRunner()
    this.allowLocalRepositoriesForTests =
      options.allowLocalRepositoriesForTests ?? false
  }

  private async git(
    args: readonly string[],
    cwd: string,
    request: CheckoutRequest,
    local: boolean,
    maxOutputBytes = this.limits.maxGitOutputBytes
  ): Promise<Buffer> {
    const credentials: GitCredentials = {
      ...(request.githubToken === undefined
        ? {}
        : { githubToken: request.githubToken }),
      ...(local ? { allowLocalFileRemote: true } : {}),
    }
    return await this.runner.run(args, {
      cwd,
      timeoutMs: this.limits.timeoutMs,
      credentials,
      maxOutputBytes,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
  }

  private async validateTree(
    objectsPath: string,
    ref: string,
    repository: GitHubRepositoryIdentity,
    commitSha: string,
    request: CheckoutRequest,
    local: boolean
  ): Promise<ValidatedTree> {
    const output = await this.git(
      ["ls-tree", "-r", "-z", "--long", ref],
      objectsPath,
      request,
      local
    )
    const entries = parseTreeEntries(output)
    if (entries.length > this.limits.maxFiles) {
      throw limitError(
        `Repository contains ${entries.length} entries; limit is ${this.limits.maxFiles}`
      )
    }
    let totalBytes = 0
    for (const entry of entries) {
      if (entry.sizeBytes > this.limits.maxTotalBytes - totalBytes) {
        throw limitError(
          `Repository content exceeds the configured limit of ${this.limits.maxTotalBytes} bytes`
        )
      }
      totalBytes += entry.sizeBytes
      if (entry.path.split("/").length > this.limits.maxDepth) {
        throw limitError(
          `Repository path depth exceeds the configured limit of ${this.limits.maxDepth}`
        )
      }
      if (entry.sizeBytes > this.limits.maxFileBytes) {
        throw limitError(
          `Repository file exceeds the configured limit of ${this.limits.maxFileBytes} bytes`
        )
      }
      if (entry.kind === "symlink") {
        assertSafeSymlink(
          entry.path,
          await this.git(
            ["cat-file", "blob", entry.objectId],
            objectsPath,
            request,
            local,
            8_192
          )
        )
      }
    }
    const treeObjectId = (
      await this.git(
        ["rev-parse", `${ref}^{tree}`],
        objectsPath,
        request,
        local,
        256
      )
    )
      .toString("utf8")
      .trim()
      .toLowerCase()
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(treeObjectId)) {
      throw new SourceConnectorError(
        "unsafe_repository",
        "Git returned an invalid tree object identity"
      )
    }
    const configuration = entries
      .filter(
        (entry) =>
          entry.kind === "file" &&
          configBasenames.has(posix.basename(entry.path))
      )
      .map(({ objectId, path, sizeBytes }) => ({ objectId, path, sizeBytes }))
    return {
      entries,
      treeObjectId,
      treeFingerprint: hashCanonical({ commitSha, repository, treeObjectId }),
      configFingerprint: hashCanonical({
        commitSha,
        configuration,
        repository,
      }),
      totalBytes,
    }
  }

  async materialize(request: CheckoutRequest): Promise<EphemeralCheckout> {
    if (
      request.targets.length < 1 ||
      request.targets.length > this.limits.maxTargets
    ) {
      throw limitError(
        `Checkout target count must be between 1 and ${this.limits.maxTargets}`
      )
    }
    if (
      request.githubToken !== undefined &&
      (request.githubToken.length < 1 || request.githubToken.length > 2_048)
    ) {
      throw new SourceConnectorError("invalid_input", "GitHub token is invalid")
    }
    if (request.repository.host !== "github.com") {
      throw new SourceConnectorError(
        "invalid_input",
        "Checkout repository must be hosted on github.com"
      )
    }
    const repository = parseGitHubRepository(
      `${request.repository.owner}/${request.repository.name}`
    )
    const labels = new Set<string>()
    const targets = request.targets.map((target) => {
      if (!labelPattern.test(target.label) || labels.has(target.label)) {
        throw new SourceConnectorError(
          "invalid_input",
          "Checkout target label is invalid or duplicated"
        )
      }
      labels.add(target.label)
      const remote = normalizedRemote(
        target.remoteUrl ?? githubCloneUrl(repository),
        this.allowLocalRepositoriesForTests
      )
      if (
        !remote.local &&
        (target.preflight === undefined ||
          !isVerifiedTreePreflight(target.preflight))
      ) {
        throw new SourceConnectorError(
          "invalid_input",
          "GitHub checkout requires bounded recursive tree metadata before fetch"
        )
      }
      return {
        label: target.label,
        sha: normalizeCommitSha(target.sha),
        remote,
        ...(target.preflight === undefined
          ? {}
          : { preflight: validatePreflight(target.preflight, this.limits) }),
      }
    })
    if (request.signal?.aborted === true) {
      throw new SourceConnectorError("aborted", "Checkout was cancelled")
    }

    let lease: CheckoutLease | undefined
    try {
      lease = await this.registry.create()
      const objectsPath = join(lease.path, "objects.git")
      const templatePath = join(lease.path, "empty-git-template")
      await mkdir(templatePath, { mode: 0o700 })
      await this.git(
        ["init", "--bare", `--template=${templatePath}`, objectsPath],
        lease.path,
        request,
        false,
        1_024 * 1_024
      )

      const validated = new Map<string, ValidatedTree>()
      for (const [index, target] of targets.entries()) {
        const remoteName = `sentinel_${index}`
        await this.git(
          ["remote", "add", remoteName, target.remote.value],
          objectsPath,
          request,
          target.remote.local,
          1_024 * 1_024
        )
        const ref = `refs/sentinel/${target.label}`
        const objectFilter =
          target.preflight === undefined
            ? "blob:none"
            : `blob:limit=${target.preflight.maxFileBytes + 1}`
        await this.git(
          [
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            "--depth=1",
            `--filter=${objectFilter}`,
            remoteName,
            `${target.sha}:${ref}`,
          ],
          objectsPath,
          request,
          target.remote.local
        )
        const resolvedSha = (
          await this.git(
            ["rev-parse", `${ref}^{commit}`],
            objectsPath,
            request,
            target.remote.local,
            256
          )
        )
          .toString("utf8")
          .trim()
          .toLowerCase()
        if (resolvedSha !== target.sha) {
          throw new SourceConnectorError(
            "unsafe_repository",
            "Fetched commit did not match the requested immutable SHA"
          )
        }
        const tree = await this.validateTree(
          objectsPath,
          ref,
          repository,
          target.sha,
          request,
          target.remote.local
        )
        if (
          target.preflight !== undefined &&
          target.preflight.treeObjectId !== tree.treeObjectId
        ) {
          throw new SourceConnectorError(
            "unsafe_repository",
            "Fetched tree did not match the bounded GitHub metadata preflight"
          )
        }
        validated.set(target.label, tree)
      }

      const snapshots = new Map<string, CheckoutSnapshot>()
      for (const target of targets) {
        const tree = validated.get(target.label)
        if (tree === undefined) {
          throw new SourceConnectorError(
            "git_failed",
            "Validated checkout tree was unavailable"
          )
        }
        const checkoutPath = join(lease.path, target.label)
        await this.git(
          [
            "worktree",
            "add",
            "--detach",
            checkoutPath,
            `refs/sentinel/${target.label}`,
          ],
          objectsPath,
          request,
          target.remote.local
        )
        const entriesByPath = new Map(
          tree.entries.map((entry) => [entry.path, entry])
        )
        const metadata: CheckoutSnapshotMetadata = {
          label: target.label,
          commitSha: target.sha,
          treeObjectId: tree.treeObjectId,
          treeFingerprint: tree.treeFingerprint,
          configFingerprint: tree.configFingerprint,
          fileCount: tree.entries.length,
          totalBytes: tree.totalBytes,
        }
        snapshots.set(target.label, {
          metadata,
          path: checkoutPath,
          enumerate: (prefix = "") => {
            if (prefix.length === 0) return Object.freeze([...tree.entries])
            const normalizedPrefix = normalizeRepositoryPath(prefix)
            return Object.freeze(
              tree.entries.filter(
                (entry) =>
                  entry.path === normalizedPrefix ||
                  entry.path.startsWith(`${normalizedPrefix}/`)
              )
            )
          },
          readText: async (path, maxBytes = this.limits.maxFileBytes) =>
            await readSafeText(
              checkoutPath,
              entriesByPath,
              path,
              Math.min(maxBytes, this.limits.maxFileBytes),
              async (objectId, maxOutputBytes) =>
                await this.git(
                  ["cat-file", "blob", objectId],
                  objectsPath,
                  request,
                  target.remote.local,
                  maxOutputBytes
                )
            ),
        })
      }

      let disposed = false
      let disposePromise: Promise<void> | undefined
      const completedLease = lease
      return {
        leasePath: lease.path,
        snapshots,
        dispose: async () => {
          if (disposed) return
          disposePromise ??= completedLease
            .cleanup()
            .then(() => {
              disposed = true
            })
            .catch((error: unknown) => {
              disposePromise = undefined
              throw error
            })
          await disposePromise
        },
      }
    } catch (error) {
      if (lease !== undefined) {
        try {
          await lease.cleanup()
        } catch {
          // Preserve the source failure; the registry retains failed cleanup for retry.
        }
      }
      throw connectorError(
        error,
        "git_failed",
        request.githubToken === undefined ? [] : [request.githubToken]
      )
    }
  }

  async withCheckout<Result>(
    request: CheckoutRequest,
    callback: (checkout: EphemeralCheckout) => Promise<Result>
  ): Promise<Result> {
    const checkout = await this.materialize(request)
    let result: Result
    try {
      result = await callback(checkout)
    } catch (error) {
      try {
        await checkout.dispose()
      } catch {
        // Preserve the adapter failure; the registry retains cleanup for retry.
      }
      throw error
    }
    await checkout.dispose()
    return result
  }
}
