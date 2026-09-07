import { TypeScriptIndexerError, invalidIndexerInput } from "./errors.ts"

export type TypeScriptSourceEntryKind = "file" | "symlink"

/**
 * The subset of a SNT-007 `CheckoutSnapshot` the indexer is allowed to use.
 *
 * Declaring the port this narrowly is deliberate: the indexer has no filesystem,
 * network, or Git access, and a checkout snapshot is structurally assignable to
 * it without an adapter shim.
 */
export interface TypeScriptSourceEntry {
  readonly path: string
  readonly kind: TypeScriptSourceEntryKind
  readonly sizeBytes: number
}

export interface TypeScriptSourceReader {
  enumerate(prefix?: string): readonly TypeScriptSourceEntry[]
  readText(path: string, maxBytes?: number): Promise<string>
}

const controlCharacters = /[\u0000-\u001f\u007f]/

/**
 * Normalizes a repository-relative POSIX path. Mirrors the SNT-007 rules so a
 * path accepted here is also acceptable to a real checkout snapshot.
 */
export function normalizeIndexPath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    invalidIndexerInput("Repository path must be a non-empty string")
  }
  if (input.length > 2_048) {
    invalidIndexerInput("Repository path exceeds the maximum length")
  }
  if (controlCharacters.test(input)) {
    invalidIndexerInput("Repository path contains control characters")
  }
  if (input.includes("\\")) {
    invalidIndexerInput("Repository path must use forward slashes")
  }
  if (input.startsWith("/") || /^[A-Za-z]:/.test(input)) {
    invalidIndexerInput("Repository path must be relative")
  }
  const segments = input.split("/").filter((segment) => segment.length > 0)
  if (segments.length === 0) {
    invalidIndexerInput("Repository path must contain at least one segment")
  }
  for (const segment of segments) {
    if (segment === "..") {
      invalidIndexerInput("Repository path cannot traverse parents")
    }
    // A checkout snapshot only ever exposes already-normalized paths, so a
    // relative segment means the caller built the path some other way.
    if (segment === ".") {
      invalidIndexerInput("Repository path must already be normalized")
    }
    if (segment.toLowerCase() === ".git") {
      invalidIndexerInput("Repository path cannot reference Git internals")
    }
  }
  return segments.join("/")
}

/**
 * Normalizes a source-root prefix. Unlike a file path, the empty prefix is
 * meaningful and selects the whole repository.
 */
export function normalizeRootPrefix(input: string): string {
  const trimmed = input.trim()
  if (trimmed.length === 0 || trimmed === "." || trimmed === "/") return ""
  return normalizeIndexPath(trimmed.replace(/\/+$/, ""))
}

export function isWithinRoot(path: string, root: string): boolean {
  if (root.length === 0) return true
  return path === root || path.startsWith(`${root}/`)
}

export interface FakeSourceReaderOptions {
  /** Paths that should reject on read, simulating snapshot read failures. */
  readonly unreadablePaths?: readonly string[]
  /** Paths the snapshot exposes as symlinks rather than regular files. */
  readonly symlinkPaths?: readonly string[]
}

/**
 * In-memory test double for {@link TypeScriptSourceReader}, in the style of the
 * scripted model gateway. It enforces the same admission rules a real snapshot
 * does so unit tests cannot pass paths production would reject.
 */
export function createFakeSourceReader(
  files: Readonly<Record<string, string>>,
  options: FakeSourceReaderOptions = {}
): TypeScriptSourceReader {
  const symlinks = new Set(options.symlinkPaths ?? [])
  const unreadable = new Set(options.unreadablePaths ?? [])
  const encoder = new TextEncoder()
  const entries: TypeScriptSourceEntry[] = Object.entries(files)
    .map(([path, text]) => ({
      path: normalizeIndexPath(path),
      kind: (symlinks.has(path)
        ? "symlink"
        : "file") satisfies TypeScriptSourceEntryKind as TypeScriptSourceEntryKind,
      sizeBytes: encoder.encode(text).byteLength,
    }))
    .sort((left, right) => (left.path < right.path ? -1 : 1))
  const contents = new Map(
    Object.entries(files).map(([path, text]) => [
      normalizeIndexPath(path),
      text,
    ])
  )
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))

  return {
    enumerate: (prefix = "") => {
      const root = normalizeRootPrefix(prefix)
      return Object.freeze(
        entries.filter((entry) => isWithinRoot(entry.path, root))
      )
    },
    readText: async (path, maxBytes) => {
      const normalized = normalizeIndexPath(path)
      const entry = byPath.get(normalized)
      const text = contents.get(normalized)
      if (entry === undefined || text === undefined) {
        throw new TypeScriptIndexerError(
          "unsafe_path",
          "Requested repository path is not an exposed regular file"
        )
      }
      if (entry.kind !== "file" || unreadable.has(normalized)) {
        throw new TypeScriptIndexerError(
          "unsafe_path",
          "Requested repository path is not an exposed regular file"
        )
      }
      if (maxBytes !== undefined && entry.sizeBytes > maxBytes) {
        throw new TypeScriptIndexerError(
          "limit_exceeded",
          "Requested repository file exceeds the read budget",
          { compatibility: true }
        )
      }
      return text
    },
  }
}
