import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { GitProcessRunner } from "./git-runner.ts"

describe("GitProcessRunner", () => {
  it("does not inherit Git configuration parameters", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sentinel-git-env-test-"))
    const previous = process.env["GIT_CONFIG_PARAMETERS"]
    process.env["GIT_CONFIG_PARAMETERS"] = "'sentinel.inherited=value'"
    try {
      await expect(
        new GitProcessRunner().run(
          ["config", "--global", "--get", "sentinel.inherited"],
          { cwd, timeoutMs: 5_000 }
        )
      ).rejects.toMatchObject({ code: "git_failed" })
    } finally {
      if (previous === undefined) delete process.env["GIT_CONFIG_PARAMETERS"]
      else process.env["GIT_CONFIG_PARAMETERS"] = previous
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
