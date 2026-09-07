import { describe, expect, it } from "vitest"

import { phpIndexerResponseSchema } from "./schema.ts"

const range = {
  startLine: 1,
  endLine: 2,
  startFilePos: 0,
  endFilePos: 20,
  startTokenPos: 0,
  endTokenPos: 5,
}

const symbol = {
  id: `php-symbol:v1:${"1".repeat(64)}`,
  kind: "class",
  role: "other",
  name: "Example",
  qualifiedName: "Fixture\\Example",
  originalName: "Example",
  static: false,
  abstract: false,
  final: true,
  attributes: [],
  range,
}

function response() {
  return {
    schemaVersion: 1,
    parser: { name: "nikic/php-parser", version: "5.8.0" },
    files: [
      {
        path: "app/Example.php",
        contentHash: `sha256:${"2".repeat(64)}`,
        symbols: [symbol],
        relationships: [],
        routes: [],
        errors: [],
      },
    ],
    summary: {
      fileCount: 1,
      symbolCount: 1,
      relationshipCount: 0,
      routeCount: 0,
      errorCount: 0,
    },
  }
}

describe("PHP indexer response contract", () => {
  it("accepts a versioned, internally consistent response", () => {
    expect(phpIndexerResponseSchema.parse(response())).toMatchObject({
      parser: { version: "5.8.0" },
      summary: { symbolCount: 1 },
    })
  })

  it("rejects inconsistent counts, ranges, and duplicate identities", () => {
    const inconsistent = response()
    inconsistent.summary.symbolCount = 0
    inconsistent.files[0]!.symbols.push({
      ...symbol,
      range: { ...range, startLine: 3, endLine: 1 },
    })
    expect(phpIndexerResponseSchema.safeParse(inconsistent).success).toBe(false)
  })
})
