import {
  MAX_GRAPH_REPLACEMENT_SCOPE,
  createMissionId,
  discoveryMissionSchema,
  hashCanonical,
  refreshChangeSetSchema,
  refreshContextValidationSchema,
  refreshGraphInventorySchema,
  refreshKnowledgeStartInputSchema,
  refreshScopePlanSchema,
  type DiscoveryMission,
  type MissionBudget,
  type RefreshChangedFile,
  type RefreshChangeSet,
  type RefreshContextValidation,
  type RefreshGraphEntity,
  type RefreshGraphInventory,
  type RefreshKnowledgeStartInput,
  type RefreshScopePlan,
} from "@sentinel/contracts"

export class RefreshPlanningError extends Error {
  constructor(
    readonly code:
      | "context_not_ready"
      | "incomplete_change_set"
      | "identity_mismatch"
      | "scope_limit_exceeded"
  ) {
    super(code)
    this.name = "RefreshPlanningError"
  }
}

const budgetKeys = [
  "toolCalls",
  "contentBytes",
  "documentBytes",
  "documentPages",
  "documentSections",
  "sourceLines",
  "repositoryBytes",
  "repositoryFiles",
  "browserActions",
  "modelCalls",
  "modelInputTokens",
  "modelOutputTokens",
  "reconciliationRounds",
  "elapsedMs",
] as const satisfies readonly (keyof MissionBudget)[]

function compareStrings(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"))
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings)
}

function changedPaths(file: RefreshChangedFile): string[] {
  return sorted([
    ...(file.oldPath === undefined ? [] : [file.oldPath]),
    ...(file.newPath === undefined ? [] : [file.newPath]),
  ])
}

function reindexPath(file: RefreshChangedFile): string | undefined {
  return file.operation === "deleted" ? undefined : file.newPath
}

function isDocumentationPath(path: string): boolean {
  return (
    /(^|\/)(docs?|documentation)(\/|$)/i.test(path) ||
    /\.(?:md|mdx|html?|rst|adoc)$/i.test(path)
  )
}

function isOpenApiPath(path: string): boolean {
  const name = path.split("/").at(-1) ?? path
  return /^(?:openapi|swagger)(?:[._-].*)?\.(?:json|ya?ml)$/i.test(name)
}

function isConfigurationPath(
  path: string,
  classifications: readonly string[]
): boolean {
  return (
    classifications.some((value) =>
      ["configuration", "schema"].includes(value)
    ) ||
    /(^|\/)(?:package\.json|tsconfig[^/]*\.json|composer\.json|vite\.config\.[^/]+|next\.config\.[^/]+|playwright\.config\.[^/]+|routes?\/[^/]+)$/i.test(
      path
    )
  )
}

function pathMatches(candidate: string, changed: ReadonlySet<string>): boolean {
  if (changed.has(candidate)) return true
  for (const value of changed) {
    if (
      candidate.startsWith(`${value}/`) ||
      value.startsWith(`${candidate}/`)
    ) {
      return true
    }
  }
  return false
}

function sourceAffected(
  entity: Pick<RefreshGraphEntity, "sourcePaths">,
  changed: ReadonlySet<string>
): boolean {
  return entity.sourcePaths.some((path) => pathMatches(path, changed))
}

function splitBudget(
  budget: MissionBudget,
  missionCount: number
): MissionBudget {
  const split = Object.fromEntries(
    budgetKeys.map((key) => [key, Math.floor(budget[key] / missionCount)])
  ) as unknown as MissionBudget
  return split
}

function mission(input: {
  readonly start: RefreshKnowledgeStartInput
  readonly agent: "documentation" | "code" | "application"
  readonly ordinal: number
  readonly budget: MissionBudget
  readonly repositoryPaths: readonly string[]
  readonly sourceUris: readonly string[]
  readonly seedEvidenceIds: readonly string[]
  readonly allowedHosts: readonly string[]
}): DiscoveryMission {
  const descriptions = {
    documentation: {
      mode: "targeted_requirement_lookup" as const,
      goal: "Refresh requirements affected by changed documentation sources.",
      question:
        "Which current requirements are supported, changed, removed, or unresolved in the refreshed documentation scope?",
      success:
        "Return source-cited current requirement claims and explicitly unresolved removals.",
      tools: [
        "list_document_tree",
        "search_documentation",
        "read_document_section",
        "inspect_linked_sections",
        "submit_requirement_claim",
        "finish_document_mission",
      ],
    },
    code: {
      mode: "implementation_trace" as const,
      goal: "Refresh implementation evidence affected by changed source maps.",
      question:
        "Which current symbols, routes, endpoints, and domain links replace or invalidate the prior implementation evidence?",
      success:
        "Return source-cited current implementation links and explicitly unresolved deleted behavior.",
      tools: [
        "find_definition",
        "find_references",
        "find_endpoint_handler",
        "read_symbol",
        "submit_code_claim",
        "finish_code_mission",
      ],
    },
    application: {
      mode: "flow_recovery" as const,
      goal: "Re-observe workflows made stale by the deployed change.",
      question:
        "Which current screens, interactions, and requests confirm or invalidate the affected workflow evidence?",
      success:
        "Return bounded observations for affected workflows and explicitly unresolved checkpoints.",
      tools: [
        "observe_page",
        "perform_observed_action",
        "navigate_history",
        "finish_application_mission",
      ],
    },
  } as const
  const description = descriptions[input.agent]
  return discoveryMissionSchema.parse({
    schemaVersion: 1,
    id: createMissionId({
      applicationId: input.start.applicationId,
      runId: input.start.runId,
      agent: input.agent,
      mode: description.mode,
      ordinal: input.ordinal,
    }),
    runId: input.start.runId,
    applicationId: input.start.applicationId,
    agent: input.agent,
    mode: description.mode,
    goal: description.goal,
    seedEvidenceIds: input.seedEvidenceIds,
    questions: [description.question],
    scope: {
      repositoryPaths: input.repositoryPaths.slice(0, 100),
      sourceUris: input.sourceUris.slice(0, 100),
      allowedHosts: input.allowedHosts.slice(0, 50),
      allowedTools: description.tools,
      ...(input.agent === "code"
        ? { languages: ["typescript", "tsx", "php"] }
        : {}),
    },
    budget: input.budget,
    successCriteria: [description.success],
  })
}

export interface RefreshScopePlanningInput {
  readonly start: RefreshKnowledgeStartInput
  readonly context: RefreshContextValidation
  readonly changeSet: RefreshChangeSet
  readonly inventory: RefreshGraphInventory
}

export function planRefreshScope(
  inputValue: RefreshScopePlanningInput
): RefreshScopePlan {
  const start = refreshKnowledgeStartInputSchema.parse(inputValue.start)
  const context = refreshContextValidationSchema.parse(inputValue.context)
  const changeSet = refreshChangeSetSchema.parse(inputValue.changeSet)
  const inventory = refreshGraphInventorySchema.parse(inputValue.inventory)
  if (context.status !== "ready") {
    throw new RefreshPlanningError("context_not_ready")
  }
  if (!changeSet.complete) {
    throw new RefreshPlanningError("incomplete_change_set")
  }
  if (
    context.applicationId !== start.applicationId ||
    context.activeCommitSha !== start.activeCommitSha ||
    context.targetCommitSha !== start.targetCommitSha ||
    context.activeGraphRevision !== start.expectedGraphRevision ||
    changeSet.baseSha !== start.activeCommitSha ||
    changeSet.targetSha !== start.targetCommitSha ||
    inventory.applicationId !== start.applicationId ||
    inventory.graphRevision !== start.expectedGraphRevision ||
    inventory.indexedCommitSha !== start.activeCommitSha
  ) {
    throw new RefreshPlanningError("identity_mismatch")
  }

  const allChangedPaths = new Set(
    changeSet.files.flatMap((file) => changedPaths(file))
  )
  const documentationPaths = new Set<string>()
  const typeScriptPaths = new Set<string>()
  const phpPaths = new Set<string>()
  const openApiPaths = new Set<string>()
  const configurationPaths = new Set<string>()
  const removedPaths = new Set<string>()
  const warnings: string[] = changeSet.warnings.map(String)

  for (const file of changeSet.files) {
    if (file.operation === "deleted" || file.operation === "renamed") {
      if (file.oldPath !== undefined) removedPaths.add(file.oldPath)
    }
    const path = reindexPath(file)
    if (path === undefined) continue
    if (isDocumentationPath(path)) documentationPaths.add(path)
    if (/\.tsx?$/i.test(path)) typeScriptPaths.add(path)
    if (/\.php$/i.test(path)) phpPaths.add(path)
    if (isOpenApiPath(path)) openApiPaths.add(path)
    if (isConfigurationPath(path, file.classifications)) {
      configurationPaths.add(path)
    }
    if (
      !isDocumentationPath(path) &&
      !/\.(?:tsx?|php)$/i.test(path) &&
      !isOpenApiPath(path) &&
      !isConfigurationPath(path, file.classifications) &&
      file.classifications.some((value) =>
        ["binary", "generated", "lockfile", "unsupported"].includes(value)
      )
    ) {
      warnings.push(`Changed path ${path} was retained as unresolved scope.`)
    }
  }

  const affected = new Set<string>(
    inventory.entities
      .filter(
        (entity) => entity.stale || sourceAffected(entity, allChangedPaths)
      )
      .map(({ id }) => id)
  )
  let expanded = true
  while (expanded) {
    expanded = false
    for (const entity of inventory.entities) {
      if (
        !affected.has(entity.id) &&
        entity.dependsOnIds.some((id) => affected.has(id))
      ) {
        affected.add(entity.id)
        expanded = true
      }
    }
  }

  const affectedEntities = inventory.entities.filter(({ id }) =>
    affected.has(id)
  )
  const invalidatedLinks = inventory.links.filter(
    (link) =>
      affected.has(link.fromId) ||
      affected.has(link.toId) ||
      link.sourcePaths.some((path) => pathMatches(path, allChangedPaths))
  )
  const invalidatedLinkIds = new Set(invalidatedLinks.map(({ id }) => id))
  const reusableReviewedLinkIds = inventory.links
    .filter(
      (link) =>
        link.reviewState === "accepted" && !invalidatedLinkIds.has(link.id)
    )
    .map(({ id }) => id)
  const reusedEntityIds = inventory.entities
    .filter(
      ({ id }) =>
        !affected.has(id) && String(id) !== String(start.applicationId)
    )
    .map(({ id }) => id)
  const affectedWorkflowIds = affectedEntities
    .filter(({ kind }) => kind === "workflow")
    .map(({ id }) => id)
  const entityById = new Map(
    inventory.entities.map((entity) => [String(entity.id), entity])
  )
  const reassessRequirementIds = sorted([
    ...affectedEntities
      .filter(({ kind }) => kind === "requirement")
      .map(({ id }) => id),
    ...affectedEntities
      .filter(({ kind }) => kind === "workflow")
      .flatMap(({ dependsOnIds }) => dependsOnIds)
      .filter((id) => entityById.get(String(id))?.kind === "requirement"),
    ...inventory.links
      .filter(
        (link) =>
          link.relationship === "COVERED_BY" &&
          affectedWorkflowIds.includes(link.toId)
      )
      .map(({ fromId }) => fromId)
      .filter((id) => entityById.get(String(id))?.kind === "requirement"),
  ])
  const sourceUris = sorted(
    affectedEntities
      .filter(({ kind }) =>
        [
          "document-source",
          "document-page",
          "document-section",
          "requirement",
        ].includes(kind)
      )
      .flatMap(({ sourceUris: values }) => values)
  )
  const priorEvidenceIds = sorted([
    ...affectedEntities.flatMap(({ evidenceIds }) => evidenceIds),
    ...invalidatedLinks.flatMap(({ evidenceIds }) => evidenceIds),
  ]).slice(0, 100)
  const retainedEvidenceIds = sorted(
    inventory.immutableAssessments.flatMap(({ evidenceIds }) => evidenceIds)
  )
  const retainedArtifactIds = sorted(
    inventory.immutableAssessments.flatMap(({ artifactIds }) => artifactIds)
  )
  const immutableAssessmentIds = sorted(
    inventory.immutableAssessments.map(({ assessmentId }) => assessmentId)
  )

  const agentKinds: ("documentation" | "code" | "application")[] = []
  if (
    documentationPaths.size > 0 ||
    affectedEntities.some(({ kind }) =>
      [
        "document-source",
        "document-page",
        "document-section",
        "requirement",
      ].includes(kind)
    )
  ) {
    agentKinds.push("documentation")
  }
  if (
    typeScriptPaths.size > 0 ||
    phpPaths.size > 0 ||
    openApiPaths.size > 0 ||
    configurationPaths.size > 0 ||
    affectedEntities.some(({ kind }) =>
      [
        "code-file",
        "code-symbol",
        "frontend-route",
        "api-endpoint",
        "domain-entity",
      ].includes(kind)
    )
  ) {
    agentKinds.push("code")
  }
  if (
    affectedWorkflowIds.length > 0 ||
    affectedEntities.some(({ kind }) =>
      ["flow-step", "screen", "ui-element"].includes(kind)
    )
  ) {
    agentKinds.push("application")
  }

  const applicationUris = [context.deployment.proof?.publicUrl].filter(
    (value): value is string => value !== undefined
  )
  const applicationHosts = sorted(
    applicationUris
      .filter((value): value is string => value !== undefined)
      .flatMap((value) => {
        try {
          return [new URL(value).hostname]
        } catch {
          return []
        }
      })
  )
  const codePaths = sorted([
    ...typeScriptPaths,
    ...phpPaths,
    ...openApiPaths,
    ...configurationPaths,
  ])
  const perMissionBudget =
    agentKinds.length === 0
      ? undefined
      : splitBudget(start.budget, agentKinds.length)
  const missions = agentKinds.map((agent, ordinal) =>
    mission({
      start,
      agent,
      ordinal,
      budget: perMissionBudget!,
      repositoryPaths:
        agent === "documentation"
          ? sorted(documentationPaths)
          : agent === "code"
            ? codePaths
            : sorted([...codePaths, ...documentationPaths]),
      sourceUris:
        agent === "documentation"
          ? sourceUris
          : agent === "application"
            ? applicationUris
            : [],
      seedEvidenceIds: priorEvidenceIds,
      allowedHosts:
        agent === "application"
          ? applicationHosts
          : agent === "documentation"
            ? sorted(
                sourceUris.flatMap((value) => {
                  try {
                    return [new URL(value).hostname]
                  } catch {
                    return []
                  }
                })
              )
            : [],
    })
  )

  if (affected.size === 0 && changeSet.files.length > 0) {
    warnings.push(
      "No current graph fact matched the changed paths; only the application commit will advance."
    )
  }
  const replacementStableKeys = sorted([
    start.applicationId,
    ...affected,
    ...invalidatedLinkIds,
  ])
  if (replacementStableKeys.length > MAX_GRAPH_REPLACEMENT_SCOPE) {
    throw new RefreshPlanningError("scope_limit_exceeded")
  }
  const draft = {
    schemaVersion: 1 as const,
    applicationId: start.applicationId,
    runId: start.runId,
    activeCommitSha: start.activeCommitSha,
    targetCommitSha: start.targetCommitSha,
    expectedGraphRevision: start.expectedGraphRevision,
    graphRevision: start.graphRevision,
    sourceScope: {
      documentationPaths: sorted(documentationPaths),
      typeScriptPaths: sorted(typeScriptPaths),
      phpPaths: sorted(phpPaths),
      openApiPaths: sorted(openApiPaths),
      configurationPaths: sorted(configurationPaths),
      removedPaths: sorted(removedPaths),
      sourceUris,
    },
    affectedEntityIds: sorted(affected),
    reusedEntityIds: sorted(reusedEntityIds),
    affectedWorkflowIds: sorted(affectedWorkflowIds),
    reassessRequirementIds: sorted(reassessRequirementIds),
    invalidatedLinkIds: sorted(invalidatedLinkIds),
    reusableReviewedLinkIds: sorted(reusableReviewedLinkIds),
    replacementStableKeys,
    missions,
    immutableAssessmentIds,
    retainedEvidenceIds,
    retainedArtifactIds,
    warnings: sorted(warnings),
    requiresPublication: true,
  }
  return refreshScopePlanSchema.parse({
    ...draft,
    id: hashCanonical({ kind: "refresh-scope-plan", version: 1, ...draft }),
  })
}
