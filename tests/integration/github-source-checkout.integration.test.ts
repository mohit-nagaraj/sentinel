import {
  access,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  CheckoutLeaseRegistry,
  EphemeralCheckoutManager,
  GitProcessRunner,
  SourceConnectorError,
  parseGitHubRepository,
  type GitRunner,
} from "@sentinel/adapters"

import {
  createGitRepositoryFixture,
  type GitRepositoryFixture,
} from "../fixtures/git-repository.ts"

describe("ephemeral GitHub source checkout", () => {
  let fixture: GitRepositoryFixture

  beforeAll(async () => {
    fixture = await createGitRepositoryFixture()
  })

  afterAll(async () => {
    await rm(fixture.rootPath, { recursive: true, force: true })
  })

  function manager(
    name: string,
    options: ConstructorParameters<typeof EphemeralCheckoutManager>[0] = {}
  ) {
    return new EphemeralCheckoutManager({
      ...options,
      registry:
        options.registry ??
        new CheckoutLeaseRegistry({
          rootDirectory: join(fixture.rootPath, `leases-${name}`),
        }),
      allowLocalRepositoriesForTests: true,
    })
  }

  function request(
    targets: ReadonlyArray<{ readonly label: string; readonly sha: string }>,
    signal?: AbortSignal
  ) {
    return {
      repository: parseGitHubRepository("fixture/source"),
      targets: targets.map((target) => ({
        ...target,
        remoteUrl: fixture.barePath,
      })),
      ...(signal === undefined ? {} : { signal }),
    }
  }

  it("materializes reproducible base and head commits with rename and deletion", async () => {
    const checkouts = manager("comparison")
    const checkout = await checkouts.materialize(
      request([
        { label: "base", sha: fixture.baseSha },
        { label: "head", sha: fixture.headSha },
      ])
    )
    const base = checkout.snapshots.get("base")
    const head = checkout.snapshots.get("head")
    expect(base).toBeDefined()
    expect(head).toBeDefined()
    await expect(base?.readText("old-name.txt")).resolves.toBe("base content\n")
    await expect(head?.readText("new-name.txt")).resolves.toBe("head content\n")
    expect(base?.enumerate().map((entry) => entry.path)).toContain(
      "deleted.txt"
    )
    expect(head?.enumerate().map((entry) => entry.path)).not.toContain(
      "deleted.txt"
    )
    expect(base?.metadata.commitSha).toBe(fixture.baseSha)
    expect(head?.metadata.commitSha).toBe(fixture.headSha)
    expect(base?.metadata.treeFingerprint).not.toBe(
      head?.metadata.treeFingerprint
    )
    const leasePath = checkout.leasePath
    await checkout.dispose()
    await expect(access(leasePath)).rejects.toThrow()
  })

  it("produces stable tree and configuration fingerprints for a pinned commit", async () => {
    const checkouts = manager("fingerprints")
    const first = await checkouts.materialize(
      request([{ label: "source", sha: fixture.baseSha }])
    )
    const firstMetadata = first.snapshots.get("source")?.metadata
    await first.dispose()
    const second = await checkouts.materialize(
      request([{ label: "source", sha: fixture.baseSha }])
    )
    const secondMetadata = second.snapshots.get("source")?.metadata
    expect(secondMetadata?.treeFingerprint).toBe(firstMetadata?.treeFingerprint)
    expect(secondMetadata?.configFingerprint).toBe(
      firstMetadata?.configFingerprint
    )
    await second.dispose()
  })

  it("rejects traversal, binary reads, and runtime symlink substitution", async () => {
    const checkouts = manager("reads")
    const checkout = await checkouts.materialize(
      request([{ label: "source", sha: fixture.baseSha }])
    )
    const source = checkout.snapshots.get("source")
    await expect(source?.readText("../outside.txt")).rejects.toMatchObject({
      code: "invalid_input",
    })
    await expect(source?.readText("binary.dat")).rejects.toMatchObject({
      code: "binary_file",
    })

    const outside = join(fixture.rootPath, "outside")
    await mkdir(outside)
    await writeFile(join(outside, "nested.txt"), "outside\n")
    await rm(join(source?.path ?? "", "safe"), { recursive: true })
    await symlink(outside, join(source?.path ?? "", "safe"), "junction")
    await expect(source?.readText("safe/nested.txt")).rejects.toMatchObject({
      code: "unsafe_path",
    })
    await checkout.dispose()
  })

  it.each([
    ["escaping symlink", "unsafeSymlinkSha"],
    ["submodule gitlink", "submoduleSha"],
  ] as const)(
    "rejects an %s before creating a worktree",
    async (_name, shaKey) => {
      const checkouts = manager(shaKey)
      await expect(
        checkouts.materialize(
          request([{ label: "source", sha: fixture[shaKey] }])
        )
      ).rejects.toBeInstanceOf(SourceConnectorError)
      await expect(
        readdir(join(fixture.rootPath, `leases-${shaKey}`))
      ).resolves.toEqual([])
    }
  )

  it("returns an actionable compatibility error when limits are exceeded", async () => {
    const checkouts = manager("limits", { limits: { maxFiles: 1 } })
    await expect(
      checkouts.materialize(
        request([{ label: "source", sha: fixture.baseSha }])
      )
    ).rejects.toMatchObject({
      code: "limit_exceeded",
      compatibility: true,
    })
    await expect(
      readdir(join(fixture.rootPath, "leases-limits"))
    ).resolves.toEqual([])
  })

  it("cancels Git work and removes partial checkout content", async () => {
    const controller = new AbortController()
    const processRunner = new GitProcessRunner()
    const abortingRunner: GitRunner = {
      run: async (args, options) => {
        if (args[0] === "fetch") controller.abort()
        return await processRunner.run(args, options)
      },
    }
    const checkouts = manager("cancel", { runner: abortingRunner })
    await expect(
      checkouts.materialize(
        request([{ label: "source", sha: fixture.baseSha }], controller.signal)
      )
    ).rejects.toMatchObject({ code: "aborted" })
    await expect(
      readdir(join(fixture.rootPath, "leases-cancel"))
    ).resolves.toEqual([])
  })

  it("cleans checkout content when an adapter callback fails", async () => {
    const checkouts = manager("exception")
    await expect(
      checkouts.withCheckout(
        request([{ label: "source", sha: fixture.baseSha }]),
        async () => {
          throw new Error("adapter failed")
        }
      )
    ).rejects.toThrow("adapter failed")
    await expect(
      readdir(join(fixture.rootPath, "leases-exception"))
    ).resolves.toEqual([])
  })
})
