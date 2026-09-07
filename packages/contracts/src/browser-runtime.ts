import { z } from "zod"

import {
  actionIdSchema,
  applicationIdSchema,
  artifactIdSchema,
  contentHashSchema,
  evidenceIdSchema,
  httpMethodSchema,
  normalizedPathSchema,
  persistedTextSchema,
  publicHttpUrlSchema,
  reasonCodeSchema,
  runIdSchema,
  schemaVersionSchema,
  shortTextSchema,
  timestampSchema,
} from "./primitives.ts"

export const boundedBrowserUrlSchema = publicHttpUrlSchema.pipe(
  z.string().max(2_048)
)

export const browserActionKindSchema = z.enum([
  "click",
  "fill",
  "select",
  "check",
  "navigate",
  "back",
  "reload",
])

export const browserPolicyCategorySchema = z.enum([
  "safe_read",
  "safe_navigation",
  "safe_form_progress",
  "credential_entry",
  "destructive",
  "payment",
  "external_message",
  "account_privilege",
  "download",
  "popup",
  "unknown_submission",
  "external_navigation",
])

export const browserPolicyDecisionSchema = z
  .strictObject({
    category: browserPolicyCategorySchema,
    allowed: z.boolean(),
    reason: reasonCodeSchema,
    replaySafe: z.boolean(),
  })
  .superRefine((decision, context) => {
    const expectedReason = decision.allowed
      ? decision.category
      : `${decision.category}_denied`
    if (decision.reason !== expectedReason) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Policy reason must match its category and decision",
      })
    }
    if (
      decision.replaySafe &&
      (!decision.allowed ||
        ![
          "safe_read",
          "safe_navigation",
          "safe_form_progress",
          "credential_entry",
        ].includes(decision.category))
    ) {
      context.addIssue({
        code: "custom",
        path: ["replaySafe"],
        message: "Only allowed safe categories may be replay-safe",
      })
    }
  })

export const browserActionCandidateSchema = z.strictObject({
  actionId: actionIdSchema,
  signature: contentHashSchema,
  kind: browserActionKindSchema,
  role: reasonCodeSchema.optional(),
  name: shortTextSchema.optional(),
  inputSlot: reasonCodeSchema.optional(),
  disabled: z.boolean(),
  policy: browserPolicyDecisionSchema,
  expiresAt: timestampSchema,
})

export const browserControlObservationSchema = z.strictObject({
  role: reasonCodeSchema,
  name: shortTextSchema,
  disabled: z.boolean(),
  checked: z.boolean().optional(),
})

export const browserDialogObservationSchema = z.strictObject({
  role: z.enum(["alert", "alertdialog", "dialog"]),
  name: shortTextSchema,
  text: persistedTextSchema,
})

export const browserRuntimeErrorEvidenceSchema = z.strictObject({
  kind: z.enum(["console", "page", "policy"]),
  message: persistedTextSchema,
  observedAt: timestampSchema,
})

export const browserNetworkEvidenceSchema = z.strictObject({
  requestId: contentHashSchema,
  method: httpMethodSchema,
  normalizedPath: normalizedPathSchema,
  resourceType: reasonCodeSchema,
  status: z.number().int().min(100).max(599).optional(),
  outcome: z.enum(["response", "failed", "pending"]),
  startedAt: timestampSchema,
  completedAt: timestampSchema.optional(),
  durationMs: z.number().int().nonnegative().max(300_000).optional(),
})

export const browserObservationSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  evidenceId: evidenceIdSchema,
  applicationId: applicationIdSchema,
  runId: runIdSchema,
  url: boundedBrowserUrlSchema,
  normalizedRoute: normalizedPathSchema,
  title: shortTextSchema,
  headings: z.array(shortTextSchema).max(50),
  controls: z.array(browserControlObservationSchema).max(250),
  dialogs: z.array(browserDialogObservationSchema).max(20),
  selectedText: z.array(persistedTextSchema).max(50),
  candidates: z.array(browserActionCandidateSchema).max(250),
  stateFingerprint: contentHashSchema,
  screenshotArtifactId: artifactIdSchema.optional(),
  errors: z.array(browserRuntimeErrorEvidenceSchema).max(100),
  priorActionId: actionIdSchema.optional(),
  observedAt: timestampSchema,
})

export const browserTransitionEvidenceSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    evidenceId: evidenceIdSchema,
    runId: runIdSchema,
    action: browserActionCandidateSchema,
    before: browserObservationSchema,
    after: browserObservationSchema,
    network: z.array(browserNetworkEvidenceSchema).max(200),
    errors: z.array(browserRuntimeErrorEvidenceSchema).max(100),
    observedAt: timestampSchema,
  })
  .superRefine((transition, context) => {
    if (
      transition.runId !== transition.before.runId ||
      transition.runId !== transition.after.runId
    ) {
      context.addIssue({
        code: "custom",
        path: ["runId"],
        message: "Transition observations must belong to its run",
      })
    }
    if (transition.before.applicationId !== transition.after.applicationId) {
      context.addIssue({
        code: "custom",
        path: ["after", "applicationId"],
        message: "Transition observations must belong to one application",
      })
    }
    const observed = transition.before.candidates.find(
      (candidate) => candidate.actionId === transition.action.actionId
    )
    if (
      observed === undefined ||
      observed.signature !== transition.action.signature ||
      observed.kind !== transition.action.kind ||
      observed.role !== transition.action.role ||
      observed.name !== transition.action.name ||
      observed.inputSlot !== transition.action.inputSlot ||
      observed.disabled !== transition.action.disabled ||
      observed.expiresAt !== transition.action.expiresAt ||
      observed.policy.category !== transition.action.policy.category ||
      observed.policy.allowed !== transition.action.policy.allowed ||
      observed.policy.reason !== transition.action.policy.reason ||
      observed.policy.replaySafe !== transition.action.policy.replaySafe
    ) {
      context.addIssue({
        code: "custom",
        path: ["action"],
        message: "Transition action must come from the before observation",
      })
    }
  })

export const browserRuntimeFailureCodeSchema = z.enum([
  "run_not_found",
  "run_already_exists",
  "run_busy",
  "run_cancelled",
  "run_expired",
  "action_not_found",
  "action_cross_run",
  "action_expired",
  "action_reused",
  "action_stale",
  "action_disabled",
  "policy_denied",
  "host_denied",
  "action_limit_reached",
  "screen_limit_reached",
  "redirect_limit_reached",
  "tab_limit_reached",
  "download_denied",
  "input_slot_missing",
  "input_too_long",
  "browser_error",
  "recovery_mismatch",
])

export const browserRuntimeFailureSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  code: browserRuntimeFailureCodeSchema,
  runId: runIdSchema,
  actionId: actionIdSchema.optional(),
  message: persistedTextSchema,
  screenshotArtifactId: artifactIdSchema.optional(),
  traceArtifactId: artifactIdSchema.optional(),
  observedAt: timestampSchema,
})

export const browserReplayStepSchema = z.strictObject({
  ordinal: z.number().int().nonnegative(),
  signature: contentHashSchema,
  kind: browserActionKindSchema,
  name: shortTextSchema.optional(),
  inputSlot: reasonCodeSchema.optional(),
  expectedBeforeFingerprint: contentHashSchema,
  expectedAfterFingerprint: contentHashSchema,
  replaySafe: z.literal(true),
})

export const browserRecoveryRecipeSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  applicationId: applicationIdSchema,
  sourceRunId: runIdSchema,
  entryUrl: boundedBrowserUrlSchema,
  steps: z.array(browserReplayStepSchema).max(100),
  createdAt: timestampSchema,
})

export type BrowserActionKind = z.infer<typeof browserActionKindSchema>
export type BrowserPolicyCategory = z.infer<typeof browserPolicyCategorySchema>
export type BrowserPolicyDecision = z.infer<typeof browserPolicyDecisionSchema>
export type BrowserActionCandidate = z.infer<
  typeof browserActionCandidateSchema
>
export type BrowserControlObservation = z.infer<
  typeof browserControlObservationSchema
>
export type BrowserRuntimeErrorEvidence = z.infer<
  typeof browserRuntimeErrorEvidenceSchema
>
export type BrowserNetworkEvidence = z.infer<
  typeof browserNetworkEvidenceSchema
>
export type BrowserObservation = z.infer<typeof browserObservationSchema>
export type BrowserTransitionEvidence = z.infer<
  typeof browserTransitionEvidenceSchema
>
export type BrowserRuntimeFailureCode = z.infer<
  typeof browserRuntimeFailureCodeSchema
>
export type BrowserRuntimeFailure = z.infer<typeof browserRuntimeFailureSchema>
export type BrowserReplayStep = z.infer<typeof browserReplayStepSchema>
export type BrowserRecoveryRecipe = z.infer<typeof browserRecoveryRecipeSchema>
