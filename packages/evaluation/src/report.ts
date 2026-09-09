import {
  evaluationRunReportSchema,
  evaluationRunSummarySchema,
  type EvaluationMetricName,
  type EvaluationRunReport,
} from "./schema.ts"

const lowerIsBetter = new Set<EvaluationMetricName>([
  "false_acceptance_rate",
  "unsupported_claim_rate",
  "control_false_positive_rate",
])

export function renderEvaluationMarkdown(
  reportValue: EvaluationRunReport
): string {
  const report = evaluationRunReportSchema.parse(reportValue)
  const lines = [
    `# Sentinel evaluation: ${report.dataset.id}`,
    "",
    `Run \`${report.run.runId}\` evaluated dataset \`${report.dataset.version}\` with ${report.run.repetitions} repetition(s).`,
    "",
    "## Outcome",
    "",
    `- Pass rate: ${formatPercent(report.summary.passRate)} (${report.summary.passed}/${report.summary.caseExecutions})`,
    `- Hard failures: ${report.summary.hardFailures}`,
    `- Mode: \`${report.run.mode}\` using \`${report.run.provider}/${report.run.model}\``,
    `- Template: \`${report.run.templateVersion}\``,
    `- Seed: \`${report.run.seed}\``,
    "",
    "## Metric distributions",
    "",
    "| Metric | Mean | P50 | P95 | Min-Max |",
    "|---|---:|---:|---:|---:|",
  ]

  for (const [name, values] of Object.entries(report.summary.metrics)) {
    const direction = lowerIsBetter.has(name as EvaluationMetricName)
      ? " (lower is better)"
      : ""
    lines.push(
      `| ${name}${direction} | ${formatPercent(values.mean)} | ${formatPercent(values.p50)} | ${formatPercent(values.p95)} | ${formatPercent(values.minimum)}-${formatPercent(values.maximum)} |`
    )
  }

  lines.push(
    "",
    "## Usage",
    "",
    `- Model calls: ${report.usage.modelCalls}`,
    `- Tokens: ${report.usage.inputTokens} input / ${report.usage.outputTokens} output`,
    `- Tool calls: ${report.usage.toolCalls}`,
    `- Browser actions: ${report.usage.browserActions}`,
    `- Actual cost: ${report.usage.actualCostUsd === undefined ? "not reported" : `$${report.usage.actualCostUsd.toFixed(4)}`}`,
    ...(report.estimatedUsage === undefined
      ? []
      : [
          "",
          "### Confirmed estimate",
          "",
          `- Model calls: ${report.estimatedUsage.modelCalls}`,
          `- Tokens: ${report.estimatedUsage.inputTokens} input / ${report.estimatedUsage.outputTokens} output`,
          `- Tool calls: ${report.estimatedUsage.toolCalls}`,
          `- Source/browser scope: ${report.estimatedUsage.sourceLines} lines / ${report.estimatedUsage.documentSections} sections / ${report.estimatedUsage.browserActions} actions`,
          `- Elapsed time: ${report.estimatedUsage.elapsedMs} ms`,
          `- Estimated cost: $${report.estimatedUsage.estimatedCostUsd.toFixed(4)}`,
        ]),
    "",
    "## Known limitations",
    ""
  )
  for (const limitation of report.limitations) lines.push(`- ${limitation}`)
  lines.push("")
  return lines.join("\n")
}

export function renderEvaluationJson(reportValue: EvaluationRunReport): string {
  const report = evaluationRunReportSchema.parse(reportValue)
  return `${JSON.stringify(sortValue(report), null, 2)}\n`
}

export function renderEvaluationSummaryJson(
  reportValue: EvaluationRunReport
): string {
  const summary = Object.fromEntries(
    Object.entries(evaluationRunReportSchema.parse(reportValue)).filter(
      ([key]) => key !== "results"
    )
  )
  return `${JSON.stringify(sortValue(evaluationRunSummarySchema.parse(summary)), null, 2)}\n`
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortValue(item))
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, child]) => [key, sortValue(child)])
    )
  }
  return value
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
