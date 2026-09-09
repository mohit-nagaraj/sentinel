import { describe, expect, it } from "vitest"

import {
  evidenceAdjudicationResultSchema,
  evidenceLinkingInputSchema,
  hashCanonical,
  linkEvidenceRecordSchema,
  pendingEvidenceLinkBatchSchema,
  submittedEvidenceLinkSchema,
} from "@sentinel/contracts"

const applicationId = `application:v1:${"a".repeat(64)}`
const runId = "run:00000000-0000-4000-8000-000000000018"
const evidenceId = `evidence:v1:${"b".repeat(64)}`
const claimId = `claim:v1:${"c".repeat(64)}`
const symbolId = `code-symbol:v1:${"d".repeat(64)}`
const otherSymbolId = `code-symbol:v1:${"e".repeat(64)}`
const commitSha = "0497418d5c66d20693751e68be066260eda3f37f"
const capturedAt = "2026-09-09T10:00:00.000Z"

function validEvidence() {
  return {
    reference: {
      schemaVersion: 1,
      id: evidenceId,
      applicationId,
      runId,
      status: "captured",
      kind: "source_call",
      contentHash: hashCanonical("source"),
      capturedAt,
    },
    provenance: {
      sourceKind: "repository",
      repository: {
        host: "github.com",
        owner: "mohit-nagaraj",
        name: "sentinel",
      },
      commitSha,
      contentHash: hashCanonical("source"),
    },
    extractionMethod: "source_call",
    summary: "AST call evidence",
  }
}

describe("evidence linking contracts", () => {
  it("rejects mismatched evidence content provenance", () => {
    expect(
      linkEvidenceRecordSchema.safeParse({
        ...validEvidence(),
        provenance: {
          ...validEvidence().provenance,
          contentHash: hashCanonical("different-source"),
        },
      }).success
    ).toBe(false)
  })

  it("enforces typed relationship endpoints", () => {
    expect(
      submittedEvidenceLinkSchema.safeParse({
        id: claimId,
        applicationId,
        assertion: "supports",
        fromId: `workflow:v1:${"f".repeat(64)}`,
        relationship: "CALLS",
        toId: otherSymbolId,
        evidenceIds: [evidenceId],
        explanation: "Invalid source kind",
      }).success
    ).toBe(false)
  })

  it("caps the complete model candidate set", () => {
    expect(
      evidenceLinkingInputSchema.safeParse({
        schemaVersion: 1,
        applicationId,
        runId,
        graphRevision: 1,
        compatibleRunIds: [runId],
        compatibleCommitShas: [commitSha],
        evidence: [],
        submittedLinks: [],
        exactObservations: [],
        apiEndpoints: [],
        frontendRoutes: [],
        semanticEntities: [],
        maxCandidates: 21,
      }).success
    ).toBe(false)
  })

  it("rejects arbitrary fields in model adjudication output", () => {
    expect(
      evidenceAdjudicationResultSchema.safeParse({
        schemaVersion: 1,
        decisions: [
          {
            candidateId: `candidate:v1:${"a".repeat(64)}`,
            decision: "select",
            reason: "Attempted arbitrary link",
            fromId: symbolId,
          },
        ],
      }).success
    ).toBe(false)
  })

  it("keeps unvalidated evidence out of a pending graph-fact batch", () => {
    expect(
      pendingEvidenceLinkBatchSchema.safeParse({
        schemaVersion: 1,
        applicationId,
        runId,
        graphRevision: 1,
        status: "pending",
        evidence: [validEvidence()],
        links: [],
        reviewCandidates: [],
        conflicts: [],
        rejections: [],
        batchHash: hashCanonical("batch"),
      }).success
    ).toBe(false)
  })
})
