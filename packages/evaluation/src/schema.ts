import { createHash } from "node:crypto"

import { z } from "zod"

export const EVALUATION_SCHEMA_VERSION = 1 as const
export const PAID_EVALUATION_CONFIRMATION =
  "SENTINEL_PAID_EVAL_CONFIRMED" as const

export const evaluationIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[a-z0-9][a-z0-9._:/-]*$/i)
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/)
const boundedStringArray = (maximum = 5_000) =>
  z
    .array(evaluationIdentifierSchema)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, {
      message: "Values must be unique",
    })

export const evaluationStageSchema = z.enum([
  "documentation",
  "code",
  "application",
  "reconciliation",
  "blast_radius",
  "report",
  "end_to_end",
])

export const evaluationExecutionScopeSchema = z.enum([
  "whole_graph",
  "node",
  "partial",
  "checkpoint",
])

export const evaluationSplitKindSchema = z.enum(["development", "held_out"])

export const evaluationMetricNameSchema = z.enum([
  "fact_precision",
  "fact_recall",
  "fact_f1",
  "evidence_fact_accuracy",
  "link_precision",
  "link_recall",
  "false_acceptance_rate",
  "citation_correctness",
  "unsupported_claim_rate",
  "path_completeness",
  "unknown_visibility",
  "impacted_recall",
  "impact_precision",
  "control_false_positive_rate",
  "trajectory_required_recall",
  "trajectory_scope_adherence",
  "trajectory_evidence_correctness",
  "trajectory_efficiency",
  "terminal_correctness",
  "budget_adherence",
  "case_score",
  "normalized_stability",
])

export const evaluationBudgetSchema = z.strictObject({
  toolCalls: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  sourceLines: z.number().int().nonnegative(),
  documentSections: z.number().int().nonnegative(),
  browserActions: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
})

export const zeroBudget = {
  toolCalls: 0,
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  sourceLines: 0,
  documentSections: 0,
  browserActions: 0,
  elapsedMs: 0,
} as const

const labeledFactSchema = z.strictObject({
  id: evaluationIdentifierSchema,
  kind: evaluationIdentifierSchema,
  critical: z.boolean().default(false),
})

const labeledLinkSchema = z.strictObject({
  id: evaluationIdentifierSchema,
  fromId: evaluationIdentifierSchema,
  relationship: evaluationIdentifierSchema,
  toId: evaluationIdentifierSchema,
  label: z.enum(["positive", "negative"]),
  critical: z.boolean().default(false),
})

const citationExpectationSchema = z.strictObject({
  claimId: evaluationIdentifierSchema,
  evidenceIds: boundedStringArray(100).min(1),
  critical: z.boolean().default(false),
})

const evidencePathExpectationSchema = z.strictObject({
  id: evaluationIdentifierSchema,
  nodeIds: boundedStringArray(20).min(2),
  critical: z.boolean().default(false),
})

const trajectoryPhaseSchema = z.strictObject({
  id: evaluationIdentifierSchema,
  stepIds: boundedStringArray(100).min(1),
  allowAnyOrder: z.boolean(),
})

const trajectoryExpectationSchema = z.strictObject({
  phases: z.array(trajectoryPhaseSchema).max(100),
  optionalStepIds: boundedStringArray(200),
  forbiddenStepIds: boundedStringArray(200),
  acceptedTerminalStatuses: boundedStringArray(20).min(1),
  maxUnnecessarySteps: z.number().int().nonnegative(),
})

const blastRadiusExpectationSchema = z.strictObject({
  impactedIds: boundedStringArray(),
  nonImpactedControlIds: boundedStringArray(),
  unknownIds: boundedStringArray(),
})

const expectedOutputSchema = z
  .strictObject({
    facts: z.array(labeledFactSchema).max(10_000),
    evidenceFacts: z.record(evaluationIdentifierSchema, z.string().max(4_096)),
    links: z.array(labeledLinkSchema).max(10_000),
    citations: z.array(citationExpectationSchema).max(10_000),
    paths: z.array(evidencePathExpectationSchema).max(5_000),
    blastRadius: blastRadiusExpectationSchema,
    trajectory: trajectoryExpectationSchema,
    budget: evaluationBudgetSchema,
    minimumScores: z.partialRecord(
      evaluationMetricNameSchema.exclude([
        "case_score",
        "normalized_stability",
      ]),
      z.number().min(0).max(1)
    ),
    maximumScores: z.partialRecord(
      evaluationMetricNameSchema.exclude([
        "case_score",
        "normalized_stability",
      ]),
      z.number().min(0).max(1)
    ),
  })
  .superRefine((expected, context) => {
    const facts = expected.facts.map(({ id }) => id)
    const links = expected.links.map(({ id }) => id)
    const citations = expected.citations.map(({ claimId }) => claimId)
    const paths = expected.paths.map(({ id }) => id)
    for (const [field, values] of [
      ["facts", facts],
      ["links", links],
      ["citations", citations],
      ["paths", paths],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} identities must be unique`,
        })
      }
    }

    const required = new Set(
      expected.trajectory.phases.flatMap(({ stepIds }) => stepIds)
    )
    const optional = new Set(expected.trajectory.optionalStepIds)
    const requiredCount = expected.trajectory.phases.reduce(
      (count, { stepIds }) => count + stepIds.length,
      0
    )
    if (
      required.size !== requiredCount ||
      expected.trajectory.optionalStepIds.some((stepId) => required.has(stepId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["trajectory"],
        message:
          "Required and optional trajectory step identities must be unique",
      })
    }
    if (
      expected.trajectory.forbiddenStepIds.some(
        (stepId) => required.has(stepId) || optional.has(stepId)
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["trajectory", "forbiddenStepIds"],
        message: "Forbidden trajectory steps cannot also be allowed",
      })
    }
  })

export const evaluationCaseSchema = z.strictObject({
  id: evaluationIdentifierSchema,
  title: z.string().trim().min(1).max(512),
  stage: evaluationStageSchema,
  execution: z.strictObject({
    scope: evaluationExecutionScopeSchema,
    entrypoint: evaluationIdentifierSchema,
    initialStateRef: evaluationIdentifierSchema.optional(),
    checkpointRef: evaluationIdentifierSchema.optional(),
  }),
  inputFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  input: z.record(z.string(), z.unknown()),
  expected: expectedOutputSchema,
  tags: boundedStringArray(50),
})

export const evaluationDatasetSchema = z
  .strictObject({
    schemaVersion: z.literal(EVALUATION_SCHEMA_VERSION),
    id: evaluationIdentifierSchema,
    version: evaluationIdentifierSchema,
    target: z.strictObject({
      name: z.string().trim().min(1).max(256),
      repository: z.url({ protocol: /^https$/ }),
      pullRequest: z.number().int().positive(),
      pullRequestUrl: z.url({ protocol: /^https$/ }),
      title: z.string().trim().min(1).max(512),
      baseSha: shaSchema,
      headSha: shaSchema,
      sanitized: z.literal(true),
      reviewedAt: z.iso.datetime({ offset: true }),
    }),
    limitations: z.array(z.string().trim().min(1).max(2_000)).min(1).max(50),
    splits: z
      .array(
        z.strictObject({
          kind: evaluationSplitKindSchema,
          cases: z.array(evaluationCaseSchema).min(1).max(1_000),
        })
      )
      .min(2)
      .max(2),
  })
  .superRefine((dataset, context) => {
    const splitKinds = dataset.splits.map(({ kind }) => kind)
    if (
      new Set(splitKinds).size !== splitKinds.length ||
      !splitKinds.includes("development") ||
      !splitKinds.includes("held_out")
    ) {
      context.addIssue({
        code: "custom",
        path: ["splits"],
        message: "Dataset requires one development and one held-out split",
      })
    }

    const allCases = dataset.splits.flatMap(({ cases }) => cases)
    const caseIds = allCases.map(({ id }) => id)
    if (new Set(caseIds).size !== caseIds.length) {
      context.addIssue({
        code: "custom",
        path: ["splits"],
        message: "Case identities must be unique across splits",
      })
    }
    for (const [index, evaluationCase] of allCases.entries()) {
      const fingerprint = fingerprintEvaluationInput(evaluationCase.input)
      if (evaluationCase.inputFingerprint !== fingerprint) {
        context.addIssue({
          code: "custom",
          path: ["splits"],
          message: `Case ${evaluationCase.id} has a stale input fingerprint at index ${index}`,
        })
      }
    }

    const development = new Set(
      dataset.splits
        .find(({ kind }) => kind === "development")
        ?.cases.map(({ inputFingerprint }) => inputFingerprint) ?? []
    )
    const leaked =
      dataset.splits
        .find(({ kind }) => kind === "held_out")
        ?.cases.find(({ inputFingerprint }) =>
          development.has(inputFingerprint)
        ) ?? null
    if (leaked !== null) {
      context.addIssue({
        code: "custom",
        path: ["splits"],
        message: `Held-out input duplicates development case ${leaked.id}`,
      })
    }
  })

export const observedCitationSchema = z.strictObject({
  claimId: evaluationIdentifierSchema,
  evidenceIds: boundedStringArray(100),
  supported: z.boolean(),
  critical: z.boolean(),
})

export const observedEvidencePathSchema = z.strictObject({
  id: evaluationIdentifierSchema,
  nodeIds: boundedStringArray(20).min(2),
})

export const observedTrajectoryStepSchema = z.strictObject({
  stepId: evaluationIdentifierSchema,
  kind: z.enum(["tool", "evidence", "terminal"]),
  name: evaluationIdentifierSchema,
  scopeAllowed: z.boolean(),
  evidenceCorrect: z.boolean(),
  unsafe: z.boolean(),
})

export const evaluationUsageSchema = evaluationBudgetSchema.extend({
  actualCostUsd: z.number().nonnegative().optional(),
})

export const evaluationEstimatedUsageSchema = evaluationBudgetSchema.extend({
  estimatedCostUsd: z.number().positive(),
})

export const observedEvaluationOutputSchema = z
  .strictObject({
    facts: boundedStringArray(10_000),
    evidenceFacts: z.record(evaluationIdentifierSchema, z.string().max(4_096)),
    acceptedLinks: boundedStringArray(10_000),
    citations: z.array(observedCitationSchema).max(10_000),
    paths: z.array(observedEvidencePathSchema).max(5_000),
    visibleUnknownIds: boundedStringArray(5_000),
    impactedIds: boundedStringArray(5_000),
    trajectory: z.array(observedTrajectoryStepSchema).max(10_000),
    terminalStatus: evaluationIdentifierSchema,
    usage: evaluationUsageSchema,
    normalizedEvidence: z.record(
      evaluationIdentifierSchema,
      z.string().max(20_000)
    ),
  })
  .superRefine((output, context) => {
    for (const [field, values] of [
      ["citations", output.citations.map(({ claimId }) => claimId)],
      ["paths", output.paths.map(({ id }) => id)],
      ["trajectory", output.trajectory.map(({ stepId }) => stepId)],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} identities must be unique`,
        })
      }
    }
  })

export const evaluationMetricSchema = z.strictObject({
  name: evaluationMetricNameSchema,
  numerator: z.number().nonnegative(),
  denominator: z.number().nonnegative(),
  value: z.number().min(0).max(1),
})

export const hardFailureCodeSchema = z.enum([
  "unsafe_tool_action",
  "unauthorized_tool_scope",
  "forbidden_trajectory_step",
  "critical_unsupported_claim",
  "critical_false_acceptance",
])

export const evaluationCaseResultSchema = z.strictObject({
  caseId: evaluationIdentifierSchema,
  split: evaluationSplitKindSchema,
  stage: evaluationStageSchema,
  executionScope: evaluationExecutionScopeSchema,
  repetition: z.number().int().positive(),
  seed: z.number().int().nonnegative(),
  metrics: z.array(evaluationMetricSchema),
  hardFailures: z.array(
    z.strictObject({
      code: hardFailureCodeSchema,
      relatedId: evaluationIdentifierSchema,
      message: z.string().trim().min(1).max(1_000),
    })
  ),
  passed: z.boolean(),
  normalizedEvidenceFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  usage: evaluationUsageSchema,
})

export const distributionSchema = z.strictObject({
  count: z.number().int().positive(),
  minimum: z.number().nonnegative(),
  p50: z.number().nonnegative(),
  p95: z.number().nonnegative(),
  maximum: z.number().nonnegative(),
  mean: z.number().nonnegative(),
  standardDeviation: z.number().nonnegative(),
})

export const evaluationRunReportSchema = z.strictObject({
  schemaVersion: z.literal(EVALUATION_SCHEMA_VERSION),
  dataset: z.strictObject({
    id: evaluationIdentifierSchema,
    version: evaluationIdentifierSchema,
  }),
  run: z.strictObject({
    runId: evaluationIdentifierSchema,
    startedAt: z.iso.datetime({ offset: true }),
    completedAt: z.iso.datetime({ offset: true }),
    repetitions: z.number().int().positive(),
    seed: z.number().int().nonnegative(),
    mode: z.enum(["deterministic", "live_model"]),
    model: evaluationIdentifierSchema,
    provider: evaluationIdentifierSchema,
    modelConfigFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    templateVersion: evaluationIdentifierSchema,
    selectedSplits: z.array(evaluationSplitKindSchema).min(1).max(2),
  }),
  summary: z.strictObject({
    caseExecutions: z.number().int().positive(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    hardFailures: z.number().int().nonnegative(),
    passRate: z.number().min(0).max(1),
    metrics: z.record(evaluationMetricNameSchema, distributionSchema),
  }),
  usage: evaluationUsageSchema,
  estimatedUsage: evaluationEstimatedUsageSchema.optional(),
  results: z.array(evaluationCaseResultSchema).min(1),
  limitations: z.array(z.string().trim().min(1).max(2_000)).min(1),
})

export const evaluationRunSummarySchema = evaluationRunReportSchema.omit({
  results: true,
})

export type EvaluationMetricName = z.infer<typeof evaluationMetricNameSchema>
export type EvaluationBudget = z.infer<typeof evaluationBudgetSchema>
export type EvaluationCase = z.infer<typeof evaluationCaseSchema>
export type EvaluationDataset = z.infer<typeof evaluationDatasetSchema>
export type EvaluationSplitKind = z.infer<typeof evaluationSplitKindSchema>
export type ObservedEvaluationOutput = z.infer<
  typeof observedEvaluationOutputSchema
>
export type EvaluationMetric = z.infer<typeof evaluationMetricSchema>
export type EvaluationCaseResult = z.infer<typeof evaluationCaseResultSchema>
export type EvaluationRunReport = z.infer<typeof evaluationRunReportSchema>
export type EvaluationRunSummary = z.infer<typeof evaluationRunSummarySchema>

export function fingerprintEvaluationInput(
  input: Record<string, unknown>
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalStringify(input)).digest("hex")}`
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(
        ([key, child]) => `${JSON.stringify(key)}:${canonicalStringify(child)}`
      )
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
