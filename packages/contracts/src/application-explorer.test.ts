import { describe, expect, it } from "vitest"

import {
  applicationExplorerCheckpointStateSchema,
  applicationExplorerFlowStepClaimSchema,
  applicationExplorerMissionOutputSchema,
  applicationExplorerPlannerContextSchema,
  applicationExplorerPlannerDecisionSchema,
} from "./application-explorer.ts"

const hash = (character: string) => `sha256:${character.repeat(64)}`
const entityId = (kind: string, character: string) =>
  `${kind}:v1:${character.repeat(64)}`
const evidenceId = (character: string) => `evidence:v1:${character.repeat(64)}`
const claimId = (character: string) => `claim:v1:${character.repeat(64)}`
const actionId = (character: string) => `action:v1:${character.repeat(64)}`

const ids = {
  action: actionId("a"),
  afterEvidence: evidenceId("b"),
  afterScreen: entityId("screen", "c"),
  application: entityId("application", "d"),
  beforeEvidence: evidenceId("e"),
  beforeScreen: entityId("screen", "f"),
  mission: `mission:v1:${"1".repeat(64)}`,
  request: hash("2"),
  run: "run:11111111-1111-4111-8111-111111111111",
  step: entityId("flow-step", "3"),
  transition: evidenceId("4"),
  workflow: entityId("workflow", "5"),
} as const

const timestamp = "2026-09-08T10:00:00.000Z"

const budget = {
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

const candidate = {
  actionId: ids.action,
  signature: hash("6"),
  kind: "click",
  role: "button",
  name: "Continue",
  disabled: false,
  policy: {
    category: "safe_form_progress",
    allowed: true,
    reason: "safe_form_progress",
    replaySafe: true,
  },
  expiresAt: "2026-09-08T10:01:00.000Z",
}

const mission = {
  schemaVersion: 1,
  id: ids.mission,
  runId: ids.run,
  applicationId: ids.application,
  agent: "application",
  mode: "workflow_discovery",
  goal: "Discover the checkout workflow",
  seedEvidenceIds: [],
  questions: ["How does checkout progress?"],
  scope: {
    repositoryPaths: [],
    sourceUris: [],
    allowedHosts: ["example.test"],
    allowedTools: [
      "observe_page",
      "perform_observed_action",
      "navigate_history",
      "finish_application_mission",
    ],
  },
  budget,
  successCriteria: ["Observe the confirmation screen"],
}

const recoveryRecipe = {
  schemaVersion: 1,
  applicationId: ids.application,
  sourceRunId: ids.run,
  entryUrl: "https://example.test/checkout",
  steps: [],
  createdAt: timestamp,
}

const checkpoint = {
  schemaVersion: 1,
  applicationId: ids.application,
  missionId: ids.mission,
  runId: ids.run,
  currentObservationEvidenceId: ids.afterEvidence,
  currentStateFingerprint: hash("7"),
  currentScreenId: ids.afterScreen,
  path: [],
  frontier: [],
  visits: [],
  replayBoundary: {
    schemaVersion: 1,
    authenticationStateReference: `secret-ref:v1:${"8".repeat(64)}`,
    recipe: recoveryRecipe,
    replaySafePathLength: 0,
    checkpointPathLength: 0,
    requiresHumanReview: false,
  },
  budgetUsed: budget,
  observedRuntimeRequestCount: 0,
  consecutiveNoProgress: 0,
  startedAt: timestamp,
  updatedAt: timestamp,
}

const evidenceIds = [ids.beforeEvidence, ids.afterEvidence, ids.transition]

const screenClaims = [
  {
    schemaVersion: 1,
    id: claimId("9"),
    status: "proposed",
    claimKind: "screen",
    missionId: ids.mission,
    runId: ids.run,
    evidenceIds: [ids.beforeEvidence],
    observationEvidenceId: ids.beforeEvidence,
    fact: {
      id: ids.beforeScreen,
      applicationId: ids.application,
      normalizedRoute: "/checkout",
      title: "Checkout",
      stateFingerprint: hash("a"),
    },
  },
  {
    schemaVersion: 1,
    id: claimId("b"),
    status: "proposed",
    claimKind: "screen",
    missionId: ids.mission,
    runId: ids.run,
    evidenceIds: [ids.afterEvidence],
    observationEvidenceId: ids.afterEvidence,
    fact: {
      id: ids.afterScreen,
      applicationId: ids.application,
      normalizedRoute: "/confirmation",
      title: "Confirmation",
      stateFingerprint: hash("7"),
    },
  },
]

const workflowClaim = {
  schemaVersion: 1,
  id: claimId("c"),
  status: "proposed",
  claimKind: "workflow",
  missionId: ids.mission,
  runId: ids.run,
  evidenceIds,
  fact: {
    id: ids.workflow,
    applicationId: ids.application,
    name: "Checkout",
    actor: "Customer",
    sourceRunId: ids.run,
  },
  stepIds: [ids.step],
}

const stepClaim = {
  schemaVersion: 1,
  id: claimId("d"),
  status: "proposed",
  claimKind: "flow_step",
  missionId: ids.mission,
  runId: ids.run,
  evidenceIds,
  fact: {
    id: ids.step,
    applicationId: ids.application,
    workflowId: ids.workflow,
    ordinal: 0,
    actionType: "click",
    expectedCheckpoint: "Confirmation",
    sourceRunId: ids.run,
  },
  before: {
    screenId: ids.beforeScreen,
    observationEvidenceId: ids.beforeEvidence,
    stateFingerprint: hash("a"),
  },
  after: {
    screenId: ids.afterScreen,
    observationEvidenceId: ids.afterEvidence,
    stateFingerprint: hash("7"),
  },
  action: candidate,
  transitionEvidenceId: ids.transition,
  networkRequestIds: [ids.request],
}

const requestClaim = {
  schemaVersion: 1,
  id: claimId("e"),
  status: "proposed",
  claimKind: "runtime_request",
  missionId: ids.mission,
  runId: ids.run,
  applicationId: ids.application,
  evidenceIds,
  transitionEvidenceId: ids.transition,
  beforeObservationEvidenceId: ids.beforeEvidence,
  afterObservationEvidenceId: ids.afterEvidence,
  request: {
    requestId: ids.request,
    method: "POST",
    normalizedPath: "/api/checkout",
    resourceType: "fetch",
    status: 200,
    outcome: "response",
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 0,
  },
}

const uiElementClaim = {
  schemaVersion: 1,
  id: claimId("f"),
  status: "proposed",
  claimKind: "ui_element",
  missionId: ids.mission,
  runId: ids.run,
  evidenceIds: [ids.beforeEvidence],
  observationEvidenceId: ids.beforeEvidence,
  fact: {
    id: entityId("ui-element", "0"),
    applicationId: ids.application,
    screenId: ids.beforeScreen,
    role: "button",
    accessibleName: "Continue",
    contextFingerprint: hash("0"),
    observedAt: timestamp,
    sourceRunId: ids.run,
  },
}

describe("Application Explorer contracts", () => {
  it("accepts a bounded untrusted planner context and observation-bound decision", () => {
    const context = applicationExplorerPlannerContextSchema.parse({
      schemaVersion: 1,
      mission,
      capabilityHintLabels: ["checkout"],
      requirementHintLabels: ["confirmation"],
      observation: {
        schemaVersion: 1,
        evidenceId: ids.beforeEvidence,
        applicationId: ids.application,
        runId: ids.run,
        stateFingerprint: hash("a"),
        normalizedRoute: "/checkout",
        title: "Checkout",
        untrustedPageContent: {
          trust: "untrusted",
          headings: ["Checkout"],
          selectedText: ["Choose tickets"],
          dialogs: [],
        },
      },
      progress: {
        schemaVersion: 1,
        visitedStateActionPairs: 0,
        pendingFrontierActions: 1,
        exploredBranchCount: 1,
        currentBranchDepth: 0,
        observedTransitionCount: 0,
        observedRuntimeRequestCount: 0,
        observedStateCount: 1,
        consecutiveNoProgress: 0,
        recentEvidenceIds: [ids.beforeEvidence],
        recentActions: [],
        budgetUsed: budget,
      },
      candidates: [
        {
          schemaVersion: 1,
          rank: 1,
          relevanceScore: 900,
          matchedCapabilityHints: ["checkout"],
          matchedRequirementHints: ["confirmation"],
          candidate,
        },
      ],
    })

    const decision = applicationExplorerPlannerDecisionSchema.parse({
      schemaVersion: 1,
      missionId: ids.mission,
      runId: ids.run,
      tool: "perform_observed_action",
      observationEvidenceId: context.observation.evidenceId,
      stateFingerprint: context.observation.stateFingerprint,
      actionId: context.candidates[0]?.candidate.actionId,
      reasonCode: "advance_checkout",
      summary: "Continue to the observed confirmation branch",
    })

    expect(decision.tool).toBe("perform_observed_action")
    expect(context.observation.untrustedPageContent.trust).toBe("untrusted")
  })

  it.each([
    "selector",
    "elementHandle",
    "cookie",
    "storageState",
    "value",
    "url",
  ])("rejects private browser material in planner actions: %s", (field) => {
    expect(() =>
      applicationExplorerPlannerDecisionSchema.parse({
        schemaVersion: 1,
        missionId: ids.mission,
        runId: ids.run,
        tool: "perform_observed_action",
        observationEvidenceId: ids.beforeEvidence,
        stateFingerprint: hash("a"),
        actionId: ids.action,
        reasonCode: "advance_checkout",
        summary: "Use the bounded observed action",
        [field]: "private-material",
      })
    ).toThrow()
  })

  it("rejects raw authentication state and inconsistent replay boundaries", () => {
    expect(() =>
      applicationExplorerCheckpointStateSchema.parse({
        ...checkpoint,
        replayBoundary: {
          ...checkpoint.replayBoundary,
          storageState: { cookies: [{ name: "session", value: "secret" }] },
        },
      })
    ).toThrow()

    expect(() =>
      applicationExplorerCheckpointStateSchema.parse({
        ...checkpoint,
        replayBoundary: {
          ...checkpoint.replayBoundary,
          checkpointPathLength: 1,
          requiresHumanReview: false,
        },
      })
    ).toThrow()
  })

  it("deduplicates visits by stable state and action signature", () => {
    const visit = {
      schemaVersion: 1,
      observationEvidenceId: ids.beforeEvidence,
      stateFingerprint: hash("a"),
      actionId: ids.action,
      actionSignature: candidate.signature,
      outcome: "denied",
      attemptedAt: timestamp,
    }
    expect(() =>
      applicationExplorerCheckpointStateSchema.parse({
        ...checkpoint,
        visits: [
          visit,
          {
            ...visit,
            actionId: actionId("b"),
          },
        ],
      })
    ).toThrow(/unique/)
  })

  it("rejects flow steps missing their before/after/transition evidence", () => {
    expect(() =>
      applicationExplorerFlowStepClaimSchema.parse({
        ...stepClaim,
        evidenceIds: [ids.transition],
      })
    ).toThrow()
  })

  it("accepts aggregate evidence relationships for screens, workflow, step, UI, and request", () => {
    const result = applicationExplorerMissionOutputSchema.parse({
      schemaVersion: 1,
      result: {
        schemaVersion: 1,
        missionId: ids.mission,
        status: "complete",
        claims: [],
        unresolved: [],
        exclusions: [],
        suggestedFollowups: [],
        stopReason: {
          code: "goal_completed",
          summary: "Observed checkout confirmation",
        },
        budgetUsed: budget,
      },
      terminal: {
        schemaVersion: 1,
        classification: "goal_completed",
        status: "complete",
        reasonCode: "goal_completed",
        summary: "Observed checkout confirmation",
      },
      checkpoint,
      evidenceClaims: [
        ...screenClaims,
        workflowClaim,
        stepClaim,
        uiElementClaim,
        requestClaim,
      ],
      blockers: [],
    })

    expect(result.evidenceClaims).toHaveLength(6)
  })

  it("rejects malformed screen, workflow, request-window, and terminal links", () => {
    const base = {
      schemaVersion: 1,
      result: {
        schemaVersion: 1,
        missionId: ids.mission,
        status: "complete",
        claims: [],
        unresolved: [],
        exclusions: [],
        suggestedFollowups: [],
        stopReason: {
          code: "goal_completed",
          summary: "Observed checkout confirmation",
        },
        budgetUsed: budget,
      },
      terminal: {
        schemaVersion: 1,
        classification: "goal_completed",
        status: "complete",
        reasonCode: "goal_completed",
        summary: "Observed checkout confirmation",
      },
      checkpoint,
      blockers: [],
    }

    expect(() =>
      applicationExplorerMissionOutputSchema.parse({
        ...base,
        evidenceClaims: [
          ...screenClaims,
          workflowClaim,
          { ...stepClaim, networkRequestIds: [hash("f")] },
          requestClaim,
        ],
      })
    ).toThrow()

    expect(() =>
      applicationExplorerMissionOutputSchema.parse({
        ...base,
        evidenceClaims: [
          ...screenClaims,
          workflowClaim,
          {
            ...uiElementClaim,
            fact: { ...uiElementClaim.fact, selectorHint: "#continue" },
          },
          stepClaim,
          requestClaim,
        ],
      })
    ).toThrow()

    expect(() =>
      applicationExplorerMissionOutputSchema.parse({
        ...base,
        terminal: { ...base.terminal, status: "partial" },
        evidenceClaims: [],
      })
    ).toThrow()

    expect(() =>
      applicationExplorerMissionOutputSchema.parse({
        ...base,
        result: {
          ...base.result,
          claims: [
            {
              id: claimId("1"),
              status: "proposed",
              subjectId: ids.beforeScreen,
              predicate: "fabricated_relation",
              objectId: ids.afterScreen,
              evidenceIds: [ids.beforeEvidence],
              explanation: "Unsupported mission claim",
            },
          ],
        },
        evidenceClaims: screenClaims,
      })
    ).toThrow(/backed/)
  })
})
