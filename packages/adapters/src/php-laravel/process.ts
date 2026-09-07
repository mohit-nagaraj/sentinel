import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { access, lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { contentHashSchema } from "@sentinel/contracts"

import type { CheckoutSnapshot } from "../source/github/checkout.ts"
import { normalizeRepositoryPath } from "../source/github/normalization.ts"
import { PhpIndexerError } from "./errors.ts"
import {
  PHP_INDEXER_SCHEMA_VERSION,
  phpIndexerLimitsSchema,
  phpIndexerResponseSchema,
  type PhpIndexerLimits,
  type PhpIndexerResponse,
} from "./schema.ts"

export const defaultPhpIndexerLimits: PhpIndexerLimits = {
  maxFiles: 2_000,
  maxFileBytes: 2 * 1_024 * 1_024,
  maxTotalBytes: 64 * 1_024 * 1_024,
  maxPathDepth: 40,
  maxFacts: 100_000,
  maxStringLength: 4_096,
  maxRequestBytes: 1024 * 1024,
  maxOutputBytes: 32 * 1_024 * 1_024,
  maxStderrBytes: 64 * 1_024,
  timeoutMs: 120_000,
}

export interface PhpLaravelIndexerOptions {
  readonly phpExecutable?: string
  readonly cliPath?: string
  readonly limits?: Partial<PhpIndexerLimits>
}

export interface PhpIndexRequest {
  readonly rootPath: string
  readonly files: readonly string[]
  readonly expectedContentHashes: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

function defaultCliPath(): string {
  return fileURLToPath(
    new URL("../../../../tools/php-indexer/bin/index.php", import.meta.url)
  )
}

function safeProcessEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...(process.env["PATH"] === undefined ? {} : { PATH: process.env["PATH"] }),
    ...(process.env["SystemRoot"] === undefined
      ? {}
      : { SystemRoot: process.env["SystemRoot"] }),
    ...(process.env["WINDIR"] === undefined
      ? {}
      : { WINDIR: process.env["WINDIR"] }),
    ...(process.env["TEMP"] === undefined ? {} : { TEMP: process.env["TEMP"] }),
    ...(process.env["TMP"] === undefined ? {} : { TMP: process.env["TMP"] }),
  }
  environment["PHPRC"] = ""
  environment["PHP_INI_SCAN_DIR"] = ""
  return environment
}

function sha256Text(value: string): string {
  return contentHashSchema.parse(
    `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`
  )
}

function validatePaths(
  files: readonly string[],
  limits: PhpIndexerLimits
): string[] {
  if (files.length < 1 || files.length > limits.maxFiles) {
    throw new PhpIndexerError(
      "limit_exceeded",
      `PHP file count must be between 1 and ${limits.maxFiles}`,
      { compatibility: true }
    )
  }
  const unique = new Set<string>()
  for (const input of files) {
    let path: string
    try {
      path = normalizeRepositoryPath(input)
    } catch {
      throw new PhpIndexerError("unsafe_path", "PHP index path is unsafe")
    }
    if (!path.toLowerCase().endsWith(".php")) {
      throw new PhpIndexerError(
        "invalid_input",
        "PHP index paths must end in .php"
      )
    }
    if (path.split("/").length > limits.maxPathDepth) {
      throw new PhpIndexerError(
        "limit_exceeded",
        "PHP index path depth exceeds its limit",
        {
          compatibility: true,
        }
      )
    }
    if (unique.has(path)) {
      throw new PhpIndexerError(
        "invalid_input",
        "PHP index paths must be unique"
      )
    }
    unique.add(path)
  }
  return [...unique].sort((left, right) =>
    Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"))
  )
}

function assertContained(root: string, candidate: string): void {
  const offset = relative(root, candidate)
  if (
    offset === "" ||
    (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))
  ) {
    return
  }
  throw new PhpIndexerError(
    "unsafe_path",
    "PHP source root escaped its boundary"
  )
}

async function normalizeRoot(rootInput: string): Promise<string> {
  if (!isAbsolute(rootInput)) {
    throw new PhpIndexerError(
      "invalid_input",
      "PHP source root must be absolute"
    )
  }
  const configuredRoot = resolve(rootInput)
  const configuredStatus = await lstat(configuredRoot).catch(() => {
    throw new PhpIndexerError("unsafe_path", "PHP source root is unavailable")
  })
  if (!configuredStatus.isDirectory() || configuredStatus.isSymbolicLink()) {
    throw new PhpIndexerError(
      "unsafe_path",
      "PHP source root must be a real directory"
    )
  }
  const root = await realpath(configuredRoot)
  assertContained(root, root)
  return root
}

function parseResponse(
  output: Buffer,
  requestedPaths: readonly string[],
  expectedHashes: Readonly<Record<string, string>>,
  limits: PhpIndexerLimits
): PhpIndexerResponse {
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output))
  } catch {
    throw new PhpIndexerError(
      "malformed_output",
      "PHP indexer returned invalid JSON"
    )
  }
  const parsed = phpIndexerResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new PhpIndexerError(
      "malformed_output",
      "PHP indexer output failed contract validation"
    )
  }
  const paths = parsed.data.files.map((file) => file.path)
  if (
    paths.length !== requestedPaths.length ||
    paths.some((path, index) => path !== requestedPaths[index])
  ) {
    throw new PhpIndexerError(
      "malformed_output",
      "PHP indexer output files did not match the request"
    )
  }
  let facts = 0
  for (const file of parsed.data.files) {
    facts +=
      file.symbols.length + file.relationships.length + file.routes.length
    if (facts > limits.maxFacts) {
      throw new PhpIndexerError(
        "limit_exceeded",
        "PHP index facts exceed their limit",
        {
          compatibility: true,
        }
      )
    }
    const expected = contentHashSchema.safeParse(expectedHashes[file.path])
    if (!expected.success || expected.data !== file.contentHash) {
      throw new PhpIndexerError(
        "content_mismatch",
        "PHP source changed or was transformed before indexing"
      )
    }
  }
  return deepFreeze(parsed.data)
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value
  }
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

export class PhpLaravelIndexer {
  readonly limits: PhpIndexerLimits
  private readonly phpExecutable: string
  private readonly cliPath: string

  constructor(options: PhpLaravelIndexerOptions = {}) {
    this.limits = phpIndexerLimitsSchema.parse({
      ...defaultPhpIndexerLimits,
      ...options.limits,
    })
    if (this.limits.maxFileBytes > this.limits.maxTotalBytes) {
      throw new PhpIndexerError(
        "invalid_input",
        "PHP per-file byte limit cannot exceed the total byte limit"
      )
    }
    this.phpExecutable =
      options.phpExecutable ?? process.env["SENTINEL_PHP_EXECUTABLE"] ?? "php"
    this.cliPath = resolve(options.cliPath ?? defaultCliPath())
    if (
      this.phpExecutable.length < 1 ||
      this.phpExecutable.length > 4_096 ||
      this.phpExecutable.includes("\0")
    ) {
      throw new PhpIndexerError("invalid_input", "PHP executable is invalid")
    }
  }

  async index(request: PhpIndexRequest): Promise<PhpIndexerResponse> {
    if (request.signal?.aborted === true) {
      throw new PhpIndexerError("aborted", "PHP indexing was cancelled")
    }
    const root = await normalizeRoot(request.rootPath)
    const files = validatePaths(request.files, this.limits)
    await access(this.cliPath).catch(() => {
      throw new PhpIndexerError(
        "executable_missing",
        "PHP indexer CLI is unavailable"
      )
    })
    const payload = Buffer.from(
      JSON.stringify({
        schemaVersion: PHP_INDEXER_SCHEMA_VERSION,
        root,
        files,
        limits: {
          maxFiles: this.limits.maxFiles,
          maxFileBytes: this.limits.maxFileBytes,
          maxTotalBytes: this.limits.maxTotalBytes,
          maxPathDepth: this.limits.maxPathDepth,
          maxFacts: this.limits.maxFacts,
          maxStringLength: this.limits.maxStringLength,
          maxRequestBytes: this.limits.maxRequestBytes,
          timeoutMs: this.limits.timeoutMs,
        },
      }),
      "utf8"
    )
    if (payload.length > this.limits.maxRequestBytes) {
      throw new PhpIndexerError(
        "limit_exceeded",
        "PHP index request exceeds its byte limit",
        {
          compatibility: true,
        }
      )
    }

    return await new Promise<PhpIndexerResponse>(
      (resolvePromise, rejectPromise) => {
        let settled = false
        let aborted = false
        let timedOut = false
        let outputExceeded = false
        let stdoutBytes = 0
        let stderrBytes = 0
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        const child = spawn(
          this.phpExecutable,
          ["-n", "-d", "memory_limit=256M", this.cliPath],
          {
            cwd: dirname(dirname(this.cliPath)),
            env: safeProcessEnvironment(),
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          }
        )
        const finish = (
          error?: PhpIndexerError,
          result?: PhpIndexerResponse
        ): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          request.signal?.removeEventListener("abort", onAbort)
          if (error !== undefined) rejectPromise(error)
          else if (result !== undefined) resolvePromise(result)
          else
            rejectPromise(
              new PhpIndexerError(
                "process_failed",
                "PHP indexer produced no result"
              )
            )
        }
        const terminate = (): void => {
          if (child.exitCode === null) child.kill("SIGKILL")
        }
        const onAbort = (): void => {
          aborted = true
          terminate()
        }
        const timer = setTimeout(() => {
          timedOut = true
          terminate()
        }, this.limits.timeoutMs)
        timer.unref()
        request.signal?.addEventListener("abort", onAbort, { once: true })

        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.length
          if (stdoutBytes > this.limits.maxOutputBytes) {
            outputExceeded = true
            terminate()
            return
          }
          stdout.push(chunk)
        })
        child.stderr.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.length
          if (stderrBytes > this.limits.maxStderrBytes) {
            outputExceeded = true
            terminate()
            return
          }
          stderr.push(chunk)
        })
        child.on("error", (error: NodeJS.ErrnoException) => {
          finish(
            new PhpIndexerError(
              error.code === "ENOENT" ? "executable_missing" : "process_failed",
              error.code === "ENOENT"
                ? "PHP executable is unavailable"
                : "Unable to start the PHP indexer"
            )
          )
        })
        child.stdin.on("error", () => undefined)
        child.stdin.end(payload)
        child.on("close", (code) => {
          if (aborted) {
            finish(new PhpIndexerError("aborted", "PHP indexing was cancelled"))
            return
          }
          if (timedOut) {
            finish(
              new PhpIndexerError(
                "timeout",
                "PHP indexing exceeded its time limit",
                {
                  retryable: true,
                  compatibility: true,
                }
              )
            )
            return
          }
          if (outputExceeded) {
            finish(
              new PhpIndexerError(
                "limit_exceeded",
                "PHP indexer output exceeded its limit",
                {
                  compatibility: true,
                }
              )
            )
            return
          }
          if (code !== 0) {
            const detail = Buffer.concat(stderr).toString("utf8").trim()
            const codeMatch =
              /^indexer_error:(invalid_input|limit_exceeded|unsafe_path|read_error|process_failed)$/.exec(
                detail
              )
            const mappedCode = codeMatch?.[1]
            finish(
              new PhpIndexerError(
                mappedCode === "invalid_input"
                  ? "invalid_input"
                  : mappedCode === "limit_exceeded"
                    ? "limit_exceeded"
                    : mappedCode === "unsafe_path"
                      ? "unsafe_path"
                      : "process_failed",
                "PHP indexer process failed",
                {
                  compatibility: mappedCode === "limit_exceeded",
                }
              )
            )
            return
          }
          try {
            finish(
              undefined,
              parseResponse(
                Buffer.concat(stdout),
                files,
                request.expectedContentHashes,
                this.limits
              )
            )
          } catch (error) {
            finish(
              error instanceof PhpIndexerError
                ? error
                : new PhpIndexerError(
                    "malformed_output",
                    "PHP indexer response was invalid"
                  )
            )
          }
        })
      }
    )
  }

  async indexCheckout(
    snapshot: CheckoutSnapshot,
    files: readonly string[],
    signal?: AbortSignal
  ): Promise<PhpIndexerResponse> {
    const normalized = validatePaths(files, this.limits)
    const expectedContentHashes: Record<string, string> = {}
    let totalBytes = 0
    for (const path of normalized) {
      const source = await snapshot.readText(path, this.limits.maxFileBytes)
      totalBytes += Buffer.byteLength(source, "utf8")
      if (totalBytes > this.limits.maxTotalBytes) {
        throw new PhpIndexerError(
          "limit_exceeded",
          "PHP source exceeds its total byte limit",
          {
            compatibility: true,
          }
        )
      }
      expectedContentHashes[path] = sha256Text(source)
    }
    return await this.index({
      rootPath: snapshot.path,
      files: normalized,
      expectedContentHashes,
      ...(signal === undefined ? {} : { signal }),
    })
  }
}
