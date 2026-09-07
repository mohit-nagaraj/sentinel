import { rm } from "node:fs/promises"
import { join } from "node:path"

import {
  applicationIdSchema,
  commitShaSchema,
  parseCodeFactEnvelope,
  runIdSchema,
} from "@sentinel/contracts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  CheckoutLeaseRegistry,
  EphemeralCheckoutManager,
  createTypeScriptIndexQuery,
  indexTypeScriptSource,
  parseGitHubRepository,
  type CheckoutSnapshot,
  type TypeScriptSourceIndex,
} from "@sentinel/adapters"

import {
  createTypeScriptRepositoryFixture,
  type TypeScriptRepositoryFixture,
} from "../fixtures/typescript-repository.ts"

const applicationId = applicationIdSchema.parse(
  `application:v1:${"b".repeat(64)}`
)
const runId = runIdSchema.parse("run:2f1d1b64-6f2a-4b6f-9f2e-2a1c3d4e5f60")
const repository = parseGitHubRepository("fixture/frontend")

describe("TypeScript source index over an ephemeral checkout", () => {
  let fixture: TypeScriptRepositoryFixture
  let checkouts: EphemeralCheckoutManager

  beforeAll(async () => {
    fixture = await createTypeScriptRepositoryFixture()
    checkouts = new EphemeralCheckoutManager({
      registry: new CheckoutLeaseRegistry({
        rootDirectory: join(fixture.rootPath, "leases"),
      }),
      allowLocalRepositoriesForTests: true,
    })
  })

  afterAll(async () => {
    await checkouts.registry.cleanupAll()
    await rm(fixture.rootPath, { recursive: true, force: true })
  })

  async function withSnapshots<Result>(
    callback: (
      snapshots: ReadonlyMap<string, CheckoutSnapshot>
    ) => Promise<Result>
  ): Promise<Result> {
    return await checkouts.withCheckout(
      {
        repository,
        targets: [
          { label: "base", sha: fixture.baseSha, remoteUrl: fixture.barePath },
          { label: "head", sha: fixture.headSha, remoteUrl: fixture.barePath },
        ],
      },
      async (checkout) => await callback(checkout.snapshots)
    )
  }

  function indexSnapshot(
    snapshot: CheckoutSnapshot,
    sha: string
  ): Promise<TypeScriptSourceIndex> {
    return indexTypeScriptSource({
      // A checkout snapshot satisfies the reader port with no adapter shim.
      reader: snapshot,
      applicationId,
      runId,
      repository,
      commitSha: commitShaSchema.parse(sha),
      roots: ["frontend/src"],
    })
  }

  it("indexes a real checkout through the snapshot reader port", async () => {
    await withSnapshots(async (snapshots) => {
      const source = snapshots.get("base")
      expect(source).toBeDefined()
      if (source === undefined) return

      const index = await indexSnapshot(source, fixture.baseSha)

      expect(index.files.map((file) => file.path)).toStrictEqual([
        "frontend/src/api/client.ts",
        "frontend/src/api/order.client.ts",
        "frontend/src/components/pages/Legacy.tsx",
        "frontend/src/components/pages/Orders.tsx",
        "frontend/src/router.tsx",
      ])
      expect(index.config.tsconfigPath).toBe("frontend/tsconfig.json")
      expect(index.config.ignoredFields).toStrictEqual(["plugins"])

      // The excluded files are visible to the snapshot but never admitted.
      const warned = new Map(
        index.warnings.map((warning) => [warning.path, warning.reason])
      )
      expect(warned.get("frontend/src/locales/en.ts")).toBe("locale_bundle")
      expect(warned.get("frontend/src/generated.d.ts")).toBe(
        "generated_declaration"
      )

      for (const envelope of index.facts) {
        expect(parseCodeFactEnvelope(envelope)).toStrictEqual(envelope)
      }
    })
  })

  it("maps the route chain from a real checkout with source provenance", async () => {
    await withSnapshots(async (snapshots) => {
      const source = snapshots.get("base")
      if (source === undefined) throw new Error("missing base snapshot")

      const index = await indexSnapshot(source, fixture.baseSha)
      const route = index.routes.find(
        ({ pathPattern }) => pathPattern === "/manage/orders/:orderId?"
      )

      expect(route?.componentQualifiedNames).toStrictEqual([
        "frontend/src/components/pages/Orders.tsx#Orders",
      ])
      expect(route?.unresolvedReasons).toStrictEqual([])

      const handler = index.handlerBindings.find(
        ({ event }) => event === "onClick"
      )
      expect(handler?.handlerQualifiedName).toBe(
        "frontend/src/components/pages/Orders.tsx#Orders.handleReload"
      )

      expect(
        index.apiCallCandidates.map(({ method, pathTemplate }) => [
          method,
          pathTemplate,
        ])
      ).toStrictEqual([
        ["GET", "/orders"],
        ["GET", "/orders/{param}"],
      ])
      expect(index.queryHooks.at(0)?.callTargetQualifiedNames).toStrictEqual([
        "frontend/src/api/order.client.ts#ordersClient.all",
      ])
    })
  })

  it("drops a deleted file and re-identifies a renamed one at head", async () => {
    await withSnapshots(async (snapshots) => {
      const base = snapshots.get("base")
      const head = snapshots.get("head")
      if (base === undefined || head === undefined) {
        throw new Error("missing snapshots")
      }

      const baseIndex = await indexSnapshot(base, fixture.baseSha)
      const headIndex = await indexSnapshot(head, fixture.headSha)

      const basePaths = baseIndex.files.map((file) => file.path)
      const headPaths = headIndex.files.map((file) => file.path)

      expect(basePaths).toContain("frontend/src/components/pages/Legacy.tsx")
      expect(headPaths).not.toContain(
        "frontend/src/components/pages/Legacy.tsx"
      )

      expect(basePaths).toContain("frontend/src/components/pages/Orders.tsx")
      expect(headPaths).toContain("frontend/src/components/screens/Orders.tsx")

      const baseOrders = baseIndex.files.find(
        (file) => file.path === "frontend/src/components/pages/Orders.tsx"
      )
      const headOrders = headIndex.files.find(
        (file) => file.path === "frontend/src/components/screens/Orders.tsx"
      )
      // Path is part of the code-file identity, so a rename is a new entity even
      // though the content hash is unchanged.
      expect(headOrders?.contentHash).toBe(baseOrders?.contentHash)
      expect(headOrders?.id).not.toBe(baseOrders?.id)

      expect(headIndex.indexFingerprint).not.toBe(baseIndex.indexFingerprint)
      expect(
        headIndex.routes.find(
          ({ pathPattern }) => pathPattern === "/manage/orders/:orderId?"
        )?.componentQualifiedNames
      ).toStrictEqual(["frontend/src/components/screens/Orders.tsx#Orders"])
    })
  })

  it("serves bounded queries and refuses excluded paths from a real checkout", async () => {
    await withSnapshots(async (snapshots) => {
      const source = snapshots.get("base")
      if (source === undefined) throw new Error("missing base snapshot")

      const index = await indexSnapshot(source, fixture.baseSha)
      const query = createTypeScriptIndexQuery(index, source)

      const inspection = await query.inspectSymbol(
        "frontend/src/components/pages/Orders.tsx#Orders"
      )
      expect(inspection.slice.text).toContain("const Orders")
      expect(inspection.slice.truncated).toBe(false)

      await expect(
        query.readSlice({
          path: "frontend/src/locales/en.ts",
          startLine: 1,
          endLine: 1,
        })
      ).rejects.toMatchObject({ code: "unsafe_path" })

      await expect(
        query.readSlice({
          path: "frontend/tsconfig.json",
          startLine: 1,
          endLine: 1,
        })
      ).rejects.toMatchObject({ code: "unsafe_path" })

      await expect(
        query.readSlice({
          path: "../outside.ts",
          startLine: 1,
          endLine: 1,
        })
      ).rejects.toMatchObject({ code: "invalid_input" })
    })
  })

  it("produces an identical index across repeated checkouts of one commit", async () => {
    const fingerprints: string[] = []
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await withSnapshots(async (snapshots) => {
        const source = snapshots.get("base")
        if (source === undefined) throw new Error("missing base snapshot")
        const index = await indexSnapshot(source, fixture.baseSha)
        fingerprints.push(index.indexFingerprint)
      })
    }

    expect(fingerprints[0]).toBe(fingerprints[1])
  })
})
