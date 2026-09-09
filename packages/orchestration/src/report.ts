import {
  REPORT_TEMPLATE_VERSION,
  REPORT_WORDING_PROMPT_VERSION,
  assessmentReportSourceSchema,
  assessmentReportViewSchema,
  githubCheckLifecycleSchema,
  hashCanonical,
  prInvestigationResultSchema,
  reportWordingOutputSchema,
  type AssessmentReportSource,
  type AssessmentReportView,
  type BlastRadiusFinding,
  type GithubCheckLifecycle,
  type PrInvestigationResult,
  type ReportWordingOutput,
} from "@sentinel/contracts"
import { z } from "zod"

const sections = [
  "identity",
  "executive_summary",
  "product_areas",
  "user_interface",
  "workflows",
  "requirements",
  "evidence",
  "recommended_qa",
  "verification",
  "unknowns_and_exclusions",
  "generation",
] as const

const riskOrder = { high: 0, medium: 1, low: 2, unknown: 3 } as const
const tierOrder = { A: 0, B: 1, C: 2, D: 3 } as const
const unsafeAssurance =
  /\b(?:this (?:pull request|change|release|feature|workflow|screen|requirement) is safe|safe to (?:merge|deploy|release|ship)|no impact|zero impact|fully verified|no risk|risk[- ]free)\b/i
const unsafeAbsence = /\b(?:does not exist|is absent|feature is missing)\b/i
const factIdPattern =
  /(?:sha256:[a-f0-9]{64}|[a-z][a-z0-9]*(?:-[a-z0-9]+)*:v1:[a-f0-9]{64})/g

function compareStrings(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings)
}

function safeReportText(value: string): string {
  return z.string().trim().min(1).max(4_096).parse(value)
}

function assertGeneratedReportText(value: string): string {
  const parsed = safeReportText(value)
  if (unsafeAssurance.test(parsed) || unsafeAbsence.test(parsed)) {
    throw new Error(
      "Report wording makes an unsupported assurance or absence claim"
    )
  }
  return parsed
}

function deterministicSummary(finding: BlastRadiusFinding): string {
  if (finding.risk === "unknown") {
    return safeReportText(
      `${finding.title}. Product impact remains unknown within the assessed scope; the assessment does not establish limited consequence.`
    )
  }
  const label = finding.targetKind.replaceAll("-", " ")
  return safeReportText(
    `This ${label} is potentially affected through ${finding.evidencePathIds.length} inspectable evidence path${finding.evidencePathIds.length === 1 ? "" : "s"}. The result is a prediction and should guide focused retesting.`
  )
}

function overallRisk(source: AssessmentReportSource) {
  return (
    [...source.blastRadius.findings]
      .map(({ risk }) => risk)
      .sort((a, b) => riskOrder[a] - riskOrder[b])[0] ?? "unknown"
  )
}

function overallEvidence(source: AssessmentReportSource) {
  return (
    [...source.blastRadius.findings]
      .map(({ evidenceStrength }) => evidenceStrength)
      .sort((a, b) => tierOrder[b] - tierOrder[a])[0] ?? "D"
  )
}

function executiveSummary(source: AssessmentReportSource): string {
  const { high, low, medium, unknown } = source.blastRadius.summary
  return safeReportText(
    `Predicted impact includes ${high} high, ${medium} medium, ${low} low, and ${unknown} unknown finding${high + medium + low + unknown === 1 ? "" : "s"}. Review uncertainty and complete the recommended QA checkpoints before making a release decision.`
  )
}

function alternateExecutiveSummary(source: AssessmentReportSource): string {
  const { high, low, medium, unknown } = source.blastRadius.summary
  return safeReportText(
    `Uncertainty remains explicit across ${high + medium + low + unknown} predicted finding${high + medium + low + unknown === 1 ? "" : "s"}: ${high} high, ${medium} medium, ${low} low, and ${unknown} unknown. Use the recommended QA checkpoints to investigate the supplied evidence before making a release decision.`
  )
}

function findingTitleChoices(finding: BlastRadiusFinding): readonly string[] {
  return [
    safeReportText(finding.title),
    safeReportText(`${finding.title}: focused QA review`),
  ]
}

function findingSummaryChoices(finding: BlastRadiusFinding): readonly string[] {
  return [
    deterministicSummary(finding),
    safeReportText(
      finding.risk === "unknown"
        ? `${finding.title}. The supplied assessment leaves product impact unknown; review the cited evidence and unresolved scope before making a release decision.`
        : `${finding.title}. The supplied ${finding.evidencePathIds.length} evidence path${finding.evidencePathIds.length === 1 ? "" : "s"} predicts potential ${finding.targetKind.replaceAll("-", " ")} impact and identifies focused QA work; it does not establish release safety.`
    ),
  ]
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort(compareStrings)
  const sortedRight = [...right].sort(compareStrings)
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((id, index) => id === sortedRight[index])
  )
}

function allowedFactIds(source: AssessmentReportSource): Set<string> {
  return new Set([
    ...source.blastRadius.findings.map(({ id }) => id),
    ...source.blastRadius.evidencePaths.flatMap((path) => [
      path.id,
      ...path.evidenceIds,
      ...path.nodes.map(({ id }) => id),
    ]),
    ...source.blastRadius.caveats.flatMap((item) => [
      item.id,
      ...item.evidenceIds,
    ]),
    ...source.blastRadius.findings.flatMap((finding) =>
      finding.scenarios.flatMap((scenario) => [
        scenario.id,
        ...scenario.checkpointEntityIds,
      ])
    ),
  ])
}

export function validateReportWording(
  sourceValue: AssessmentReportSource,
  wordingValue: ReportWordingOutput
): ReportWordingOutput {
  const source = assessmentReportSourceSchema.parse(sourceValue)
  const wording = reportWordingOutputSchema.parse(wordingValue)
  const eligibleFindings = source.blastRadius.findings.slice(0, 30)
  const findingById = new Map(
    eligibleFindings.map((finding) => [finding.id, finding])
  )
  const allowed = allowedFactIds(source)
  const eligibleFindingIds = eligibleFindings.map(({ id }) => id)
  const wordingFindingIds = wording.findings.map(({ findingId }) => findingId)
  if (new Set(wordingFindingIds).size !== wordingFindingIds.length) {
    throw new Error("Report wording contains duplicate finding entries")
  }
  if (!sameIds(wording.findingIds, eligibleFindingIds)) {
    throw new Error("Executive report wording must cite every supplied finding")
  }
  assertGeneratedReportText(wording.executiveSummary)
  if (
    ![executiveSummary(source), alternateExecutiveSummary(source)].includes(
      wording.executiveSummary
    )
  ) {
    throw new Error("Executive report wording is not a supplied wording choice")
  }
  for (const id of wording.executiveSummary.match(factIdPattern) ?? []) {
    if (!allowed.has(id))
      throw new Error("Executive report wording invents a fact ID")
  }
  for (const entry of wording.findings) {
    const finding = findingById.get(entry.findingId)
    if (finding === undefined) {
      throw new Error("Report wording cites an unknown finding")
    }
    const pathIds = new Set(finding.evidencePathIds)
    const scenarioIds = new Set(finding.scenarios.map(({ id }) => id))
    const caveatIds = new Set(finding.caveatIds)
    if (
      !sameIds(entry.evidencePathIds, [...pathIds]) ||
      !sameIds(entry.scenarioIds, [...scenarioIds]) ||
      !sameIds(entry.caveatIds, [...caveatIds])
    ) {
      throw new Error(
        "Report wording citations must exactly match supplied finding facts"
      )
    }
    assertGeneratedReportText(entry.title)
    assertGeneratedReportText(entry.summary)
    if (!findingTitleChoices(finding).includes(entry.title)) {
      throw new Error("Report title is not a supplied wording choice")
    }
    if (!findingSummaryChoices(finding).includes(entry.summary)) {
      throw new Error("Report summary is not a supplied wording choice")
    }
    for (const id of `${entry.title} ${entry.summary}`.match(factIdPattern) ??
      []) {
      if (!allowed.has(id)) throw new Error("Report wording invents a fact ID")
    }
  }
  return wording
}

function reportReferences(
  path: AssessmentReportSource["blastRadius"]["evidencePaths"][number]
) {
  const references = new Map<
    string,
    {
      id: string
      extractionMethod: string
      sourceUris: string[]
      artifactIds: string[]
    }
  >()
  for (const relationship of path.relationships) {
    const key = `${relationship.id}:${relationship.extractionMethod}`
    const current = references.get(key)
    references.set(key, {
      id: relationship.id,
      extractionMethod: relationship.extractionMethod,
      sourceUris: sortedUnique([
        ...(current?.sourceUris ?? []),
        ...relationship.sourceUris,
      ]),
      artifactIds: sortedUnique([
        ...(current?.artifactIds ?? []),
        ...relationship.artifactIds,
      ]),
    })
  }
  return [...references.values()]
    .sort((left, right) =>
      compareStrings(
        `${left.id}:${left.extractionMethod}`,
        `${right.id}:${right.extractionMethod}`
      )
    )
    .slice(0, 10)
}

function viewFrom(
  source: AssessmentReportSource,
  wording: ReportWordingOutput | null,
  modelId?: string
): AssessmentReportView {
  const pathById = new Map(
    source.blastRadius.evidencePaths.map((path) => [path.id, path])
  )
  const caveatById = new Map(
    source.blastRadius.caveats.map((item) => [item.id, item])
  )
  const wordingByFinding = new Map(
    (wording?.findings ?? []).map((entry) => [entry.findingId, entry])
  )
  const findings = source.blastRadius.findings.map((finding) => {
    const selectedWording = wordingByFinding.get(finding.id)
    return {
      id: finding.id,
      ...(finding.targetId === undefined ? {} : { targetId: finding.targetId }),
      targetKind: finding.targetKind,
      risk: finding.risk,
      evidenceStrength: finding.evidenceStrength,
      title: safeReportText(selectedWording?.title ?? finding.title),
      summary: safeReportText(
        selectedWording?.summary ?? deterministicSummary(finding)
      ),
      changedSymbolIds: finding.changedSymbolIds,
      evidencePaths: finding.evidencePathIds.map((id) => {
        const path = pathById.get(id)
        if (path === undefined)
          throw new Error("Report finding path is missing")
        return {
          id: path.id,
          evidenceStrength: path.evidenceStrength,
          nodes: path.nodes.map(({ id, kind, title }) => ({ id, kind, title })),
          evidenceIds: path.evidenceIds,
          references: reportReferences(path),
        }
      }),
      scenarios: finding.scenarios.map(
        ({
          id,
          kind,
          targetId,
          checkpointEntityIds,
          evidencePathIds,
          priority,
        }) => ({
          id,
          kind,
          targetId,
          checkpointEntityIds,
          evidencePathIds,
          priority,
        })
      ),
      caveats: finding.caveatIds.map((id) => {
        const item = caveatById.get(id)
        if (item === undefined)
          throw new Error("Report finding caveat is missing")
        return { id: item.id, summary: item.summary }
      }),
    }
  })
  const draft = {
    schemaVersion: 1,
    assessmentId: source.assessmentId,
    applicationId: source.applicationId,
    runId: source.runId,
    repository: source.pullRequest.repository,
    pullRequestId: source.pullRequest.id,
    pullRequestNumber: source.pullRequest.number,
    pullRequestTitle: source.pullRequest.title,
    baseSha: source.pullRequest.baseSha,
    headSha: source.pullRequest.headSha,
    graphCommitSha: source.blastRadius.graphCommitSha,
    graphRevision: source.blastRadius.graphRevision,
    policyVersion: source.blastRadius.policyVersion,
    templateVersion: REPORT_TEMPLATE_VERSION,
    wordingPromptVersion: REPORT_WORDING_PROMPT_VERSION,
    model:
      wording === null || modelId === undefined
        ? ({ mode: "deterministic_fallback" } as const)
        : ({ mode: "validated_model_wording", modelId } as const),
    generatedAt: source.generatedAt,
    overallRisk: overallRisk(source),
    overallEvidenceStrength: overallEvidence(source),
    executiveSummary: safeReportText(
      wording?.executiveSummary ?? executiveSummary(source)
    ),
    sections,
    findings,
    coverage: source.coverage,
    verification: source.verification,
    unknowns: findings.filter(({ risk }) => risk === "unknown"),
    exclusions: source.exclusions,
  }
  return assessmentReportViewSchema.parse({
    ...draft,
    id: hashCanonical({
      kind: "assessment-report",
      repository: source.pullRequest.repository,
      pullRequestNumber: source.pullRequest.number,
      headSha: source.pullRequest.headSha,
      graphRevision: source.blastRadius.graphRevision,
      policyVersion: source.blastRadius.policyVersion,
      templateVersion: REPORT_TEMPLATE_VERSION,
      wordingPromptVersion: REPORT_WORDING_PROMPT_VERSION,
      model: draft.model,
      version: 1,
    }),
  })
}

export interface ReportWordingModelPort {
  generateStructured<Output>(request: {
    readonly input: string
    readonly instructions: string
    readonly schemaName: string
    readonly schema: z.ZodType<Output>
    readonly maxOutputTokens: number
    readonly signal?: AbortSignal
  }): Promise<{
    readonly output: Output
    readonly model: string
    readonly usage: {
      readonly inputTokens: number
      readonly outputTokens: number
      readonly totalTokens: number
    }
  }>
}

function wordingInput(source: AssessmentReportSource): string {
  const compact = {
    assessmentId: source.assessmentId,
    executiveSummaryChoices: [
      executiveSummary(source),
      alternateExecutiveSummary(source),
    ],
    findings: source.blastRadius.findings.slice(0, 30).map((finding) => ({
      id: finding.id,
      targetId: finding.targetId ?? null,
      targetKind: finding.targetKind,
      title: finding.title,
      risk: finding.risk,
      evidenceStrength: finding.evidenceStrength,
      evidencePathIds: finding.evidencePathIds,
      scenarioIds: finding.scenarios.map(({ id }) => id),
      caveatIds: finding.caveatIds,
      titleChoices: findingTitleChoices(finding),
      summaryChoices: findingSummaryChoices(finding),
    })),
  }
  return JSON.stringify(compact)
}

export async function generateAssessmentReport(input: {
  readonly source: AssessmentReportSource
  readonly model?: ReportWordingModelPort
  readonly signal?: AbortSignal
}): Promise<AssessmentReportView> {
  const source = assessmentReportSourceSchema.parse(input.source)
  if (input.model === undefined || source.blastRadius.findings.length === 0) {
    return viewFrom(source, null)
  }
  try {
    const result = await input.model.generateStructured({
      input: wordingInput(source),
      instructions:
        "Select executive, title, and summary text verbatim from the supplied choices for a product-aware QA lead. Cite every supplied finding ID and every selected finding's complete evidence-path, scenario, and caveat ID lists. Do not author new prose or IDs.",
      schemaName: "sentinel_assessment_report_wording_v1",
      schema: reportWordingOutputSchema,
      maxOutputTokens: 1_200,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const wording = validateReportWording(source, result.output)
    return viewFrom(source, wording, result.model)
  } catch (error) {
    if (input.signal?.aborted === true) {
      throw input.signal.reason ?? error
    }
    return viewFrom(source, null)
  }
}

function escapeMarkdown(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(/([`*_{}\[\]()#+.!|>~-])/g, "\\$1")
    .replace(/[\r\n]+/g, " ")
}

function heading(title: string) {
  return `## ${title}\n`
}

function findingBlock(finding: AssessmentReportView["findings"][number]) {
  const lines = [
    `### ${escapeMarkdown(finding.risk.toUpperCase())} - ${escapeMarkdown(finding.title)}`,
    "",
    escapeMarkdown(finding.summary),
    "",
    `- Evidence strength: ${finding.evidenceStrength}`,
    `- Changed symbols: ${finding.changedSymbolIds.length}`,
    `- Inspectable paths: ${finding.evidencePaths.length}`,
  ]
  for (const path of finding.evidencePaths) {
    lines.push(
      "",
      `Path \`${path.id}\`: ${path.nodes
        .map(({ kind, title }) => `${escapeMarkdown(title)} (${kind})`)
        .join(" -> ")}`,
      `Evidence: ${path.evidenceIds.map((id) => `\`${id}\``).join(", ")}`
    )
    for (const reference of path.references) {
      lines.push(
        `Reference \`${reference.id}\` (${escapeMarkdown(reference.extractionMethod)})`
      )
      for (const sourceUri of reference.sourceUris) {
        lines.push(
          sourceUri.startsWith("http://") || sourceUri.startsWith("https://")
            ? `- Source: <${sourceUri}>`
            : `- Source: \`${sourceUri.replaceAll("`", "\\`")}\``
        )
      }
      for (const artifactId of reference.artifactIds) {
        lines.push(`- Private artifact: \`${artifactId}\``)
      }
    }
  }
  return lines.join("\n")
}

function verificationLines(view: AssessmentReportView): string[] {
  const lines = [
    `${escapeMarkdown(view.verification.reason)} (status: ${view.verification.status}; version: ${view.verification.version})`,
  ]
  const results = view.verification.results.slice(0, 20)
  for (const result of results) {
    lines.push(
      "",
      `### ${escapeMarkdown(result.status.toUpperCase())} - workflow \`${result.workflowId}\``,
      "",
      `- Completed: ${result.completedAt}`,
      `- Requirements: ${
        result.requirementIds.length === 0
          ? "none recorded"
          : result.requirementIds
              .slice(0, 20)
              .map((id) => `\`${id}\``)
              .join(", ")
      }`
    )
    if ("deploymentUrl" in result) {
      lines.push(`- Trusted head deployment: <${result.deploymentUrl}>`)
    }
    for (const assertion of result.assertions.slice(0, 20)) {
      lines.push(
        `- ${assertion.passed ? "PASS" : "FAIL"}: ${escapeMarkdown(assertion.name)}; evidence: ${assertion.evidenceIds.map((id) => `\`${id}\``).join(", ")}`
      )
    }
    for (const request of result.requests.slice(0, 20)) {
      lines.push(
        `- Request: ${request.method} \`${escapeMarkdown(request.normalizedPath)}\` -> ${request.status}`
      )
    }
    if (result.assertions.length > 20 || result.requests.length > 20) {
      lines.push(
        "- Additional bounded verification detail is available in the dashboard."
      )
    }
  }
  if (view.verification.results.length > results.length) {
    lines.push(
      "",
      `${view.verification.results.length - results.length} additional verification results are available in the dashboard.`
    )
  }
  return lines
}

export function renderAssessmentReportMarkdown(
  viewValue: AssessmentReportView
): string {
  const view = assessmentReportViewSchema.parse(viewValue)
  const ui = view.findings.filter(({ targetKind }) =>
    ["ui-element", "screen"].includes(targetKind)
  )
  const workflows = view.findings.filter(
    ({ targetKind }) => targetKind === "workflow"
  )
  const requirements = view.findings.filter(
    ({ targetKind }) => targetKind === "requirement"
  )
  const markdown = [
    `# Sentinel assessment - PR #${view.pullRequestNumber}`,
    "",
    heading("PR and baseline identity"),
    `- Repository: ${escapeMarkdown(`${view.repository.owner}/${view.repository.name}`)}`,
    `- Pull request: #${view.pullRequestNumber} - ${escapeMarkdown(view.pullRequestTitle)}`,
    `- Base: \`${view.baseSha}\``,
    `- Head: \`${view.headSha}\``,
    `- Graph commit: \`${view.graphCommitSha}\``,
    "",
    heading("Executive risk summary"),
    escapeMarkdown(view.executiveSummary),
    "",
    `Overall predicted risk: **${view.overallRisk.toUpperCase()}**`,
    `Overall evidence strength: **${view.overallEvidenceStrength}**`,
    "",
    heading("Affected product areas"),
    `- UI/screens: ${ui.length}`,
    `- Workflows: ${workflows.length}`,
    `- Requirements: ${requirements.length}`,
    `- Unknown: ${view.unknowns.length}`,
    "",
    heading("Affected UI, screens, and elements"),
    ...(ui.length === 0
      ? ["No UI impact path was established within scope."]
      : ui.map(findingBlock)),
    "",
    heading("Affected workflows"),
    ...(workflows.length === 0
      ? ["No workflow impact path was established within scope."]
      : workflows.map(findingBlock)),
    "",
    heading("Requirements at risk and coverage"),
    ...(requirements.length === 0
      ? ["No requirement impact path was established within scope."]
      : requirements.map(findingBlock)),
    ...view.coverage.flatMap((item) => [
      `- ${escapeMarkdown(item.wording)} (status: ${item.status}; scope: ${escapeMarkdown(item.scope)})`,
    ]),
    "",
    heading("Why items were flagged"),
    ...view.findings.map(findingBlock),
    "",
    heading("Recommended QA scenarios"),
    ...view.findings.flatMap((finding) =>
      finding.scenarios.map(
        (scenario) =>
          `- ${scenario.kind.replaceAll("_", " ")} for ${escapeMarkdown(finding.title)}; checkpoints: ${scenario.checkpointEntityIds.map((id) => `\`${id}\``).join(", ")}`
      )
    ),
    "",
    heading("Verification results"),
    ...verificationLines(view),
    "",
    heading("Unknowns, exclusions, and stale or missing evidence"),
    ...view.unknowns.map(
      (finding) => `- ${escapeMarkdown(finding.summary)} [\`${finding.id}\`]`
    ),
    ...view.exclusions.map((item) => `- Excluded: ${escapeMarkdown(item)}`),
    ...(view.unknowns.length === 0 && view.exclusions.length === 0
      ? ["No additional unknown or excluded scope was recorded."]
      : []),
    "",
    heading("Report generation"),
    `- Generated at: ${view.generatedAt}`,
    `- Report ID: \`${view.id}\``,
    `- Policy: \`${view.policyVersion}\``,
    `- Template: \`${view.templateVersion}\``,
    `- Wording prompt: \`${view.wordingPromptVersion}\``,
    `- Wording mode: ${view.model.mode}`,
    "",
  ].join("\n")
  return markdown
}

export function buildGithubReportCheck(input: {
  readonly view: AssessmentReportView
  readonly actionRequired?: boolean
  readonly infrastructureFailed?: boolean
}) {
  const view = assessmentReportViewSchema.parse(input.view)
  const verificationFailed = view.verification.status === "failed"
  const outcome = input.infrastructureFailed
    ? "infrastructure_failed"
    : input.actionRequired
      ? "action_required"
      : verificationFailed
        ? "verification_failed"
        : view.unknowns.length > 0
          ? "unknown_scope"
          : view.verification.status === "verification_unavailable"
            ? "verification_unavailable"
            : view.overallRisk === "high" || view.overallRisk === "medium"
              ? "predicted_risk"
              : "analysis_succeeded"
  const counts = view.findings.reduce(
    (total, finding) => {
      if (finding.targetKind === "workflow") total.workflows += 1
      if (finding.targetKind === "requirement") total.requirements += 1
      return total
    },
    { workflows: 0, requirements: 0 }
  )
  const lifecycle = githubCheckLifecycleSchema.parse({
    state: "completed" as const,
    outcome,
    title: input.infrastructureFailed
      ? "Sentinel analysis failed"
      : input.actionRequired
        ? "Sentinel assessment needs action"
        : "Sentinel blast radius completed",
    summary: safeReportText(
      `Risk: ${view.overallRisk}. ${counts.workflows} workflows. ${counts.requirements} requirements. Evidence: ${view.overallEvidenceStrength}. Verification: ${view.verification.status}. Open the full Sentinel report for evidence and QA checkpoints.`
    ),
    completedAt: view.generatedAt,
  })
  if (lifecycle.state !== "completed") {
    throw new Error("GitHub report check did not remain completed")
  }
  return lifecycle
}

export interface AssessmentReportPublicationPort {
  publish(input: {
    readonly view: AssessmentReportView
    readonly markdown: string
  }): Promise<{
    readonly disposition: "published" | "existing" | "superseded"
    readonly artifactId: string
  }>
}

export interface AssessmentReportCurrentHeadPort {
  isCurrent(input: {
    readonly assessmentId: string
    readonly headSha: string
  }): Promise<boolean>
}

export interface AssessmentReportRunSourcePort {
  resolve(
    input: { readonly investigation: PrInvestigationResult },
    signal?: AbortSignal
  ): Promise<AssessmentReportSource>
}

export interface AssessmentReportCheckPort {
  publishCheck(input: {
    readonly assessmentId: string
    readonly headSha: string
    readonly lifecycle: GithubCheckLifecycle
  }): Promise<"published" | "sync_pending" | "superseded">
}

export interface AssessmentReportRunFinalizerPort {
  finalize(
    input: { readonly investigation: PrInvestigationResult },
    signal?: AbortSignal
  ): Promise<"published" | "existing" | "superseded">
}

export function createAssessmentReportRunFinalizer(input: {
  readonly source: AssessmentReportRunSourcePort
  readonly currentHead: AssessmentReportCurrentHeadPort
  readonly publisher: AssessmentReportPublicationPort
  readonly checks: AssessmentReportCheckPort
  readonly model?: ReportWordingModelPort
}): AssessmentReportRunFinalizerPort {
  return {
    finalize: async ({ investigation: investigationValue }, signal) => {
      const investigation =
        prInvestigationResultSchema.parse(investigationValue)
      if (investigation.status !== "completed") {
        throw new Error("Only completed PR investigations can produce a report")
      }
      const source = assessmentReportSourceSchema.parse(
        await input.source.resolve({ investigation }, signal)
      )
      if (
        source.assessmentId !== investigation.assessmentId ||
        source.applicationId !== investigation.applicationId ||
        source.runId !== investigation.runId ||
        source.pullRequest.id !== investigation.pullRequest.id ||
        source.pullRequest.headSha !== investigation.pullRequest.headSha ||
        source.blastRadius.graphRevision !== investigation.graphRevision ||
        source.blastRadius.graphCommitSha !== investigation.graphCommitSha
      ) {
        throw new Error("Report source conflicts with its PR investigation")
      }
      const report = await generateAndPublishAssessmentReport({
        source,
        currentHead: input.currentHead,
        publisher: input.publisher,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(signal === undefined ? {} : { signal }),
      })
      if (report.status === "superseded") return "superseded"
      const synchronized = await input.checks.publishCheck({
        assessmentId: source.assessmentId,
        headSha: source.pullRequest.headSha,
        lifecycle: report.check,
      })
      if (synchronized === "sync_pending") {
        throw new Error(
          "Assessment report GitHub check synchronization is pending"
        )
      }
      return synchronized === "published" ? report.status : "superseded"
    },
  }
}

export async function generateAndPublishAssessmentReport(input: {
  readonly source: AssessmentReportSource
  readonly currentHead: AssessmentReportCurrentHeadPort
  readonly publisher: AssessmentReportPublicationPort
  readonly model?: ReportWordingModelPort
  readonly signal?: AbortSignal
}) {
  const source = assessmentReportSourceSchema.parse(input.source)
  if (
    !(await input.currentHead.isCurrent({
      assessmentId: source.assessmentId,
      headSha: source.pullRequest.headSha,
    }))
  ) {
    return { status: "superseded" as const }
  }
  const view = await generateAssessmentReport({
    source,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  const markdown = renderAssessmentReportMarkdown(view)
  if (
    !(await input.currentHead.isCurrent({
      assessmentId: source.assessmentId,
      headSha: source.pullRequest.headSha,
    }))
  ) {
    return { status: "superseded" as const }
  }
  const publication = await input.publisher.publish({ view, markdown })
  if (publication.disposition === "superseded") {
    return { status: "superseded" as const }
  }
  return {
    status: publication.disposition,
    view,
    markdown,
    artifactId: publication.artifactId,
    check: buildGithubReportCheck({ view }),
  }
}
