import { describe, expect, it } from "vitest"

import {
  BLAST_RADIUS_POLICY_VERSION,
  blastRadiusCandidatePathSchema,
  blastRadiusFindingSchema,
  blastRadiusInputSchema,
} from "./blast-radius.ts"

describe("blast-radius contracts", () => {
  it("rejects unknown findings that claim confident paths", () => {
    expect(() =>
      blastRadiusFindingSchema.parse({
        schemaVersion: 1,
        id: `sha256:${"a".repeat(64)}`,
        targetKind: "unknown",
        title: "Unknown impact",
        risk: "unknown",
        evidenceStrength: "D",
        criticality: "standard",
        changedSymbolIds: [],
        evidencePathIds: [`sha256:${"b".repeat(64)}`],
        caveatIds: [],
        factors: [
          {
            code: "unmapped_change",
            points: 0,
            value: "product_path_unknown",
            relatedIds: [],
          },
        ],
        scenarios: [],
        score: 0,
      })
    ).toThrow("Unknown findings")
  })

  it("rejects confident findings without an inspectable path", () => {
    expect(() =>
      blastRadiusFindingSchema.parse({
        schemaVersion: 1,
        id: `sha256:${"a".repeat(64)}`,
        targetId: `requirement:v1:${"b".repeat(64)}`,
        targetKind: "requirement",
        title: "Order creation",
        risk: "high",
        evidenceStrength: "A",
        criticality: "critical",
        changedSymbolIds: [`code-symbol:v1:${"c".repeat(64)}`],
        evidencePathIds: [],
        caveatIds: [],
        factors: [
          {
            code: "product_criticality",
            points: 4,
            value: "critical",
            relatedIds: [],
          },
        ],
        scenarios: [],
        score: 4,
      })
    ).toThrow("Confident findings")
  })

  it("pins the deterministic policy version and candidate depth", () => {
    expect(() =>
      blastRadiusInputSchema.parse({
        schemaVersion: 1,
        applicationId: `application:v1:${"a".repeat(64)}`,
        assessmentId: "00000000-0000-4000-8000-000000000028",
        pullRequestId: `pull-request:v1:${"b".repeat(64)}`,
        graphRevision: 1,
        graphCommitSha: "1".repeat(40),
        policyVersion: "future-policy",
        candidates: [],
        unknowns: [],
        criticalities: [],
      })
    ).toThrow()
    expect(BLAST_RADIUS_POLICY_VERSION).toBe("blast-radius-policy-v1")
    expect(() =>
      blastRadiusCandidatePathSchema.parse({
        schemaVersion: 1,
        id: `sha256:${"d".repeat(64)}`,
        source: "current_graph",
        applicationId: `application:v1:${"a".repeat(64)}`,
        graphRevision: 1,
        seedId: `code-symbol:v1:${"c".repeat(64)}`,
        targetId: `requirement:v1:${"b".repeat(64)}`,
        targetKind: "requirement",
        changedSymbolIds: [`code-symbol:v1:${"c".repeat(64)}`],
        operations: ["modified"],
        nodes: [],
        relationships: [],
      })
    ).toThrow()
  })

  it("rejects duplicate candidate identities", () => {
    const candidate = {
      schemaVersion: 1,
      id: `sha256:${"d".repeat(64)}`,
      source: "current_graph",
      applicationId: `application:v1:${"a".repeat(64)}`,
      graphRevision: 1,
      seedId: `code-symbol:v1:${"c".repeat(64)}`,
      targetId: `ui-element:v1:${"e".repeat(64)}`,
      targetKind: "ui-element",
      changedSymbolIds: [`code-symbol:v1:${"c".repeat(64)}`],
      operations: ["modified"],
      nodes: [
        {
          id: `code-symbol:v1:${"c".repeat(64)}`,
          applicationId: `application:v1:${"a".repeat(64)}`,
          kind: "code-symbol",
          title: "handler",
          evidenceTier: "A",
          evidenceIds: [],
          provenance: {
            sourceKind: "system",
            observedAt: "2026-09-09T00:00:00.000Z",
          },
          reviewState: "not_required",
          graphRevision: 1,
        },
        {
          id: `ui-element:v1:${"e".repeat(64)}`,
          applicationId: `application:v1:${"a".repeat(64)}`,
          kind: "ui-element",
          title: "Submit",
          evidenceTier: "A",
          evidenceIds: [],
          provenance: {
            sourceKind: "system",
            observedAt: "2026-09-09T00:00:00.000Z",
          },
          reviewState: "not_required",
          graphRevision: 1,
        },
      ],
      relationships: [
        {
          id: `evidence:v1:${"f".repeat(64)}`,
          applicationId: `application:v1:${"a".repeat(64)}`,
          type: "BINDS",
          fromId: `ui-element:v1:${"e".repeat(64)}`,
          toId: `code-symbol:v1:${"c".repeat(64)}`,
          evidenceTier: "A",
          extractionMethod: "fixture",
          evidenceIds: [`evidence:v1:${"f".repeat(64)}`],
          provenance: [
            { sourceKind: "system", observedAt: "2026-09-09T00:00:00.000Z" },
          ],
          reviewState: "not_required",
          graphRevision: 1,
          stale: false,
          conflictIds: [],
        },
      ],
    }
    expect(() =>
      blastRadiusInputSchema.parse({
        schemaVersion: 1,
        applicationId: candidate.applicationId,
        assessmentId: "00000000-0000-4000-8000-000000000028",
        pullRequestId: `pull-request:v1:${"b".repeat(64)}`,
        graphRevision: 1,
        graphCommitSha: "1".repeat(40),
        policyVersion: BLAST_RADIUS_POLICY_VERSION,
        candidates: [candidate, candidate],
        unknowns: [],
        criticalities: [],
      })
    ).toThrow("candidate IDs")
  })
})
