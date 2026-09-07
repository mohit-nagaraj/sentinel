import {
  createStableKey,
  hashCanonical,
  runIdSchema,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import { defaultIndexPolicy } from "./policy.ts"
import { createFakeSourceReader } from "./reader.ts"
import { indexTypeScriptSource, type TypeScriptSourceIndex } from "./indexer.ts"
import {
  fixtureCommitScope,
  fixtureRunId,
  indexFixture,
  reactAppFixtureFiles,
} from "./testing.ts"
import { TYPESCRIPT_INDEXER_VERSION } from "./identity.ts"

/**
 * Serializes everything the index promises to be reproducible. Only the
 * measured wall-clock duration is excluded, which is why it lives outside
 * `statistics` on the result.
 */
function reproduciblePart(index: TypeScriptSourceIndex): string {
  const { elapsedMs, ...rest } = index
  void elapsedMs
  return JSON.stringify(rest)
}

describe("index determinism", () => {
  it("produces byte-identical output for identical inputs", async () => {
    const [first, second] = await Promise.all([indexFixture(), indexFixture()])

    expect(reproduciblePart(second.index)).toBe(reproduciblePart(first.index))
  })

  it("produces identical output when the reader enumerates in a different order", async () => {
    const reversed = Object.fromEntries(
      Object.entries(reactAppFixtureFiles).reverse()
    )
    const [ordered, shuffled] = await Promise.all([
      indexFixture(),
      indexFixture({ files: reversed }),
    ])

    expect(reproduciblePart(shuffled.index)).toBe(
      reproduciblePart(ordered.index)
    )
  })

  it("keeps wall-clock timing out of the deterministic statistics", async () => {
    const { index } = await indexFixture()

    expect(Object.keys(index.statistics).sort()).toStrictEqual([
      "fileCount",
      "nodeCount",
      "referenceCount",
      "routeCount",
      "symbolCount",
      "totalBytes",
    ])
    expect(index.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it("keeps every collection in its documented order", async () => {
    const { index } = await indexFixture()

    const paths = index.files.map((file) => file.path)
    expect(paths).toStrictEqual([...paths].sort())

    const referenceKeys = index.references.map(
      ({ referenceKey }) => referenceKey
    )
    expect(referenceKeys).toStrictEqual([...referenceKeys].sort())

    const modulePaths = index.modules.map(({ path }) => path)
    expect(modulePaths).toStrictEqual([...modulePaths].sort())

    for (const file of index.files) {
      const lines = index.symbols
        .filter((symbol) => symbol.filePath === file.path)
        .map((symbol) => symbol.range.startLine)
      expect(lines).toStrictEqual([...lines].sort((a, b) => a - b))
    }
  })

  it("binds the fingerprint to the indexer version", async () => {
    const { index } = await indexFixture()

    const fingerprintInput = {
      commitSha: index.commitSha,
      files: index.files.map((file) => ({
        contentHash: file.contentHash,
        path: file.path,
      })),
      indexerVersion: TYPESCRIPT_INDEXER_VERSION,
      limits: index.limits,
      policy: index.policy,
      repository: index.repository,
      roots: [...index.roots],
      tsconfigPath: index.config.tsconfigPath,
    }

    expect(hashCanonical(fingerprintInput)).toBe(index.indexFingerprint)
    expect(
      hashCanonical({ ...fingerprintInput, indexerVersion: "99.0.0" })
    ).not.toBe(index.indexFingerprint)
    expect(TYPESCRIPT_INDEXER_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it("changes the fingerprint when the policy changes", async () => {
    const [baseline, relaxed] = await Promise.all([
      indexFixture(),
      indexFixture({
        policy: { ...defaultIndexPolicy, includeTests: true },
      }),
    ])

    expect(relaxed.index.indexFingerprint).not.toBe(
      baseline.index.indexFingerprint
    )
  })

  it("changes the fingerprint when the limits change", async () => {
    const [baseline, tighter] = await Promise.all([
      indexFixture(),
      indexFixture({ limits: { maxSliceLines: 10 } }),
    ])

    expect(tighter.index.indexFingerprint).not.toBe(
      baseline.index.indexFingerprint
    )
  })

  it("changes the fingerprint when source content changes", async () => {
    const [baseline, edited] = await Promise.all([
      indexFixture(),
      indexFixture({
        files: {
          ...reactAppFixtureFiles,
          "frontend/src/error-page.tsx":
            "const ErrorPage = () => <div>Changed</div>\n\nexport default ErrorPage\n",
        },
      }),
    ])

    expect(edited.index.indexFingerprint).not.toBe(
      baseline.index.indexFingerprint
    )
  })

  it("derives file, symbol, and route IDs from the contract stable-key scheme", async () => {
    const { index } = await indexFixture()

    const file = index.files.find(
      ({ path }) => path === "frontend/src/router.tsx"
    )
    expect(file?.id).toBe(
      createStableKey({
        kind: "code-file",
        applicationId: fixtureCommitScope.applicationId,
        repository: fixtureCommitScope.repository,
        commitSha: fixtureCommitScope.commitSha,
        path: "frontend/src/router.tsx",
      })
    )

    const symbol = index.symbols.find(
      ({ qualifiedName }) =>
        qualifiedName === "frontend/src/api/event.client.ts#eventsClient.create"
    )
    expect(symbol?.id).toBe(
      createStableKey({
        kind: "code-symbol",
        applicationId: fixtureCommitScope.applicationId,
        repository: fixtureCommitScope.repository,
        commitSha: fixtureCommitScope.commitSha,
        filePath: "frontend/src/api/event.client.ts",
        qualifiedName: "frontend/src/api/event.client.ts#eventsClient.create",
        symbolKind: "method",
      })
    )

    const route = index.routes.find(
      ({ pathPattern }) => pathPattern === "/manage/events/:eventsState?"
    )
    expect(route?.id).toBe(
      createStableKey({
        kind: "frontend-route",
        applicationId: fixtureCommitScope.applicationId,
        repository: fixtureCommitScope.repository,
        commitSha: fixtureCommitScope.commitSha,
        pathPattern: "/manage/events/:eventsState?",
      })
    )
  })

  it("keeps stable entity IDs independent of the run", async () => {
    const otherRun = runIdSchema.parse(
      "run:11111111-2222-4333-8444-555555555555"
    )
    const reader = createFakeSourceReader(reactAppFixtureFiles)
    const [baseline, differentRun] = await Promise.all([
      indexFixture(),
      indexTypeScriptSource({
        reader,
        applicationId: fixtureCommitScope.applicationId,
        runId: otherRun,
        repository: fixtureCommitScope.repository,
        commitSha: fixtureCommitScope.commitSha,
        roots: ["frontend/src"],
      }),
    ])

    expect(differentRun.indexFingerprint).toBe(baseline.index.indexFingerprint)
    expect(differentRun.files.map(({ id }) => id)).toStrictEqual(
      baseline.index.files.map(({ id }) => id)
    )
    expect(differentRun.symbols.map(({ id }) => id)).toStrictEqual(
      baseline.index.symbols.map(({ id }) => id)
    )
    expect(differentRun.routes.map(({ id }) => id)).toStrictEqual(
      baseline.index.routes.map(({ id }) => id)
    )
    // Reference evidence IDs are run-scoped by contract, but their ordinals and
    // ordering are not, so the edge order stays reproducible.
    expect(
      differentRun.references.map(({ referenceKey }) => referenceKey)
    ).toStrictEqual(
      baseline.index.references.map(({ referenceKey }) => referenceKey)
    )
    expect(differentRun.references.map(({ id }) => id)).not.toStrictEqual(
      baseline.index.references.map(({ id }) => id)
    )
  })

  it("changes entity IDs when the commit changes", async () => {
    const { index } = await indexFixture()
    const reader = createFakeSourceReader(reactAppFixtureFiles)

    const otherCommit = await indexTypeScriptSource({
      reader,
      applicationId: fixtureCommitScope.applicationId,
      runId: fixtureRunId,
      repository: fixtureCommitScope.repository,
      commitSha: "0497418d5c66d20693751e68be066260eda3f37f" as never,
      roots: ["frontend/src"],
    })

    expect(otherCommit.files.map(({ id }) => id)).not.toStrictEqual(
      index.files.map(({ id }) => id)
    )
    expect(otherCommit.indexFingerprint).not.toBe(index.indexFingerprint)
  })
})
