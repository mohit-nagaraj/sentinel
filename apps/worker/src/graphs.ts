import {
  CodeExplorerRepository,
  CodeExplorerTools,
  DocumentationExplorerTools,
  DocumentationMapIndex,
  PhpCodeIndex,
  PhpLaravelIndexer,
  createAzureOpenAIModelGateway,
  createPlaywrightBrowserEvidenceRuntime,
  crawlWebDocumentation,
  createTypeScriptIndexQuery,
  documentMapPersistenceView,
  endpointFromFrontendCandidate,
  endpointsFromLaravelRoute,
  indexTypeScriptSource,
  loadAzureOpenAIEnvironment,
  matchRuntimeRequest,
  prepareRepositoryDocumentation,
  startGitHubSourceConnector,
  type DocumentationMap,
  type EndpointEvidence,
} from "@sentinel/adapters"
import {
  applicationIdSchema,
  claimIdSchema,
  codeFileFactSchema,
  codeSymbolFactSchema,
  compatibilityReportSchema,
  contentHashSchema,
  coverageMatrixInputSchema,
  createMissionId,
  createRunScopedEvidenceId,
  createStableKey,
  codeExplorerMissionSchema,
  codeExplorerToolNames,
  discoveryMissionSchema,
  documentationExplorerMissionSchema,
  documentationExplorerToolNames,
  graphPublicationInputSchema,
  hashCanonical,
  onboardingConfigurationSchema,
  persistedTextSchema,
  runIdSchema,
  submittedEvidenceLinkSchema,
  type ApplicationExplorerEvidenceClaim,
  type ApplicationId,
  type CommitSha,
  type EvidenceLink,
  type GraphPublicationNode,
  type LinkEvidenceRecord,
  type MissionBudget,
  type OnboardingConfiguration,
  type RequirementCandidate,
  type SubmittedEvidenceLink,
} from "@sentinel/contracts"
import {
  DurableRunEventSink,
  InMemoryCuratorMissionResultStore,
  InMemoryResumeCoordinator,
  RunDispatchError,
  createApplicationExplorerSpecialist,
  createCodeExplorerSpecialist,
  createCoverageAssessment,
  createEvidenceLinker,
  createEvidenceCurator,
  createCuratorSpecialistDispatcher,
  createDocumentationExplorerSpecialist,
  initializePostgresCheckpointSaver,
  type CompiledRunGraph,
  type GraphRunInput,
  type OrchestrationEvent,
  type OrchestrationEventSink,
  type RunExecutionContext,
  type RunGraphRegistry,
  type RuntimeDependencies,
} from "@sentinel/orchestration"
import {
  ArtifactMetadataRepository,
  ArtifactService,
  DocumentMapRepository,
  KnowledgePublicationRepository,
  Neo4jGraphPublicationRepository,
  PostgresApplicationExplorerSpecialistStore,
  PostgresCodeExplorerSpecialistStore,
  PostgresDocumentationExplorerSpecialistStore,
  PostgresSpecialistToolExecutionCoordinator,
  RunRepository,
  S3PrivateObjectStore,
  SourceRepository,
  TargetSecretService,
  createPostgresDatabase,
  getSharedNeo4jGraphDatabase,
  loadNeo4jEnvironment,
  loadStorageEnvironment,
} from "@sentinel/storage"
import { z } from "zod"

import { logWorkerError, workerLog } from "./logger.ts"
import { createPrAssessmentGraph } from "./pr-assessment-graph.ts"

const GRAPH_NAME = "initialize_knowledge_graph" as const
const MODEL_OUTPUT_TOKENS = 1_024
const DOCUMENTATION_PAGES_PER_MISSION = 8

const applicationRowSchema = z.strictObject({
  stable_key: applicationIdSchema,
  name: z.string().trim().min(1).max(512),
  deployment_url: z.url({ protocol: /^https?$/ }),
  graph_revision: z.coerce.number().int().nonnegative(),
  configuration: onboardingConfigurationSchema,
  compatibility_report: compatibilityReportSchema,
  confirmation_fingerprint: contentHashSchema,
  input_fingerprint: contentHashSchema,
})

type ApplicationRow = z.infer<typeof applicationRowSchema>

function stableRunId(databaseRunId: string) {
  return runIdSchema.parse(`run:${databaseRunId}`)
}

function unsupportedGraph(): CompiledRunGraph {
  const fail = async (): Promise<never> => {
    throw new RunDispatchError(
      "configuration",
      "graph_handler_unconfigured",
      false
    )
  }
  return {
    hasCheckpoint: async () => false,
    hasPendingInterrupt: async () => false,
    start: fail,
    continue: fail,
    resume: fail,
  }
}

function emptyBudget(): MissionBudget {
  return {
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
}

function mergeBudget(limit: MissionBudget, requested: Partial<MissionBudget>) {
  const zero = emptyBudget()
  return Object.fromEntries(
    Object.keys(zero).map((key) => {
      const name = key as keyof MissionBudget
      return [name, Math.min(limit[name], requested[name] ?? zero[name])]
    })
  ) as unknown as MissionBudget
}

function documentationRoots(configuration: OnboardingConfiguration) {
  const repository: string[] = []
  const web: string[] = []
  for (const source of configuration.documentationSources) {
    if (source.startsWith("repository://")) {
      const path = source.slice("repository://".length).replace(/^\/+/, "")
      if (path.length > 0) repository.push(path)
    } else {
      web.push(source)
    }
  }
  return {
    repository: [...new Set(repository)].sort(),
    web: [...new Set(web)].sort(),
  }
}

function documentationMissionScopes(map: DocumentationMap) {
  const pages = [...map.pages].sort((left, right) =>
    left.fact.canonicalUri.localeCompare(right.fact.canonicalUri)
  )
  const scopes: Array<{
    readonly label: string
    readonly sourceUris: readonly string[]
  }> = []
  for (
    let offset = 0;
    offset < pages.length;
    offset += DOCUMENTATION_PAGES_PER_MISSION
  ) {
    const batch = pages.slice(offset, offset + DOCUMENTATION_PAGES_PER_MISSION)
    scopes.push({
      label: batch
        .map(({ fact }) => `${fact.title} (${fact.canonicalUri})`)
        .join("; "),
      sourceUris: [
        map.source.rootUri,
        ...batch.flatMap((page) => [page.sourceUri, page.fact.canonicalUri]),
      ],
    })
  }
  return scopes.length === 0
    ? [{ label: map.source.rootUri, sourceUris: [map.source.rootUri] }]
    : scopes
}

function documentationMapForScope(
  map: DocumentationMap,
  sourceUris: readonly string[]
): DocumentationMap {
  const allowedUris = new Set(sourceUris)
  const selectedPages = map.pages.filter(
    (page) =>
      allowedUris.has(page.sourceUri) || allowedUris.has(page.fact.canonicalUri)
  )
  const pageIds = new Set(selectedPages.map(({ fact }) => fact.id))
  const pages = selectedPages.map((page) => ({
    ...page,
    fact: {
      ...page.fact,
      linkedPageIds: page.fact.linkedPageIds.filter((id) => pageIds.has(id)),
    },
  }))
  const sections = map.sections.filter(({ fact }) => pageIds.has(fact.pageId))
  const links = map.links.filter(
    ({ fromPageId, toPageId }) =>
      pageIds.has(fromPageId) && pageIds.has(toPageId)
  )
  const coverage = {
    attemptedPages: pages.length,
    successfulPages: pages.length,
    failedPages: 0,
    duplicatePages: 0,
    removedPages: 0,
    fetchedBytes: pages.reduce(
      (total, page) => total + Buffer.byteLength(page.sanitizedText, "utf8"),
      0
    ),
    complete: true,
  }
  const mapHash = contentHashSchema.parse(
    hashCanonical({
      coverage,
      failedUris: [],
      links,
      pages: pages.map((page) => page.fact),
      sections: sections.map((section) => ({
        ...section.fact,
        endOffset: section.endOffset,
        sourceUri: section.sourceUri,
        startOffset: section.startOffset,
      })),
    })
  )
  return {
    source: { ...map.source, contentHash: mapHash },
    pages,
    sections,
    links,
    failedUris: [],
    warnings: [],
    coverage,
    mapHash,
  }
}

function publicationNode(
  kind: GraphPublicationNode["kind"],
  fact: unknown,
  provenance: GraphPublicationNode["provenance"],
  extractionMethod: string,
  evidenceIds: readonly string[] = []
): GraphPublicationNode {
  return {
    kind,
    fact,
    provenance,
    extractionMethod,
    evidenceTier: "A",
    evidenceIds: [...evidenceIds],
    reviewState: "not_required",
  } as GraphPublicationNode
}

function uniqueNodes(nodes: readonly GraphPublicationNode[]) {
  const byId = new Map<string, GraphPublicationNode>()
  for (const node of nodes) {
    const id = String(node.fact.id)
    const existing = byId.get(id)
    if (
      existing !== undefined &&
      hashCanonical(existing.fact) !== hashCanonical(node.fact)
    ) {
      throw new Error(`Conflicting graph node ${id}`)
    }
    byId.set(id, existing ?? node)
  }
  return [...byId.values()].sort((left, right) =>
    String(left.fact.id).localeCompare(String(right.fact.id))
  )
}

function createLinkCollector(input: {
  readonly applicationId: string
  readonly runId: string
  readonly graphRevision: number
  readonly commitSha: string
  readonly now: string
}) {
  const links: EvidenceLink[] = []
  const evidence: LinkEvidenceRecord[] = []
  let ordinal = 0

  const add = (
    fromId: string,
    relationship: EvidenceLink["relationship"],
    toId: string,
    extractionMethod: LinkEvidenceRecord["extractionMethod"],
    provenance: LinkEvidenceRecord["provenance"],
    summary: string
  ) => {
    const evidenceId = createRunScopedEvidenceId({
      applicationId: input.applicationId,
      runId: input.runId,
      sourceId: fromId,
      kind: `link_${relationship.toLowerCase()}`,
      ordinal: ordinal++,
    })
    const linkId = createRunScopedEvidenceId({
      applicationId: input.applicationId,
      runId: input.runId,
      sourceId: toId,
      kind: `edge_${relationship.toLowerCase()}`,
      ordinal: ordinal++,
    })
    const binding = { fromId, relationship, toId }
    evidence.push({
      reference: {
        schemaVersion: 1,
        id: evidenceId,
        applicationId: input.applicationId,
        runId: input.runId,
        status: "validated",
        kind: extractionMethod,
        sourceEntityId: fromId,
        capturedAt: input.now,
      },
      provenance,
      extractionMethod,
      bindings: [binding],
      summary,
    } as LinkEvidenceRecord)
    links.push({
      schemaVersion: 1,
      id: linkId,
      applicationId: input.applicationId,
      fromId,
      relationship,
      toId,
      extractionMethod,
      evidenceTier: "A",
      explanation: summary,
      evidenceIds: [evidenceId],
      sourceCommitSha: input.commitSha,
      crawlRunId: input.runId,
      reviewState: "not_required",
      graphRevision: input.graphRevision,
      lastConfirmedAt: input.now,
    } as EvidenceLink)
  }

  return {
    add,
    values: () => ({
      links: links.sort((left, right) =>
        String(left.id).localeCompare(String(right.id))
      ),
      evidence: evidence.sort((left, right) =>
        String(left.reference.id).localeCompare(String(right.reference.id))
      ),
    }),
  }
}

function submittedLinksFromCollected(
  links: readonly EvidenceLink[]
): SubmittedEvidenceLink[] {
  const grouped = new Map<
    string,
    {
      readonly fromId: EvidenceLink["fromId"]
      readonly relationship: EvidenceLink["relationship"]
      readonly toId: EvidenceLink["toId"]
      readonly applicationId: EvidenceLink["applicationId"]
      evidenceIds: string[]
      explanations: string[]
    }
  >()
  for (const link of links) {
    const key = `${link.fromId}\u0000${link.relationship}\u0000${link.toId}`
    const current = grouped.get(key) ?? {
      fromId: link.fromId,
      relationship: link.relationship,
      toId: link.toId,
      applicationId: link.applicationId,
      evidenceIds: [],
      explanations: [],
    }
    current.evidenceIds.push(...link.evidenceIds)
    current.explanations.push(link.explanation)
    grouped.set(key, current)
  }
  return [...grouped.values()]
    .map((group) => {
      const evidenceIds = [...new Set(group.evidenceIds)].sort()
      const explanation = [...new Set(group.explanations)].join(" ")
      const id = claimIdSchema.parse(
        `claim:v1:${hashCanonical({
          applicationId: group.applicationId,
          evidenceIds,
          fromId: group.fromId,
          kind: "baseline_submitted_link",
          relationship: group.relationship,
          toId: group.toId,
        }).slice("sha256:".length)}`
      )
      return submittedEvidenceLinkSchema.parse({
        id,
        applicationId: group.applicationId,
        assertion: "supports",
        evidenceIds,
        explanation,
        fromId: group.fromId,
        relationship: group.relationship,
        toId: group.toId,
      })
    })
    .sort((left, right) => left.id.localeCompare(right.id))
}

async function loadApplication(
  database: ReturnType<typeof createPostgresDatabase>,
  applicationId: string
): Promise<ApplicationRow> {
  const rows = await database.query<Record<string, unknown>>(
    `select application.stable_key, application.name,
            application.deployment_url, application.graph_revision,
            onboarding.configuration, onboarding.compatibility_report,
            onboarding.confirmation_fingerprint, onboarding.input_fingerprint
       from sentinel.applications application
       join sentinel.onboarding_configurations onboarding
         on onboarding.application_id = application.id
      where application.id = $1::uuid`,
    [applicationId]
  )
  const row = rows[0]
  if (row === undefined) throw new Error("Initialization application not found")
  const parsed = applicationRowSchema.parse(row)
  if (parsed.confirmation_fingerprint !== parsed.input_fingerprint) {
    throw new Error("Initialization scope is not confirmed")
  }
  return parsed
}

async function emitStage(
  events: OrchestrationEventSink,
  input: {
    readonly runId: string
    readonly nodeName: string
    readonly phase: "started" | "completed"
    readonly summary: string
    readonly detail?: string
    readonly coverageDelta?: number
  }
) {
  workerLog("info", "initializer_stage", {
    runId: input.runId,
    stage: input.nodeName,
    phase: input.phase,
    summary: input.summary,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    ...(input.coverageDelta === undefined
      ? {}
      : { coverageDelta: input.coverageDelta }),
  })
  const event: OrchestrationEvent = {
    runId: input.runId,
    graphName: GRAPH_NAME,
    nodeName: input.nodeName,
    kind: input.phase === "started" ? "node_started" : "node_completed",
    status: input.phase,
    summary: input.summary,
    reasonCode: `${input.nodeName}_${input.phase}`,
    occurredAt: new Date().toISOString(),
    activity: {
      category: input.coverageDelta === undefined ? "status" : "coverage",
      ...(input.detail === undefined
        ? {}
        : { detail: persistedTextSchema.parse(input.detail) }),
      ...(input.coverageDelta === undefined
        ? {}
        : { coverageDelta: input.coverageDelta }),
    },
  }
  await events.append(event, {
    idempotencyKey: hashCanonical({
      kind: "initialization_stage",
      runId: input.runId,
      nodeName: input.nodeName,
      phase: input.phase,
      occurredAt: event.occurredAt,
    }),
  })
}

function specialistRuntime(input: {
  readonly owner: string
  readonly context: RunExecutionContext
  readonly events: OrchestrationEventSink
}): RuntimeDependencies {
  return {
    owner: input.owner,
    control: { assertActive: async () => input.context.assertActive() },
    events: input.events,
    effects: { execute: async () => input.context.assertActive() },
    resumeAuthorization: { authorize: async () => true },
    resumeCoordinator: new InMemoryResumeCoordinator(),
    executionSignal: input.context.signal,
  }
}

function documentNodes(
  map: DocumentationMap,
  requirements: readonly {
    readonly requirement: RequirementCandidate
  }[]
) {
  const nodes: GraphPublicationNode[] = []
  const sourceProvenance = {
    sourceKind: "document" as const,
    sourceUri: map.source.rootUri,
    contentHash: map.mapHash,
  }
  nodes.push(
    publicationNode(
      "document-source",
      map.source,
      sourceProvenance,
      "document_parse"
    )
  )
  for (const page of map.pages) {
    nodes.push(
      publicationNode(
        "document-page",
        page.fact,
        {
          sourceKind: "document",
          sourceUri: page.fact.canonicalUri,
          contentHash: page.fact.contentHash,
        },
        "document_parse"
      )
    )
  }
  for (const section of map.sections) {
    nodes.push(
      publicationNode(
        "document-section",
        section.fact,
        {
          sourceKind: "document",
          sourceUri: section.sourceUri,
          contentHash: section.fact.contentHash,
        },
        "document_parse"
      )
    )
  }
  for (const { requirement } of requirements) {
    const parsed = z
      .object({
        source: z.object({
          uri: z.string(),
          contentHash: z.string(),
        }),
      })
      .passthrough()
      .parse(requirement)
    nodes.push(
      publicationNode(
        "requirement",
        requirement,
        {
          sourceKind: "document",
          sourceUri: parsed.source.uri,
          contentHash: parsed.source.contentHash,
        } as GraphPublicationNode["provenance"],
        "validated_requirement_extraction"
      )
    )
  }
  return nodes
}

function addDocumentLinks(
  map: DocumentationMap,
  requirements: readonly {
    readonly requirement: RequirementCandidate
  }[],
  collector: ReturnType<typeof createLinkCollector>
) {
  const provenance = {
    sourceKind: "document" as const,
    sourceUri: map.source.rootUri,
    contentHash: map.mapHash,
  }
  for (const page of map.pages) {
    collector.add(
      map.source.id,
      "HAS_PAGE",
      page.fact.id,
      "document_parse",
      provenance,
      "The prepared documentation map contains this page."
    )
    for (const sectionId of page.sectionIds) {
      collector.add(
        page.fact.id,
        "HAS_SECTION",
        sectionId,
        "document_parse",
        provenance,
        "The prepared page contains this exact section."
      )
    }
  }
  for (const edge of map.links) {
    collector.add(
      edge.fromPageId,
      "LINKS_TO",
      edge.toPageId,
      "sanitized_link_map",
      provenance,
      "The sanitized documentation page links to this page."
    )
  }
  for (const { requirement } of requirements) {
    collector.add(
      requirement.source.sectionId,
      "STATES",
      requirement.id,
      "cited_excerpt",
      provenance,
      "The exact cited excerpt states this testable requirement."
    )
    collector.add(
      requirement.source.sectionId,
      "STATES",
      requirement.id,
      "validated_requirement_extraction",
      provenance,
      "The cited section states this testable requirement."
    )
  }
}

function addCompleteEvidencePath(input: {
  readonly applicationId: ApplicationId
  readonly runId: ReturnType<typeof stableRunId>
  readonly graphRevision: number
  readonly configuration: OnboardingConfiguration
  readonly requirement: RequirementCandidate
  readonly claims: readonly ApplicationExplorerEvidenceClaim[]
  readonly endpoints: readonly EndpointEvidence[]
  readonly nodes: GraphPublicationNode[]
  readonly collector: ReturnType<typeof createLinkCollector>
  readonly now: string
}): boolean {
  const workflows = input.claims.filter(
    (
      claim
    ): claim is Extract<
      ApplicationExplorerEvidenceClaim,
      { claimKind: "workflow" }
    > => claim.claimKind === "workflow"
  )
  const steps = input.claims.filter(
    (
      claim
    ): claim is Extract<
      ApplicationExplorerEvidenceClaim,
      { claimKind: "flow_step" }
    > => claim.claimKind === "flow_step"
  )
  const elements = input.claims.filter(
    (
      claim
    ): claim is Extract<
      ApplicationExplorerEvidenceClaim,
      { claimKind: "ui_element" }
    > => claim.claimKind === "ui_element"
  )
  const requests = input.claims.filter(
    (
      claim
    ): claim is Extract<
      ApplicationExplorerEvidenceClaim,
      { claimKind: "runtime_request" }
    > => claim.claimKind === "runtime_request"
  )
  for (const step of steps) {
    const workflow = workflows.find(
      (candidate) => candidate.fact.id === step.fact.workflowId
    )
    const element = elements.find(
      (candidate) =>
        candidate.fact.screenId === step.before.screenId &&
        (step.action.role === undefined ||
          candidate.fact.role === step.action.role) &&
        (step.action.name === undefined ||
          candidate.fact.accessibleName === step.action.name)
    )
    const request = requests.find((candidate) =>
      step.networkRequestIds.includes(candidate.request.requestId)
    )
    if (
      workflow === undefined ||
      element === undefined ||
      request === undefined
    ) {
      continue
    }
    const match = matchRuntimeRequest(
      {
        applicationId: input.applicationId,
        method: request.request.method,
        url: request.request.normalizedPath,
        sourceHash: request.request.requestId,
        observedAt: request.request.startedAt,
      },
      input.endpoints
    )
    if (match.kind !== "exact") continue
    const endpointEvidence = input.endpoints.find(
      (candidate) =>
        candidate.endpoint.id === match.endpoint.id &&
        candidate.handler?.symbolId !== undefined
    )
    if (endpointEvidence === undefined) continue
    const handlerId = endpointEvidence.handler?.symbolId
    const handlerRepository = endpointEvidence.provenance.repository
    const handlerCommitSha = endpointEvidence.provenance.commitSha
    if (
      handlerId === undefined ||
      handlerRepository === undefined ||
      handlerCommitSha === undefined
    ) {
      continue
    }
    const provenance = {
      sourceKind: "browser" as const,
      sourceUri: input.configuration.deploymentUrl,
      observedAt: input.now,
    }
    input.collector.add(
      input.requirement.id,
      "COVERED_BY",
      workflow.fact.id,
      "validated_requirement_extraction",
      {
        sourceKind: "document",
        sourceUri: input.requirement.source.uri,
        contentHash: input.requirement.source.contentHash,
      },
      "The targeted browser mission originated from this exact cited requirement."
    )
    input.collector.add(
      input.requirement.id,
      "COVERED_BY",
      workflow.fact.id,
      "browser_transition",
      provenance,
      "The documentation-derived mission observed this workflow within the approved application scope."
    )
    input.collector.add(
      step.fact.id,
      "ACTS_ON",
      element.fact.id,
      "locator_action",
      provenance,
      "The observed browser transition acted on this accessibility control."
    )
    input.collector.add(
      element.fact.id,
      "TRIGGERS_API",
      match.endpoint.id,
      "runtime_request_match",
      provenance,
      "The action-aligned request window matched this indexed endpoint."
    )
    input.collector.add(
      match.endpoint.id,
      "HANDLED_BY",
      handlerId,
      "laravel_route_action",
      {
        sourceKind: "repository",
        repository: handlerRepository,
        commitSha: handlerCommitSha,
        contentHash: endpointEvidence.provenance.sourceHash,
      },
      "The indexed Laravel route resolves to this handler symbol."
    )
    const assessment = createCoverageAssessment({
      schemaVersion: 1,
      applicationId: input.applicationId,
      requirementId: input.requirement.id,
      runId: input.runId,
      graphRevision: input.graphRevision,
      scope: {
        summary: persistedTextSchema.parse(`Observed ${workflow.fact.name}`),
        missionIds: [workflow.missionId],
        workflowIds: [workflow.fact.id],
        screenIds: [...new Set([step.before.screenId, step.after.screenId])],
        exploredRoutes: [],
      },
      revisionContext: {
        requirementSourceHash: input.requirement.source.contentHash,
        crawlConfigurationHash: hashCanonical(input.configuration.crawl),
        authenticationRevision: input.configuration.authentication.revision,
      },
      environment: {
        authentication:
          input.configuration.authentication.method === "none"
            ? "not_required"
            : "configured",
        testData:
          input.configuration.testDataSetupReference === undefined
            ? "not_required"
            : "configured",
      },
      evaluationRequested: true,
      expectedCheckpointCount: 1,
      observedCheckpointCount: 1,
      attemptSummary: persistedTextSchema.parse(
        "A safe browser transition and its matched runtime request were observed."
      ),
      attemptEvidenceIds: step.evidenceIds,
      supportingEvidenceIds: step.evidenceIds,
      blockers: [],
      ambiguities: [],
      evaluatedAt: input.now,
    })
    input.nodes.push(
      publicationNode(
        "coverage-assessment",
        assessment.graphFact,
        { sourceKind: "system", observedAt: input.now },
        "coverage_evaluator"
      )
    )
    input.collector.add(
      input.requirement.id,
      "HAS_ASSESSMENT",
      assessment.graphFact.id,
      "coverage_evaluator",
      { sourceKind: "system", observedAt: input.now },
      assessment.graphFact.wording
    )
    return true
  }
  return false
}

function addApplicationClaims(
  claims: readonly ApplicationExplorerEvidenceClaim[],
  nodes: GraphPublicationNode[],
  collector: ReturnType<typeof createLinkCollector>,
  deploymentUrl: string,
  observedAt: string
) {
  const provenance = {
    sourceKind: "browser" as const,
    sourceUri: deploymentUrl,
    observedAt,
  }
  const workflows = new Map<
    string,
    Extract<ApplicationExplorerEvidenceClaim, { claimKind: "workflow" }>
  >()
  const steps = new Map<
    string,
    Extract<ApplicationExplorerEvidenceClaim, { claimKind: "flow_step" }>
  >()
  const screens = new Map<
    string,
    Extract<ApplicationExplorerEvidenceClaim, { claimKind: "screen" }>
  >()
  for (const claim of claims) {
    if (claim.claimKind === "runtime_request") continue
    const kind = claim.claimKind === "flow_step" ? "flow-step" : claim.claimKind
    nodes.push(
      publicationNode(
        kind as GraphPublicationNode["kind"],
        claim.fact,
        provenance,
        claim.claimKind === "flow_step"
          ? "browser_transition"
          : claim.claimKind === "ui_element"
            ? "accessibility_snapshot"
            : "browser_transition",
        claim.evidenceIds
      )
    )
    if (claim.claimKind === "workflow") workflows.set(claim.fact.id, claim)
    if (claim.claimKind === "flow_step") steps.set(claim.fact.id, claim)
    if (claim.claimKind === "screen") screens.set(claim.fact.id, claim)
  }
  for (const workflow of workflows.values()) {
    const ordered = workflow.stepIds
      .map((id) => steps.get(id))
      .filter(
        (
          step
        ): step is Extract<
          ApplicationExplorerEvidenceClaim,
          { claimKind: "flow_step" }
        > => step !== undefined
      )
      .sort((left, right) => left.fact.ordinal - right.fact.ordinal)
    for (const step of ordered) {
      collector.add(
        workflow.fact.id,
        "HAS_STEP",
        step.fact.id,
        "crawl_record",
        provenance,
        "The observed workflow contains this browser transition."
      )
      collector.add(
        step.fact.id,
        "ON_SCREEN",
        step.after.screenId,
        "browser_transition",
        provenance,
        "The transition reached this observed screen."
      )
    }
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]
      const current = ordered[index]
      if (previous === undefined || current === undefined) continue
      collector.add(
        previous.fact.id,
        "NEXT",
        current.fact.id,
        "browser_transition",
        provenance,
        "The observed transitions occurred consecutively."
      )
    }
  }
  for (const claim of claims) {
    if (claim.claimKind !== "ui_element" || !screens.has(claim.fact.screenId)) {
      continue
    }
    collector.add(
      claim.fact.screenId,
      "CONTAINS",
      claim.fact.id,
      "accessibility_snapshot",
      provenance,
      "The accessibility snapshot contains this visible control."
    )
  }
}

function indexNodes(input: {
  readonly typescript: Awaited<ReturnType<typeof indexTypeScriptSource>>
  readonly php: readonly Awaited<
    ReturnType<PhpLaravelIndexer["indexCheckout"]>
  >[]
  readonly endpoints: readonly EndpointEvidence[]
  readonly repository: {
    readonly host: string
    readonly owner: string
    readonly name: string
  }
  readonly applicationId: ApplicationId
  readonly commitSha: CommitSha
}) {
  const nodes: GraphPublicationNode[] = []
  for (const envelope of input.typescript.facts) {
    if (envelope.factKind === "code_reference") continue
    const kind = envelope.factKind.replaceAll("_", "-")
    const fact =
      envelope.factKind === "code_symbol"
        ? { ...envelope.fact, schemaVersion: 1 as const }
        : envelope.fact
    nodes.push(
      publicationNode(
        kind as GraphPublicationNode["kind"],
        fact,
        envelope.provenance,
        envelope.extractor.name
      )
    )
  }
  for (const php of input.php) {
    for (const file of php.files) {
      const fileId = createStableKey({
        kind: "code-file",
        applicationId: input.applicationId,
        repository: input.repository,
        commitSha: input.commitSha,
        path: file.path,
      })
      const provenance = {
        sourceKind: "repository" as const,
        repository: input.repository,
        commitSha: input.commitSha,
        contentHash: file.contentHash,
      }
      nodes.push(
        publicationNode(
          "code-file",
          codeFileFactSchema.parse({
            id: fileId,
            applicationId: input.applicationId,
            repository: input.repository,
            commitSha: input.commitSha,
            path: file.path,
            language: "php",
            contentHash: file.contentHash,
          }),
          provenance,
          "php_laravel_indexer"
        )
      )
      for (const symbol of file.symbols) {
        const kind = (() => {
          if (
            [
              "action",
              "controller",
              "handler",
              "service",
              "repository",
            ].includes(symbol.role)
          ) {
            return symbol.role
          }
          if (symbol.kind === "function" || symbol.kind === "method")
            return symbol.kind
          if (["class", "interface", "trait", "enum"].includes(symbol.kind))
            return "class"
          return "module"
        })()
        nodes.push(
          publicationNode(
            "code-symbol",
            codeSymbolFactSchema.parse({
              schemaVersion: 1,
              id: symbol.id,
              applicationId: input.applicationId,
              repository: input.repository,
              commitSha: input.commitSha,
              language: "php",
              kind,
              qualifiedName: symbol.qualifiedName,
              filePath: file.path,
              range: {
                startLine: symbol.range.startLine,
                endLine: symbol.range.endLine,
              },
            }),
            provenance,
            "php_laravel_indexer"
          )
        )
      }
    }
  }
  for (const endpoint of input.endpoints) {
    nodes.push(
      publicationNode(
        "api-endpoint",
        {
          schemaVersion: 1,
          id: endpoint.endpoint.id,
          applicationId: endpoint.endpoint.applicationId,
          method: endpoint.endpoint.method,
          normalizedPath: endpoint.endpoint.normalizedPath,
          ...(endpoint.operation ?? {}),
          sourceHash: endpoint.provenance.sourceHash,
        },
        {
          sourceKind: "repository",
          repository: input.repository,
          commitSha: input.commitSha,
          contentHash: endpoint.provenance.sourceHash,
        },
        endpoint.sourceKind === "laravel"
          ? "laravel_route_action"
          : "frontend_http_call"
      )
    )
  }
  return nodes
}

async function createInitializeGraph(input: {
  readonly databaseUrl: string
  readonly workerId: string
  readonly checkpointer: Awaited<
    ReturnType<typeof initializePostgresCheckpointSaver>
  >
}): Promise<CompiledRunGraph> {
  const database = createPostgresDatabase(input.databaseUrl, {
    maxConnections: 1,
  })
  const runs = new RunRepository(database)
  const secrets = new TargetSecretService(database)
  const documentMaps = new DocumentMapRepository(database)
  const knowledgePublications = new KnowledgePublicationRepository(database)
  const sources = new SourceRepository(database)
  const storageEnvironment = loadStorageEnvironment(process.env)
  const artifactService = new ArtifactService(
    storageEnvironment.SUPABASE_STORAGE_BUCKET,
    new S3PrivateObjectStore(storageEnvironment),
    new ArtifactMetadataRepository(database)
  )
  const publisher = new Neo4jGraphPublicationRepository(
    getSharedNeo4jGraphDatabase(loadNeo4jEnvironment(process.env))
  )

  const execute = async (
    graphInput: GraphRunInput,
    context: RunExecutionContext
  ) => {
    const runId = stableRunId(graphInput.runId)
    workerLog("info", "neo4j_bootstrap_started", { runId })
    try {
      await publisher.bootstrap()
      workerLog("info", "neo4j_bootstrap_completed", { runId })
    } catch (error) {
      logWorkerError("neo4j_bootstrap_failed", error, { runId })
      throw error
    }
    const inputFingerprint = contentHashSchema.parse(
      graphInput.configurationFingerprint
    )
    const priorEvents = await runs.listEvents(graphInput.runId)
    const events = new DurableRunEventSink(
      (event, key) => runs.appendEvent(event, key),
      priorEvents.length
    )
    const row = await loadApplication(database, graphInput.applicationId)
    const applicationId = row.stable_key
    const specialistScope = {
      applicationDatabaseId: graphInput.applicationId,
      applicationStableId: applicationId,
      runDatabaseId: graphInput.runId,
      runStableId: runId,
    }
    const documentationStore = new PostgresDocumentationExplorerSpecialistStore(
      database,
      specialistScope
    )
    const codeStore = new PostgresCodeExplorerSpecialistStore(
      database,
      specialistScope
    )
    const applicationStore = new PostgresApplicationExplorerSpecialistStore(
      database,
      specialistScope
    )
    const executionCoordinator = new PostgresSpecialistToolExecutionCoordinator(
      database,
      specialistScope
    )
    const configuration = row.configuration
    const commitSha = row.compatibility_report.resolvedCommitSha
    if (commitSha === undefined) {
      throw new Error("Confirmed initialization has no immutable commit")
    }
    if (
      graphInput.configurationFingerprint !== row.input_fingerprint ||
      Object.keys(graphInput.payload).length !== 0
    ) {
      throw new Error("Initialization command does not match confirmed scope")
    }
    const now = new Date().toISOString()
    const graphRevision = row.graph_revision + 1
    const nodes: GraphPublicationNode[] = [
      publicationNode(
        "application",
        {
          id: applicationId,
          applicationId,
          name: row.name,
          indexedCommitSha: commitSha,
        },
        { sourceKind: "system", observedAt: now },
        "crawl_record"
      ),
    ]
    const collector = createLinkCollector({
      applicationId,
      runId,
      graphRevision,
      commitSha,
      now,
    })

    await emitStage(events, {
      runId,
      nodeName: "resolve_repository",
      phase: "started",
      summary: "Resolving the confirmed repository revision",
      detail: `${configuration.repository.url} at ${commitSha.slice(0, 12)}`,
    })
    await context.assertActive()
    const githubToken = process.env["GITHUB_TOKEN"]?.trim()
    const connector = await startGitHubSourceConnector({
      ...(githubToken === undefined || githubToken.length === 0
        ? {}
        : { token: githubToken }),
      limits: {
        maxFiles: Math.min(graphInput.budget.repositoryFiles, 200_000),
        maxTotalBytes: Math.min(
          graphInput.budget.repositoryBytes,
          2_000_000_000
        ),
        maxFileBytes: 16 * 1_024 * 1_024,
        timeoutMs: Math.min(graphInput.budget.elapsedMs, 10 * 60_000),
      },
    })
    const resolved = await connector.resolveCommit(
      configuration.repository.url,
      commitSha,
      context.signal
    )
    context.registerCleanup(() => resolved.checkout.dispose())
    const snapshot = resolved.checkout.snapshots.get("source")
    if (snapshot === undefined)
      throw new Error("Source checkout is unavailable")
    await emitStage(events, {
      runId,
      nodeName: "resolve_repository",
      phase: "completed",
      summary: "Immutable repository checkout prepared",
      detail: `${snapshot.metadata.fileCount} files across ${snapshot.metadata.totalBytes} bytes`,
    })

    const roots = documentationRoots(configuration)
    const maps: DocumentationMap[] = []
    await emitStage(events, {
      runId,
      nodeName: "map_documentation",
      phase: "started",
      summary: "Crawling all configured documentation sources",
      detail: `${roots.web.length} web source(s) and ${roots.repository.length} repository root(s)`,
    })
    if (roots.repository.length > 0) {
      maps.push(
        await prepareRepositoryDocumentation({
          applicationId,
          repository: resolved.repository.repository,
          snapshot,
          roots: roots.repository,
          maxPages: Math.min(graphInput.budget.documentPages, 500),
          maxTotalBytes: Math.min(
            graphInput.budget.documentBytes,
            32 * 1_024 * 1_024
          ),
          timeoutMs: Math.min(graphInput.budget.elapsedMs, 120_000),
        })
      )
    }
    for (const root of roots.web) {
      await context.assertActive()
      maps.push(
        await crawlWebDocumentation({
          applicationId,
          roots: [root],
          maxPages: Math.max(
            1,
            Math.min(
              100,
              Math.floor(graphInput.budget.documentPages / roots.web.length)
            )
          ),
          maxTotalBytes: Math.max(
            1,
            Math.min(
              16 * 1_024 * 1_024,
              Math.floor(graphInput.budget.documentBytes / roots.web.length)
            )
          ),
          timeoutMs: Math.min(graphInput.budget.elapsedMs, 180_000),
          requestTimeoutMs: 20_000,
          maxRequestRetries: 1,
          signal: context.signal,
        })
      )
    }
    for (const map of maps) {
      await documentMaps.replace(
        graphInput.applicationId,
        documentMapPersistenceView(map)
      )
      await sources.upsert({
        applicationId: graphInput.applicationId,
        stableKey: map.source.id,
        kind: "documentation",
        uri: map.source.rootUri,
        status: map.coverage.complete ? "ready" : "warning",
        contentHash: map.mapHash,
        secretReference: null,
      })
    }
    await emitStage(events, {
      runId,
      nodeName: "map_documentation",
      phase: "completed",
      summary: "Documentation maps prepared",
      detail: `${maps.reduce((total, map) => total + map.pages.length, 0)} pages and ${maps.reduce((total, map) => total + map.sections.length, 0)} sections`,
      coverageDelta: maps.reduce(
        (total, map) => total + map.sections.length,
        0
      ),
    })

    const model = createAzureOpenAIModelGateway(
      loadAzureOpenAIEnvironment(process.env),
      {
        maxInputCharacters: 32_000,
        maxOutputTokens: MODEL_OUTPUT_TOKENS,
        maxTools: 16,
        maxToolCalls: 1,
        maxToolOutputCharacters: 32_768,
        timeoutMs: 30_000,
        maxRetries: 1,
      }
    )
    const runtime = specialistRuntime({
      owner: input.workerId,
      context,
      events,
    })
    const documentationRequirements: Array<{
      readonly requirement: RequirementCandidate
      readonly capability: string
    }> = []
    await emitStage(events, {
      runId,
      nodeName: "discover_requirements",
      phase: "started",
      summary: "Extracting cited requirements from every documentation map",
    })
    const runDocumentationMission = async (
      map: DocumentationMap,
      mission: ReturnType<typeof documentationExplorerMissionSchema.parse>
    ) =>
      createDocumentationExplorerSpecialist({
        mission,
        model,
        tools: new DocumentationExplorerTools(
          new DocumentationMapIndex(map),
          mission,
          {
            maxResultsPerTool: DOCUMENTATION_PAGES_PER_MISSION,
            maxSectionsPerPage: 25,
            maxSectionCharacters: 4_096,
            maxContentBytesPerTool: 65_536,
          }
        ),
        store: documentationStore,
        executionCoordinator,
        runtime,
        checkpointer: input.checkpointer,
        options: {
          maxIterations: 40,
          maxResultsPerTool: DOCUMENTATION_PAGES_PER_MISSION,
          maxTotalResultItems: 2_000,
        },
      }).service.start()
    let documentationMissionOrdinal = 0
    for (const map of maps) {
      for (const scope of documentationMissionScopes(map)) {
        await context.assertActive()
        const ordinal = documentationMissionOrdinal++
        const missionMap = documentationMapForScope(map, scope.sourceUris)
        const mission = documentationExplorerMissionSchema.parse({
          schemaVersion: 1,
          id: createMissionId({
            applicationId,
            runId,
            agent: "documentation",
            mode: "baseline_discovery",
            ordinal,
          }),
          runId,
          applicationId,
          agent: "documentation",
          mode: "baseline_discovery",
          goal: `Discover every atomic, testable product behavior in this documentation area: ${scope.label}`,
          seedEvidenceIds: [],
          questions: [
            `Which user-visible and operational behaviors are explicitly documented by these pages: ${scope.label}?`,
          ],
          scope: {
            repositoryPaths: [],
            sourceUris: [...scope.sourceUris],
            allowedHosts:
              map.source.kind === "web"
                ? [new URL(map.source.rootUri).hostname]
                : [],
            allowedTools: [...documentationExplorerToolNames],
          },
          budget: mergeBudget(graphInput.budget, {
            toolCalls: 12,
            contentBytes: 750_000,
            documentBytes: 300_000,
            documentPages: 100,
            documentSections: 1_000,
            modelCalls: 12,
            modelInputTokens: 200_000,
            modelOutputTokens: 16_000,
            elapsedMs: 300_000,
          }),
          successCriteria: [
            "Return atomic behavior backed by exact section citations and explicit exclusions for unsupported claims.",
          ],
        })
        const result = await runDocumentationMission(missionMap, mission)
        workerLog("info", "documentation_mission_completed", {
          runId,
          missionId: mission.id,
          source: map.source.rootUri,
          status: result.documentationMission.status,
          stopReason: result.documentationMission.stopReason.code,
          requirements: result.documentationMission.requirements.length,
          toolCalls: result.documentationMission.budgetUsed.toolCalls,
          modelCalls: result.documentationMission.budgetUsed.modelCalls,
        })
        const requirements = [...result.documentationMission.requirements]
        documentationRequirements.push(
          ...requirements.map((item) => ({
            requirement: item.requirement,
            capability: item.requirement.capability,
          }))
        )
        nodes.push(...documentNodes(map, requirements))
        addDocumentLinks(map, requirements, collector)
      }
    }
    const uniqueDocumentationRequirements = [
      ...new Map(
        documentationRequirements.map((item) => [item.requirement.id, item])
      ).values(),
    ]
    if (documentationRequirements.length === 0) {
      throw new Error(
        "Documentation exploration retained no exact cited requirements"
      )
    }
    await emitStage(events, {
      runId,
      nodeName: "discover_requirements",
      phase: "completed",
      summary: "Cited requirement discovery completed",
      detail: `${uniqueDocumentationRequirements.length} exact requirements retained across ${documentationMissionOrdinal} focused mission(s)`,
      coverageDelta: uniqueDocumentationRequirements.length,
    })

    await emitStage(events, {
      runId,
      nodeName: "index_code",
      phase: "started",
      summary: "Indexing every approved repository root",
      detail: row.compatibility_report.proposedScope.repositoryPaths.join(", "),
    })
    const repositoryPaths =
      row.compatibility_report.proposedScope.repositoryPaths
    workerLog("info", "typescript_index_started", {
      runId,
      repositoryPaths,
    })
    const typescript = await indexTypeScriptSource({
      reader: snapshot,
      applicationId,
      runId,
      repository: resolved.repository.repository,
      commitSha,
      roots: repositoryPaths,
      signal: context.signal,
      limits: {
        timeoutMs: Math.min(graphInput.budget.elapsedMs, 8 * 60_000),
        maxTotalBytes: Math.min(
          graphInput.budget.repositoryBytes,
          512 * 1_024 * 1_024
        ),
        maxFiles: Math.min(graphInput.budget.repositoryFiles, 50_000),
        maxTotalNodes: 40_000_000,
      },
    })
    workerLog("info", "typescript_index_completed", {
      runId,
      files: typescript.files.length,
      symbols: typescript.symbols.length,
      apiCandidates: typescript.apiCallCandidates.length,
    })
    const phpPaths = snapshot
      .enumerate()
      .filter(
        (entry) =>
          entry.kind === "file" &&
          entry.path.endsWith(".php") &&
          repositoryPaths.some(
            (root) => entry.path === root || entry.path.startsWith(`${root}/`)
          )
      )
      .map((entry) => entry.path)
    const phpIndexer = new PhpLaravelIndexer({
      limits: {
        maxFiles: 10_000,
        maxTotalBytes: 256 * 1_024 * 1_024,
        maxFacts: 1_000_000,
        maxRequestBytes: 4 * 1_024 * 1_024,
        maxOutputBytes: 256 * 1_024 * 1_024,
        timeoutMs: Math.min(graphInput.budget.elapsedMs, 8 * 60_000),
      },
    })
    workerLog("info", "php_index_started", {
      runId,
      files: phpPaths.length,
    })
    const php = [
      await phpIndexer.indexCheckout(snapshot, phpPaths, {
        applicationId,
        repository: resolved.repository.repository,
        commitSha,
      }),
    ]
    workerLog("info", "php_index_completed", {
      runId,
      files: php.reduce((total, index) => total + index.files.length, 0),
      symbols: php.reduce(
        (total, index) => total + index.summary.symbolCount,
        0
      ),
      routes: php.reduce(
        (total, index) =>
          total +
          index.files.reduce(
            (fileTotal, file) => fileTotal + file.routes.length,
            0
          ),
        0
      ),
    })
    const endpoints: EndpointEvidence[] = []
    for (const candidate of typescript.apiCallCandidates) {
      const file = typescript.files.find(
        ({ path }) => path === candidate.filePath
      )
      if (file === undefined) continue
      endpoints.push(
        ...endpointFromFrontendCandidate({
          applicationId,
          repository: resolved.repository.repository,
          commitSha,
          indexerVersion: typescript.indexerVersion,
          contentHash: file.contentHash,
          candidate,
        }).endpoints
      )
    }
    for (const phpIndex of php) {
      for (const file of phpIndex.files) {
        for (const route of file.routes) {
          endpoints.push(
            ...endpointsFromLaravelRoute({
              response: phpIndex,
              file,
              route,
            }).endpoints
          )
        }
      }
    }
    nodes.push(
      ...indexNodes({
        typescript,
        php,
        endpoints,
        repository: resolved.repository.repository,
        applicationId,
        commitSha,
      })
    )
    const checkoutEndpoint = endpoints.find(
      ({ endpoint, sourceKind }) =>
        sourceKind === "laravel" &&
        endpoint.method === "POST" &&
        endpoint.normalizedPath.includes("/public/events/") &&
        endpoint.normalizedPath.endsWith("/order")
    )
    if (checkoutEndpoint === undefined) {
      throw new Error("Indexed checkout order endpoint is unavailable")
    }
    const codeMission = codeExplorerMissionSchema.parse({
      schemaVersion: 1,
      id: createMissionId({
        applicationId,
        runId,
        agent: "code",
        mode: "implementation_trace",
        ordinal: 0,
      }),
      runId,
      applicationId,
      agent: "code",
      mode: "implementation_trace",
      goal: `Trace the attendee checkout implementation for POST ${checkoutEndpoint.endpoint.normalizedPath}.`,
      seedEvidenceIds: [],
      questions: [
        "Which frontend symbols call this checkout endpoint?",
        "Which Laravel route action, handler, and repository implement it?",
      ],
      scope: {
        repositoryPaths,
        languages: ["typescript", "tsx", "php"],
        sourceUris: [],
        allowedHosts: [],
        allowedTools: [...codeExplorerToolNames],
      },
      budget: mergeBudget(graphInput.budget, {
        toolCalls: 20,
        contentBytes: 1_000_000,
        sourceLines: 2_000,
        repositoryBytes: 1_000_000,
        repositoryFiles: 500,
        modelCalls: 20,
        modelInputTokens: 200_000,
        modelOutputTokens: 20_000,
        elapsedMs: 300_000,
      }),
      successCriteria: [
        "Return a source-cited frontend and backend checkout path, or explicit unresolved boundaries.",
      ],
    })
    const primaryPhpIndex = php[0]
    if (primaryPhpIndex === undefined) {
      throw new Error("PHP source index is unavailable")
    }
    const codeTools = new CodeExplorerTools(
      new CodeExplorerRepository({
        applicationId,
        runId,
        typescript: {
          index: typescript,
          query: createTypeScriptIndexQuery(typescript, snapshot),
        },
        php: { index: new PhpCodeIndex(primaryPhpIndex), snapshot },
        endpoints,
      }),
      codeMission
    )
    const codeSpecialist = createCodeExplorerSpecialist({
      mission: codeMission,
      model,
      tools: codeTools,
      store: codeStore,
      executionCoordinator,
      runtime,
      checkpointer: input.checkpointer,
      options: { maxIterations: 30, maxTotalResultItems: 2_000 },
    })
    workerLog("info", "code_mission_started", {
      runId,
      missionId: codeMission.id,
    })
    const codeResult = await codeSpecialist.service.start()
    workerLog("info", "code_mission_completed", {
      runId,
      missionId: codeMission.id,
      status: codeResult.status,
      claims: codeResult.mission.claims.length,
      stopReason: codeResult.mission.stopReason.code,
    })
    await sources.upsert({
      applicationId: graphInput.applicationId,
      stableKey: createStableKey({
        kind: "document-source",
        applicationId,
        rootUri: configuration.repository.url,
      }),
      kind: "repository",
      uri: configuration.repository.url,
      status: "ready",
      contentHash: hashCanonical({
        php: php.map((index) => index.summary),
        typescript: typescript.indexFingerprint,
      }),
      secretReference: null,
    })
    await emitStage(events, {
      runId,
      nodeName: "index_code",
      phase: "completed",
      summary: "Repository source index completed",
      detail: `${typescript.files.length + php.reduce((total, index) => total + index.files.length, 0)} files, ${typescript.symbols.length + php.reduce((total, index) => total + index.summary.symbolCount, 0)} symbols, ${endpoints.length} endpoint observations; Code Explorer ${codeResult.status}`,
    })

    await artifactService.initialize()
    let applicationClaimCount = 0
    const applicationClaims: ApplicationExplorerEvidenceClaim[] = []
    const requirementRuns: Array<{
      readonly requirement: RequirementCandidate
      readonly claims: readonly ApplicationExplorerEvidenceClaim[]
    }> = []
    const storageStateReference =
      configuration.authentication.method === "storage_state"
        ? configuration.authentication.reference
        : undefined
    const createBrowser = () =>
      createPlaywrightBrowserEvidenceRuntime({
        artifacts: {
          persist: async (artifact) =>
            (
              await artifactService.persist({
                applicationId: graphInput.applicationId,
                applicationStableId: applicationId,
                runId: graphInput.runId,
                artifactType: artifact.artifactType,
                mimeType: artifact.mimeType,
                body: artifact.body,
                retainUntil:
                  artifact.retention === "report"
                    ? null
                    : new Date(Date.now() + 7 * 24 * 60 * 60_000),
              })
            ).id,
        },
        inputResolver: {
          resolve: async (_browserRunId, slot) => {
            if (configuration.authentication.method !== "credentials") {
              throw new Error("No credential input is configured")
            }
            const field = configuration.authentication.fields.find(
              ({ key }) => key === slot
            )
            if (field === undefined)
              throw new Error("Credential input is not configured")
            return secrets.resolve(graphInput.applicationId, field.reference)
          },
        },
        ...(storageStateReference === undefined
          ? {}
          : {
              storageStateProvider: {
                resolve: async () =>
                  JSON.parse(
                    await secrets.resolve(
                      graphInput.applicationId,
                      storageStateReference
                    )
                  ),
              },
            }),
      })
    const targets: Array<{
      readonly label: string
      readonly requirement?: RequirementCandidate
    }> = [
      {
        label:
          "Discover every distinct safe user workflow reachable from the application entry point.",
      },
      ...uniqueDocumentationRequirements.map(({ capability, requirement }) => ({
        label: capability,
        requirement,
      })),
      ...configuration.capabilityHints
        .filter(
          (hint) =>
            !uniqueDocumentationRequirements.some(
              ({ capability }) => capability === hint
            )
        )
        .map((label) => ({ label })),
    ]
    await emitStage(events, {
      runId,
      nodeName: "explore_application",
      phase: "started",
      summary: "Discovering application paths from documented behavior",
      detail: `${targets.length} automatically planned exploration mission(s)`,
    })
    const actionShare = Math.max(
      1,
      Math.floor(configuration.crawl.maxActions / targets.length)
    )
    const modelShare = Math.max(1, Math.floor(50 / targets.length))
    for (const [ordinal, target] of targets.entries()) {
      await context.assertActive()
      const mission = discoveryMissionSchema.parse({
        schemaVersion: 1,
        id: createMissionId({
          applicationId,
          runId,
          agent: "application",
          mode:
            ordinal === 0
              ? "workflow_discovery"
              : "targeted_requirement_observation",
          ordinal,
        }),
        runId,
        applicationId,
        agent: "application",
        mode:
          ordinal === 0
            ? "workflow_discovery"
            : "targeted_requirement_observation",
        goal:
          ordinal === 0
            ? target.label
            : `Observe all safe application paths that demonstrate: ${target.label}`,
        seedEvidenceIds: [],
        questions: [
          "Which screens, controls, transitions, and runtime requests demonstrate this behavior?",
        ],
        scope: {
          repositoryPaths: [],
          sourceUris: [],
          allowedHosts: configuration.crawl.allowedHosts,
          allowedTools: [
            "observe_page",
            "perform_observed_action",
            "navigate_history",
            "finish_application_mission",
          ],
        },
        budget: mergeBudget(graphInput.budget, {
          toolCalls: actionShare * 2,
          contentBytes: 500_000,
          browserActions: actionShare,
          modelCalls: modelShare,
          modelInputTokens: 100_000,
          modelOutputTokens: 16_000,
          elapsedMs: configuration.crawl.maxDurationSeconds * 1_000,
        }),
        successCriteria: [
          "Return all distinct safe paths found within the approved action and screen budgets, including explicit bounded gaps.",
        ],
      })
      const browserOptions = {
        applicationId,
        runId,
        entryUrl: configuration.deploymentUrl,
        ...(configuration.authentication.method === "credentials"
          ? {
              inputSlots: configuration.authentication.fields.map((field) => ({
                slot: field.key,
                kind: "fill" as const,
                accessibleName: field.label,
              })),
            }
          : {}),
        ...(storageStateReference === undefined
          ? {}
          : { storageStateReference }),
        policy: {
          allowedOrigins: [
            new URL(configuration.deploymentUrl).origin,
            ...configuration.crawl.allowedHosts
              .map((host) => `https://${host}`)
              .filter(
                (origin) =>
                  origin !== new URL(configuration.deploymentUrl).origin
              ),
          ],
          allowedCategories:
            row.compatibility_report.proposedScope.allowedActionCategories,
          allowInsecureLocalhost: false,
          budgets: {
            maxActions: actionShare,
            maxScreens: Math.max(
              1,
              Math.floor(configuration.crawl.maxScreens / targets.length)
            ),
            maxDurationMs: configuration.crawl.maxDurationSeconds * 1_000,
            actionExpiryMs: 120_000,
            actionTimeoutMs: 30_000,
            observationSettleMs: 1_000,
          },
        },
        traceOnFailure: true,
      }
      const browser = createBrowser()
      const applicationSpecialist = createApplicationExplorerSpecialist({
        browser,
        planner: model,
        store: applicationStore,
        resolveMissionContext: (requestedMission) => {
          if (requestedMission.id !== mission.id) {
            throw new Error("Application mission context mismatch")
          }
          return {
            browserOptions,
            capabilityHintLabels:
              ordinal === 0 ? configuration.capabilityHints : [target.label],
            requirementHintLabels: ordinal === 0 ? [] : [target.label],
            candidateLimit: 20,
          }
        },
        modelEstimate: {
          contentBytes: 64_000,
          modelCalls: 1,
          modelInputTokens: 32_000,
          modelOutputTokens: MODEL_OUTPUT_TOKENS,
        },
        executionCoordinator,
        runtime,
        checkpointer: input.checkpointer,
      })
      const result = await applicationSpecialist.start(mission)
      workerLog("info", "application_mission_completed", {
        runId,
        missionId: mission.id,
        target: target.label,
        status: result.status,
        stopReason: result.mission.stopReason.code,
      })
      if (result.status === "interrupted") {
        throw new Error("Application exploration requires operator review")
      }
      const applicationRecord = await applicationStore.load(mission.id)
      const output = applicationRecord?.output
      if (output === null || output === undefined) {
        workerLog("warn", "application_mission_output_unavailable", {
          runId,
          missionId: mission.id,
          target: target.label,
          status: result.status,
          stopReason: result.mission.stopReason.code,
          observationStored: applicationRecord?.observation !== undefined,
        })
        if (target.requirement !== undefined) {
          requirementRuns.push({
            requirement: target.requirement,
            claims: [],
          })
        }
        continue
      }
      applicationClaimCount += output.evidenceClaims.length
      applicationClaims.push(...output.evidenceClaims)
      if (target.requirement !== undefined) {
        requirementRuns.push({
          requirement: target.requirement,
          claims: output.evidenceClaims,
        })
      }
      addApplicationClaims(
        output.evidenceClaims,
        nodes,
        collector,
        configuration.deploymentUrl,
        new Date().toISOString()
      )
    }
    await emitStage(events, {
      runId,
      nodeName: "explore_application",
      phase: "completed",
      summary: "Automatic application path discovery completed",
      detail: `${applicationClaimCount} screen, workflow, step, control, and request claims observed`,
      coverageDelta: applicationClaimCount,
    })
    await sources.upsert({
      applicationId: graphInput.applicationId,
      stableKey: applicationId,
      kind: "application",
      uri: configuration.deploymentUrl,
      status: "ready",
      contentHash: hashCanonical(
        applicationClaims.map(({ claimKind, evidenceIds }) => ({
          claimKind,
          evidenceIds,
        }))
      ),
      secretReference: null,
    })

    const completePathCount = requirementRuns.filter(
      ({ requirement, claims }) =>
        addCompleteEvidencePath({
          applicationId,
          runId,
          graphRevision,
          configuration,
          requirement,
          claims,
          endpoints,
          nodes,
          collector,
          now: new Date().toISOString(),
        })
    ).length
    workerLog("info", "complete_evidence_paths_evaluated", {
      runId,
      requirements: requirementRuns.length,
      completePaths: completePathCount,
      gaps: requirementRuns.length - completePathCount,
    })

    await emitStage(events, {
      runId,
      nodeName: "publish_knowledge",
      phase: "started",
      summary: "Linking, validating, and publishing the knowledge graph",
    })
    const collected = collector.values()
    const linked = await createEvidenceLinker().link(
      {
        schemaVersion: 1,
        applicationId,
        runId,
        graphRevision,
        compatibleRunIds: [runId],
        compatibleCommitShas: [commitSha],
        evidence: collected.evidence,
        submittedLinks: submittedLinksFromCollected(collected.links),
        exactObservations: [],
        apiEndpoints: uniqueNodes(nodes)
          .filter(({ kind }) => kind === "api-endpoint")
          .map(({ fact }) => fact),
        frontendRoutes: uniqueNodes(nodes)
          .filter(({ kind }) => kind === "frontend-route")
          .map(({ fact }) => fact),
        semanticEntities: [],
        maxCandidates: 20,
      },
      context.signal
    )
    if (linked.rejections.length > 0 || linked.conflicts.length > 0) {
      throw new Error("Evidence Linker rejected baseline relationships")
    }
    await emitStage(events, {
      runId,
      nodeName: "curate_evidence",
      phase: "started",
      summary: "Auditing cross-specialist coverage and publication gaps",
    })
    const coverageKinds = new Set([
      "requirement",
      "workflow",
      "flow-step",
      "screen",
      "ui-element",
      "frontend-route",
      "api-endpoint",
      "code-symbol",
    ])
    const coverageNodes = uniqueNodes(nodes).filter(({ kind }) =>
      coverageKinds.has(kind)
    )
    const evidenceStateId = hashCanonical({
      runId,
      batchHash: linked.batchHash,
      entities: coverageNodes.map(({ fact }) => fact.id),
    })
    const coverageInput = coverageMatrixInputSchema.parse({
      schemaVersion: 1,
      applicationId,
      runId,
      evidenceStateId,
      entities: coverageNodes.map((node) => ({
        id: node.fact.id,
        applicationId,
        kind: node.kind,
        evidenceIds: node.evidenceIds,
        behavioral: new Set([
          "requirement",
          "workflow",
          "flow-step",
          "screen",
          "ui-element",
        ]).has(node.kind),
        changed: false,
      })),
      currentLinks: [],
      pendingBatch: linked,
      staleEvidenceIds: [],
      reviewDecisions: [],
    })
    const unavailableSpecialist = async (): Promise<never> => {
      throw new Error("Baseline Curator follow-up dispatch is unavailable")
    }
    const curator = createEvidenceCurator({
      dependencies: {
        model: {
          propose: async () => ({
            output: { schemaVersion: 1, missions: [] },
            inputTokens: 0,
            outputTokens: 0,
          }),
        },
        dispatcher: createCuratorSpecialistDispatcher({
          documentation: unavailableSpecialist,
          code: unavailableSpecialist,
          application: unavailableSpecialist,
        }),
        resultStore: new InMemoryCuratorMissionResultStore(),
        evidenceState: {
          load: async () => coverageInput,
          applyMissionResults: async () => coverageInput,
          applyReview: async () => coverageInput,
        },
        events: {
          append: async (event) =>
            events.append(
              {
                runId: event.runId,
                graphName: "evidence_curator",
                nodeName: event.kind,
                kind: "node_completed",
                status: "completed",
                summary: event.summary,
                reasonCode: event.reasonCode,
                occurredAt: event.occurredAt,
                agent: "curator",
                ...(event.missionId === undefined
                  ? {}
                  : { missionId: event.missionId }),
                activity: {
                  category:
                    event.kind === "coverage_built" ? "coverage" : "policy",
                  ...(event.evidenceGain === undefined
                    ? {}
                    : { coverageDelta: event.evidenceGain }),
                },
              },
              { idempotencyKey: event.id }
            ),
        },
        resumeCoordinator: new InMemoryResumeCoordinator(),
        policies: [
          {
            agent: "documentation",
            modes: ["targeted_requirement_lookup"],
            allowedRepositoryPaths: [],
            allowedSourceUris: maps.map(({ source }) => source.rootUri),
            allowedHosts: roots.web.map((root) => new URL(root).hostname),
            allowedTools: [...documentationExplorerToolNames],
            maxMissionBudget: graphInput.budget,
            maxMissionsPerRound: 1,
          },
        ],
        signal: context.signal,
      },
      checkpointer: input.checkpointer,
      options: { maxRounds: 1, maxNoProgressRounds: 1 },
    })
    const curated = await curator.service.start({
      applicationId,
      runId,
      evidenceStateId,
      budget: mergeBudget(graphInput.budget, {
        modelCalls: 1,
        modelInputTokens: 1,
        modelOutputTokens: 1,
        reconciliationRounds: 1,
        elapsedMs: 30_000,
      }),
    })
    if (curated.result === undefined) {
      throw new Error("Evidence Curator produced no terminal result")
    }
    workerLog("info", "evidence_curator_completed", {
      runId,
      status: curated.result.status,
      readiness: curated.result.matrix.readiness,
      gaps: curated.result.matrix.stats.gapCount,
      humanGaps: curated.result.matrix.stats.humanGapCount,
      stopReason: curated.result.stopReason,
    })
    await emitStage(events, {
      runId,
      nodeName: "curate_evidence",
      phase: "completed",
      summary: "Cross-specialist coverage audit completed",
      detail: `${curated.result.matrix.stats.gapCount} explicit coverage gap(s); readiness ${curated.result.matrix.readiness}`,
    })
    const publication = graphPublicationInputSchema.parse({
      schemaVersion: 1,
      applicationId,
      runId,
      inputFingerprint,
      indexedCommitSha: commitSha,
      expectedGraphRevision: row.graph_revision,
      graphRevision,
      replacement: { kind: "full" },
      nodes: uniqueNodes(nodes),
      links: linked.links,
      evidence: linked.evidence,
      retainedEvidenceIds: [],
      batchSize: 250,
    })
    const summary = await publisher.publish(
      publication,
      ({ terminalPublication }) =>
        runs.activateKnowledgePublication({
          runId: graphInput.runId,
          owner: input.workerId,
          publication: terminalPublication,
        })
    )
    workerLog("info", "neo4j_publication_completed", {
      runId,
      graphRevision,
      nodeCount: summary.nodeCount,
      relationshipCount: summary.relationshipCount,
    })
    await knowledgePublications.recordActivated(summary)
    await emitStage(events, {
      runId,
      nodeName: "publish_knowledge",
      phase: "completed",
      summary: "Knowledge graph revision published",
      detail: `${summary.nodeCount} nodes and ${summary.relationshipCount} validated relationships`,
    })
    return {
      status: "succeeded" as const,
      publication: {
        kind: "knowledge" as const,
        inputFingerprint,
        expectedGraphRevision: row.graph_revision,
        indexedCommitSha: commitSha,
      },
    }
  }

  return {
    hasCheckpoint: async () => false,
    hasPendingInterrupt: async () => false,
    start: execute,
    continue: execute,
    resume: (graphInput, _decision, context) => execute(graphInput, context),
  }
}

export async function createRunGraphs(input: {
  readonly databaseUrl: string
  readonly workerId: string
}): Promise<RunGraphRegistry> {
  const checkpointer = await initializePostgresCheckpointSaver(
    input.databaseUrl
  )
  const initialize = await createInitializeGraph({ ...input, checkpointer })
  const assessment = await createPrAssessmentGraph({ ...input, checkpointer })
  return {
    inspect_application: unsupportedGraph(),
    initialize_knowledge: initialize,
    assess_pr: assessment,
    verify_pr: unsupportedGraph(),
    refresh_knowledge: initialize,
    run_eval: unsupportedGraph(),
  }
}
