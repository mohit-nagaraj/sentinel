import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { CheckoutLeaseRegistry } from "./lease-registry.ts"
import {
  EphemeralCheckoutManager,
  type CheckoutTreePreflight,
} from "./checkout.ts"
import type { GitRunner } from "./git-runner.ts"
import { parseGitHubRepository } from "./normalization.ts"
import { markTreePreflight } from "./tree-preflight.ts"

const sha = "1".repeat(40)
const treeObjectId = "2".repeat(40)

const boundedTree: CheckoutTreePreflight = {
  treeObjectId,
  fileCount: 1,
  totalBytes: 10,
  maxFileBytes: 10,
  maxDepth: 1,
  hasSubmodules: false,
  truncated: false,
}

describe("EphemeralCheckoutManager preflight", () => {
  it("requires recursive tree metadata before a GitHub fetch", async () => {
    const parent = await mkdtemp(join(tmpdir(), "sentinel-preflight-test-"))
    const rootDirectory = join(parent, "leases")
    const run = vi.fn<GitRunner["run"]>()
    const manager = new EphemeralCheckoutManager({
      registry: new CheckoutLeaseRegistry({ rootDirectory }),
      runner: { run },
    })
    await expect(
      manager.materialize({
        repository: parseGitHubRepository("owner/repo"),
        targets: [{ label: "source", sha }],
      })
    ).rejects.toMatchObject({ code: "invalid_input" })
    expect(run).not.toHaveBeenCalled()
    await expect(access(rootDirectory)).rejects.toThrow()
    await rm(parent, { recursive: true, force: true })
  })

  it("rejects caller-forged GitHub tree metadata", async () => {
    const parent = await mkdtemp(join(tmpdir(), "sentinel-forged-tree-test-"))
    const rootDirectory = join(parent, "leases")
    const run = vi.fn<GitRunner["run"]>()
    const manager = new EphemeralCheckoutManager({
      registry: new CheckoutLeaseRegistry({ rootDirectory }),
      runner: { run },
    })
    await expect(
      manager.materialize({
        repository: parseGitHubRepository("owner/repo"),
        targets: [{ label: "source", sha, preflight: boundedTree }],
      })
    ).rejects.toMatchObject({ code: "invalid_input" })
    expect(run).not.toHaveBeenCalled()
    await rm(parent, { recursive: true, force: true })
  })

  it.each([
    ["truncated", { ...boundedTree, truncated: true }],
    ["file count", { ...boundedTree, fileCount: 2 }],
    ["total bytes", { ...boundedTree, totalBytes: 11 }],
    ["file bytes", { ...boundedTree, maxFileBytes: 11 }],
    ["depth", { ...boundedTree, maxDepth: 2 }],
  ])(
    "rejects %s metadata before creating a lease",
    async (_name, preflight) => {
      const parent = await mkdtemp(join(tmpdir(), "sentinel-bounds-test-"))
      const rootDirectory = join(parent, "leases")
      const run = vi.fn<GitRunner["run"]>()
      const manager = new EphemeralCheckoutManager({
        limits: {
          maxFiles: 1,
          maxTotalBytes: 10,
          maxFileBytes: 10,
          maxDepth: 1,
        },
        registry: new CheckoutLeaseRegistry({ rootDirectory }),
        runner: { run },
      })
      await expect(
        manager.materialize({
          repository: parseGitHubRepository("owner/repo"),
          targets: [
            { label: "source", sha, preflight: markTreePreflight(preflight) },
          ],
        })
      ).rejects.toMatchObject({
        code: "limit_exceeded",
        compatibility: true,
      })
      expect(run).not.toHaveBeenCalled()
      await expect(access(rootDirectory)).rejects.toThrow()
      await rm(parent, { recursive: true, force: true })
    }
  )
})
