import { execFile } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export interface GitRepositoryFixture {
  readonly rootPath: string
  readonly workPath: string
  readonly barePath: string
  readonly baseSha: string
  readonly headSha: string
  readonly unsafeSymlinkSha: string
  readonly submoduleSha: string
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    windowsHide: true,
  })
  return result.stdout.trim()
}

async function commit(cwd: string, message: string): Promise<string> {
  await git(cwd, "commit", "-m", message)
  return await git(cwd, "rev-parse", "HEAD")
}

export async function createGitRepositoryFixture(): Promise<GitRepositoryFixture> {
  const rootPath = await mkdtemp(join(tmpdir(), "sentinel-git-fixture-"))
  const workPath = join(rootPath, "source")
  const barePath = join(rootPath, "fixture.git")
  await mkdir(workPath)
  await git(workPath, "init", "--initial-branch=main")
  await git(workPath, "config", "user.email", "sentinel-tests@example.invalid")
  await git(workPath, "config", "user.name", "Sentinel Tests")

  await mkdir(join(workPath, "safe"))
  await writeFile(join(workPath, "old-name.txt"), "base content\n")
  await writeFile(join(workPath, "deleted.txt"), "delete me\n")
  await writeFile(join(workPath, ".gitattributes"), "*.txt text eol=crlf\n")
  await writeFile(join(workPath, "safe", "nested.txt"), "nested source\n")
  await writeFile(join(workPath, "binary.dat"), Buffer.from([0, 1, 2, 3]))
  await writeFile(
    join(workPath, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0" })
  )
  await git(workPath, "add", ".")
  const baseSha = await commit(workPath, "base")

  await git(workPath, "switch", "-c", "feature")
  await git(workPath, "mv", "old-name.txt", "new-name.txt")
  await git(workPath, "rm", "deleted.txt")
  await writeFile(join(workPath, "new-name.txt"), "head content\n")
  await git(workPath, "add", ".")
  const headSha = await commit(workPath, "rename and delete")

  await git(workPath, "switch", "-c", "unsafe-symlink", "main")
  await writeFile(join(workPath, "escape-link"), "../outside.txt")
  const linkBlob = await git(workPath, "hash-object", "-w", "escape-link")
  await git(
    workPath,
    "update-index",
    "--add",
    "--cacheinfo",
    `120000,${linkBlob},escape-link`
  )
  const unsafeSymlinkSha = await commit(workPath, "unsafe symlink")

  await git(workPath, "switch", "--force", "-c", "submodule", "main")
  await git(
    workPath,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${baseSha},vendor/module`
  )
  const submoduleSha = await commit(workPath, "gitlink")

  await git(rootPath, "init", "--bare", barePath)
  await git(workPath, "remote", "add", "fixture", barePath)
  await git(workPath, "push", "--all", "fixture")
  return {
    rootPath,
    workPath,
    barePath,
    baseSha,
    headSha,
    unsafeSymlinkSha,
    submoduleSha,
  }
}
