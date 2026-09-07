import { z } from "zod"

import {
  browserActionCandidateSchema,
  browserActionKindSchema,
  browserDialogObservationSchema,
  browserNetworkEvidenceSchema,
  browserPolicyDecisionSchema,
  browserRecoveryRecipeSchema,
} from "./browser-runtime.ts"
import {
  flowStepFactSchema,
  screenFactSchema,
  uiElementFactSchema,
  workflowFactSchema,
} from "./facts.ts"
import {
  discoveryMissionSchema,
  missionBudgetSchema,
  missionResultSchema,
} from "./operations.ts"
import {
  actionIdSchema,
  applicationIdSchema,
  artifactIdSchema,
  claimIdSchema,
  contentHashSchema,
  evidenceIdSchema,
  flowStepIdSchema,
  missionIdSchema,
  normalizedPathSchema,
  persistedTextSchema,
  reasonCodeSchema,
  runIdSchema,
  schemaVersionSchema,
  screenIdSchema,
  secretReferenceSchema,
  shortTextSchema,
  terminalStatusSchema,
  timestampSchema,
} from "./primitives.ts"

export const applicationExplorerToolNameSchema = z.enum([
  "observe_page",
  "perform_observed_action",
  "navigate_history",
  "finish_application_mission",
])

export const applicationExplorerTerminalClassificationSchema = z.enum([
  "goal_completed",
  "dead_end",
  "recoverable_branch",
  "login_block",
  "unsafe_boundary",
  "budget_exhausted",
  "recovery_review",
  "failure",
])

const terminalStatusByClassification = {
  goal_completed: "complete",
  dead_end: "partial",
  recoverable_branch: "partial",
  login_block: "blocked",
  unsafe_boundary: "needs_human",
  budget_exhausted: "budget_exhausted",
  recovery_review: "needs_human",
  failure: "failed",
} as const

const publicDecisionSummarySchema = persistedTextSchema.refine(
  (summary) => summary.length <= 512,
  { message: "Planner decision summaries cannot exceed 512 characters" }
)

export const applicationExplorerTerminalSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    classification: applicationExplorerTerminalClassificationSchema,
    status: terminalStatusSchema,
    reasonCode: reasonCodeSchema,
    summary: persistedTextSchema,
  })
  .superRefine((terminal, context) => {
    if (
      terminal.status !==
      terminalStatusByClassification[terminal.classification]
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Terminal status must match its explorer classification",
      })
    }
  })

const toolInputBase = {
  schemaVersion: schemaVersionSchema,
  missionId: missionIdSchema,
  runId: runIdSchema,
  reasonCode: reasonCodeSchema,
  summary: publicDecisionSummarySchema,
}

export const observePageToolInputSchema = z.strictObject({
  ...toolInputBase,
  tool: z.literal("observe_page"),
  previousObservationEvidenceId: evidenceIdSchema.optional(),
  previousStateFingerprint: contentHashSchema.optional(),
})

const observedActionToolInputBase = {
  ...toolInputBase,
  observationEvidenceId: evidenceIdSchema,
  stateFingerprint: contentHashSchema,
  actionId: actionIdSchema,
}

export const performObservedActionToolInputSchema = z.strictObject({
  ...observedActionToolInputBase,
  tool: z.literal("perform_observed_action"),
})

export const navigateHistoryToolInputSchema = z.strictObject({
  ...observedActionToolInputBase,
  tool: z.literal("navigate_history"),
})

export const finishApplicationMissionToolInputSchema = z.strictObject({
  ...toolInputBase,
  tool: z.literal("finish_application_mission"),
  terminal: applicationExplorerTerminalSchema,
})

export const applicationExplorerPlannerDecisionSchema = z.discriminatedUnion(
  "tool",
  [
    observePageToolInputSchema,
    performObservedActionToolInputSchema,
    navigateHistoryToolInputSchema,
    finishApplicationMissionToolInputSchema,
  ]
)

export const applicationExplorerContextCandidateSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  rank: z.number().int().positive().max(250),
  relevanceScore: z.number().int().min(0).max(1_000),
  matchedCapabilityHints: z.array(shortTextSchema).max(20),
  matchedRequirementHints: z.array(shortTextSchema).max(20),
  candidate: browserActionCandidateSchema,
})

export const applicationExplorerPlannerObservationSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  evidenceId: evidenceIdSchema,
  applicationId: applicationIdSchema,
  runId: runIdSchema,
  stateFingerprint: contentHashSchema,
  normalizedRoute: normalizedPathSchema,
  title: shortTextSchema,
  untrustedPageContent: z.strictObject({
    trust: z.literal("untrusted"),
    headings: z.array(shortTextSchema).max(50),
    selectedText: z.array(persistedTextSchema).max(50),
    dialogs: z.array(browserDialogObservationSchema).max(20),
  }),
})

export const applicationExplorerPlannerProgressSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  visitedStateActionPairs: z.number().int().nonnegative().max(500),
  pendingFrontierActions: z.number().int().nonnegative().max(500),
  exploredBranchCount: z.number().int().nonnegative().max(100),
  currentBranchDepth: z.number().int().nonnegative().max(100),
  observedTransitionCount: z.number().int().nonnegative().max(100),
  observedStateCount: z.number().int().nonnegative().max(201),
  consecutiveNoProgress: z.number().int().nonnegative().max(100),
  recentEvidenceIds: z.array(evidenceIdSchema).max(20),
  budgetUsed: missionBudgetSchema,
})

export const applicationExplorerPlannerContextSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    mission: discoveryMissionSchema,
    capabilityHintLabels: z.array(shortTextSchema).max(50),
    requirementHintLabels: z.array(shortTextSchema).max(50),
    observation: applicationExplorerPlannerObservationSchema,
    progress: applicationExplorerPlannerProgressSchema,
    candidates: z.array(applicationExplorerContextCandidateSchema).max(250),
  })
  .superRefine((plannerContext, context) => {
    const { mission, observation } = plannerContext
    if (mission.agent !== "application") {
      context.addIssue({
        code: "custom",
        path: ["mission", "agent"],
        message: "Application Explorer requires an application mission",
      })
    }
    if (
      mission.applicationId !== observation.applicationId ||
      mission.runId !== observation.runId
    ) {
      context.addIssue({
        code: "custom",
        path: ["observation"],
        message: "Planner observation must belong to its mission",
      })
    }

    const ranks = new Set<number>()
    const actionIds = new Set<string>()
    for (const [
      index,
      rankedCandidate,
    ] of plannerContext.candidates.entries()) {
      if (ranks.has(rankedCandidate.rank)) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "rank"],
          message: "Candidate ranks must be unique",
        })
      }
      ranks.add(rankedCandidate.rank)

      if (actionIds.has(rankedCandidate.candidate.actionId)) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "candidate", "actionId"],
          message: "Candidate action IDs must be unique",
        })
      }
      actionIds.add(rankedCandidate.candidate.actionId)
    }
  })

export const applicationExplorerFrontierStatusSchema = z.enum([
  "pending",
  "visited",
  "denied",
  "dead_end",
])

export const applicationExplorerFrontierEntrySchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  observationEvidenceId: evidenceIdSchema,
  stateFingerprint: contentHashSchema,
  actionId: actionIdSchema,
  actionSignature: contentHashSchema,
  actionKind: browserActionKindSchema,
  actionName: shortTextSchema.optional(),
  policy: browserPolicyDecisionSchema,
  branchDepth: z.number().int().nonnegative().max(100),
  relevanceScore: z.number().int().min(0).max(1_000),
  status: applicationExplorerFrontierStatusSchema,
  discoveredAt: timestampSchema,
})

export const applicationExplorerVisitOutcomeSchema = z.enum([
  "executed",
  "denied",
  "stale",
  "used",
  "no_progress",
])

export const applicationExplorerStateActionVisitSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    observationEvidenceId: evidenceIdSchema,
    stateFingerprint: contentHashSchema,
    actionId: actionIdSchema,
    actionSignature: contentHashSchema,
    outcome: applicationExplorerVisitOutcomeSchema,
    transitionEvidenceId: evidenceIdSchema.optional(),
    attemptedAt: timestampSchema,
  })
  .superRefine((visit, context) => {
    const needsTransition = ["executed", "no_progress"].includes(visit.outcome)
    if (needsTransition !== (visit.transitionEvidenceId !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["transitionEvidenceId"],
        message:
          "Executed visits require transition evidence and denied visits cannot claim it",
      })
    }
  })

export const applicationExplorerPathStepSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  ordinal: z.number().int().nonnegative().max(99),
  actionId: actionIdSchema,
  actionSignature: contentHashSchema,
  beforeObservationEvidenceId: evidenceIdSchema,
  beforeStateFingerprint: contentHashSchema,
  afterObservationEvidenceId: evidenceIdSchema,
  afterStateFingerprint: contentHashSchema,
  transitionEvidenceId: evidenceIdSchema,
  replaySafe: z.boolean(),
})

export const applicationExplorerReplayBoundarySchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    authenticationStateReference: secretReferenceSchema.optional(),
    recipe: browserRecoveryRecipeSchema,
    replaySafePathLength: z.number().int().nonnegative().max(100),
    checkpointPathLength: z.number().int().nonnegative().max(100),
    requiresHumanReview: z.boolean(),
  })
  .superRefine((boundary, context) => {
    if (boundary.recipe.steps.length !== boundary.replaySafePathLength) {
      context.addIssue({
        code: "custom",
        path: ["replaySafePathLength"],
        message: "Replay-safe path length must match the bounded recipe",
      })
    }
    if (boundary.replaySafePathLength > boundary.checkpointPathLength) {
      context.addIssue({
        code: "custom",
        path: ["checkpointPathLength"],
        message: "Checkpoint cannot be before its replay-safe path",
      })
    }
    if (
      boundary.requiresHumanReview !==
      boundary.checkpointPathLength > boundary.replaySafePathLength
    ) {
      context.addIssue({
        code: "custom",
        path: ["requiresHumanReview"],
        message:
          "Human review is required exactly when the checkpoint exceeds the safe replay boundary",
      })
    }
  })

export const applicationExplorerCheckpointStateSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    applicationId: applicationIdSchema,
    missionId: missionIdSchema,
    runId: runIdSchema,
    currentObservationEvidenceId: evidenceIdSchema,
    currentStateFingerprint: contentHashSchema,
    currentScreenId: screenIdSchema.optional(),
    currentScreenshotArtifactId: artifactIdSchema.optional(),
    path: z.array(applicationExplorerPathStepSchema).max(100),
    frontier: z.array(applicationExplorerFrontierEntrySchema).max(500),
    visits: z.array(applicationExplorerStateActionVisitSchema).max(500),
    replayBoundary: applicationExplorerReplayBoundarySchema,
    budgetUsed: missionBudgetSchema,
    consecutiveNoProgress: z.number().int().nonnegative().max(100),
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .superRefine((checkpoint, context) => {
    if (
      checkpoint.replayBoundary.recipe.applicationId !==
        checkpoint.applicationId ||
      checkpoint.replayBoundary.recipe.sourceRunId !== checkpoint.runId
    ) {
      context.addIssue({
        code: "custom",
        path: ["replayBoundary", "recipe"],
        message: "Recovery recipe must belong to its checkpoint",
      })
    }
    if (
      checkpoint.replayBoundary.checkpointPathLength !== checkpoint.path.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["replayBoundary", "checkpointPathLength"],
        message: "Replay boundary must describe the checkpoint path",
      })
    }
    for (const [index, step] of checkpoint.path.entries()) {
      if (step.ordinal !== index) {
        context.addIssue({
          code: "custom",
          path: ["path", index, "ordinal"],
          message: "Path ordinals must be contiguous and zero-based",
        })
      }
    }

    for (const [
      index,
      replayStep,
    ] of checkpoint.replayBoundary.recipe.steps.entries()) {
      const pathStep = checkpoint.path[index]
      if (
        pathStep === undefined ||
        !pathStep.replaySafe ||
        replayStep.ordinal !== index ||
        replayStep.signature !== pathStep.actionSignature ||
        replayStep.expectedBeforeFingerprint !==
          pathStep.beforeStateFingerprint ||
        replayStep.expectedAfterFingerprint !== pathStep.afterStateFingerprint
      ) {
        context.addIssue({
          code: "custom",
          path: ["replayBoundary", "recipe", "steps", index],
          message:
            "Recovery recipe must match the replay-safe checkpoint path prefix",
        })
      }
    }

    const pairKeys = new Set<string>()
    for (const [index, visit] of checkpoint.visits.entries()) {
      const key = `${visit.stateFingerprint}:${visit.actionSignature}`
      if (pairKeys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["visits", index],
          message: "State/action visits must be unique",
        })
      }
      pairKeys.add(key)
    }
  })

export const applicationExplorerBlockerKindSchema = z.enum([
  "login_required",
  "unsafe_action",
  "policy_denied",
  "stale_observation",
  "used_action",
  "history_unavailable",
  "repeated_state",
  "no_progress",
  "dead_end",
  "budget_exhausted",
  "recovery_mismatch",
  "non_idempotent_replay",
  "browser_failure",
  "planner_failure",
])

export const applicationExplorerBlockerSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: applicationExplorerBlockerKindSchema,
  reasonCode: reasonCodeSchema,
  summary: persistedTextSchema,
  recoverable: z.boolean(),
  observationEvidenceId: evidenceIdSchema.optional(),
  actionId: actionIdSchema.optional(),
  evidenceIds: z.array(evidenceIdSchema).max(100),
})

const evidenceClaimBase = {
  schemaVersion: schemaVersionSchema,
  id: claimIdSchema,
  status: z.literal("proposed"),
  missionId: missionIdSchema,
  runId: runIdSchema,
  evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
}

export const applicationExplorerScreenClaimSchema = z
  .strictObject({
    ...evidenceClaimBase,
    claimKind: z.literal("screen"),
    fact: screenFactSchema,
    observationEvidenceId: evidenceIdSchema,
    screenshotArtifactId: artifactIdSchema.optional(),
  })
  .superRefine((claim, context) => {
    if (!claim.evidenceIds.includes(claim.observationEvidenceId)) {
      context.addIssue({
        code: "custom",
        path: ["evidenceIds"],
        message: "Screen evidence must include its observation",
      })
    }
  })

export const applicationExplorerWorkflowClaimSchema = z
  .strictObject({
    ...evidenceClaimBase,
    claimKind: z.literal("workflow"),
    fact: workflowFactSchema,
    stepIds: z.array(flowStepIdSchema).max(100),
  })
  .superRefine((claim, context) => {
    if (claim.fact.sourceRunId !== claim.runId) {
      context.addIssue({
        code: "custom",
        path: ["fact", "sourceRunId"],
        message: "Workflow fact must belong to its claim run",
      })
    }
  })

const screenEvidenceLinkSchema = z.strictObject({
  screenId: screenIdSchema,
  observationEvidenceId: evidenceIdSchema,
  stateFingerprint: contentHashSchema,
})

export const applicationExplorerFlowStepClaimSchema = z
  .strictObject({
    ...evidenceClaimBase,
    claimKind: z.literal("flow_step"),
    fact: flowStepFactSchema,
    before: screenEvidenceLinkSchema,
    after: screenEvidenceLinkSchema,
    action: browserActionCandidateSchema,
    transitionEvidenceId: evidenceIdSchema,
    afterScreenshotArtifactId: artifactIdSchema.optional(),
    networkRequestIds: z.array(contentHashSchema).max(200),
  })
  .superRefine((claim, context) => {
    const requiredEvidence = [
      claim.before.observationEvidenceId,
      claim.after.observationEvidenceId,
      claim.transitionEvidenceId,
    ]
    if (!requiredEvidence.every((id) => claim.evidenceIds.includes(id))) {
      context.addIssue({
        code: "custom",
        path: ["evidenceIds"],
        message:
          "Flow-step evidence must include before, after, and transition evidence",
      })
    }
    if (claim.fact.sourceRunId !== claim.runId) {
      context.addIssue({
        code: "custom",
        path: ["fact", "sourceRunId"],
        message: "Flow-step fact must belong to its claim run",
      })
    }
  })

export const applicationExplorerUiElementClaimSchema = z
  .strictObject({
    ...evidenceClaimBase,
    claimKind: z.literal("ui_element"),
    fact: uiElementFactSchema.omit({ selectorHint: true }),
    observationEvidenceId: evidenceIdSchema,
  })
  .superRefine((claim, context) => {
    if (!claim.evidenceIds.includes(claim.observationEvidenceId)) {
      context.addIssue({
        code: "custom",
        path: ["evidenceIds"],
        message: "UI-element evidence must include its observation",
      })
    }
    if (claim.fact.sourceRunId !== claim.runId) {
      context.addIssue({
        code: "custom",
        path: ["fact", "sourceRunId"],
        message: "UI-element fact must belong to its claim run",
      })
    }
  })

export const applicationExplorerRuntimeRequestClaimSchema = z
  .strictObject({
    ...evidenceClaimBase,
    claimKind: z.literal("runtime_request"),
    applicationId: applicationIdSchema,
    request: browserNetworkEvidenceSchema,
    transitionEvidenceId: evidenceIdSchema,
    beforeObservationEvidenceId: evidenceIdSchema,
    afterObservationEvidenceId: evidenceIdSchema,
  })
  .superRefine((claim, context) => {
    const requiredEvidence = [
      claim.beforeObservationEvidenceId,
      claim.afterObservationEvidenceId,
      claim.transitionEvidenceId,
    ]
    if (!requiredEvidence.every((id) => claim.evidenceIds.includes(id))) {
      context.addIssue({
        code: "custom",
        path: ["evidenceIds"],
        message:
          "Runtime-request evidence must include before, after, and transition evidence",
      })
    }
  })

export const applicationExplorerEvidenceClaimSchema = z.union([
  applicationExplorerScreenClaimSchema,
  applicationExplorerWorkflowClaimSchema,
  applicationExplorerFlowStepClaimSchema,
  applicationExplorerUiElementClaimSchema,
  applicationExplorerRuntimeRequestClaimSchema,
])

function claimApplicationId(
  claim: z.infer<typeof applicationExplorerEvidenceClaimSchema>
) {
  return claim.claimKind === "runtime_request"
    ? claim.applicationId
    : claim.fact.applicationId
}

export const applicationExplorerMissionOutputSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    result: missionResultSchema,
    terminal: applicationExplorerTerminalSchema,
    checkpoint: applicationExplorerCheckpointStateSchema,
    evidenceClaims: z.array(applicationExplorerEvidenceClaimSchema).max(500),
    blockers: z.array(applicationExplorerBlockerSchema).max(100),
  })
  .superRefine((output, context) => {
    if (output.result.missionId !== output.checkpoint.missionId) {
      context.addIssue({
        code: "custom",
        path: ["result", "missionId"],
        message: "Mission result must belong to its checkpoint",
      })
    }
    if (
      output.result.status !== output.terminal.status ||
      output.result.stopReason.code !== output.terminal.reasonCode ||
      output.result.stopReason.summary !== output.terminal.summary
    ) {
      context.addIssue({
        code: "custom",
        path: ["terminal"],
        message: "Terminal classification must match the mission result",
      })
    }

    const screenClaims = output.evidenceClaims.filter(
      (claim) => claim.claimKind === "screen"
    )
    const workflowClaims = output.evidenceClaims.filter(
      (claim) => claim.claimKind === "workflow"
    )
    const stepClaims = output.evidenceClaims.filter(
      (claim) => claim.claimKind === "flow_step"
    )
    const requestClaims = output.evidenceClaims.filter(
      (claim) => claim.claimKind === "runtime_request"
    )
    const uiElementClaims = output.evidenceClaims.filter(
      (claim) => claim.claimKind === "ui_element"
    )

    for (const [index, claim] of output.evidenceClaims.entries()) {
      if (
        claim.missionId !== output.checkpoint.missionId ||
        claim.runId !== output.checkpoint.runId ||
        claimApplicationId(claim) !== output.checkpoint.applicationId
      ) {
        context.addIssue({
          code: "custom",
          path: ["evidenceClaims", index],
          message: "Evidence claim must belong to the output checkpoint",
        })
      }
    }

    for (const [index, step] of stepClaims.entries()) {
      const workflow = workflowClaims.find(
        (claim) => claim.fact.id === step.fact.workflowId
      )
      if (workflow === undefined || !workflow.stepIds.includes(step.fact.id)) {
        context.addIssue({
          code: "custom",
          path: ["evidenceClaims", index, "fact", "workflowId"],
          message: "Flow step must reference an emitted workflow claim",
        })
      }

      for (const [linkName, screenLink] of [
        ["before", step.before],
        ["after", step.after],
      ] as const) {
        const screen = screenClaims.find(
          (claim) =>
            claim.fact.id === screenLink.screenId &&
            claim.observationEvidenceId === screenLink.observationEvidenceId &&
            claim.fact.stateFingerprint === screenLink.stateFingerprint
        )
        if (screen === undefined) {
          context.addIssue({
            code: "custom",
            path: ["evidenceClaims", index],
            message:
              "Flow-step screen links must reference emitted screen evidence",
          })
        } else if (
          linkName === "after" &&
          screen.screenshotArtifactId !== undefined &&
          step.afterScreenshotArtifactId !== screen.screenshotArtifactId
        ) {
          context.addIssue({
            code: "custom",
            path: ["evidenceClaims", index, "afterScreenshotArtifactId"],
            message:
              "Flow step must reference the emitted after-state screenshot",
          })
        }
      }

      for (const requestId of step.networkRequestIds) {
        const request = requestClaims.find(
          (claim) =>
            claim.request.requestId === requestId &&
            claim.transitionEvidenceId === step.transitionEvidenceId &&
            claim.beforeObservationEvidenceId ===
              step.before.observationEvidenceId &&
            claim.afterObservationEvidenceId ===
              step.after.observationEvidenceId
        )
        if (request === undefined) {
          context.addIssue({
            code: "custom",
            path: ["evidenceClaims", index, "networkRequestIds"],
            message:
              "Flow-step request IDs must reference the transition request window",
          })
        }
      }
    }

    for (const [index, workflow] of workflowClaims.entries()) {
      for (const stepId of workflow.stepIds) {
        const step = stepClaims.find(
          (claim) =>
            claim.fact.id === stepId &&
            claim.fact.workflowId === workflow.fact.id
        )
        if (step === undefined) {
          context.addIssue({
            code: "custom",
            path: ["evidenceClaims", index, "stepIds"],
            message:
              "Workflow step IDs must reference emitted flow-step claims",
          })
        }
      }
    }

    for (const [index, uiElement] of uiElementClaims.entries()) {
      const screen = screenClaims.find(
        (claim) =>
          claim.fact.id === uiElement.fact.screenId &&
          claim.observationEvidenceId === uiElement.observationEvidenceId
      )
      if (screen === undefined) {
        context.addIssue({
          code: "custom",
          path: ["evidenceClaims", index, "fact", "screenId"],
          message: "UI element must reference its emitted screen observation",
        })
      }
    }

    const requiresBlocker = ["blocked", "needs_human", "failed"].includes(
      output.result.status
    )
    if (requiresBlocker && output.blockers.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["blockers"],
        message: "Blocked, human-review, and failed results need a blocker",
      })
    }
  })

export type ApplicationExplorerToolName = z.infer<
  typeof applicationExplorerToolNameSchema
>
export type ApplicationExplorerTerminalClassification = z.infer<
  typeof applicationExplorerTerminalClassificationSchema
>
export type ApplicationExplorerTerminal = z.infer<
  typeof applicationExplorerTerminalSchema
>
export type ObservePageToolInput = z.infer<typeof observePageToolInputSchema>
export type PerformObservedActionToolInput = z.infer<
  typeof performObservedActionToolInputSchema
>
export type NavigateHistoryToolInput = z.infer<
  typeof navigateHistoryToolInputSchema
>
export type FinishApplicationMissionToolInput = z.infer<
  typeof finishApplicationMissionToolInputSchema
>
export type ApplicationExplorerPlannerDecision = z.infer<
  typeof applicationExplorerPlannerDecisionSchema
>
export type ApplicationExplorerContextCandidate = z.infer<
  typeof applicationExplorerContextCandidateSchema
>
export type ApplicationExplorerPlannerObservation = z.infer<
  typeof applicationExplorerPlannerObservationSchema
>
export type ApplicationExplorerPlannerProgress = z.infer<
  typeof applicationExplorerPlannerProgressSchema
>
export type ApplicationExplorerPlannerContext = z.infer<
  typeof applicationExplorerPlannerContextSchema
>
export type ApplicationExplorerFrontierEntry = z.infer<
  typeof applicationExplorerFrontierEntrySchema
>
export type ApplicationExplorerStateActionVisit = z.infer<
  typeof applicationExplorerStateActionVisitSchema
>
export type ApplicationExplorerPathStep = z.infer<
  typeof applicationExplorerPathStepSchema
>
export type ApplicationExplorerReplayBoundary = z.infer<
  typeof applicationExplorerReplayBoundarySchema
>
export type ApplicationExplorerCheckpointState = z.infer<
  typeof applicationExplorerCheckpointStateSchema
>
export type ApplicationExplorerBlocker = z.infer<
  typeof applicationExplorerBlockerSchema
>
export type ApplicationExplorerScreenClaim = z.infer<
  typeof applicationExplorerScreenClaimSchema
>
export type ApplicationExplorerWorkflowClaim = z.infer<
  typeof applicationExplorerWorkflowClaimSchema
>
export type ApplicationExplorerFlowStepClaim = z.infer<
  typeof applicationExplorerFlowStepClaimSchema
>
export type ApplicationExplorerUiElementClaim = z.infer<
  typeof applicationExplorerUiElementClaimSchema
>
export type ApplicationExplorerRuntimeRequestClaim = z.infer<
  typeof applicationExplorerRuntimeRequestClaimSchema
>
export type ApplicationExplorerEvidenceClaim = z.infer<
  typeof applicationExplorerEvidenceClaimSchema
>
export type ApplicationExplorerMissionOutput = z.infer<
  typeof applicationExplorerMissionOutputSchema
>
