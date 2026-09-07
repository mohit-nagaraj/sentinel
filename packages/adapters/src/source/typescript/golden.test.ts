import { describe, expect, it } from "vitest"

import type { TypeScriptSourceIndex } from "./indexer.ts"
import { indexFixture } from "./testing.ts"

/**
 * Projects the index into a snapshot-stable shape.
 *
 * Only the measured wall-clock duration and the request-scoped scope fields are
 * dropped. Stable IDs, fingerprints, ordinals, and ordering are all included on
 * purpose: they are the properties the acceptance criteria require, so a change
 * to any of them must show up as a snapshot diff.
 */
function snapshotOf(index: TypeScriptSourceIndex): unknown {
  return {
    indexerVersion: index.indexerVersion,
    indexFingerprint: index.indexFingerprint,
    config: index.config,
    modules: index.modules,
    files: index.files,
    symbols: index.symbols,
    references: index.references,
    imports: index.imports,
    routes: index.routes,
    jsxElements: index.jsxElements,
    handlerBindings: index.handlerBindings,
    apiCallCandidates: index.apiCallCandidates,
    queryHooks: index.queryHooks,
    warnings: index.warnings,
    facts: index.facts,
    statistics: index.statistics,
  }
}

describe("golden structural facts", () => {
  it("matches the recorded index for the React fixture tree", async () => {
    const { index } = await indexFixture()

    expect(snapshotOf(index)).toMatchSnapshot()
  })

  it("matches the recorded index when focused test indexing is enabled", async () => {
    const { index } = await indexFixture({
      policy: {
        policyVersion: 1,
        excludedSegments: [".git"],
        excludedSuffixes: [".d.ts"],
        localeSegments: ["locales"],
        vendorSegments: ["node_modules"],
        buildSegments: ["dist"],
        testSegments: ["__tests__"],
        testInfixes: [".test."],
        includeTests: true,
        testPathPrefixes: ["frontend/src"],
      },
    })

    expect(index.files.map((file) => file.path)).toContain(
      "frontend/src/router.test.tsx"
    )
    expect(snapshotOf(index)).toMatchSnapshot()
  })
})
