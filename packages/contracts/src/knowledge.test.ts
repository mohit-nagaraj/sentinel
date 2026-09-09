import { describe, expect, it } from "vitest"

import {
  coverageItemSchema,
  evidencePathSchema,
  knowledgeSourceSchema,
  knowledgeReviewDecisionSchema,
} from "./knowledge.ts"

const requirementId = `requirement:v1:${"a".repeat(64)}`
const sectionId = `document-section:v1:${"b".repeat(64)}`
const evidenceId = `evidence:v1:${"c".repeat(64)}`

describe("knowledge contracts", () => {
  it.each([
    "observed",
    "partially_observed",
    "not_observed",
    "blocked",
    "not_evaluated",
    "ambiguous",
  ])("accepts the %s coverage state", (status) => {
    expect(
      coverageItemSchema.parse({
        requirementId,
        statement: "A buyer can complete checkout.",
        capability: "complete checkout",
        status,
        summary: "Evidence is limited to the explored checkout scope.",
        possibleCauses: [],
        reviewerActions: [],
        workflowCount: 0,
        evidenceTiers: [],
        stale: false,
      }).status
    ).toBe(status)
  })

  it("requires one provenance-bearing link between each path node", () => {
    const input = {
      schemaVersion: 1,
      id: "checkout-path",
      requirementId,
      complete: false,
      nodes: [
        { id: sectionId, kind: "document-section", label: "Checkout" },
        { id: requirementId, kind: "requirement", label: "Checkout" },
      ],
      links: [
        {
          id: evidenceId,
          relationship: "states",
          tier: "A",
          reviewState: "not_required",
          extractionMethod: "document_parser",
          sourceIdentityHash: `sha256:${"d".repeat(64)}`,
          explanation: "The exact source section states the requirement.",
          stale: false,
        },
      ],
    }
    expect(evidencePathSchema.parse(input).links).toHaveLength(1)
    expect(() => evidencePathSchema.parse({ ...input, links: [] })).toThrow()
  })

  it("requires a meaningful review reason and rejects extra input", () => {
    expect(() =>
      knowledgeReviewDecisionSchema.parse({
        schemaVersion: 1,
        decision: "accepted",
        reason: "ok",
      })
    ).toThrow()
    expect(() =>
      knowledgeReviewDecisionSchema.parse({
        schemaVersion: 1,
        decision: "accepted",
        reason: "Runtime and route evidence agree.",
        token: "must-not-pass",
      })
    ).toThrow()
  })

  it("rejects unsafe source URI schemes", () => {
    expect(() =>
      knowledgeSourceSchema.parse({
        id: `application:v1:${"e".repeat(64)}`,
        kind: "application",
        uri: "javascript:alert(document.domain)",
        status: "ready",
        freshness: "current",
      })
    ).toThrow()
  })
})
