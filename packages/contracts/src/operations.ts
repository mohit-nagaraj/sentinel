import { z } from "zod"

import { hashCanonical } from "./identity.ts"

import {
  agentKindSchema,
  applicationIdSchema,
  claimIdSchema,
  commitShaSchema,
  contentHashSchema,
  evidenceIdSchema,
  hostnameSchema,
  languageSchema,
  missionIdSchema,
  persistedTextSchema,
  publicHttpUrlSchema,
  reasonCodeSchema,
  repositoryIdentitySchema,
  repositoryPathSchema,
  runIdSchema,
  runStatusSchema,
  runTypeSchema,
  schemaVersionSchema,
  secretReferenceSchema,
  shortTextSchema,
  sourceUriSchema,
  stableEntityIdSchema,
  terminalStatusSchema,
  timestampSchema,
} from "./primitives.ts"

export const applicationStatusSchema = z.enum([
  "not_configured",
  "inspecting",
  "awaiting_confirmation",
  "initializing_knowledge",
  "ready",
  "assessing_pr",
  "verifying",
  "refreshing",
  "needs_review",
  "stale",
  "failed",
])

export const applicationSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: applicationIdSchema,
  name: shortTextSchema,
  deploymentUrl: publicHttpUrlSchema,
  status: applicationStatusSchema,
  indexedCommitSha: commitShaSchema.optional(),
  graphRevision: z.number().int().nonnegative(),
  refreshedAt: timestampSchema.optional(),
})

export const sourceKindSchema = z.enum([
  "repository",
  "documentation",
  "application",
])

export const sourceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: stableEntityIdSchema,
  applicationId: applicationIdSchema,
  kind: sourceKindSchema,
  uri: sourceUriSchema,
  status: z.enum(["pending", "ready", "warning", "blocked", "failed"]),
  contentHash: contentHashSchema.optional(),
  secretReference: secretReferenceSchema.optional(),
  checkedAt: timestampSchema.optional(),
})

export const githubRepositoryUrlSchema = publicHttpUrlSchema.refine((value) => {
  const url = new URL(value)
  const parts = url.pathname
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean)
  return (
    url.protocol === "https:" &&
    url.hostname === "github.com" &&
    url.search.length === 0 &&
    parts.length === 2 &&
    parts.every((part) => /^[A-Za-z0-9_.-]{1,100}$/.test(part))
  )
}, "Repository URL must identify one GitHub owner/repository over HTTPS")

export const repositoryRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.startsWith("-") &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !/[\\\s~^:?*[\]\u0000-\u001f\u007f]/.test(value),
    "Repository ref contains unsafe Git ref syntax"
  )

const previewUrlPatternSchema = z
  .string()
  .trim()
  .max(2_048)
  .refine(
    (value) =>
      value.length === 0 ||
      (value.split("{branch}").length <= 2 &&
        publicHttpUrlSchema.safeParse(value.replace("{branch}", "preview"))
          .success),
    "Preview URL pattern must be a public HTTP URL with at most one {branch} token"
  )
  .transform((value) => (value.length === 0 ? undefined : value))

export const onboardingRepositoryInputSchema = z
  .strictObject({
    url: githubRepositoryUrlSchema,
    ref: repositoryRefSchema,
    accessMode: z.enum(["manual", "github_app"]),
    installationId: z
      .string()
      .regex(/^[1-9][0-9]{0,19}$/)
      .optional(),
  })
  .superRefine((repository, context) => {
    if (
      repository.accessMode === "github_app" &&
      repository.installationId === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "GitHub App mode requires an installation identifier",
        path: ["installationId"],
      })
    }
    if (
      repository.accessMode === "manual" &&
      repository.installationId !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Manual mode cannot include an installation identifier",
        path: ["installationId"],
      })
    }
  })

export const onboardingRepositoryConfigurationSchema =
  onboardingRepositoryInputSchema.and(
    z.strictObject({ resolvedCommitSha: commitShaSchema.optional() })
  )

const storageStateJsonSchema = z
  .string()
  .min(2)
  .max(256 * 1_024)
  .superRefine((value, context) => {
    try {
      const parsed = JSON.parse(value) as unknown
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !Array.isArray((parsed as { cookies?: unknown }).cookies) ||
        !Array.isArray((parsed as { origins?: unknown }).origins)
      ) {
        context.addIssue({
          code: "custom",
          message: "Storage state must contain cookies and origins arrays",
        })
      }
    } catch {
      context.addIssue({
        code: "custom",
        message: "Storage state must be valid JSON",
      })
    }
  })

const credentialFieldKeySchema = reasonCodeSchema
const credentialLabelSchema = z.string().trim().min(1).max(80)

export const onboardingAuthenticationInputSchema = z.discriminatedUnion(
  "method",
  [
    z.strictObject({ method: z.literal("none") }),
    z.strictObject({
      method: z.literal("credentials"),
      automationConfirmed: z.boolean(),
      fields: z
        .array(
          z.strictObject({
            key: credentialFieldKeySchema,
            label: credentialLabelSchema,
            value: z.string().min(1).max(16_384),
          })
        )
        .min(1)
        .max(10)
        .refine(
          (fields) =>
            new Set(fields.map((field) => field.key)).size === fields.length,
          "Credential field keys must be unique"
        ),
    }),
    z.strictObject({
      method: z.literal("storage_state"),
      automationConfirmed: z.boolean(),
      value: storageStateJsonSchema,
    }),
  ]
)

export const onboardingAuthenticationConfigurationSchema = z.discriminatedUnion(
  "method",
  [
    z.strictObject({ method: z.literal("none"), revision: z.literal(0) }),
    z.strictObject({
      method: z.literal("credentials"),
      automationConfirmed: z.boolean(),
      revision: z.number().int().positive(),
      fields: z
        .array(
          z.strictObject({
            key: credentialFieldKeySchema,
            label: credentialLabelSchema,
            reference: secretReferenceSchema,
          })
        )
        .min(1)
        .max(10)
        .refine(
          (fields) =>
            new Set(fields.map((field) => field.key)).size === fields.length,
          "Credential field keys must be unique"
        ),
    }),
    z.strictObject({
      method: z.literal("storage_state"),
      automationConfirmed: z.boolean(),
      revision: z.number().int().positive(),
      reference: secretReferenceSchema,
    }),
  ]
)

export const onboardingCrawlPolicySchema = z.strictObject({
  allowedHosts: z
    .array(hostnameSchema)
    .min(1)
    .max(20)
    .transform((hosts) => [...new Set(hosts)].sort()),
  maxActions: z.number().int().min(1).max(500),
  maxScreens: z.number().int().min(1).max(500),
  maxDurationSeconds: z.number().int().min(10).max(3_600),
  allowFormSubmission: z.boolean(),
  denyDestructiveActions: z.literal(true),
  denyRealPayments: z.literal(true),
  denyExternalMessaging: z.literal(true),
  denyPrivilegeChanges: z.literal(true),
})

const onboardingBaseShape = {
  schemaVersion: schemaVersionSchema,
  recordId: z.uuid().optional(),
  name: shortTextSchema,
  deploymentUrl: publicHttpUrlSchema,
  documentationSources: z
    .array(sourceUriSchema)
    .min(1)
    .max(20)
    .transform((sources) => [...new Set(sources)].sort()),
  previewUrlPattern: previewUrlPatternSchema.optional(),
  crawl: onboardingCrawlPolicySchema,
  capabilityHints: z.array(shortTextSchema).max(20),
  testDataSetupReference: persistedTextSchema.optional(),
  testDataResetReference: persistedTextSchema.optional(),
} as const

function requireDeploymentHost(
  value: {
    readonly deploymentUrl: string
    readonly crawl: { readonly allowedHosts: readonly string[] }
  },
  context: z.RefinementCtx
): void {
  let deploymentHost: string
  try {
    deploymentHost = new URL(value.deploymentUrl).hostname.toLowerCase()
  } catch {
    return
  }
  if (!value.crawl.allowedHosts.includes(deploymentHost)) {
    context.addIssue({
      code: "custom",
      message: "Allowed hosts must include the application deployment host",
      path: ["crawl", "allowedHosts"],
    })
  }
}

export const onboardingSubmissionSchema = z
  .strictObject({
    ...onboardingBaseShape,
    repository: onboardingRepositoryInputSchema,
    authentication: onboardingAuthenticationInputSchema,
  })
  .superRefine(requireDeploymentHost)

export const onboardingConfigurationSchema = z
  .strictObject({
    ...onboardingBaseShape,
    repository: onboardingRepositoryConfigurationSchema,
    authentication: onboardingAuthenticationConfigurationSchema,
  })
  .superRefine(requireDeploymentHost)

export function createOnboardingInputFingerprint(
  configurationInput: OnboardingConfiguration
) {
  const configuration = onboardingConfigurationSchema.parse(configurationInput)
  return hashCanonical({
    schemaVersion: configuration.schemaVersion,
    deploymentUrl: configuration.deploymentUrl,
    repository: {
      url: configuration.repository.url,
      ref: configuration.repository.ref,
      accessMode: configuration.repository.accessMode,
      ...(configuration.repository.installationId === undefined
        ? {}
        : { installationId: configuration.repository.installationId }),
    },
    documentationSources: configuration.documentationSources,
    ...(configuration.previewUrlPattern === undefined
      ? {}
      : { previewUrlPattern: configuration.previewUrlPattern }),
    authentication: configuration.authentication,
    crawl: configuration.crawl,
    capabilityHints: configuration.capabilityHints,
    ...(configuration.testDataSetupReference === undefined
      ? {}
      : { testDataSetupReference: configuration.testDataSetupReference }),
    ...(configuration.testDataResetReference === undefined
      ? {}
      : { testDataResetReference: configuration.testDataResetReference }),
  })
}

export const compatibilityCapabilitySchema = z.enum([
  "repository_resolved",
  "application_reachable",
  "documentation_reachable",
  "typescript_react",
  "php_laravel",
  "laravel_routes",
  "openapi_scramble",
  "playwright_assets",
  "authentication_automatable",
  "safe_action_policy",
])

export const compatibilityEvidenceSchema = z.strictObject({
  capability: compatibilityCapabilitySchema,
  status: z.enum(["detected", "missing", "blocked"]),
  code: reasonCodeSchema,
  summary: persistedTextSchema,
  source: z.enum([
    "repository",
    "documentation",
    "application",
    "configuration",
  ]),
  references: z.array(z.string().min(1).max(2_048)).max(20),
})

export const compatibilityFindingSchema = z.strictObject({
  severity: z.enum(["warning", "blocker"]),
  code: reasonCodeSchema,
  summary: persistedTextSchema,
  humanAction: persistedTextSchema,
})

export const onboardingProposedScopeSchema = z.strictObject({
  repositoryPaths: z.array(repositoryPathSchema).max(100),
  documentationSources: z.array(sourceUriSchema).max(20),
  applicationOrigins: z.array(publicHttpUrlSchema).max(20),
  allowedActionCategories: z
    .array(
      z.enum([
        "safe_read",
        "safe_navigation",
        "safe_form_progress",
        "credential_entry",
        "unknown_submission",
      ])
    )
    .max(5),
  maxActions: z.number().int().min(1).max(500),
  maxScreens: z.number().int().min(1).max(500),
  maxDurationSeconds: z.number().int().min(10).max(3_600),
})

export const compatibilityReportSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    inputFingerprint: contentHashSchema,
    status: z.enum(["supported", "partial", "blocked"]),
    resolvedCommitSha: commitShaSchema.optional(),
    selectedAdapters: z.array(reasonCodeSchema).max(20),
    evidence: z.array(compatibilityEvidenceSchema).min(1).max(100),
    findings: z.array(compatibilityFindingSchema).max(100),
    humanActions: z.array(persistedTextSchema).max(100),
    proposedScope: onboardingProposedScopeSchema,
    inspectedAt: timestampSchema,
  })
  .superRefine((report, context) => {
    const blockerCount = report.findings.filter(
      (finding) => finding.severity === "blocker"
    ).length
    const warningCount = report.findings.length - blockerCount
    const expected =
      blockerCount > 0 ? "blocked" : warningCount > 0 ? "partial" : "supported"
    if (report.status !== expected) {
      context.addIssue({
        code: "custom",
        message: `Compatibility status must be ${expected} for its findings`,
        path: ["status"],
      })
    }
    if (blockerCount === 0 && report.resolvedCommitSha === undefined) {
      context.addIssue({
        code: "custom",
        message: "Non-blocked reports require an immutable commit",
        path: ["resolvedCommitSha"],
      })
    }
  })

export const publicOnboardingConfigurationSchema = z.strictObject({
  repository: onboardingRepositoryConfigurationSchema,
  documentationSources: z.array(sourceUriSchema).max(20),
  previewUrlPattern: z.string().max(2_048).optional(),
  authentication: z.strictObject({
    method: z.enum(["none", "credentials", "storage_state"]),
    configuredFields: z
      .array(
        z.strictObject({
          key: credentialFieldKeySchema,
          label: credentialLabelSchema,
        })
      )
      .max(10),
    revision: z.number().int().nonnegative(),
    automationConfirmed: z.boolean(),
  }),
  crawl: onboardingCrawlPolicySchema,
  capabilityHints: z.array(shortTextSchema).max(20),
  testDataSetupReference: persistedTextSchema.optional(),
  testDataResetReference: persistedTextSchema.optional(),
})

export const publicOnboardingApplicationSchema = z.strictObject({
  id: z.uuid(),
  name: shortTextSchema,
  deploymentUrl: publicHttpUrlSchema,
  status: applicationStatusSchema,
  indexedCommitSha: commitShaSchema.optional(),
  graphRevision: z.number().int().nonnegative(),
  refreshedAt: timestampSchema.optional(),
  knowledgeStale: z.boolean(),
  configuration: publicOnboardingConfigurationSchema,
  compatibility: compatibilityReportSchema.optional(),
  confirmed: z.boolean(),
  updatedAt: timestampSchema,
})

export const onboardingFormValuesSchema = z.strictObject({
  recordId: z.uuid().optional(),
  name: z.string().max(512),
  deploymentUrl: z.string().max(2_048),
  repositoryUrl: z.string().max(2_048),
  repositoryRef: z.string().max(255),
  repositoryAccessMode: z.enum(["manual", "github_app"]),
  githubInstallationId: z.string().max(20),
  documentationSources: z.string().max(16_384),
  previewUrlPattern: z.string().max(2_048),
  authenticationMethod: z.enum(["none", "credentials", "storage_state"]),
  authenticationAutomationConfirmed: z.boolean(),
  credentialFields: z
    .array(
      z.strictObject({
        key: z.string().max(96),
        label: z.string().max(80),
      })
    )
    .max(10),
  allowedHosts: z.string().max(4_096),
  maxActions: z.string().max(8),
  maxScreens: z.string().max(8),
  maxDurationSeconds: z.string().max(8),
  allowFormSubmission: z.boolean(),
  denyDestructiveActions: z.boolean(),
  denyRealPayments: z.boolean(),
  denyExternalMessaging: z.boolean(),
  denyPrivilegeChanges: z.boolean(),
  capabilityHints: z.string().max(8_192),
  testDataSetupReference: z.string().max(4_096),
  testDataResetReference: z.string().max(4_096),
})

export const onboardingActionStateSchema = z.strictObject({
  status: z.enum([
    "idle",
    "validation_error",
    "inspected",
    "confirmed",
    "error",
  ]),
  message: persistedTextSchema.optional(),
  fieldErrors: z.record(z.string(), z.array(z.string().max(512)).max(10)),
  values: onboardingFormValuesSchema,
  application: publicOnboardingApplicationSchema.optional(),
})

export const commitReferenceSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  repository: repositoryIdentitySchema,
  sha: commitShaSchema,
  ref: z.string().trim().min(1).max(255).optional(),
})

export const runSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: runIdSchema,
  applicationId: applicationIdSchema,
  type: runTypeSchema,
  status: runStatusSchema,
  idempotencyKey: persistedTextSchema,
  budget: z.lazy(() => executionBudgetSchema),
  createdAt: timestampSchema,
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional(),
})

export const missionModeSchema = z.enum([
  "baseline_discovery",
  "targeted_requirement_lookup",
  "conflict_resolution",
  "baseline_architecture_discovery",
  "implementation_trace",
  "pr_change_investigation",
  "unmapped_endpoint_resolution",
  "workflow_discovery",
  "targeted_requirement_observation",
  "pr_change_validation",
  "flow_recovery",
])

export const executionBudgetSchema = z.strictObject({
  toolCalls: z.number().int().nonnegative(),
  contentBytes: z.number().int().nonnegative(),
  documentBytes: z.number().int().nonnegative(),
  documentPages: z.number().int().nonnegative(),
  documentSections: z.number().int().nonnegative(),
  sourceLines: z.number().int().nonnegative(),
  repositoryBytes: z.number().int().nonnegative(),
  repositoryFiles: z.number().int().nonnegative(),
  browserActions: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  modelInputTokens: z.number().int().nonnegative(),
  modelOutputTokens: z.number().int().nonnegative(),
  reconciliationRounds: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
})

export const missionBudgetSchema = executionBudgetSchema

export const missionScopeSchema = z.strictObject({
  repositoryPaths: z.array(repositoryPathSchema).max(100).default([]),
  languages: z.array(languageSchema).min(1).max(3).optional(),
  sourceUris: z.array(sourceUriSchema).max(100).default([]),
  allowedHosts: z.array(hostnameSchema).max(50).default([]),
  allowedTools: z.array(reasonCodeSchema).min(1).max(50),
})

const modesByAgent = {
  documentation: new Set([
    "baseline_discovery",
    "targeted_requirement_lookup",
    "conflict_resolution",
  ]),
  code: new Set([
    "baseline_architecture_discovery",
    "implementation_trace",
    "pr_change_investigation",
    "unmapped_endpoint_resolution",
  ]),
  application: new Set([
    "workflow_discovery",
    "targeted_requirement_observation",
    "pr_change_validation",
    "flow_recovery",
  ]),
} as const

export const discoveryMissionSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: missionIdSchema,
    runId: runIdSchema,
    applicationId: applicationIdSchema,
    agent: agentKindSchema.exclude(["curator", "system"]),
    mode: missionModeSchema,
    goal: persistedTextSchema,
    seedEvidenceIds: z.array(evidenceIdSchema).max(100),
    questions: z.array(persistedTextSchema).min(1).max(20),
    scope: missionScopeSchema,
    budget: missionBudgetSchema,
    successCriteria: z.array(persistedTextSchema).min(1).max(20),
  })
  .superRefine(({ agent, mode }, context) => {
    if (!modesByAgent[agent].has(mode)) {
      context.addIssue({
        code: "custom",
        message: `Mode ${mode} is not allowed for ${agent} missions`,
        path: ["mode"],
      })
    }
  })

export const unresolvedQuestionSchema = z.strictObject({
  question: persistedTextSchema,
  reasonCode: reasonCodeSchema,
  evidenceIds: z.array(evidenceIdSchema).max(100),
})

export const proposedClaimSchema = z.strictObject({
  id: claimIdSchema,
  status: z.literal("proposed"),
  subjectId: stableEntityIdSchema,
  predicate: reasonCodeSchema,
  objectId: stableEntityIdSchema,
  evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
  explanation: persistedTextSchema,
})

export const missionResultSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  missionId: missionIdSchema,
  status: terminalStatusSchema,
  claims: z.array(proposedClaimSchema).max(500),
  unresolved: z.array(unresolvedQuestionSchema).max(100),
  exclusions: z.array(persistedTextSchema).max(100),
  suggestedFollowups: z.array(discoveryMissionSchema).max(20),
  stopReason: z.strictObject({
    code: reasonCodeSchema,
    summary: persistedTextSchema,
  }),
  budgetUsed: missionBudgetSchema,
})

export type Application = z.infer<typeof applicationSchema>
export type Source = z.infer<typeof sourceSchema>
export type OnboardingSubmission = z.infer<typeof onboardingSubmissionSchema>
export type OnboardingConfiguration = z.infer<
  typeof onboardingConfigurationSchema
>
export type OnboardingAuthenticationConfiguration = z.infer<
  typeof onboardingAuthenticationConfigurationSchema
>
export type CompatibilityCapability = z.infer<
  typeof compatibilityCapabilitySchema
>
export type CompatibilityEvidence = z.infer<typeof compatibilityEvidenceSchema>
export type CompatibilityFinding = z.infer<typeof compatibilityFindingSchema>
export type CompatibilityReport = z.infer<typeof compatibilityReportSchema>
export type OnboardingProposedScope = z.infer<
  typeof onboardingProposedScopeSchema
>
export type PublicOnboardingConfiguration = z.infer<
  typeof publicOnboardingConfigurationSchema
>
export type PublicOnboardingApplication = z.infer<
  typeof publicOnboardingApplicationSchema
>
export type OnboardingFormValues = z.infer<typeof onboardingFormValuesSchema>
export type OnboardingActionState = z.infer<typeof onboardingActionStateSchema>
export type CommitReference = z.infer<typeof commitReferenceSchema>
export type Run = z.infer<typeof runSchema>
export type MissionBudget = z.infer<typeof missionBudgetSchema>
export type DiscoveryMission = z.infer<typeof discoveryMissionSchema>
export type ProposedClaim = z.infer<typeof proposedClaimSchema>
export type MissionResult = z.infer<typeof missionResultSchema>
