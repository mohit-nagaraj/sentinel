import { spawn } from "node:child_process"
import { devNull } from "node:os"

import { redactConnectorText, SourceConnectorError } from "./errors.ts"

export interface GitCredentials {
  readonly githubToken?: string
  readonly allowLocalFileRemote?: boolean
}

export interface GitRunOptions {
  readonly cwd?: string
  readonly signal?: AbortSignal
  readonly timeoutMs: number
  readonly credentials?: GitCredentials
  readonly maxOutputBytes?: number
}

export interface GitRunner {
  run(args: readonly string[], options: GitRunOptions): Promise<Buffer>
}

function gitEnvironment(credentials: GitCredentials = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_VALUE_0",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_WORK_TREE",
  ]) {
    delete environment[key]
  }
  environment["GIT_TERMINAL_PROMPT"] = "0"
  environment["GCM_INTERACTIVE"] = "Never"
  environment["GIT_ASKPASS"] = ""
  environment["GIT_CONFIG_NOSYSTEM"] = "1"
  environment["GIT_CONFIG_GLOBAL"] =
    process.platform === "win32" ? "NUL" : devNull

  const configuration: Array<readonly [string, string]> = [
    ["core.autocrlf", "false"],
    ["core.eol", "lf"],
    ["credential.helper", ""],
    ["fetch.recurseSubmodules", "false"],
    ["submodule.recurse", "false"],
    [
      "protocol.file.allow",
      credentials.allowLocalFileRemote === true ? "always" : "never",
    ],
  ]
  if (credentials.githubToken !== undefined) {
    const basic = Buffer.from(
      `x-access-token:${credentials.githubToken}`
    ).toString("base64")
    configuration.push([
      "http.https://github.com/.extraHeader",
      `AUTHORIZATION: basic ${basic}`,
    ])
  }
  environment["GIT_CONFIG_COUNT"] = String(configuration.length)
  configuration.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key
    environment[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return environment
}

function validateArguments(args: readonly string[]): void {
  if (
    args.length < 1 ||
    args.length > 64 ||
    args.some((argument) => argument.length > 4_096 || argument.includes("\0"))
  ) {
    throw new SourceConnectorError(
      "invalid_input",
      "Git command arguments are invalid"
    )
  }
}

export class GitProcessRunner implements GitRunner {
  async run(args: readonly string[], options: GitRunOptions): Promise<Buffer> {
    validateArguments(args)
    if (options.signal?.aborted === true) {
      throw new SourceConnectorError("aborted", "Git operation was cancelled")
    }
    const maxOutputBytes = options.maxOutputBytes ?? 16 * 1_024 * 1_024
    const secrets =
      options.credentials?.githubToken === undefined
        ? []
        : [options.credentials.githubToken]

    return await new Promise<Buffer>((resolve, reject) => {
      let settled = false
      let timedOut = false
      let aborted = false
      let outputBytes = 0
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const child = spawn("git", [...args], {
        cwd: options.cwd,
        env: gitEnvironment(options.credentials),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })

      const finish = (error?: SourceConnectorError, output?: Buffer): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", onAbort)
        if (error === undefined) resolve(output ?? Buffer.alloc(0))
        else reject(error)
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
      }, options.timeoutMs)
      timer.unref()
      options.signal?.addEventListener("abort", onAbort, { once: true })

      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length
        if (outputBytes > maxOutputBytes) {
          terminate()
          return
        }
        stdout.push(chunk)
      })
      child.stderr.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length
        if (outputBytes > maxOutputBytes) {
          terminate()
          return
        }
        stderr.push(chunk)
      })
      child.on("error", (error) => {
        finish(
          new SourceConnectorError(
            "git_failed",
            `Unable to start the Git process: ${error.message}`
          )
        )
      })
      child.on("close", (code) => {
        if (aborted) {
          finish(
            new SourceConnectorError("aborted", "Git operation was cancelled")
          )
          return
        }
        if (timedOut) {
          finish(
            new SourceConnectorError(
              "timeout",
              "Git operation exceeded its time limit",
              {
                retryable: true,
                compatibility: true,
              }
            )
          )
          return
        }
        if (outputBytes > maxOutputBytes) {
          finish(
            new SourceConnectorError(
              "limit_exceeded",
              "Git output exceeded the configured byte limit",
              { compatibility: true }
            )
          )
          return
        }
        if (code !== 0) {
          const detail = redactConnectorText(
            Buffer.concat(stderr).toString("utf8"),
            secrets
          )
          finish(
            new SourceConnectorError(
              "git_failed",
              detail.length > 0
                ? `Git read operation failed: ${detail}`
                : "Git read operation failed",
              { secrets }
            )
          )
          return
        }
        finish(undefined, Buffer.concat(stdout))
      })
    })
  }
}
