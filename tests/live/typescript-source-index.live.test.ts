import {
  applicationIdSchema,
  commitShaSchema,
  parseCodeFactEnvelope,
  runIdSchema,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import {
  createTypeScriptIndexQuery,
  indexTypeScriptSource,
  parseGitHubRepository,
  startGitHubSourceConnector,
  type ResolvedGitHubCommit,
} from "@sentinel/adapters"

const runSmoke = process.env["RUN_TYPESCRIPT_INDEX_SMOKE"] === "1"

const PINNED_SHA = "2064f88ff7590e93c738efb8becaa7d732063619"
const applicationId = applicationIdSchema.parse(
  `application:v1:${"c".repeat(64)}`
)
const runId = runIdSchema.parse("run:3f1d1b64-6f2a-4b6f-9f2e-2a1c3d4e5f60")

describe.runIf(runSmoke)("public Hi.Events TypeScript index", () => {
  it(
    "indexes the pinned frontend and maps routes to API client calls",
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
          PINNED_SHA
        )
        const snapshot = resolved.checkout.snapshots.get("source")
        expect(snapshot).toBeDefined()
        if (snapshot === undefined) return

        const index = await indexTypeScriptSource({
          reader: snapshot,
          applicationId,
          runId,
          repository: parseGitHubRepository("HiEventsDev/Hi.Events"),
          commitSha: commitShaSchema.parse(PINNED_SHA),
          roots: ["frontend/src"],
          limits: { timeoutMs: 8 * 60_000, maxTotalNodes: 40_000_000 },
        })

        expect(index.config.tsconfigPath).toBe("frontend/tsconfig.json")
        expect(index.files.length).toBeGreaterThan(200)
        expect(
          index.files.every((file) => file.path.startsWith("frontend/src/"))
        ).toBe(true)
        // Locale bundles are a large part of this tree and must stay excluded.
        expect(
          index.files.some((file) => file.path.includes("/locales/"))
        ).toBe(false)

        // At least one route resolves all the way to a component. The target
        // loads most routes through `async lazy()` dynamic imports.
        const resolvedRoutes = index.routes.filter(
          (route) => route.componentSymbolIds.length > 0
        )
        expect(resolvedRoutes.length).toBeGreaterThan(0)
        expect(
          index.routes.some(({ pathPattern }) =>
            pathPattern.startsWith("/manage")
          )
        ).toBe(true)

        // At least one API client call normalizes to a usable path template.
        const templated = index.apiCallCandidates.filter(
          (candidate) => candidate.pathTemplate !== undefined
        )
        expect(templated.length).toBeGreaterThan(20)
        expect(
          templated.some((candidate) =>
            candidate.pathTemplate?.startsWith("/events")
          )
        ).toBe(true)
        expect(index.queryHooks.length).toBeGreaterThan(10)

        for (const envelope of index.facts) {
          expect(parseCodeFactEnvelope(envelope)).toStrictEqual(envelope)
        }

        // Bounded queries work against the real tree and still refuse anything
        // the policy excluded.
        const query = createTypeScriptIndexQuery(index, snapshot)
        const firstRoute = resolvedRoutes[0]
        if (firstRoute !== undefined) {
          const componentId = firstRoute.componentQualifiedNames[0]
          if (componentId !== undefined) {
            const inspection = await query.inspectSymbol(componentId)
            expect(inspection.slice.text.length).toBeGreaterThan(0)
          }
        }
        await expect(
          query.readSlice({
            path: "frontend/package.json",
            startLine: 1,
            endLine: 1,
          })
        ).rejects.toMatchObject({ code: "unsafe_path" })

        console.log(
          [
            `Hi.Events index: ${index.statistics.fileCount} files`,
            `${index.statistics.symbolCount} symbols`,
            `${index.statistics.referenceCount} references`,
            `${index.statistics.routeCount} routes (${resolvedRoutes.length} with a resolved component)`,
            `${templated.length}/${index.apiCallCandidates.length} API candidates with a path template`,
            `${index.queryHooks.length} query hooks`,
            `${index.warnings.length} warnings`,
            `${index.elapsedMs}ms`,
          ].join(", ")
        )
      } finally {
        await resolved?.checkout.dispose()
      }
    },
    15 * 60_000
  )
})
