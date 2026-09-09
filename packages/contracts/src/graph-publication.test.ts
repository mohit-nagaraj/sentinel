import { describe, expect, it } from "vitest"

import {
  graphApplicationFactSchema,
  graphPathQuerySchema,
  graphPathRelationshipSchema,
  graphPublicationNodeSchema,
  graphPublicationSummarySchema,
} from "./graph-publication.ts"

const applicationId = `application:v1:${"a".repeat(64)}`
const timestamp = "2026-09-09T00:00:00.000Z"

describe("graph publication contracts", () => {
  it("requires an application root to equal its namespace", () => {
    expect(() =>
      graphApplicationFactSchema.parse({
        id: `application:v1:${"b".repeat(64)}`,
        applicationId,
        name: "Sentinel",
        indexedCommitSha: "c".repeat(40),
      })
    ).toThrow("namespace")
  })

  it("allows only accepted Tier C nodes and excludes Tier D", () => {
    const node = {
      kind: "application",
      fact: {
        id: applicationId,
        applicationId,
        name: "Sentinel",
        indexedCommitSha: "c".repeat(40),
      },
      extractionMethod: "source_reference",
      evidenceTier: "C",
      evidenceIds: [],
      provenance: { sourceKind: "system", observedAt: timestamp },
      reviewState: "pending",
    }
    expect(() => graphPublicationNodeSchema.parse(node)).toThrow(
      "accepted human review"
    )
    expect(
      graphPublicationNodeSchema.parse({
        ...node,
        reviewState: "accepted",
      }).evidenceTier
    ).toBe("C")
    expect(() =>
      graphPublicationNodeSchema.parse({
        ...node,
        evidenceTier: "D",
        reviewState: "accepted",
      })
    ).toThrow()
  })

  it("requires exhaustive compact summary counts", () => {
    expect(() =>
      graphPublicationSummarySchema.parse({
        schemaVersion: 1,
        applicationId,
        runId: "run:11111111-1111-4111-8111-111111111111",
        inputFingerprint: `sha256:${"1".repeat(64)}`,
        indexedCommitSha: "c".repeat(40),
        expectedGraphRevision: 0,
        graphRevision: 1,
        publicationHash: `sha256:${"2".repeat(64)}`,
        replacementKind: "full",
        nodeCounts: { application: 1 },
        relationshipCounts: {},
        coverageCounts: {},
        evidenceTierCounts: { A: 0, B: 0, C: 0 },
        nodeCount: 1,
        relationshipCount: 0,
        retainedEvidenceCount: 0,
        publishedAt: timestamp,
      })
    ).toThrow()
  })

  it("bounds selected path depth and rejects Tier D filters", () => {
    const query = {
      applicationId,
      graphRevision: 1,
      startId: `requirement:v1:${"3".repeat(64)}`,
      endId: `workflow:v1:${"4".repeat(64)}`,
      relationshipTypes: ["COVERED_BY"],
      evidenceTiers: ["A"],
      maxDepth: 8,
      limit: 20,
    }
    expect(graphPathQuerySchema.parse(query).maxDepth).toBe(8)
    expect(() =>
      graphPathQuerySchema.parse({ ...query, maxDepth: 13 })
    ).toThrow()
    expect(() =>
      graphPathQuerySchema.parse({ ...query, evidenceTiers: ["D"] })
    ).toThrow()
  })

  it("keeps corroborated link extraction methods readable by path queries", () => {
    const relationship = {
      id: `evidence:v1:${"5".repeat(64)}`,
      fromId: `requirement:v1:${"6".repeat(64)}`,
      type: "COVERED_BY",
      toId: `workflow:v1:${"7".repeat(64)}`,
      extractionMethod: "corroborated:runtime_request_match+frontend_http_call",
      evidenceTier: "B",
      evidenceIds: [`evidence:v1:${"8".repeat(64)}`],
      evidence: [
        {
          evidenceId: `evidence:v1:${"8".repeat(64)}`,
          extractionMethod: "runtime_request_match",
          provenance: { sourceKind: "system", observedAt: timestamp },
        },
      ],
      reviewState: "not_required",
      graphRevision: 1,
    }
    expect(
      graphPathRelationshipSchema.parse(relationship).extractionMethod
    ).toBe("corroborated:runtime_request_match+frontend_http_call")
  })
})
