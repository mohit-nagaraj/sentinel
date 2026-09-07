import {
  entityKindSchema,
  evidenceRelationshipSchema,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import {
  constraintStatements,
  nodeLabelByKind,
  relationshipConstraintStatements,
  relationshipEndpointKinds,
  resolveNodeLabel,
  resolveRelationshipType,
} from "./schema.ts"

describe("Neo4j schema allowlists", () => {
  it("maps every entity kind to one constraint-backed label", () => {
    expect(Object.keys(nodeLabelByKind)).toEqual(entityKindSchema.options)
    expect(constraintStatements).toHaveLength(entityKindSchema.options.length)
    expect(new Set(constraintStatements).size).toBe(constraintStatements.length)
    expect(constraintStatements).toEqual(
      expect.arrayContaining([
        expect.stringContaining("FOR (n:Application)"),
        expect.stringContaining("(n.application_id, n.stable_key) IS UNIQUE"),
      ])
    )
  })

  it("maps every evidence relationship to endpoints and a constraint", () => {
    expect(Object.keys(relationshipEndpointKinds)).toEqual(
      evidenceRelationshipSchema.options
    )
    expect(relationshipConstraintStatements).toHaveLength(
      evidenceRelationshipSchema.options.length
    )
  })

  it("rejects untrusted labels and relationship fragments", () => {
    expect(() =>
      resolveNodeLabel("Application) MATCH (n) DETACH DELETE n")
    ).toThrow()
    expect(() => resolveRelationshipType("CALLS]->() DELETE r //")).toThrow()
  })
})
