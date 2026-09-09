import { describe, expect, it } from "vitest"

import {
  coverageEntitySchema,
  coverageGapSchema,
  curatorAgentPolicySchema,
  curatorModelOutputSchema,
  hashCanonical,
} from "@sentinel/contracts"

const applicationId = `application:v1:${"a".repeat(64)}`
const evidenceId = `evidence:v1:${"b".repeat(64)}`
const requirementId = `requirement:v1:${"c".repeat(64)}`

const budget = {
  toolCalls: 1,
  contentBytes: 1,
  documentBytes: 1,
  documentPages: 1,
  documentSections: 1,
  sourceLines: 1,
  repositoryBytes: 1,
  repositoryFiles: 1,
  browserActions: 1,
  modelCalls: 1,
  modelInputTokens: 1,
  modelOutputTokens: 1,
  reconciliationRounds: 1,
  elapsedMs: 1,
}

describe("evidence Curator contracts", () => {
  it("binds coverage entity IDs to their declared kind", () => {
    expect(
      coverageEntitySchema.safeParse({
        id: requirementId,
        applicationId,
        kind: "workflow",
        evidenceIds: [evidenceId],
      }).success
    ).toBe(false)
  })

  it("requires human gaps to omit specialist recommendations", () => {
    expect(
      coverageGapSchema.safeParse({
        id: hashCanonical("gap"),
        kind: "human_review_required",
        subjectIds: [requirementId],
        evidenceIds: [evidenceId],
        candidateIds: [],
        conflictIds: [],
        summary: "Review required",
        requiresHuman: true,
        recommendedAgent: "code",
        allowedModes: [],
      }).success
    ).toBe(false)
  })

  it("rejects Curator policies that grant curator or system agents", () => {
    expect(
      curatorAgentPolicySchema.safeParse({
        agent: "curator",
        modes: ["implementation_trace"],
        allowedRepositoryPaths: [],
        allowedSourceUris: [],
        allowedHosts: [],
        allowedTools: ["find_definition"],
        maxMissionBudget: budget,
        maxMissionsPerRound: 1,
      }).success
    ).toBe(false)
  })

  it("rejects free-form Curator output fields and invalid mission envelopes", () => {
    expect(
      curatorModelOutputSchema.safeParse({
        schemaVersion: 1,
        missions: [],
        graphWrite: { relationship: "CALLS" },
      }).success
    ).toBe(false)
  })
})
