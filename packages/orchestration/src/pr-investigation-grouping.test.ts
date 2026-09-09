import {
  apiEndpointIdSchema,
  codeSymbolIdSchema,
  commitShaSchema,
  parsePrDiffAnalysis,
  type PrDiffAnalysis,
  type PrInvestigationRelationshipHint,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import { baselineOutcome, groupPrChanges } from "./pr-investigation-grouping.ts"

const pullRequestId = `pull-request:v1:${"b".repeat(64)}`
const baseSha = commitShaSchema.parse("1".repeat(40))
const headSha = commitShaSchema.parse("2".repeat(40))
const diffHash = `sha256:${"c".repeat(64)}`
const symbolA = codeSymbolIdSchema.parse(`code-symbol:v1:${"d".repeat(64)}`)
const symbolB = codeSymbolIdSchema.parse(`code-symbol:v1:${"e".repeat(64)}`)
const endpoint = apiEndpointIdSchema.parse(`api-endpoint:v1:${"f".repeat(64)}`)

function analysis(reverse = false): PrDiffAnalysis {
  const provenance = { pullRequestId, baseSha, headSha, diffHash }
  const symbols = [
    {
      operation: "modified" as const,
      base: {
        id: symbolA,
        filePath: "src/order-service.ts",
        qualifiedName: "OrderService.submit",
        name: "submit",
        kind: "method",
        language: "typescript" as const,
        range: { startLine: 10, endLine: 30 },
        parentSymbolIds: [],
        contentHash: `sha256:${"1".repeat(64)}`,
      },
      head: {
        id: symbolA,
        filePath: "src/order-service.ts",
        qualifiedName: "OrderService.submit",
        name: "submit",
        kind: "method",
        language: "typescript" as const,
        range: { startLine: 10, endLine: 32 },
        parentSymbolIds: [],
        contentHash: `sha256:${"2".repeat(64)}`,
      },
      baseRanges: [{ startLine: 20, endLine: 20 }],
      headRanges: [{ startLine: 20, endLine: 22 }],
      matchStrategy: "same_structure" as const,
      unresolvedReasons: [],
      provenance,
    },
    {
      operation: "modified" as const,
      base: {
        id: symbolB,
        filePath: "src/order-controller.ts",
        qualifiedName: "OrderController.create",
        name: "create",
        kind: "method",
        language: "typescript" as const,
        range: { startLine: 40, endLine: 60 },
        parentSymbolIds: [],
        contentHash: `sha256:${"3".repeat(64)}`,
      },
      head: {
        id: symbolB,
        filePath: "src/order-controller.ts",
        qualifiedName: "OrderController.create",
        name: "create",
        kind: "method",
        language: "typescript" as const,
        range: { startLine: 40, endLine: 62 },
        parentSymbolIds: [],
        contentHash: `sha256:${"4".repeat(64)}`,
      },
      baseRanges: [{ startLine: 50, endLine: 50 }],
      headRanges: [{ startLine: 50, endLine: 52 }],
      matchStrategy: "same_structure" as const,
      unresolvedReasons: [],
      provenance,
    },
  ]
  const files = [
    {
      operation: "modified" as const,
      oldPath: "src/order-service.ts",
      newPath: "src/order-service.ts",
      language: "typescript" as const,
      classifications: ["source" as const],
      baseRanges: [{ startLine: 20, endLine: 20 }],
      headRanges: [{ startLine: 20, endLine: 22 }],
      binary: false,
      noNewlineAtEnd: false,
      mappingStatus: "mapped" as const,
      baseSymbolIds: [symbolA],
      headSymbolIds: [symbolA],
      unresolvedReasons: [],
      provenance,
    },
    {
      operation: "modified" as const,
      oldPath: "src/order-controller.ts",
      newPath: "src/order-controller.ts",
      language: "typescript" as const,
      classifications: ["source" as const],
      baseRanges: [{ startLine: 50, endLine: 50 }],
      headRanges: [{ startLine: 50, endLine: 52 }],
      binary: false,
      noNewlineAtEnd: false,
      mappingStatus: "mapped" as const,
      baseSymbolIds: [symbolB],
      headSymbolIds: [symbolB],
      unresolvedReasons: [],
      provenance,
    },
    {
      operation: "modified" as const,
      oldPath: "config/runtime.yml",
      newPath: "config/runtime.yml",
      classifications: ["configuration" as const, "unsupported" as const],
      baseRanges: [{ startLine: 1, endLine: 1 }],
      headRanges: [{ startLine: 1, endLine: 1 }],
      binary: false,
      noNewlineAtEnd: false,
      mappingStatus: "unmapped" as const,
      baseSymbolIds: [],
      headSymbolIds: [],
      unresolvedReasons: ["unsupported_language" as const],
      provenance,
    },
  ]
  return parsePrDiffAnalysis({
    schemaVersion: 1,
    pullRequestId,
    repository: { host: "github.com", owner: "Sentinel", name: "Demo" },
    baseSha,
    headSha,
    diffHash,
    ancestry: "base_is_ancestor",
    baseline: {
      status: "exact",
      assessmentAllowed: true,
      graphCommitSha: baseSha,
      baseSha,
      reason: "graph_matches_pr_base",
      relevantInterveningPaths: [],
    },
    files: reverse ? [...files].reverse() : files,
    symbols: reverse ? [...symbols].reverse() : symbols,
    summary: {
      fileCount: files.length,
      symbolCount: symbols.length,
      mappedFileCount: 2,
      unmappedFileCount: 1,
    },
  })
}

const hints: PrInvestigationRelationshipHint[] = [
  { symbolId: symbolA, endpointIds: [endpoint], domainEntityIds: [] },
  { symbolId: symbolB, endpointIds: [endpoint], domainEntityIds: [] },
]

describe("PR investigation grouping", () => {
  it("groups symbols through shared endpoint relationships and retains config unknowns", () => {
    const result = groupPrChanges({ analysis: analysis(), hints })

    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]).toMatchObject({
      symbolIds: [symbolA, symbolB],
      endpointIds: [endpoint],
      groupingReasons: ["shared_endpoint"],
    })
    expect(result.unknowns).toHaveLength(1)
    expect(result.unknowns[0]).toMatchObject({
      kind: "file",
      filePaths: ["config/runtime.yml"],
      classifications: ["configuration", "unsupported"],
      unresolvedReasons: ["unsupported_language"],
    })
  })

  it("is deterministic when diff and hint order changes", () => {
    expect(groupPrChanges({ analysis: analysis(), hints })).toEqual(
      groupPrChanges({
        analysis: analysis(true),
        hints: [...hints].reverse(),
      })
    )
  })

  it("rejects duplicate symbol hint identities", () => {
    expect(() =>
      groupPrChanges({ analysis: analysis(), hints: [hints[0]!, hints[0]!] })
    ).toThrow("unique symbols")
  })

  it("maps all baseline compatibility states to documented outcomes", () => {
    expect(baselineOutcome(analysis().baseline)).toMatchObject({
      disposition: "proceed",
      action: "none",
    })
    expect(
      baselineOutcome({
        status: "stale_relevant",
        assessmentAllowed: false,
        graphCommitSha: baseSha,
        baseSha: headSha,
        reason: "ancestor_with_relevant_changes",
        relevantInterveningPaths: ["src/order-service.ts"],
      })
    ).toMatchObject({
      disposition: "action_required",
      action: "refresh_graph",
    })
  })
})
