import { describe, expect, it } from "vitest"

import {
  blastRadiusResultSchema,
  deploymentValidationResultSchema,
  hashCanonical,
  verificationControlDefinitionSchema,
  verificationScenarioDefinitionSchema,
  verificationPlanningInputSchema,
  type DeploymentValidationResult,
  type VerificationPlanningInput,
} from "@sentinel/contracts"

import { createVerificationPlan } from "./verification-planning.ts"

const applicationId = `application:v1:${"a".repeat(64)}`
const runId = "run:123e4567-e89b-42d3-a456-426614174000"
const workflowId = `workflow:v1:${"b".repeat(64)}`
const controlWorkflowId = `workflow:v1:${"c".repeat(64)}`
const codeSymbolId = `code-symbol:v1:${"d".repeat(64)}`
const evidenceId = `evidence:v1:${"e".repeat(64)}`
const pathId = `sha256:${"1".repeat(64)}`
const scenarioId = `sha256:${"2".repeat(64)}`
const findingId = `sha256:${"3".repeat(64)}`
const headSha = "f".repeat(40)
const assessmentId = "123e4567-e89b-42d3-a456-426614174001"
const pullRequestId = `pull-request:v1:${"7".repeat(64)}`

function trustedDeployment(
  overrides: Partial<DeploymentValidationResult> = {}
): DeploymentValidationResult {
  return deploymentValidationResultSchema.parse({
    schemaVersion: 1,
    applicationId,
    registrationId: `sha256:${"4".repeat(64)}`,
    purpose: "pr_head_verification",
    assessmentId,
    pullRequestId,
    expectedCommitSha: headSha,
    identityState: "exact",
    trustState: "trusted",
    readinessState: "ready",
    browserAccessAllowed: true,
    credentialAccessAllowed: true,
    reason: "deployment_ready",
    proof: {
      schemaVersion: 1,
      provider: "render",
      serviceId: "srv-head",
      deployId: "dep-head",
      repository: {
        host: "github.com",
        owner: "hieventsdev",
        name: "hi.events",
      },
      commitSha: headSha,
      publicUrl: "https://hi-events-pr.onrender.com",
      status: "live",
      observedAt: "2026-09-09T10:00:00.000Z",
    },
    validatedAt: "2026-09-09T10:00:00.000Z",
    ...overrides,
  })
}

const scenario = {
  schemaVersion: 1 as const,
  id: scenarioId,
  kind: "workflow_checkpoint" as const,
  targetId: workflowId,
  workflowId,
  checkpointEntityIds: [workflowId],
  evidencePathIds: [pathId],
  priority: "high" as const,
}

function blastRadius() {
  const candidateId = `sha256:${"5".repeat(64)}`
  const relationship = {
    id: evidenceId,
    applicationId,
    type: "CALLS" as const,
    fromId: codeSymbolId,
    toId: workflowId,
    evidenceTier: "A" as const,
    extractionMethod: "fixture",
    evidenceIds: [evidenceId],
    provenance: [
      {
        sourceKind: "repository" as const,
        repository: {
          host: "github.com",
          owner: "hieventsdev",
          name: "hi.events",
        },
        commitSha: headSha,
      },
    ],
    reviewState: "not_required" as const,
    graphRevision: 1,
    stale: false,
    conflictIds: [],
  }
  const nodes = [
    {
      id: codeSymbolId,
      applicationId,
      kind: "code-symbol" as const,
      title: "Checkout submit handler",
      evidenceTier: "A" as const,
      evidenceIds: [evidenceId],
      provenance: {
        sourceKind: "repository" as const,
        repository: {
          host: "github.com",
          owner: "hieventsdev",
          name: "hi.events",
        },
        commitSha: headSha,
      },
      reviewState: "not_required" as const,
      graphRevision: 1,
    },
    {
      id: workflowId,
      applicationId,
      kind: "workflow" as const,
      title: "Free ticket checkout",
      evidenceTier: "A" as const,
      evidenceIds: [evidenceId],
      provenance: {
        sourceKind: "browser" as const,
        sourceUri: "https://demo.hi.events",
        observedAt: "2026-09-08T10:00:00.000Z",
      },
      reviewState: "not_required" as const,
      graphRevision: 1,
    },
  ]
  return blastRadiusResultSchema.parse({
    schemaVersion: 1,
    id: `sha256:${"6".repeat(64)}`,
    applicationId,
    assessmentId,
    pullRequestId,
    graphRevision: 1,
    graphCommitSha: "8".repeat(40),
    policyVersion: "blast-radius-policy-v1",
    evidencePaths: [
      {
        schemaVersion: 1,
        id: pathId,
        semanticKey: `sha256:${"9".repeat(64)}`,
        applicationId,
        graphRevision: 1,
        seedId: codeSymbolId,
        targetId: workflowId,
        targetKind: "workflow",
        changedSymbolIds: [codeSymbolId],
        operations: ["modified"],
        evidenceStrength: "A",
        candidateIds: [candidateId],
        evidenceIds: [evidenceId],
        provenance: relationship.provenance,
        nodes,
        relationships: [relationship],
      },
    ],
    caveats: [],
    findings: [
      {
        schemaVersion: 1,
        id: findingId,
        targetId: workflowId,
        targetKind: "workflow",
        title: "Free ticket checkout",
        risk: "high",
        evidenceStrength: "A",
        criticality: "critical",
        changedSymbolIds: [codeSymbolId],
        evidencePathIds: [pathId],
        caveatIds: [],
        factors: [
          {
            code: "change_severity",
            points: 4,
            value: "modified",
            relatedIds: [codeSymbolId],
          },
        ],
        scenarios: [scenario],
        score: 10,
      },
    ],
    summary: { high: 1, medium: 0, low: 0, unknown: 0 },
  })
}

const checkpoint = {
  id: `sha256:${"a".repeat(64)}`,
  kind: "transition" as const,
  sourceEntityId: workflowId,
  operator: "changed" as const,
  description: "Checkout advances to the attendee details state",
}

function planningInput(
  deployment = trustedDeployment()
): VerificationPlanningInput {
  return verificationPlanningInputSchema.parse({
    schemaVersion: 1,
    applicationId: applicationId as never,
    runId: runId as never,
    deployment,
    blastRadius: blastRadius(),
    scenarios: [
      verificationScenarioDefinitionSchema.parse({
        scenario,
        goal: "Verify the impacted free-ticket checkout checkpoint",
        entryPath: "/events/demo/checkout",
        checkpoints: [checkpoint],
        setup: {
          method: "trusted_fixture_api",
          classification: "outside_blast_radius",
          reference: "Prepare an isolated event with a free ticket",
          relatedEntityIds: [codeSymbolId],
          cleanupReference: "Remove the isolated event fixture",
        },
        exclusions: ["Do not complete a real payment"],
      }),
    ],
    controls: [
      verificationControlDefinitionSchema.parse({
        id: `sha256:${"b".repeat(64)}`,
        workflowId: controlWorkflowId,
        goal: "Verify the public event listing control flow",
        entryPath: "/events",
        checkpoints: [
          {
            ...checkpoint,
            id: `sha256:${"c".repeat(64)}`,
            sourceEntityId: controlWorkflowId,
            kind: "reachability",
            operator: "present",
            description: "The public event listing remains reachable",
          },
        ],
        setup: {
          method: "trusted_fixture_api",
          classification: "outside_blast_radius",
          reference: "Prepare a published event fixture",
          relatedEntityIds: [controlWorkflowId],
          cleanupReference: "Remove the published event fixture",
        },
        exclusions: [],
      }),
    ],
    exclusions: ["Real payments are outside verification scope"],
  })
}

describe("createVerificationPlan", () => {
  it("builds bounded affected and control missions with setup classification", () => {
    const plan = createVerificationPlan(planningInput(), {
      now: () => new Date("2026-09-09T10:05:00.000Z"),
    })

    expect(plan.status).toBe("planned")
    expect(plan.missions).toHaveLength(1)
    expect(plan.missions[0]).toMatchObject({
      kind: "affected",
      findingIds: [findingId],
      scenarioIds: [scenarioId],
      priority: "high",
      setup: {
        classification: "inside_blast_radius",
        method: "user_interface",
      },
      mission: {
        agent: "application",
        mode: "pr_change_validation",
        scope: { allowedHosts: ["hi-events-pr.onrender.com"] },
      },
    })
    expect(plan.control).toMatchObject({
      kind: "control",
      targetIds: [controlWorkflowId],
      setup: {
        classification: "outside_blast_radius",
        method: "trusted_fixture_api",
      },
    })
    expect(plan.budget.browserActions).toBe(24)
    expect(plan.budget.reconciliationRounds).toBe(1)
  })

  it("returns actionable verification_unavailable while preserving static assessment identity", () => {
    const unavailable = deploymentValidationResultSchema.parse({
      schemaVersion: 1,
      applicationId,
      registrationId: `sha256:${"4".repeat(64)}`,
      purpose: "pr_head_verification",
      assessmentId,
      pullRequestId,
      expectedCommitSha: headSha,
      identityState: "unreachable",
      trustState: "unreachable",
      readinessState: "not_checked",
      browserAccessAllowed: false,
      credentialAccessAllowed: false,
      reason: "provider_unreachable",
      actionRequired: "Restore Render API access and retry validation",
      validatedAt: "2026-09-09T10:00:00.000Z",
    })
    const source = planningInput(unavailable)
    const plan = createVerificationPlan(source)

    expect(plan).toMatchObject({
      status: "verification_unavailable",
      assessmentId: source.blastRadius.assessmentId,
      blastRadiusResultId: source.blastRadius.id,
      missions: [],
      actionRequired: "Restore Render API access and retry validation",
    })
    expect(plan.exclusions.join(" ")).toContain(
      "static blast-radius assessment remains valid"
    )
  })

  it("never promotes a trusted baseline observation to PR-head verification", () => {
    const {
      assessmentId: _assessmentId,
      pullRequestId: _pullRequestId,
      ...trusted
    } = trustedDeployment()
    void _assessmentId
    void _pullRequestId
    const baseline = deploymentValidationResultSchema.parse({
      ...trusted,
      purpose: "baseline_observation",
    })
    const plan = createVerificationPlan(planningInput(baseline))

    expect(plan.status).toBe("verification_unavailable")
    expect(plan.actionRequired).toContain("baseline observations cannot verify")
  })

  it("keeps scenarios without a workflow link out of executable report missions", () => {
    const input = planningInput()
    const { workflowId: _workflowId, ...unlinkedScenario } = scenario
    void _workflowId
    const source = verificationPlanningInputSchema.parse({
      ...input,
      blastRadius: {
        ...input.blastRadius,
        findings: input.blastRadius.findings.map((finding) => ({
          ...finding,
          scenarios: [unlinkedScenario],
        })),
      },
      scenarios: input.scenarios.map((definition) => ({
        ...definition,
        scenario: unlinkedScenario,
      })),
      controls: [],
    })

    const plan = createVerificationPlan(source)

    expect(plan.status).toBe("verification_unavailable")
    expect(plan.exclusions.join(" ")).toContain("not linked to a workflow")
  })

  it("rejects a trusted deployment validation from another assessment", () => {
    const otherAssessment = trustedDeployment({
      assessmentId: "123e4567-e89b-42d3-a456-426614174099",
    })

    expect(() =>
      createVerificationPlan(planningInput(otherAssessment))
    ).toThrow("does not match the blast-radius assessment and pull request")
  })

  it("is deterministic for the same inputs and creation time", () => {
    const input = planningInput()
    const now = () => new Date("2026-09-09T10:05:00.000Z")
    const first = createVerificationPlan(input, { now })
    const second = createVerificationPlan(input, { now })

    expect(second.id).toBe(first.id)
    expect(hashCanonical(second)).toBe(hashCanonical(first))
  })

  it("keeps system exclusions within the wire limit", () => {
    const input = verificationPlanningInputSchema.parse({
      ...planningInput(),
      controls: [],
      exclusions: Array.from(
        { length: 100 },
        (_, index) => `Caller exclusion ${index}`
      ),
    })
    const plan = createVerificationPlan(input)

    expect(plan.exclusions).toHaveLength(100)
    expect(plan.exclusions[0]).toContain("No unaffected control flow")
  })
})
