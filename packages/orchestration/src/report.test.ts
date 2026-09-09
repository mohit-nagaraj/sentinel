import {
  BLAST_RADIUS_POLICY_VERSION,
  REPORT_TEMPLATE_VERSION,
  REPORT_WORDING_PROMPT_VERSION,
  applicationIdSchema,
  assessmentReportSourceSchema,
  blastRadiusResultSchema,
  evidenceCuratorResultSchema,
  evidenceIdSchema,
  hashCanonical,
  prInvestigationResultSchema,
  reportWordingOutputSchema,
  type ReportWordingOutput,
} from "@sentinel/contracts"
import { describe, expect, it, vi } from "vitest"

import {
  buildGithubReportCheck,
  createAssessmentReportRunFinalizer,
  generateAndPublishAssessmentReport,
  generateAssessmentReport,
  renderAssessmentReportMarkdown,
  validateReportWording,
  type ReportWordingModelPort,
} from "./report.ts"

const applicationId = applicationIdSchema.parse(
  `application:v1:${"a".repeat(64)}`
)
const assessmentId = "00000000-0000-4000-8000-000000000029"
const runId = "run:00000000-0000-4000-8000-000000000029"
const pullRequestId = `pull-request:v1:${"b".repeat(64)}`
const symbolId = `code-symbol:v1:${"c".repeat(64)}`
const workflowId = `workflow:v1:${"d".repeat(64)}`
const requirementId = `requirement:v1:${"e".repeat(64)}`
const evidenceId = evidenceIdSchema.parse(`evidence:v1:${"f".repeat(64)}`)
const timestamp = "2026-09-09T10:00:00.000Z"
const zeroBudget = {
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
} as const

function confidentFinding(risk: "high" | "medium" | "low", ordinal: number) {
  const pathId = hashCanonical({ kind: "report-path", risk, ordinal })
  const findingId = hashCanonical({ kind: "report-finding", risk, ordinal })
  const scenarioId = hashCanonical({ kind: "report-scenario", risk, ordinal })
  const path = {
    schemaVersion: 1,
    id: pathId,
    semanticKey: hashCanonical({ kind: "semantic-path", risk, ordinal }),
    applicationId,
    graphRevision: 3,
    seedId: symbolId,
    targetId: requirementId,
    targetKind: "requirement" as const,
    changedSymbolIds: [symbolId],
    operations: ["modified" as const],
    evidenceStrength: risk === "medium" ? ("B" as const) : ("A" as const),
    candidateIds: [hashCanonical({ kind: "candidate", risk, ordinal })],
    evidenceIds: [evidenceId],
    provenance: [{ sourceKind: "system" as const, observedAt: timestamp }],
    nodes: [
      {
        id: symbolId,
        applicationId,
        kind: "code-symbol" as const,
        title: "OrderService.submit",
        evidenceTier: "A" as const,
        evidenceIds: [],
        provenance: { sourceKind: "system" as const, observedAt: timestamp },
        reviewState: "not_required" as const,
        graphRevision: 3,
      },
      {
        id: workflowId,
        applicationId,
        kind: "workflow" as const,
        title: "Attendee checkout",
        evidenceTier: "A" as const,
        evidenceIds: [],
        provenance: { sourceKind: "system" as const, observedAt: timestamp },
        reviewState: "not_required" as const,
        graphRevision: 3,
      },
      {
        id: requirementId,
        applicationId,
        kind: "requirement" as const,
        title: "Buyers create orders",
        evidenceTier: "A" as const,
        evidenceIds: [],
        provenance: { sourceKind: "system" as const, observedAt: timestamp },
        reviewState: "not_required" as const,
        graphRevision: 3,
      },
    ],
    relationships: [
      {
        id: evidenceId,
        applicationId,
        type: "CALLS" as const,
        fromId: symbolId,
        toId: workflowId,
        evidenceTier: "A" as const,
        extractionMethod: "fixture_path",
        evidenceIds: [evidenceId],
        sourceUris: ["repository://src/order-service.ts"],
        artifactIds: [`artifact:v1:${"9".repeat(64)}`],
        provenance: [{ sourceKind: "system" as const, observedAt: timestamp }],
        reviewState: "not_required" as const,
        graphRevision: 3,
        stale: false,
        conflictIds: [],
      },
      {
        id: evidenceId,
        applicationId,
        type: "COVERED_BY" as const,
        fromId: requirementId,
        toId: workflowId,
        evidenceTier: "A" as const,
        extractionMethod: "fixture_path",
        evidenceIds: [evidenceId],
        sourceUris: [
          "https://docs.example.test/requirements/order-creation#acceptance",
        ],
        artifactIds: [],
        provenance: [{ sourceKind: "system" as const, observedAt: timestamp }],
        reviewState: "not_required" as const,
        graphRevision: 3,
        stale: false,
        conflictIds: [],
      },
    ],
  }
  const scenario = {
    schemaVersion: 1,
    id: scenarioId,
    kind: "requirement_acceptance" as const,
    targetId: requirementId,
    workflowId,
    requirementId,
    checkpointEntityIds: [workflowId, requirementId],
    evidencePathIds: [pathId],
    priority: risk,
  }
  const finding = {
    schemaVersion: 1,
    id: findingId,
    targetId: requirementId,
    targetKind: "requirement" as const,
    title: "Attendee checkout and order creation",
    risk,
    evidenceStrength: path.evidenceStrength,
    criticality:
      risk === "high" ? ("critical" as const) : ("standard" as const),
    changedSymbolIds: [symbolId],
    evidencePathIds: [pathId],
    caveatIds: [],
    factors: [
      {
        code: "product_criticality" as const,
        points: risk === "high" ? 4 : 2,
        value: risk === "high" ? "critical" : "standard",
        relatedIds: [requirementId],
      },
    ],
    scenarios: [scenario],
    score: risk === "high" ? 10 : risk === "medium" ? 7 : 4,
  }
  return { path, finding }
}

function unknownFinding() {
  const unknownId = hashCanonical({ kind: "unknown-report-finding" })
  return {
    schemaVersion: 1,
    id: unknownId,
    targetKind: "unknown" as const,
    title: "Configuration change",
    risk: "unknown" as const,
    evidenceStrength: "D" as const,
    criticality: "standard" as const,
    changedSymbolIds: [],
    evidencePathIds: [],
    caveatIds: [],
    factors: [
      {
        code: "unmapped_change" as const,
        points: 0,
        value: "product_path_unknown",
        relatedIds: [],
      },
    ],
    scenarios: [],
    score: 0,
  }
}

function source(kind: "high" | "medium" | "low" | "unknown" | "mixed") {
  const confident =
    kind === "unknown"
      ? []
      : [confidentFinding(kind === "mixed" ? "high" : kind, 1)]
  const unknown =
    kind === "unknown" || kind === "mixed" ? [unknownFinding()] : []
  const findings = [...confident.map(({ finding }) => finding), ...unknown]
  const blastRadius = blastRadiusResultSchema.parse({
    schemaVersion: 1,
    id: hashCanonical({ kind: "report-blast-radius", reportKind: kind }),
    applicationId,
    assessmentId,
    pullRequestId,
    graphRevision: 3,
    graphCommitSha: "1".repeat(40),
    policyVersion: BLAST_RADIUS_POLICY_VERSION,
    evidencePaths: confident.map(({ path }) => path),
    caveats: [],
    findings,
    summary: {
      high: findings.filter(({ risk }) => risk === "high").length,
      medium: findings.filter(({ risk }) => risk === "medium").length,
      low: findings.filter(({ risk }) => risk === "low").length,
      unknown: findings.filter(({ risk }) => risk === "unknown").length,
    },
  })
  return assessmentReportSourceSchema.parse({
    schemaVersion: 1,
    assessmentId,
    applicationId,
    runId,
    pullRequest: {
      id: pullRequestId,
      repository: { host: "github.com", owner: "Sentinel", name: "Demo" },
      number: 29,
      title: "Update order creation",
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
    },
    baseline: {
      status: "exact",
      assessmentAllowed: true,
      graphCommitSha: "1".repeat(40),
      baseSha: "1".repeat(40),
      reason: "graph_matches_pr_base",
      relevantInterveningPaths: [],
    },
    blastRadius,
    coverage: [
      {
        requirementId,
        status: "not_observed",
        scope: "Checkout submission",
        wording:
          "Order confirmation was not observed within the explored checkout scope.",
        evidenceIds: [],
      },
    ],
    exclusions: [
      "Organizer reporting was outside the selected assessment scope.",
    ],
    verification: {
      status: "verification_unavailable",
      results: [],
      reason:
        "Verification is unavailable because no trusted head deployment was configured.",
      version: 0,
    },
    generatedAt: timestamp,
    templateVersion: REPORT_TEMPLATE_VERSION,
    wordingPromptVersion: REPORT_WORDING_PROMPT_VERSION,
  })
}

function completedInvestigation(selected: ReturnType<typeof source>) {
  const evidenceStateId = hashCanonical({ kind: "report-finalizer-evidence" })
  const curatorResult = evidenceCuratorResultSchema.parse({
    schemaVersion: 1,
    applicationId: selected.applicationId,
    runId: selected.runId,
    status: "complete",
    stopReason: "evidence_sufficient",
    roundsUsed: 0,
    budgetUsed: zeroBudget,
    matrix: {
      schemaVersion: 1,
      applicationId: selected.applicationId,
      runId: selected.runId,
      evidenceStateId,
      evidenceFingerprint: hashCanonical({ evidenceStateId, kind: "matrix" }),
      gaps: [],
      stats: {
        entityCount: 0,
        confidentLinkCount: 0,
        requirementCount: 0,
        workflowCount: 0,
        endpointCount: 0,
        codeSymbolCount: 0,
        gapCount: 0,
        humanGapCount: 0,
      },
      readiness: "ready",
      publicationReady: true,
    },
    missionReceipts: [],
    missionRejections: [],
    reviews: [],
  })
  return prInvestigationResultSchema.parse({
    schemaVersion: 1,
    id: hashCanonical({ kind: "report-finalizer-investigation" }),
    assessmentId: selected.assessmentId,
    applicationId: selected.applicationId,
    runId: selected.runId,
    pullRequest: {
      schemaVersion: 1,
      id: selected.pullRequest.id,
      applicationId: selected.applicationId,
      repository: selected.pullRequest.repository,
      number: selected.pullRequest.number,
      title: selected.pullRequest.title,
      baseSha: selected.pullRequest.baseSha,
      headSha: selected.pullRequest.headSha,
      analyzedAt: selected.generatedAt,
    },
    graphRevision: selected.blastRadius.graphRevision,
    graphCommitSha: selected.blastRadius.graphCommitSha,
    diffAnalysisId: hashCanonical({ kind: "report-finalizer-diff" }),
    baseline: {
      disposition: "proceed",
      action: "none",
      compatibility: selected.baseline,
    },
    completedAt: selected.generatedAt,
    status: "completed",
    groups: [],
    workerReceipts: [],
    overlayId: hashCanonical({ kind: "report-finalizer-overlay" }),
    curatorResult,
    hypotheses: [],
    verificationCandidates: [],
    unknowns: [],
  })
}

class FakeModel implements ReportWordingModelPort {
  constructor(
    readonly output: unknown,
    readonly throws = false
  ) {}
  async generateStructured<Output>() {
    if (this.throws) throw new Error("provider unavailable")
    return {
      output: this.output as Output,
      model: "fake-report-model-v1",
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    }
  }
}

describe("assessment report generation", () => {
  it.each(["high", "medium", "low", "unknown", "mixed"] as const)(
    "renders the %s golden Markdown report",
    async (kind) => {
      const view = await generateAssessmentReport({ source: source(kind) })
      expect(renderAssessmentReportMarkdown(view)).toMatchSnapshot()
    }
  )

  it("accepts only supplied model wording choices with complete citations", async () => {
    const selected = source("high")
    const finding = selected.blastRadius.findings[0]!
    const wording = reportWordingOutputSchema.parse({
      executiveSummary:
        "Predicted impact includes 1 high, 0 medium, 0 low, and 0 unknown finding. Review uncertainty and complete the recommended QA checkpoints before making a release decision.",
      findingIds: [finding.id],
      findings: [
        {
          findingId: finding.id,
          title: `${finding.title}: focused QA review`,
          summary: `This ${finding.targetKind.replaceAll("-", " ")} is potentially affected through ${finding.evidencePathIds.length} inspectable evidence path${finding.evidencePathIds.length === 1 ? "" : "s"}. The result is a prediction and should guide focused retesting.`,
          evidencePathIds: finding.evidencePathIds,
          scenarioIds: finding.scenarios.map(({ id }) => id),
          caveatIds: finding.caveatIds,
        },
      ],
    })
    const view = await generateAssessmentReport({
      source: selected,
      model: new FakeModel(wording),
    })

    expect(view.model).toEqual({
      mode: "validated_model_wording",
      modelId: "fake-report-model-v1",
    })
    expect(view.findings[0]?.title).toBe(wording.findings[0]?.title)
  })

  it.each([
    [
      "hallucinated ID",
      (value: ReportWordingOutput) =>
        reportWordingOutputSchema.parse({
          ...value,
          findingIds: [hashCanonical({ fake: true })],
        }),
    ],
    [
      "unsafe assurance",
      (value: ReportWordingOutput) =>
        reportWordingOutputSchema.parse({
          ...value,
          executiveSummary: "This pull request is safe.",
        }),
    ],
    [
      "invented stable ID family",
      (value: ReportWordingOutput) =>
        reportWordingOutputSchema.parse({
          ...value,
          executiveSummary: `Inspect artifact:v1:${"9".repeat(64)} before release.`,
        }),
    ],
  ] as const)("falls back for %s model output", async (_label, mutate) => {
    const selected = source("high")
    const finding = selected.blastRadius.findings[0]!
    const valid = reportWordingOutputSchema.parse({
      executiveSummary:
        "Predicted impact includes 1 high, 0 medium, 0 low, and 0 unknown finding. Review uncertainty and complete the recommended QA checkpoints before making a release decision.",
      findingIds: [finding.id],
      findings: [],
    })
    const view = await generateAssessmentReport({
      source: selected,
      model: new FakeModel(mutate(valid)),
    })
    expect(view.model).toEqual({ mode: "deterministic_fallback" })
  })

  it("falls back when the wording provider is unavailable", async () => {
    const view = await generateAssessmentReport({
      source: source("high"),
      model: new FakeModel({}, true),
    })
    expect(view.model.mode).toBe("deterministic_fallback")
  })

  it("propagates cancellation instead of publishing fallback wording", async () => {
    const controller = new AbortController()
    const cancellation = new Error("lease lost")
    await expect(
      generateAssessmentReport({
        source: source("high"),
        signal: controller.signal,
        model: {
          generateStructured: async () => {
            controller.abort(cancellation)
            throw new Error("provider aborted")
          },
        },
      })
    ).rejects.toBe(cancellation)
  })

  it("rejects citations outside each supplied finding", () => {
    const selected = source("high")
    const finding = selected.blastRadius.findings[0]!
    expect(() =>
      validateReportWording(
        selected,
        reportWordingOutputSchema.parse({
          executiveSummary:
            "Predicted impact includes 1 high, 0 medium, 0 low, and 0 unknown finding. Review uncertainty and complete the recommended QA checkpoints before making a release decision.",
          findingIds: [finding.id],
          findings: [
            {
              findingId: finding.id,
              title: "Order creation",
              summary: "Inspect the supplied relationship.",
              evidencePathIds: [hashCanonical({ unknown: "path" })],
              scenarioIds: [],
              caveatIds: [],
            },
          ],
        })
      )
    ).toThrow("must exactly match")
  })

  it("falls back when valid finding IDs accompany invented prose", async () => {
    const selected = source("high")
    const finding = selected.blastRadius.findings[0]!
    const view = await generateAssessmentReport({
      source: selected,
      model: new FakeModel(
        reportWordingOutputSchema.parse({
          executiveSummary:
            "Customer records are deleted when this change is deployed.",
          findingIds: [finding.id],
          findings: [
            {
              findingId: finding.id,
              title: "Customer records are deleted",
              summary: "This invented claim cites real evidence IDs.",
              evidencePathIds: finding.evidencePathIds,
              scenarioIds: finding.scenarios.map(({ id }) => id),
              caveatIds: finding.caveatIds,
            },
          ],
        })
      ),
    })

    expect(view.model).toEqual({ mode: "deterministic_fallback" })
  })

  it("renders source names and URLs containing safe without treating them as assurance", async () => {
    const selected = source("high")
    const finding = selected.blastRadius.findings[0]!
    const safeNamed = assessmentReportSourceSchema.parse({
      ...selected,
      pullRequest: { ...selected.pullRequest, title: "Safe checkout refresh" },
      blastRadius: {
        ...selected.blastRadius,
        findings: selected.blastRadius.findings.map((item) =>
          item.id === finding.id ? { ...item, title: "Safe checkout" } : item
        ),
      },
    })

    const view = await generateAssessmentReport({ source: safeNamed })
    expect(renderAssessmentReportMarkdown(view)).toContain("Safe checkout")
  })
})

describe("GitHub report projection", () => {
  it("finalizes the report and its GitHub lifecycle as one run stage", async () => {
    const selected = source("low")
    const publishCheck = vi.fn().mockResolvedValue("published")
    const finalizer = createAssessmentReportRunFinalizer({
      source: { resolve: async () => selected },
      currentHead: { isCurrent: async () => true },
      publisher: {
        publish: async () => ({
          disposition: "published",
          artifactId: `artifact:v1:${"a".repeat(64)}`,
        }),
      },
      checks: { publishCheck },
    })

    await expect(
      finalizer.finalize({ investigation: completedInvestigation(selected) })
    ).resolves.toBe("published")
    expect(publishCheck).toHaveBeenCalledWith({
      assessmentId,
      headSha: selected.pullRequest.headSha,
      lifecycle: expect.objectContaining({ state: "completed" }),
    })
  })

  it("retries a current report when GitHub check synchronization is pending", async () => {
    const selected = source("low")
    const finalizer = createAssessmentReportRunFinalizer({
      source: { resolve: async () => selected },
      currentHead: { isCurrent: async () => true },
      publisher: {
        publish: async () => ({
          disposition: "existing",
          artifactId: `artifact:v1:${"a".repeat(64)}`,
        }),
      },
      checks: { publishCheck: async () => "sync_pending" },
    })

    await expect(
      finalizer.finalize({ investigation: completedInvestigation(selected) })
    ).rejects.toThrow("synchronization is pending")
  })

  it("keeps predicted high risk neutral through the existing outcome mapping", async () => {
    const view = await generateAssessmentReport({ source: source("high") })
    expect(buildGithubReportCheck({ view })).toMatchObject({
      state: "completed",
      outcome: "verification_unavailable",
      title: "Sentinel blast radius completed",
    })
  })

  it.each([
    ["passed", "analysis_succeeded"],
    ["failed", "verification_failed"],
  ] as const)("maps %s verification to %s", async (status, outcome) => {
    const selected = source("low")
    const withVerification = assessmentReportSourceSchema.parse({
      ...selected,
      verification: {
        status,
        reason:
          status === "passed"
            ? "The selected requirement checkpoint passed."
            : "The selected requirement checkpoint failed.",
        version: 1,
        results: [
          {
            schemaVersion: 1,
            runId,
            pullRequestId,
            headSha: "2".repeat(40),
            workflowId,
            requirementIds: [requirementId],
            completedAt: timestamp,
            status,
            deploymentUrl: "https://preview.example.com/pr/29",
            assertions: [
              {
                name: "Order confirmation is reachable",
                passed: status === "passed",
                evidenceIds: [evidenceId],
              },
            ],
            requests: [
              {
                method: "GET",
                normalizedPath: "/orders/confirmation",
                status: 200,
              },
            ],
          },
        ],
      },
    })
    const view = await generateAssessmentReport({ source: withVerification })
    expect(buildGithubReportCheck({ view }).outcome).toBe(outcome)
    const markdown = renderAssessmentReportMarkdown(view)
    expect(markdown).toContain(`workflow \`${workflowId}\``)
    expect(markdown).toContain("Order confirmation is reachable")
    expect(markdown).toContain("Request: GET `/orders/confirmation` -> 200")
  })

  it("maps action-required and infrastructure failures explicitly", async () => {
    const view = await generateAssessmentReport({ source: source("low") })
    expect(buildGithubReportCheck({ view, actionRequired: true }).outcome).toBe(
      "action_required"
    )
    expect(
      buildGithubReportCheck({ view, infrastructureFailed: true }).outcome
    ).toBe("infrastructure_failed")
  })

  it("prevents a stale head from publishing after wording generation", async () => {
    let checks = 0
    let publications = 0
    const result = await generateAndPublishAssessmentReport({
      source: source("high"),
      currentHead: {
        isCurrent: async () => {
          checks += 1
          return checks < 2
        },
      },
      publisher: {
        publish: async () => {
          publications += 1
          return { disposition: "published", artifactId: "unused" }
        },
      },
    })

    expect(result).toEqual({ status: "superseded" })
    expect(publications).toBe(0)
  })

  it("returns an idempotent existing publication with its check projection", async () => {
    const result = await generateAndPublishAssessmentReport({
      source: source("low"),
      currentHead: { isCurrent: async () => true },
      publisher: {
        publish: async () => ({
          disposition: "existing",
          artifactId: `artifact:v1:${"a".repeat(64)}`,
        }),
      },
    })

    expect(result).toMatchObject({
      status: "existing",
      check: { state: "completed" },
    })
  })
})
