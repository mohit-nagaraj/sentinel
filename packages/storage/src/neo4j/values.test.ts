import neo4j from "neo4j-driver"
import { describe, expect, it } from "vitest"

import { toNativeGraphValue } from "./values.ts"

describe("Neo4j value mapping", () => {
  it("converts safe integers and preserves unsafe integers as strings", () => {
    expect(toNativeGraphValue(neo4j.int(42))).toBe(42)
    expect(toNativeGraphValue(neo4j.int("9007199254740993"))).toBe(
      "9007199254740993"
    )
  })

  it("maps nodes, nested arrays, optional properties, and temporal values", () => {
    class TemporalValue {
      toString(): string {
        return "2026-09-07T12:00:00Z"
      }
    }

    expect(
      toNativeGraphValue({
        properties: {
          count: neo4j.int(3),
          optional: null,
          nested: [neo4j.int(4), { at: new TemporalValue() }],
        },
      })
    ).toEqual({
      count: 3,
      optional: null,
      nested: [4, { at: "2026-09-07T12:00:00Z" }],
    })
  })

  it("rejects unsupported values", () => {
    expect(() => toNativeGraphValue(undefined)).toThrow(TypeError)
  })
})
