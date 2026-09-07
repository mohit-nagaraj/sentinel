import { describe, expect, it } from "vitest"

import {
  PhpLaravelIndexer,
  startGitHubSourceConnector,
  type ResolvedGitHubCommit,
} from "@sentinel/adapters"

const runSmoke = process.env["RUN_PHP_INDEXER_SMOKE"] === "1"
const pinnedCommit = "2064f88ff7590e93c738efb8becaa7d732063619"
const files = [
  "backend/app/Http/Actions/Orders/Public/CreateOrderActionPublic.php",
  "backend/app/Http/Request/Order/CreateOrderRequest.php",
  "backend/app/Repository/Eloquent/OrderRepository.php",
  "backend/app/Services/Application/Handlers/Order/CreateOrderHandler.php",
  "backend/routes/api.php",
] as const

describe.runIf(runSmoke)("public Hi.Events PHP index", () => {
  it(
    "indexes selected backend files at the pinned commit without booting Laravel",
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
      })
      let resolved: ResolvedGitHubCommit | undefined
      try {
        resolved = await connector.resolveCommit(
          "https://github.com/HiEventsDev/Hi.Events",
          pinnedCommit
        )
        const snapshot = resolved.checkout.snapshots.get("source")
        expect(snapshot).toBeDefined()
        if (snapshot === undefined)
          throw new Error("Source checkout is unavailable")
        const response = await new PhpLaravelIndexer({
          limits: { timeoutMs: 5 * 60_000 },
        }).indexCheckout(snapshot, files)
        expect(response.files).toHaveLength(files.length)
        expect(response.summary.errorCount).toBe(0)
        expect(
          response.files
            .flatMap((file) => file.symbols)
            .some((symbol) =>
              symbol.qualifiedName.endsWith("CreateOrderHandler")
            )
        ).toBe(true)
        expect(
          response.files
            .flatMap((file) => file.routes)
            .find((route) => route.path === "/public/events/{event_id}/order")
        ).toMatchObject({
          methods: ["POST"],
          action: {
            resolvedName:
              "HiEvents\\Http\\Actions\\Orders\\Public\\CreateOrderActionPublic",
            dynamic: false,
          },
        })
        expect(
          response.files
            .flatMap((file) => file.symbols)
            .some((symbol) =>
              symbol.qualifiedName.endsWith("CreateOrderActionPublic::__invoke")
            )
        ).toBe(true)
      } finally {
        await resolved?.checkout.dispose()
      }
    },
    10 * 60_000
  )
})
