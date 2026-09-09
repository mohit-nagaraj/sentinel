import { describe, expect, it } from "vitest"

import {
  prInvestigationBaselineOutcomeSchema,
  prInvestigationOverlaySchema,
} from "./pr-investigation.ts"

const graphSha = "1".repeat(40)
const baseSha = "2".repeat(40)

describe("PR investigation contracts", () => {
  it.each([
    ["exact", true, "graph_matches_pr_base", "proceed", "none", graphSha],
    [
      "safe_ancestor_warning",
      true,
      "ancestor_without_relevant_changes",
      "proceed_with_warning",
      "none",
      baseSha,
    ],
    [
      "stale_relevant",
      false,
      "ancestor_with_relevant_changes",
      "action_required",
      "refresh_graph",
      baseSha,
    ],
    [
      "unrelated_or_unknown",
      false,
      "baseline_not_ancestor_of_pr_base",
      "action_required",
      "reconnect_baseline",
      baseSha,
    ],
  ] as const)(
    "enforces the %s baseline policy",
    (status, allowed, reason, disposition, action, selectedBaseSha) => {
      const relevantInterveningPaths =
        status === "stale_relevant" ? ["src/order.ts"] : []
      expect(
        prInvestigationBaselineOutcomeSchema.parse({
          disposition,
          action,
          compatibility: {
            status,
            assessmentAllowed: allowed,
            graphCommitSha: graphSha,
            baseSha: selectedBaseSha,
            reason,
            relevantInterveningPaths,
          },
        })
      ).toMatchObject({ disposition, action })
    }
  )

  it("rejects a proceed outcome for an incompatible baseline", () => {
    expect(() =>
      prInvestigationBaselineOutcomeSchema.parse({
        disposition: "proceed",
        action: "none",
        compatibility: {
          status: "stale_relevant",
          assessmentAllowed: false,
          graphCommitSha: graphSha,
          baseSha,
          reason: "ancestor_with_relevant_changes",
          relevantInterveningPaths: ["src/order.ts"],
        },
      })
    ).toThrow("Baseline outcome does not match compatibility policy")
  })

  it("only accepts assessment-only overlays", () => {
    const minimal = {
      schemaVersion: 1,
      id: `sha256:${"a".repeat(64)}`,
      mode: "baseline_publication",
      applicationId: `application:v1:${"b".repeat(64)}`,
      runId: "run:00000000-0000-4000-8000-000000000001",
      pullRequestId: `pull-request:v1:${"c".repeat(64)}`,
      graphRevision: 1,
      graphCommitSha: graphSha,
      diffAnalysisId: `sha256:${"d".repeat(64)}`,
      codeResultIds: [],
      graphPaths: [],
      proposedClaims: [],
      validatedClaimIds: [],
      rejectedClaimIds: [],
      conflictIds: [],
      unresolvedBoundaries: [],
      unknowns: [],
      curatorEvidenceStateId: `sha256:${"e".repeat(64)}`,
    }
    expect(() => prInvestigationOverlaySchema.parse(minimal)).toThrow()
    expect(
      prInvestigationOverlaySchema.parse({
        ...minimal,
        mode: "assessment_only",
      }).mode
    ).toBe("assessment_only")
    expect(() =>
      prInvestigationOverlaySchema.parse({
        ...minimal,
        mode: "assessment_only",
        validatedClaimIds: [`claim:v1:${"f".repeat(64)}`],
      })
    ).toThrow("must reference proposed claims")
  })
})
