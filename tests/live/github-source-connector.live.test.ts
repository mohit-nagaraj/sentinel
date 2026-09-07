import { describe, expect, it } from "vitest"

import {
  startGitHubSourceConnector,
  type ResolvedGitHubCommit,
} from "@sentinel/adapters"

const runSmoke = process.env["RUN_GITHUB_CHECKOUT_SMOKE"] === "1"

describe.runIf(runSmoke)("public Hi.Events source checkout", () => {
  it(
    "checks out the PRD-pinned base commit reproducibly",
    async () => {
      const connector = await startGitHubSourceConnector({
        ...(process.env["GITHUB_TOKEN"] === undefined
          ? {}
          : { token: process.env["GITHUB_TOKEN"] }),
        limits: {
          maxTotalBytes: 1024 * 1024 * 1024,
          maxFileBytes: 16 * 1024 * 1024,
          timeoutMs: 5 * 60_000,
        },
        staleLeaseAgeMs: 0,
      })
      let resolved: ResolvedGitHubCommit | undefined
      try {
        resolved = await connector.resolveCommit(
          "https://github.com/HiEventsDev/Hi.Events",
          "2064f88ff7590e93c738efb8becaa7d732063619"
        )
        expect(resolved.commit.sha).toBe(
          "2064f88ff7590e93c738efb8becaa7d732063619"
        )
        const source = resolved.checkout.snapshots.get("source")
        await expect(source?.readText("README.md")).resolves.toContain(
          "Hi.Events"
        )
      } finally {
        await resolved?.checkout.dispose()
      }
    },
    10 * 60_000
  )
})
