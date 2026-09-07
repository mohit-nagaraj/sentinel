import { describe, expect, it } from "vitest"

import {
  codeExplorerMissionSchema,
  codeExplorerToolNames,
  codeImplementationPathSchema,
  codeMissionResultSchema,
  codeProposedClaimSchema,
  codeSourceEvidenceSchema,
  submitCodeClaimInputSchema,
} from "./code-explorer.ts"

const applicationId = `application:v1:${"a".repeat(64)}`
const runId = "run:00000000-0000-4000-8000-000000000001"
const missionId = `mission:v1:${"b".repeat(64)}`
const claimId = `claim:v1:${"c".repeat(64)}`
const evidenceId = `evidence:v1:${"d".repeat(64)}`
const endpointId = `api-endpoint:v1:${"e".repeat(64)}`
const symbolId = `code-symbol:v1:${"f".repeat(64)}`

const emptyBudget = {
  toolCalls: 0,
  contentBytes: 0,
  documentBytes: 0,
  documentPages: 0,
  documentSections: 0,
  sourceLines: 0,
  repositoryBytes: 0,
  repositoryFiles: 0,
  browserActions: 0,
  modelCalls: 0,
  modelInputTokens: 0,
  modelOutputTokens: 0,
  reconciliationRounds: 0,
  elapsedMs: 0,
}

const mission = {
  schemaVersion: 1,
  id: missionId,
  runId,
  applicationId,
  agent: "code",
  mode: "implementation_trace",
  goal: "Trace order creation through the indexed repository.",
  seedEvidenceIds: [],
  questions: ["Which symbols implement order creation?"],
  scope: {
    repositoryPaths: ["frontend/src", "backend/app", "backend/routes"],
    languages: ["tsx", "typescript", "php"],
    sourceUris: [],
    allowedHosts: [],
    allowedTools: [...codeExplorerToolNames],
  },
  budget: { ...emptyBudget, toolCalls: 20, sourceLines: 400 },
  successCriteria: ["A cited frontend-to-backend path is returned."],
}

const structuralEvidence = {
  evidenceId,
  kind: "route_handler",
  strength: "structural",
  filePath: "backend/routes/api.php",
  range: { startLine: 10, endLine: 12 },
  sourceEntityId: endpointId,
  targetEntityId: symbolId,
}

const claim = {
  id: claimId,
  status: "proposed",
  subjectId: endpointId,
  predicate: "handled_by",
  objectId: symbolId,
  evidenceIds: [evidenceId],
  explanation: "The normalized Laravel route names this action.",
  evidence: [structuralEvidence],
}

describe("Code Explorer contracts", () => {
  it("defines the exact least-privilege tool surface", () => {
    expect(codeExplorerToolNames).toStrictEqual([
      "list_repository_modules",
      "search_symbols",
      "search_code_text",
      "inspect_symbol",
      "find_definition",
      "find_references",
      "trace_callers",
      "trace_callees",
      "find_endpoint_handler",
      "find_frontend_callers",
      "inspect_tests",
      "submit_code_claim",
      "finish_code_mission",
    ])
    expect(codeExplorerMissionSchema.parse(mission)).toMatchObject({
      agent: "code",
      scope: { languages: ["tsx", "typescript", "php"] },
    })
  })

  it("rejects another agent, an unknown tool, and unsafe repository paths", () => {
    expect(
      codeExplorerMissionSchema.safeParse({ ...mission, agent: "application" })
        .success
    ).toBe(false)
    expect(
      codeExplorerMissionSchema.safeParse({
        ...mission,
        scope: { ...mission.scope, allowedTools: ["run_shell"] },
      }).success
    ).toBe(false)
    expect(
      codeExplorerMissionSchema.safeParse({
        ...mission,
        scope: { ...mission.scope, repositoryPaths: ["../outside"] },
      }).success
    ).toBe(false)
  })

  it("requires claim evidence to be source ranged, correlated, and structural", () => {
    expect(codeProposedClaimSchema.parse(claim)).toMatchObject({
      status: "proposed",
      evidence: [{ strength: "structural" }],
    })
    expect(
      codeSourceEvidenceSchema.safeParse({
        ...structuralEvidence,
        evidenceTier: "A",
      }).success
    ).toBe(false)
    expect(
      codeProposedClaimSchema.safeParse({
        ...claim,
        evidence: [{ ...structuralEvidence, strength: "lexical" }],
      }).success
    ).toBe(false)
    expect(
      codeProposedClaimSchema.safeParse({
        ...claim,
        evidenceIds: [`evidence:v1:${"1".repeat(64)}`],
      }).success
    ).toBe(false)
    expect(
      submitCodeClaimInputSchema.safeParse({
        ...claim,
        predicate: "deletes",
      }).success
    ).toBe(false)
  })

  it("requires implementation path edges to connect adjacent unique nodes", () => {
    const path = {
      key: `sha256:${"1".repeat(64)}`,
      nodes: [endpointId, symbolId],
      edges: [
        {
          subjectId: endpointId,
          predicate: "handled_by",
          objectId: symbolId,
          evidenceIds: [evidenceId],
        },
      ],
    }
    expect(codeImplementationPathSchema.parse(path)).toStrictEqual(path)
    expect(
      codeImplementationPathSchema.safeParse({
        ...path,
        nodes: [endpointId, endpointId],
      }).success
    ).toBe(false)
    expect(
      codeImplementationPathSchema.safeParse({
        ...path,
        edges: [{ ...path.edges[0], subjectId: symbolId }],
      }).success
    ).toBe(false)
  })

  it("returns a strict Code MissionResult-compatible terminal envelope", () => {
    const result = {
      schemaVersion: 1,
      missionId,
      status: "complete",
      claims: [claim],
      paths: [
        {
          key: `sha256:${"1".repeat(64)}`,
          nodes: [endpointId, symbolId],
          edges: [
            {
              subjectId: endpointId,
              predicate: "handled_by",
              objectId: symbolId,
              evidenceIds: [evidenceId],
            },
          ],
        },
      ],
      unresolved: [],
      unresolvedBoundaries: [],
      exclusions: [],
      suggestedFollowups: [],
      stopReason: {
        code: "criteria_met",
        summary: "The cited implementation path was established.",
      },
      budgetUsed: emptyBudget,
      traversalHopsUsed: 1,
      resultItemsUsed: 2,
    }
    expect(codeMissionResultSchema.parse(result)).toStrictEqual(result)
    expect(
      codeMissionResultSchema.safeParse({ ...result, accepted: true }).success
    ).toBe(false)
    expect(
      codeMissionResultSchema.safeParse({
        ...result,
        paths: [result.paths[0], result.paths[0]],
      }).success
    ).toBe(false)
  })
})
