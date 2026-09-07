import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { promisify } from "node:util"

import type { CheckoutEntry, CheckoutSnapshot } from "@sentinel/adapters"
import { commitShaSchema, type CommitSha } from "@sentinel/contracts"

const execFileAsync = promisify(execFile)

export interface PrDiffRepositoryFixture {
  readonly rootPath: string
  readonly workPath: string
  readonly staleGraphSha: CommitSha
  readonly safeGraphSha: CommitSha
  readonly baseSha: CommitSha
  readonly headSha: CommitSha
  readonly unrelatedSha: CommitSha
  readonly baseSnapshot: CheckoutSnapshot
  readonly headSnapshot: CheckoutSnapshot
  readonly unrelatedSnapshot: CheckoutSnapshot
  dispose(): Promise<void>
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

async function gitBuffer(cwd: string, ...args: string[]): Promise<Buffer> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "buffer",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    windowsHide: true,
  })
  return result.stdout
}

async function commit(cwd: string, message: string): Promise<CommitSha> {
  await git(cwd, "commit", "-m", message)
  return commitShaSchema.parse(await git(cwd, "rev-parse", "HEAD"))
}

async function snapshot(
  workPath: string,
  label: string,
  sha: CommitSha
): Promise<CheckoutSnapshot> {
  const treeObjectId = await git(workPath, "rev-parse", `${sha}^{tree}`)
  const raw = await gitBuffer(workPath, "ls-tree", "-r", "-l", "-z", sha)
  const entries: CheckoutEntry[] = raw
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match =
        /^(\d{6}) (blob) ([a-f0-9]{40,64}) +(\d+|-)\t([\s\S]+)$/.exec(record)
      if (match === null) throw new Error("Unexpected fixture tree record")
      return {
        mode: match[1]!,
        kind: match[1] === "120000" ? "symlink" : "file",
        objectId: match[3]!,
        sizeBytes: match[4] === "-" ? 0 : Number(match[4]),
        path: match[5]!,
      }
    })
  const totalBytes = entries.reduce(
    (total, entry) => total + entry.sizeBytes,
    0
  )
  return {
    path: workPath,
    metadata: {
      label,
      commitSha: sha,
      treeObjectId,
      treeFingerprint: `sha256:${"1".repeat(64)}`,
      configFingerprint: `sha256:${"2".repeat(64)}`,
      fileCount: entries.length,
      totalBytes,
    },
    enumerate: (prefix = "") =>
      entries.filter(
        ({ path }) =>
          prefix.length === 0 ||
          path === prefix ||
          path.startsWith(`${prefix}/`)
      ),
    readText: async (path, maxBytes) => {
      const output = await gitBuffer(workPath, "show", `${sha}:${path}`)
      if (maxBytes !== undefined && output.length > maxBytes) {
        throw new Error("Fixture read exceeds maxBytes")
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(output)
    },
  }
}

export async function createPrDiffRepositoryFixture(): Promise<PrDiffRepositoryFixture> {
  const rootPath = await mkdtemp(join(tmpdir(), "sentinel-pr-diff-"))
  const workPath = join(rootPath, "repository")
  await mkdir(workPath)
  await git(workPath, "init", "--initial-branch=main")
  await git(workPath, "config", "user.email", "sentinel-tests@example.invalid")
  await git(workPath, "config", "user.name", "Sentinel Tests")
  await mkdir(join(workPath, "src"), { recursive: true })
  await mkdir(join(workPath, "backend"), { recursive: true })
  await mkdir(join(workPath, "dist"), { recursive: true })
  await mkdir(join(workPath, "config"), { recursive: true })
  await mkdir(join(workPath, "database"), { recursive: true })
  await writeFile(join(workPath, "tsconfig.json"), "{}\n")
  await writeFile(
    join(workPath, "src", "edit.ts"),
    "export function outer() {\n  function nested() {\n    return 1\n  }\n  return nested()\n}\n"
  )
  await writeFile(
    join(workPath, "backend", "Edit.php"),
    "<?php\nclass Edit {\n  public function run(): int {\n    return 1;\n  }\n}\n"
  )
  await writeFile(
    join(workPath, "backend", "Delete.php"),
    "<?php\nclass DeleteMe { public function run(): void {} }\n"
  )
  await writeFile(
    join(workPath, "src", "old-name.ts"),
    "export function renamed() {\n  return 1\n}\n"
  )
  await writeFile(
    join(workPath, "src", "move-from.ts"),
    "export function moved() {\n  return 7\n}\nexport const fromOnly = 1\n"
  )
  await writeFile(
    join(workPath, "src", "move-to.ts"),
    "export const toOnly = 2\n"
  )
  await writeFile(join(workPath, "image.bin"), Buffer.from([0, 1, 2, 3]))
  await writeFile(
    join(workPath, "dist", "client.generated.ts"),
    "export const generated = 1\n"
  )
  await writeFile(join(workPath, "pnpm-lock.yaml"), "lockfileVersion: 1\n")
  await writeFile(join(workPath, "config", "settings.yaml"), "enabled: false\n")
  await writeFile(join(workPath, "database", "schema.sql"), "select 1;\n")
  await writeFile(join(workPath, "no-newline.txt"), "before")
  await writeFile(join(workPath, "script.sh"), "echo before\n")
  await writeFile(join(workPath, "README.md"), "initial\n")
  await git(workPath, "add", ".")
  const staleGraphSha = await commit(workPath, "initial source")

  await writeFile(
    join(workPath, "src", "edit.ts"),
    "export function outer() {\n  function nested() {\n    return 2\n  }\n  return nested()\n}\n"
  )
  await git(workPath, "add", "src/edit.ts")
  const safeGraphSha = await commit(workPath, "advance indexed source")
  await writeFile(join(workPath, "README.md"), "baseline docs\n")
  await git(workPath, "add", "README.md")
  const baseSha = await commit(workPath, "establish PR base")

  await git(workPath, "switch", "-c", "feature")
  await writeFile(
    join(workPath, "src", "edit.ts"),
    "export function outer() {\n  function nested() {\n    return 3\n  }\n  return nested()\n}\n"
  )
  await writeFile(
    join(workPath, "backend", "Edit.php"),
    "<?php\nclass Edit {\n  public function run(): int {\n    return 2;\n  }\n}\n"
  )
  await writeFile(
    join(workPath, "src", "added.ts"),
    "export function added() { return 1 }\n"
  )
  await rm(join(workPath, "backend", "Delete.php"))
  await rename(
    join(workPath, "src", "old-name.ts"),
    join(workPath, "src", "new-name.ts")
  )
  await writeFile(
    join(workPath, "src", "new-name.ts"),
    "export function renamed() {\n  return 2\n}\n"
  )
  await writeFile(
    join(workPath, "src", "move-from.ts"),
    "export const fromOnly = 1\n"
  )
  await writeFile(
    join(workPath, "src", "move-to.ts"),
    "export const toOnly = 2\nexport function moved() {\n  return 7\n}\n"
  )
  await writeFile(join(workPath, "image.bin"), Buffer.from([0, 1, 9, 3]))
  await writeFile(
    join(workPath, "dist", "client.generated.ts"),
    "export const generated = 2\n"
  )
  await writeFile(join(workPath, "pnpm-lock.yaml"), "lockfileVersion: 2\n")
  await writeFile(join(workPath, "config", "settings.yaml"), "enabled: true\n")
  await writeFile(join(workPath, "database", "schema.sql"), "select 2;\n")
  await writeFile(join(workPath, "no-newline.txt"), "after")
  await writeFile(join(workPath, "script.sh"), "echo before\n")
  if (process.platform !== "win32")
    await chmod(join(workPath, "script.sh"), 0o755)
  await git(workPath, "add", "-A")
  await git(workPath, "update-index", "--chmod=+x", "script.sh")
  const headSha = await commit(workPath, "feature matrix")

  await git(workPath, "switch", "-c", "unrelated", staleGraphSha)
  await writeFile(join(workPath, "unrelated.txt"), "unrelated\n")
  await git(workPath, "add", "unrelated.txt")
  const unrelatedSha = await commit(workPath, "unrelated history")

  return {
    rootPath,
    workPath,
    staleGraphSha,
    safeGraphSha,
    baseSha,
    headSha,
    unrelatedSha,
    baseSnapshot: await snapshot(workPath, "base", baseSha),
    headSnapshot: await snapshot(workPath, "head", headSha),
    unrelatedSnapshot: await snapshot(workPath, "unrelated", unrelatedSha),
    dispose: async () => {
      const tempRoot = resolve(tmpdir())
      const resolvedRoot = resolve(rootPath)
      const offset = relative(tempRoot, resolvedRoot)
      if (
        offset.length === 0 ||
        offset === ".." ||
        offset.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
        isAbsolute(offset)
      ) {
        throw new Error("Refusing to remove an unexpected fixture path")
      }
      await rm(resolvedRoot, { recursive: true, force: true })
    },
  }
}
