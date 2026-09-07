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
  id: `code-symbol:v1:${"1".repeat(64)}`,
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
    source: {
      applicationId: `application:v1:${"a".repeat(64)}`,
      repository: { host: "github.com", owner: "fixture", name: "example" },
      commitSha: "b".repeat(40),
    },
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

  it("rejects dangling containers/routes and falsely resolved dynamics", () => {
    const danglingContainer = structuredClone(response())
    Object.assign(danglingContainer.files[0]!.symbols[0]!, {
      containerSymbolId: `code-symbol:v1:${"9".repeat(64)}`,
    })
    expect(phpIndexerResponseSchema.safeParse(danglingContainer).success).toBe(
      false
    )

    const dynamicRelationship = structuredClone(response())
    Object.assign(dynamicRelationship.files[0]!, {
      relationships: [
        {
          id: `php-relationship:v1:${"3".repeat(64)}`,
          kind: "unresolved_dynamic",
          sourceSymbolId: symbol.id,
          originalTarget: "dynamic-call",
          resolvedTarget: "Fixture\\Wrong::call",
          dynamic: true,
          range,
        },
      ],
    })
    dynamicRelationship.summary.relationshipCount = 1
    expect(
      phpIndexerResponseSchema.safeParse(dynamicRelationship).success
    ).toBe(false)

    const danglingRoute = structuredClone(response())
    Object.assign(danglingRoute.files[0]!, {
      routes: [
        {
          id: `php-route:v1:${"4".repeat(64)}`,
          methods: ["GET"],
          path: "/example",
          middleware: [],
          action: {
            originalName: "Example",
            resolvedName: "Fixture\\Example",
            dynamic: false,
            targetSymbolId: `code-symbol:v1:${"9".repeat(64)}`,
          },
          dynamic: false,
          range,
        },
      ],
    })
    danglingRoute.summary.routeCount = 1
    expect(phpIndexerResponseSchema.safeParse(danglingRoute).success).toBe(
      false
    )
  })
})
