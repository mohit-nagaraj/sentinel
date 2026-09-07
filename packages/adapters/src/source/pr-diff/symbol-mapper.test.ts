import {
  applicationIdSchema,
  codeSymbolIdSchema,
  commitShaSchema,
  hashCanonical,
  pullRequestIdSchema,
  runIdSchema,
  type CodeSymbolId,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import { PhpIndexerError } from "../../php-laravel/errors.ts"
import {
  DefaultAffectedSymbolIndexer,
  type AffectedSymbol,
  type AffectedSymbolIndex,
} from "./affected-indexer.ts"
import { parseGitDiff } from "./diff-parser.ts"
import { mapDiffSymbols } from "./symbol-mapper.ts"

const baseSha = commitShaSchema.parse("1".repeat(40))
const headSha = commitShaSchema.parse("2".repeat(40))
const applicationId = applicationIdSchema.parse(
  `application:v1:${"a".repeat(64)}`
)
const runId = runIdSchema.parse("run:123e4567-e89b-12d3-a456-426614174000")
const pullRequestId = pullRequestIdSchema.parse(
  `pull-request:v1:${"b".repeat(64)}`
)
const repository = { host: "github.com", owner: "fixture", name: "mapping" }

function id(value: number): CodeSymbolId {
  return codeSymbolIdSchema.parse(
    `code-symbol:v1:${value.toString(16).padStart(64, "0")}`
  )
}

function symbol(
  value: number,
  input: Omit<AffectedSymbol, "id" | "contentHash"> & {
    readonly content?: string
  }
): AffectedSymbol {
  const { content = `${value}`, ...rest } = input
  return {
    id: id(value),
    ...rest,
    contentHash: hashCanonical({ content }),
  }
}

function index(symbols: readonly AffectedSymbol[]): AffectedSymbolIndex {
  return { symbols, failures: [] }
}

const provenance = {
  pullRequestId,
  baseSha,
  headSha,
  diffHash: hashCanonical({ diff: true }),
}

describe("PR diff symbol mapper", () => {
  it("selects the smallest TypeScript and PHP symbols with parent context", () => {
    const files = parseGitDiff(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "@@ -4 +4 @@",
        "-old",
        "+new",
        "diff --git a/app/Action.php b/app/Action.php",
        "@@ -6 +6 @@",
        "-old",
        "+new",
      ].join("\n")
    ).files
    const base = index([
      symbol(1, {
        filePath: "src/app.ts",
        qualifiedName: "src/app.ts",
        name: "app.ts",
        kind: "module",
        language: "typescript",
        range: { startLine: 1, endLine: 20 },
        parentSymbolIds: [],
      }),
      symbol(2, {
        filePath: "src/app.ts",
        qualifiedName: "src/app.ts#outer",
        name: "outer",
        kind: "function",
        language: "typescript",
        range: { startLine: 2, endLine: 10 },
        parentSymbolIds: [id(1)],
      }),
      symbol(3, {
        filePath: "src/app.ts",
        qualifiedName: "src/app.ts#outer.inner",
        name: "inner",
        kind: "function",
        language: "typescript",
        range: { startLine: 3, endLine: 5 },
        parentSymbolIds: [id(2), id(1)],
      }),
      symbol(4, {
        filePath: "app/Action.php",
        qualifiedName: "App\\Action",
        name: "Action",
        kind: "class",
        language: "php",
        range: { startLine: 2, endLine: 12 },
        parentSymbolIds: [],
      }),
      symbol(5, {
        filePath: "app/Action.php",
        qualifiedName: "App\\Action::run",
        name: "run",
        kind: "method",
        language: "php",
        range: { startLine: 5, endLine: 8 },
        parentSymbolIds: [id(4)],
      }),
    ])
    const head = index(
      base.symbols.map((candidate, offset) => ({
        ...candidate,
        id: id(20 + offset),
        parentSymbolIds: [],
      }))
    )
    const mapped = mapDiffSymbols(files, base, head, provenance)

    expect(mapped.files[0]?.baseSymbolIds).toStrictEqual([id(5)])
    expect(mapped.files[1]?.baseSymbolIds).toStrictEqual([id(3)])
    expect(
      mapped.symbols.find(({ base }) => base?.id === id(3))?.base
    ).toMatchObject({ parentSymbolIds: [id(2), id(1)] })
  })

  it("classifies unique exact-content cross-file symbols as moved", () => {
    const files = parseGitDiff(
      [
        "diff --git a/src/from.ts b/src/from.ts",
        "@@ -2,3 +1,0 @@",
        "-export function moved() {",
        "-  return 1",
        "-}",
        "diff --git a/src/to.ts b/src/to.ts",
        "@@ -1,0 +2,3 @@",
        "+export function moved() {",
        "+  return 1",
        "+}",
      ].join("\n")
    ).files
    const content = "same function"
    const base = index([
      symbol(30, {
        filePath: "src/from.ts",
        qualifiedName: "src/from.ts#moved",
        name: "moved",
        kind: "function",
        language: "typescript",
        range: { startLine: 2, endLine: 4 },
        parentSymbolIds: [],
        content,
      }),
    ])
    const head = index([
      symbol(31, {
        filePath: "src/to.ts",
        qualifiedName: "src/to.ts#moved",
        name: "moved",
        kind: "function",
        language: "typescript",
        range: { startLine: 2, endLine: 4 },
        parentSymbolIds: [],
        content,
      }),
    ])

    expect(mapDiffSymbols(files, base, head, provenance).symbols).toMatchObject(
      [{ operation: "moved", matchStrategy: "unique_exact_content" }]
    )
  })

  it("does not guess when exact move candidates are ambiguous", () => {
    const files = parseGitDiff(
      "diff --git a/src/from.ts b/src/from.ts\n@@ -1 +1 @@\n-old\n+new"
    ).files
    const shared = {
      filePath: "src/from.ts",
      qualifiedName: "src/from.ts#same",
      name: "same",
      kind: "function",
      language: "typescript" as const,
      range: { startLine: 1, endLine: 1 },
      parentSymbolIds: [],
      content: "same",
    }
    const mapped = mapDiffSymbols(
      files,
      index([symbol(40, shared), symbol(41, shared)]),
      index([symbol(42, shared), symbol(43, shared)]),
      provenance
    )
    expect(
      mapped.symbols.every(({ operation }) => operation !== "modified")
    ).toBe(true)
    expect(
      mapped.symbols.every(({ unresolvedReasons }) =>
        unresolvedReasons.includes("symbol_match_ambiguous")
      )
    ).toBe(true)
  })

  it("indexes only selected TypeScript files through a masked snapshot", async () => {
    const files = new Map([
      ["tsconfig.json", "{}\n"],
      [
        "src/selected.ts",
        "export function outer() {\n  function inner() {\n    return 1\n  }\n  return inner()\n}\n",
      ],
      ["src/not-selected.ts", "export function hidden() { return 0 }\n"],
    ])
    const reads: string[] = []
    const snapshot = {
      path: "C:/fixture",
      metadata: {
        label: "base",
        commitSha: baseSha,
        treeObjectId: "3".repeat(40),
        treeFingerprint: `sha256:${"4".repeat(64)}`,
        configFingerprint: `sha256:${"5".repeat(64)}`,
        fileCount: files.size,
        totalBytes: [...files.values()].join("").length,
      },
      enumerate: (prefix = "") =>
        [...files]
          .filter(([path]) =>
            prefix.length === 0
              ? true
              : path === prefix || path.startsWith(`${prefix}/`)
          )
          .map(([path, text]) => ({
            path,
            kind: "file" as const,
            mode: "100644",
            objectId: "6".repeat(40),
            sizeBytes: text.length,
          })),
      readText: async (path: string) => {
        reads.push(path)
        const text = files.get(path)
        if (text === undefined) throw new Error("missing fixture path")
        return text
      },
    }
    const indexed = await new DefaultAffectedSymbolIndexer().index({
      snapshot,
      applicationId,
      runId,
      repository,
      commitSha: baseSha,
      paths: ["src/selected.ts"],
    })

    expect(indexed.failures).toStrictEqual([])
    expect(
      indexed.symbols.some(({ qualifiedName }) =>
        qualifiedName.endsWith("outer.inner")
      )
    ).toBe(true)
    expect(
      indexed.symbols.every(({ filePath }) => filePath === "src/selected.ts")
    ).toBe(true)
    expect(reads).not.toContain("src/not-selected.ts")
  })

  it.each(["aborted", "content_mismatch"] as const)(
    "does not downgrade PHP %s failures to unresolved mappings",
    async (code) => {
      const snapshot = {
        path: "C:/fixture",
        metadata: {
          label: "base",
          commitSha: baseSha,
          treeObjectId: "3".repeat(40),
          treeFingerprint: `sha256:${"4".repeat(64)}`,
          configFingerprint: `sha256:${"5".repeat(64)}`,
          fileCount: 1,
          totalBytes: 6,
        },
        enumerate: () => [
          {
            path: "app/Action.php",
            kind: "file" as const,
            mode: "100644",
            objectId: "6".repeat(40),
            sizeBytes: 6,
          },
        ],
        readText: async () => "<?php\n",
      }
      const error = new PhpIndexerError(code, `fixture ${code}`)
      const indexer = new DefaultAffectedSymbolIndexer({
        phpIndexer: {
          indexCheckout: async () => {
            throw error
          },
        },
      })

      await expect(
        indexer.index({
          snapshot,
          applicationId,
          runId,
          repository,
          commitSha: baseSha,
          paths: ["app/Action.php"],
        })
      ).rejects.toBe(error)
    }
  )
})
