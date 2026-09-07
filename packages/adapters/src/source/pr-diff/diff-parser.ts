import {
  changedFileClassificationSchema,
  changedFileUnresolvedReasonSchema,
  hashCanonical,
  type ContentHash,
} from "@sentinel/contracts"
import type { z } from "zod"

import { normalizeRepositoryPath } from "../github/normalization.ts"
import { PrDiffError } from "./errors.ts"
import {
  prDiffLimit,
  resolvePrDiffLimits,
  type PrDiffLimits,
} from "./limits.ts"

export type DiffFileOperation = "added" | "modified" | "deleted" | "renamed"
export type ChangedFileClassification = z.infer<
  typeof changedFileClassificationSchema
>
export type ChangedFileUnresolvedReason = z.infer<
  typeof changedFileUnresolvedReasonSchema
>

export interface DiffRange {
  readonly startLine: number
  readonly endLine: number
}

export interface ParsedDiffLine {
  readonly kind: "context" | "added" | "deleted" | "no_newline"
  readonly text: string
}

export interface ParsedDiffHunk {
  readonly baseStart: number
  readonly baseCount: number
  readonly headStart: number
  readonly headCount: number
  readonly baseRanges: readonly DiffRange[]
  readonly headRanges: readonly DiffRange[]
  readonly lines: readonly ParsedDiffLine[]
}

export interface ParsedDiffFile {
  readonly operation: DiffFileOperation
  readonly oldPath: string | undefined
  readonly newPath: string | undefined
  readonly oldMode: string | undefined
  readonly newMode: string | undefined
  readonly similarity: number | undefined
  readonly language: "typescript" | "tsx" | "php" | undefined
  readonly classifications: readonly ChangedFileClassification[]
  readonly binary: boolean
  readonly patchAvailable: boolean
  readonly noNewlineAtEnd: boolean
  readonly baseRanges: readonly DiffRange[]
  readonly headRanges: readonly DiffRange[]
  readonly hunks: readonly ParsedDiffHunk[]
  readonly unresolvedReasons: readonly ChangedFileUnresolvedReason[]
}

export interface ParsedDiff {
  readonly diffHash: ContentHash
  readonly files: readonly ParsedDiffFile[]
}

export interface GitHubPullFileInput {
  readonly filename: string
  readonly previousFilename?: string
  readonly status: "added" | "modified" | "removed" | "renamed" | "copied"
  readonly patch?: string
  readonly binary?: boolean
}

interface MutableFile {
  operation: DiffFileOperation
  oldPath: string | undefined
  newPath: string | undefined
  oldMode: string | undefined
  newMode: string | undefined
  similarity: number | undefined
  binary: boolean
  patchAvailable: boolean
  noNewlineAtEnd: boolean
  hunks: ParsedDiffHunk[]
  copied: boolean
}

const hunkHeaderPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/
const modePattern = /^[0-7]{6}$/
const lockfiles = new Set([
  "bun.lock",
  "bun.lockb",
  "composer.lock",
  "deno.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
])
const configurationBasenames = new Set([
  ".editorconfig",
  ".env.example",
  ".gitattributes",
  ".gitignore",
  "dockerfile",
  "composer.json",
  "eslint.config.js",
  "eslint.config.mjs",
  "package.json",
  "phpstan.neon",
  "phpstan.neon.dist",
  "phpunit.xml",
  "playwright.config.ts",
  "prettier.config.js",
  "tsconfig.json",
  "vitest.config.ts",
])

function malformed(message: string): never {
  throw new PrDiffError("malformed_diff", message)
}

function compareStrings(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"))
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort(compareStrings))
}

function normalizePath(input: string): string {
  try {
    return normalizeRepositoryPath(input)
  } catch {
    throw new PrDiffError("malformed_diff", "Diff contains an unsafe path")
  }
}

function decodeQuotedPath(input: string): string {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"'))
    malformed("Diff contains an unterminated quoted path")
  const bytes: number[] = []
  const value = input.slice(1, -1)
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (character !== "\\") {
      bytes.push(...Buffer.from(character, "utf8"))
      continue
    }
    const escaped = value[++index]
    if (escaped === undefined) malformed("Diff path ends in an escape")
    const mapping: Readonly<Record<string, number>> = {
      "\\": 0x5c,
      '"': 0x22,
      a: 0x07,
      b: 0x08,
      f: 0x0c,
      n: 0x0a,
      r: 0x0d,
      t: 0x09,
      v: 0x0b,
    }
    const mapped = mapping[escaped]
    if (mapped !== undefined) {
      bytes.push(mapped)
      continue
    }
    if (!/[0-7]/.test(escaped)) malformed("Diff path has an invalid escape")
    let octal = escaped
    while (octal.length < 3 && /[0-7]/.test(value[index + 1] ?? "")) {
      octal += value[++index]
    }
    bytes.push(Number.parseInt(octal, 8))
  }
  return Buffer.from(bytes).toString("utf8")
}

function parseHeaderPaths(line: string): readonly [string, string] {
  const body = line.slice("diff --git ".length)
  if (body.startsWith('"')) {
    let escaped = false
    let end = -1
    for (let index = 1; index < body.length; index += 1) {
      const character = body[index]!
      if (character === '"' && !escaped) {
        end = index
        break
      }
      escaped = character === "\\" && !escaped
      if (character !== "\\") escaped = false
    }
    if (end === -1 || body[end + 1] !== " ") malformed("Invalid diff header")
    const left = body.slice(0, end + 1)
    const right = body.slice(end + 2)
    return [decodeQuotedPath(left), decodeQuotedPath(right)]
  }
  const separator = body.lastIndexOf(" b/")
  if (!body.startsWith("a/") || separator < 0) malformed("Invalid diff header")
  return [body.slice(0, separator), body.slice(separator + 1)]
}

function stripSidePrefix(path: string, prefix: "a/" | "b/"): string {
  if (!path.startsWith(prefix))
    malformed("Diff header has an invalid side prefix")
  return normalizePath(path.slice(prefix.length))
}

function parseExtendedPath(value: string): string {
  return normalizePath(decodeQuotedPath(value))
}

function appendRange(ranges: DiffRange[], line: number): void {
  const previous = ranges.at(-1)
  if (previous !== undefined && previous.endLine + 1 === line) {
    ranges[ranges.length - 1] = { ...previous, endLine: line }
  } else {
    ranges.push({ startLine: line, endLine: line })
  }
}

function parseHunk(
  lines: readonly string[],
  startIndex: number
): { readonly hunk: ParsedDiffHunk; readonly nextIndex: number } {
  const match = hunkHeaderPattern.exec(lines[startIndex] ?? "")
  if (match === null) malformed("Invalid diff hunk header")
  const baseStart = Number(match[1])
  const baseCount = match[2] === undefined ? 1 : Number(match[2])
  const headStart = Number(match[3])
  const headCount = match[4] === undefined ? 1 : Number(match[4])
  let baseLine = baseStart
  let headLine = headStart
  let consumedBase = 0
  let consumedHead = 0
  let index = startIndex + 1
  const baseRanges: DiffRange[] = []
  const headRanges: DiffRange[] = []
  const hunkLines: ParsedDiffLine[] = []
  while (index < lines.length) {
    const line = lines[index]!
    if (line.startsWith("diff --git ") || line.startsWith("@@ ")) break
    const prefix = line[0]
    if (prefix === " ") {
      hunkLines.push({ kind: "context", text: line.slice(1) })
      baseLine += 1
      headLine += 1
      consumedBase += 1
      consumedHead += 1
    } else if (prefix === "-") {
      hunkLines.push({ kind: "deleted", text: line.slice(1) })
      appendRange(baseRanges, baseLine)
      baseLine += 1
      consumedBase += 1
    } else if (prefix === "+") {
      hunkLines.push({ kind: "added", text: line.slice(1) })
      appendRange(headRanges, headLine)
      headLine += 1
      consumedHead += 1
    } else if (line === "\\ No newline at end of file") {
      hunkLines.push({ kind: "no_newline", text: "" })
    } else {
      break
    }
    index += 1
  }
  if (consumedBase !== baseCount || consumedHead !== headCount) {
    malformed("Diff hunk body does not match its declared line counts")
  }
  return {
    hunk: Object.freeze({
      baseStart,
      baseCount,
      headStart,
      headCount,
      baseRanges: Object.freeze(baseRanges),
      headRanges: Object.freeze(headRanges),
      lines: Object.freeze(hunkLines),
    }),
    nextIndex: index,
  }
}

function languageFor(path: string): ParsedDiffFile["language"] {
  const lower = path.toLowerCase()
  if (lower.endsWith(".tsx")) return "tsx"
  if (lower.endsWith(".ts")) return "typescript"
  if (lower.endsWith(".php")) return "php"
  return undefined
}

function classifyFile(file: MutableFile): {
  readonly language: ParsedDiffFile["language"]
  readonly classifications: readonly ChangedFileClassification[]
  readonly unresolvedReasons: readonly ChangedFileUnresolvedReason[]
} {
  const path = (file.newPath ?? file.oldPath)!
  const lower = path.toLowerCase()
  const basename = lower.split("/").at(-1)!
  const language = languageFor(path)
  const classifications: ChangedFileClassification[] = []
  const reasons: ChangedFileUnresolvedReason[] = []
  if (language !== undefined) classifications.push("source")
  if (
    configurationBasenames.has(basename) ||
    /\.(?:ini|jsonc|toml|ya?ml)$/.test(lower) ||
    /(?:^|\/)(?:config|\.github)(?:\/|$)/.test(lower)
  ) {
    classifications.push("configuration")
  }
  if (
    /(?:^|\/)(?:database\/)?migrations?(?:\/|$)/.test(lower) ||
    /\.(?:graphql|prisma|sql)$/.test(lower) ||
    /(?:^|\/)openapi\.(?:json|ya?ml)$/.test(lower)
  ) {
    classifications.push("schema")
  }
  if (lockfiles.has(basename)) {
    classifications.push("lockfile")
    reasons.push("lockfile")
  }
  if (
    /(?:^|\/)(?:dist|build|coverage|generated|node_modules|vendor)(?:\/|$)/.test(
      lower
    ) ||
    /(?:\.d\.tsx?$|\.generated\.|\.min\.(?:css|js|ts)$)/.test(lower)
  ) {
    classifications.push("generated")
    reasons.push("generated_file")
  }
  if (file.binary) {
    classifications.push("binary")
    reasons.push("binary_file")
  }
  if (language === undefined) {
    classifications.push("unsupported")
    reasons.push("unsupported_language")
  }
  if (!file.patchAvailable) reasons.push("patch_unavailable")
  if (
    file.hunks.length === 0 &&
    !file.binary &&
    file.patchAvailable &&
    file.operation === "modified"
  ) {
    reasons.push("no_changed_ranges")
  }
  if (file.copied) reasons.push("copied_file")
  return {
    language,
    classifications: uniqueSorted(classifications),
    unresolvedReasons: uniqueSorted(reasons),
  }
}

function finalizeFile(file: MutableFile): ParsedDiffFile {
  const baseRanges = file.hunks.flatMap((hunk) => hunk.baseRanges)
  const headRanges = file.hunks.flatMap((hunk) => hunk.headRanges)
  const classified = classifyFile(file)
  return Object.freeze({
    operation: file.operation,
    oldPath: file.oldPath,
    newPath: file.newPath,
    oldMode: file.oldMode,
    newMode: file.newMode,
    similarity: file.similarity,
    language: classified.language,
    classifications: classified.classifications,
    binary: file.binary,
    patchAvailable: file.patchAvailable,
    noNewlineAtEnd: file.noNewlineAtEnd,
    baseRanges: Object.freeze(baseRanges),
    headRanges: Object.freeze(headRanges),
    hunks: Object.freeze(file.hunks),
    unresolvedReasons: classified.unresolvedReasons,
  })
}

function normalizedHash(files: readonly ParsedDiffFile[]): ContentHash {
  return hashCanonical({
    kind: "pr_diff",
    version: 1,
    files: files.map((file) => ({
      operation: file.operation,
      oldPath: file.oldPath ?? null,
      newPath: file.newPath ?? null,
      oldMode: file.oldMode ?? null,
      newMode: file.newMode ?? null,
      similarity: file.similarity ?? null,
      binary: file.binary,
      patchAvailable: file.patchAvailable,
      noNewlineAtEnd: file.noNewlineAtEnd,
      hunks: file.hunks,
    })),
  })
}

function enforceLimits(
  files: readonly ParsedDiffFile[],
  limits: PrDiffLimits
): void {
  if (files.length > limits.maxFiles) prDiffLimit("PR diff file limit exceeded")
  let changedLines = 0
  for (const file of files) {
    if (file.hunks.length > limits.maxHunksPerFile) {
      prDiffLimit("PR diff hunk limit exceeded")
    }
    for (const hunk of file.hunks) {
      changedLines += hunk.lines.filter(
        ({ kind }) => kind === "added" || kind === "deleted"
      ).length
      if (changedLines > limits.maxChangedLines) {
        prDiffLimit("PR diff changed-line limit exceeded")
      }
    }
  }
}

function sortFiles(
  files: readonly ParsedDiffFile[]
): readonly ParsedDiffFile[] {
  return Object.freeze(
    [...files].sort((left, right) =>
      compareStrings(
        `${left.newPath ?? left.oldPath ?? ""}\0${left.oldPath ?? ""}`,
        `${right.newPath ?? right.oldPath ?? ""}\0${right.oldPath ?? ""}`
      )
    )
  )
}

export function parseGitDiff(
  input: string,
  options: Partial<PrDiffLimits> = {}
): ParsedDiff {
  const limits = resolvePrDiffLimits(options)
  if (Buffer.byteLength(input, "utf8") > limits.maxPatchBytes) {
    prDiffLimit("PR diff patch byte limit exceeded")
  }
  const lines = input.replace(/\r\n?/g, "\n").split("\n")
  const files: ParsedDiffFile[] = []
  let current: MutableFile | undefined
  let index = 0
  const finish = (): void => {
    if (current === undefined) return
    files.push(finalizeFile(current))
    current = undefined
  }
  while (index < lines.length) {
    const line = lines[index]!
    if (line.length === 0) {
      index += 1
      continue
    }
    if (line.startsWith("diff --git ")) {
      finish()
      const [left, right] = parseHeaderPaths(line)
      current = {
        operation: "modified",
        oldPath: stripSidePrefix(left, "a/"),
        newPath: stripSidePrefix(right, "b/"),
        oldMode: undefined,
        newMode: undefined,
        similarity: undefined,
        binary: false,
        patchAvailable: true,
        noNewlineAtEnd: false,
        hunks: [],
        copied: false,
      }
      index += 1
      continue
    }
    if (current === undefined)
      malformed("Diff content appears before a file header")
    if (line.startsWith("new file mode ")) {
      const mode = line.slice("new file mode ".length)
      if (!modePattern.test(mode)) malformed("Invalid new file mode")
      current.operation = "added"
      current.oldPath = undefined
      current.newMode = mode
    } else if (line.startsWith("deleted file mode ")) {
      const mode = line.slice("deleted file mode ".length)
      if (!modePattern.test(mode)) malformed("Invalid deleted file mode")
      current.operation = "deleted"
      current.newPath = undefined
      current.oldMode = mode
    } else if (line.startsWith("old mode ")) {
      const mode = line.slice("old mode ".length)
      if (!modePattern.test(mode)) malformed("Invalid old mode")
      current.oldMode = mode
    } else if (line.startsWith("new mode ")) {
      const mode = line.slice("new mode ".length)
      if (!modePattern.test(mode)) malformed("Invalid new mode")
      current.newMode = mode
    } else if (line.startsWith("similarity index ")) {
      const match = /^(\d{1,3})%$/.exec(line.slice("similarity index ".length))
      if (match === null || Number(match[1]) > 100)
        malformed("Invalid similarity index")
      current.similarity = Number(match[1])
    } else if (line.startsWith("rename from ")) {
      current.operation = "renamed"
      current.oldPath = parseExtendedPath(line.slice("rename from ".length))
    } else if (line.startsWith("rename to ")) {
      current.operation = "renamed"
      current.newPath = parseExtendedPath(line.slice("rename to ".length))
    } else if (line.startsWith("copy from ")) {
      parseExtendedPath(line.slice("copy from ".length))
      current.operation = "added"
      current.oldPath = undefined
      current.copied = true
    } else if (line.startsWith("copy to ")) {
      current.newPath = parseExtendedPath(line.slice("copy to ".length))
      current.copied = true
    } else if (
      line.startsWith("Binary files ") ||
      line === "GIT binary patch"
    ) {
      current.binary = true
    } else if (line.startsWith("@@ ")) {
      const parsed = parseHunk(lines, index)
      current.hunks.push(parsed.hunk)
      if (parsed.hunk.lines.some(({ kind }) => kind === "no_newline")) {
        current.noNewlineAtEnd = true
      }
      index = parsed.nextIndex
      continue
    } else if (
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("dissimilarity index ")
    ) {
      // Identity and display headers are deliberately excluded from persisted output.
    } else if (current.binary) {
      // `--binary` payload lines are intentionally opaque; the file-level binary
      // marker is sufficient evidence and avoids retaining encoded blob content.
    } else {
      malformed("Unsupported diff file header or body line")
    }
    index += 1
  }
  finish()
  const ordered = sortFiles(files)
  enforceLimits(ordered, limits)
  return Object.freeze({ diffHash: normalizedHash(ordered), files: ordered })
}

export function parseGitHubPullFiles(
  inputs: readonly GitHubPullFileInput[],
  options: Partial<PrDiffLimits> = {}
): ParsedDiff {
  const limits = resolvePrDiffLimits(options)
  if (inputs.length > limits.maxFiles)
    prDiffLimit("PR diff file limit exceeded")
  const patchBytes = inputs.reduce(
    (total, input) => total + Buffer.byteLength(input.patch ?? "", "utf8"),
    0
  )
  if (patchBytes > limits.maxPatchBytes) {
    prDiffLimit("PR diff patch byte limit exceeded")
  }
  const files = inputs.map((input): ParsedDiffFile => {
    const filename = normalizePath(input.filename)
    const previous =
      input.previousFilename === undefined
        ? undefined
        : normalizePath(input.previousFilename)
    if (input.status === "renamed" && previous === undefined) {
      throw new PrDiffError(
        "invalid_input",
        "A renamed GitHub file requires previousFilename"
      )
    }
    let operation: DiffFileOperation
    if (input.status === "added" || input.status === "copied")
      operation = "added"
    else if (input.status === "removed") operation = "deleted"
    else if (input.status === "renamed") operation = "renamed"
    else operation = "modified"
    const oldPath =
      operation === "added"
        ? undefined
        : operation === "renamed"
          ? previous
          : filename
    const newPath = operation === "deleted" ? undefined : filename
    const patchAvailable = input.patch !== undefined || operation === "renamed"
    const synthetic = parseGitDiff(
      [
        `diff --git a/${oldPath ?? filename} b/${newPath ?? filename}`,
        operation === "added" ? "new file mode 100644" : "",
        operation === "deleted" ? "deleted file mode 100644" : "",
        operation === "renamed" ? `rename from ${oldPath}` : "",
        operation === "renamed" ? `rename to ${newPath}` : "",
        input.binary === true ? "Binary files differ" : "",
        input.patch ?? "",
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
      limits
    ).files[0]
    if (synthetic === undefined)
      malformed("GitHub file could not be normalized")
    const mutable: MutableFile = {
      operation: synthetic.operation,
      oldPath: synthetic.oldPath,
      newPath: synthetic.newPath,
      oldMode: synthetic.oldMode,
      newMode: synthetic.newMode,
      similarity: synthetic.similarity,
      binary: synthetic.binary,
      patchAvailable,
      noNewlineAtEnd: synthetic.noNewlineAtEnd,
      hunks: [...synthetic.hunks],
      copied: input.status === "copied",
    }
    return finalizeFile(mutable)
  })
  const ordered = sortFiles(files)
  enforceLimits(ordered, limits)
  return Object.freeze({ diffHash: normalizedHash(ordered), files: ordered })
}
