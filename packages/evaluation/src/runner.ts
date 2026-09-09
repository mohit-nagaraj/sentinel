import { createHash } from "node:crypto"

import { z } from "zod"

import { evaluateCase } from "./metrics.ts"
import {
  distributionSchema,
  evaluationCaseResultSchema,
  evaluationDatasetSchema,
  evaluationEstimatedUsageSchema,
  evaluationIdentifierSchema,
  evaluationMetricNameSchema,
  evaluationRunReportSchema,
  evaluationSplitKindSchema,
  observedEvaluationOutputSchema,
  PAID_EVALUATION_CONFIRMATION,
  zeroBudget,
  type EvaluationBudget,
  type EvaluationCase,
  type EvaluationCaseResult,
  type EvaluationDataset,
  type EvaluationMetricName,
  type EvaluationRunReport,
  type EvaluationSplitKind,
  type ObservedEvaluationOutput,
} from "./schema.ts"

const runConfigurationSchema = z.strictObject({
  runId: evaluationIdentifierSchema,
  repetitions: z.number().int().min(1).max(100),
  seed: z.number().int().nonnegative(),
  mode: z.enum(["deterministic", "live_model"]),
  model: evaluationIdentifierSchema,
  provider: evaluationIdentifierSchema,
  modelConfig: z.record(z.string(), z.unknown()),
  templateVersion: evaluationIdentifierSchema,
  splits: z.array(evaluationSplitKindSchema).min(1).max(2),
  caseIds: z.array(evaluationIdentifierSchema).optional(),
  paidConfirmation: z.string().optional(),
  estimatedUsage: evaluationEstimatedUsageSchema.optional(),
})

export type EvaluationRunConfiguration = z.input<typeof runConfigurationSchema>

export interface EvaluationTargetRequest {
  caseId: string
  stage: EvaluationCase["stage"]
  execution: EvaluationCase["execution"]
  input: Record<string, unknown>
  repetition: number
  seed: number
  model: string
  provider: string
  modelConfig: Record<string, unknown>
  templateVersion: string
}

export interface EvaluationTarget {
  execute(
    request: EvaluationTargetRequest
  ): Promise<ObservedEvaluationOutput> | ObservedEvaluationOutput
}

export interface EvaluationRunnerDependencies {
  now?: () => Date
}

export async function runEvaluation(
  datasetValue: EvaluationDataset,
  target: EvaluationTarget,
  configurationValue: EvaluationRunConfiguration,
  dependencies: EvaluationRunnerDependencies = {}
): Promise<EvaluationRunReport> {
  const dataset = evaluationDatasetSchema.parse(datasetValue)
  const configuration = runConfigurationSchema.parse(configurationValue)
  assertPaidRunConfirmed(configuration)
  const cases = selectCases(
    dataset,
    configuration.splits,
    configuration.caseIds
  )
  if (cases.length === 0) {
    throw new Error("Evaluation selection contains no cases")
  }

  const now = dependencies.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const rawResults: EvaluationCaseResult[] = []
  for (
    let repetition = 1;
    repetition <= configuration.repetitions;
    repetition += 1
  ) {
    for (const [caseIndex, selected] of cases.entries()) {
      const seed =
        configuration.seed + (repetition - 1) * cases.length + caseIndex
      const actual = observedEvaluationOutputSchema.parse(
        await target.execute({
          caseId: selected.evaluationCase.id,
          stage: selected.evaluationCase.stage,
          execution: selected.evaluationCase.execution,
          input: structuredClone(selected.evaluationCase.input),
          repetition,
          seed,
          model: configuration.model,
          provider: configuration.provider,
          modelConfig: structuredClone(configuration.modelConfig),
          templateVersion: configuration.templateVersion,
        })
      )
      rawResults.push(
        evaluateCase(selected.evaluationCase, actual, {
          split: selected.split,
          repetition,
          seed,
        })
      )
    }
  }

  const results = addStabilityMetrics(rawResults)
  const completedAt = now().toISOString()
  const metrics = aggregateMetricDistributions(results)
  const passed = results.filter((result) => result.passed).length
  const totalUsage = sumUsage(results)

  return evaluationRunReportSchema.parse({
    schemaVersion: 1,
    dataset: { id: dataset.id, version: dataset.version },
    run: {
      runId: configuration.runId,
      startedAt,
      completedAt,
      repetitions: configuration.repetitions,
      seed: configuration.seed,
      mode: configuration.mode,
      model: configuration.model,
      provider: configuration.provider,
      modelConfigFingerprint: hashCanonical(configuration.modelConfig),
      templateVersion: configuration.templateVersion,
      selectedSplits: configuration.splits,
    },
    summary: {
      caseExecutions: results.length,
      passed,
      failed: results.length - passed,
      hardFailures: results.reduce(
        (sum, result) => sum + result.hardFailures.length,
        0
      ),
      passRate: passed / results.length,
      metrics,
    },
    usage: totalUsage,
    ...(configuration.estimatedUsage === undefined
      ? {}
      : { estimatedUsage: configuration.estimatedUsage }),
    results,
    limitations: dataset.limitations,
  })
}

function assertPaidRunConfirmed(
  configuration: z.output<typeof runConfigurationSchema>
): void {
  if (configuration.mode !== "live_model") return
  if (
    configuration.paidConfirmation !== PAID_EVALUATION_CONFIRMATION ||
    configuration.estimatedUsage === undefined
  ) {
    throw new Error(
      `Live model evaluation requires an estimated usage record and exact confirmation ${PAID_EVALUATION_CONFIRMATION}`
    )
  }
}

function selectCases(
  dataset: EvaluationDataset,
  selectedSplits: EvaluationSplitKind[],
  caseIds?: string[]
): { split: EvaluationSplitKind; evaluationCase: EvaluationCase }[] {
  const selectedIds = caseIds === undefined ? undefined : new Set(caseIds)
  const availableIds = new Set(
    dataset.splits.flatMap(({ cases }) => cases.map(({ id }) => id))
  )
  const unknownId = caseIds?.find((caseId) => !availableIds.has(caseId))
  if (unknownId !== undefined) {
    throw new Error(`Unknown evaluation case ${unknownId}`)
  }

  return dataset.splits
    .filter(({ kind }) => selectedSplits.includes(kind))
    .flatMap(({ kind, cases }) =>
      cases
        .filter(({ id }) => selectedIds === undefined || selectedIds.has(id))
        .map((evaluationCase) => ({ split: kind, evaluationCase }))
    )
}

function addStabilityMetrics(
  results: EvaluationCaseResult[]
): EvaluationCaseResult[] {
  const fingerprintsByCase = new Map<string, string[]>()
  for (const result of results) {
    const values = fingerprintsByCase.get(result.caseId) ?? []
    values.push(result.normalizedEvidenceFingerprint)
    fingerprintsByCase.set(result.caseId, values)
  }
  return results.map((result) => {
    const fingerprints = fingerprintsByCase.get(result.caseId) ?? []
    const expected = fingerprints[0]
    const stable = fingerprints.filter((value) => value === expected).length
    return evaluationCaseResultSchema.parse({
      ...result,
      metrics: [
        ...result.metrics,
        {
          name: "normalized_stability",
          numerator: stable,
          denominator: fingerprints.length,
          value: stable / fingerprints.length,
        },
      ],
    })
  })
}

function aggregateMetricDistributions(
  results: EvaluationCaseResult[]
): Record<EvaluationMetricName, z.infer<typeof distributionSchema>> {
  return Object.fromEntries(
    evaluationMetricNameSchema.options.map((name) => {
      const values = results.flatMap((result) =>
        result.metrics
          .filter((metric) => metric.name === name)
          .map(({ value }) => value)
      )
      if (values.length === 0) {
        throw new Error(`Evaluation did not produce required metric ${name}`)
      }
      return [name, distribution(values)]
    })
  ) as Record<EvaluationMetricName, z.infer<typeof distributionSchema>>
}

export function distribution(
  values: number[]
): z.infer<typeof distributionSchema> {
  if (values.length === 0)
    throw new Error("Cannot summarize an empty distribution")
  const sorted = [...values].sort((left, right) => left - right)
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  const variance =
    sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length
  return distributionSchema.parse({
    count: sorted.length,
    minimum: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    maximum: sorted.at(-1),
    mean,
    standardDeviation: Math.sqrt(variance),
  })
}

function percentile(sorted: number[], quantile: number): number {
  const index = Math.ceil(quantile * sorted.length) - 1
  return sorted[Math.max(0, index)]!
}

function sumUsage(results: EvaluationCaseResult[]): EvaluationBudget & {
  actualCostUsd?: number
} {
  const total: EvaluationBudget & { actualCostUsd?: number } = {
    ...zeroBudget,
  }
  let hasActualCost = false
  for (const result of results) {
    for (const key of Object.keys(zeroBudget) as (keyof EvaluationBudget)[]) {
      total[key] += result.usage[key]
    }
    if (result.usage.actualCostUsd !== undefined) {
      total.actualCostUsd =
        (total.actualCostUsd ?? 0) + result.usage.actualCostUsd
      hasActualCost = true
    }
  }
  if (!hasActualCost) delete total.actualCostUsd
  return total
}

function hashCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalStringify(value)).digest("hex")}`
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
