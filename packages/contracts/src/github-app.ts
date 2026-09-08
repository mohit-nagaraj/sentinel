import { z } from "zod"

import {
  commitShaSchema,
  persistedTextSchema,
  publicHttpUrlSchema,
  repositoryIdentitySchema,
  schemaVersionSchema,
  timestampSchema,
} from "./primitives.ts"

export const githubDeliveryIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)

export const githubDecimalIdSchema = z
  .union([
    z.string().regex(/^[1-9][0-9]{0,19}$/),
    z.number().int().positive().safe(),
  ])
  .transform(String)

export const githubInstallationIdSchema = githubDecimalIdSchema
export const githubCheckRunIdSchema = githubDecimalIdSchema

export const githubPullRequestActionSchema = z.enum([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
])

const githubAssessmentIdentityShape = {
  schemaVersion: schemaVersionSchema,
  installationId: githubInstallationIdSchema,
  repositoryId: githubDecimalIdSchema,
  repository: repositoryIdentitySchema,
  pullRequestId: githubDecimalIdSchema,
  pullRequestNumber: z.number().int().positive(),
  pullRequestUrl: publicHttpUrlSchema,
  baseSha: commitShaSchema,
  headSha: commitShaSchema,
  providerUpdatedAt: timestampSchema,
} as const

export const githubWebhookAssessmentTriggerSchema = z.strictObject({
  ...githubAssessmentIdentityShape,
  source: z.literal("webhook"),
  event: z.literal("pull_request"),
  action: githubPullRequestActionSchema,
  deliveryId: githubDeliveryIdSchema,
  sender: z.strictObject({
    id: githubDecimalIdSchema,
    login: z.string().trim().min(1).max(255),
    type: z.string().trim().min(1).max(64),
  }),
})

export const githubManualAssessmentTriggerSchema = z.strictObject({
  ...githubAssessmentIdentityShape,
  source: z.literal("manual"),
  applicationId: z.uuid(),
  operatorId: z.uuid(),
})

export const githubAssessmentTriggerSchema = z.discriminatedUnion("source", [
  githubWebhookAssessmentTriggerSchema,
  githubManualAssessmentTriggerSchema,
])

export const githubWebhookDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("enqueue"),
    trigger: githubWebhookAssessmentTriggerSchema,
  }),
  z.strictObject({
    kind: z.literal("ignored"),
    deliveryId: githubDeliveryIdSchema,
    event: z.string().trim().min(1).max(128),
    action: z.string().trim().min(1).max(128).optional(),
    reason: z.enum([
      "unsupported_event",
      "unsupported_action",
      "draft_pull_request",
    ]),
  }),
])

export const manualGithubAssessmentRequestSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  applicationId: z.uuid(),
  pullRequestUrl: publicHttpUrlSchema.refine((value) => {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\/?$/.test(
        url.pathname
      )
    )
  }, "A canonical GitHub pull request URL is required"),
})

export const githubAssessmentEnqueueResultSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    disposition: z.enum(["created", "duplicate", "stale"]),
    assessmentId: z.uuid(),
    runId: z.uuid().nullable(),
    installationId: githubInstallationIdSchema,
    repository: repositoryIdentitySchema,
    pullRequestNumber: z.number().int().positive(),
    headSha: commitShaSchema,
    isCurrent: z.boolean(),
    checkRunId: githubCheckRunIdSchema.nullable(),
  })
  .superRefine((value, context) => {
    if (value.disposition === "stale") {
      if (value.isCurrent || value.runId !== null) {
        context.addIssue({
          code: "custom",
          message: "Stale assessments cannot be current or enqueue work",
        })
      }
      return
    }
    if (!value.isCurrent || value.runId === null) {
      context.addIssue({
        code: "custom",
        message:
          "Created and duplicate assessments require current run identity",
      })
    }
  })

export const githubCheckTargetSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  assessmentId: z.uuid(),
  installationId: githubInstallationIdSchema,
  repository: repositoryIdentitySchema,
  pullRequestNumber: z.number().int().positive(),
  headSha: commitShaSchema,
  isCurrent: z.boolean(),
  checkRunId: githubCheckRunIdSchema.nullable(),
  syncLeaseToken: z.uuid().nullable(),
  recovering: z.boolean(),
})

export const githubCheckOutcomeSchema = z.enum([
  "analysis_succeeded",
  "predicted_risk",
  "unknown_scope",
  "verification_unavailable",
  "verification_failed",
  "action_required",
  "infrastructure_failed",
])

export const githubCheckLifecycleSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("queued") }),
  z.strictObject({
    state: z.literal("running"),
    startedAt: timestampSchema,
  }),
  z.strictObject({
    state: z.literal("completed"),
    outcome: githubCheckOutcomeSchema,
    title: persistedTextSchema,
    summary: persistedTextSchema,
    completedAt: timestampSchema,
  }),
])

export const githubCheckConclusionSchema = z.enum([
  "success",
  "neutral",
  "failure",
  "action_required",
])

export const githubCheckRequestSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    assessmentId: z.uuid(),
    headSha: commitShaSchema,
    detailsUrl: publicHttpUrlSchema,
    lifecycle: githubCheckLifecycleSchema,
  })
  .superRefine((value, context) => {
    const expectedSuffix = `/assessments/${value.assessmentId}`
    if (new URL(value.detailsUrl).pathname !== expectedSuffix) {
      context.addIssue({
        code: "custom",
        message: "Check details URL must identify its assessment",
        path: ["detailsUrl"],
      })
    }
  })

export const githubAssessmentResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    status: z.literal("ignored"),
    reason: z.enum([
      "unsupported_event",
      "unsupported_action",
      "draft_pull_request",
      "stale_delivery",
    ]),
  }),
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    status: z.literal("accepted"),
    assessmentId: z.uuid(),
    runId: z.uuid(),
    headSha: commitShaSchema,
    duplicate: z.boolean(),
    check: z.enum(["queued", "sync_pending"]),
  }),
])

export const githubAppRegistrationSchema = z.strictObject({
  permissions: z.strictObject({
    contents: z.literal("read"),
    pullRequests: z.literal("read"),
    checks: z.literal("write"),
  }),
  events: z.tuple([z.literal("pull_request")]),
})

export const SENTINEL_GITHUB_APP_REGISTRATION =
  githubAppRegistrationSchema.parse({
    permissions: {
      contents: "read",
      pullRequests: "read",
      checks: "write",
    },
    events: ["pull_request"],
  })

export type GithubAssessmentTrigger = z.infer<
  typeof githubAssessmentTriggerSchema
>
export type GithubWebhookAssessmentTrigger = z.infer<
  typeof githubWebhookAssessmentTriggerSchema
>
export type GithubManualAssessmentTrigger = z.infer<
  typeof githubManualAssessmentTriggerSchema
>
export type GithubWebhookDecision = z.infer<typeof githubWebhookDecisionSchema>
export type GithubAssessmentEnqueueResult = z.infer<
  typeof githubAssessmentEnqueueResultSchema
>
export type GithubCheckTarget = z.infer<typeof githubCheckTargetSchema>
export type GithubCheckLifecycle = z.infer<typeof githubCheckLifecycleSchema>
export type GithubCheckOutcome = z.infer<typeof githubCheckOutcomeSchema>
export type GithubAssessmentResponse = z.infer<
  typeof githubAssessmentResponseSchema
>
