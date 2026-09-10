import {
  CodeExplorerRepository,
  CodeExplorerTools,
  GithubAppClient,
  PhpCodeIndex,
  PhpLaravelIndexer,
  PrDiffAnalyzer,
  createAzureOpenAIModelGateway,
  createTypeScriptIndexQuery,
  endpointFromFrontendCandidate,
  endpointsFromLaravelRoute,
  indexTypeScriptSource,
  loadAzureOpenAIEnvironment,
  loadGithubAppConfiguration,
  startGitHubSourceConnector,
  type EndpointEvidence,
} from "@sentinel/adapters"
import {
  BLAST_RADIUS_POLICY_VERSION,
  REPORT_TEMPLATE_VERSION,
  REPORT_WORDING_PROMPT_VERSION,
  assessmentReportSourceSchema,
  codeMissionResultSchema,
  createStableKey,
  evidenceCuratorResultSchema,
  githubCheckLifecycleSchema,
  hashCanonical,
  prInvestigationStartInputSchema,
  type GithubCheckLifecycle,
  type ApplicationId,
  type CommitSha,
  type MissionBudget,
  type PrInvestigationOverlay,
} from "@sentinel/contracts"
import {
  InMemoryResumeCoordinator,
  DurableRunEventSink,
  computeBlastRadius,
  createAssessmentReportRunFinalizer,
  createCodeExplorerSpecialist,
  createPrInvestigation,
  createPrInvestigationCompiledRunGraph,
  createBlastRadiusCandidatesFromInvestigation,
  type CompiledRunGraph,
  type OrchestrationEventSink,
  type RuntimeDependencies,
} from "@sentinel/orchestration"
import {
  ArtifactMetadataRepository,
  ArtifactService,
  AssessmentReportDeliveryService,
  AssessmentReportRepository,
  GithubAssessmentRepository,
  Neo4jGraphQueryRepository,
  PostgresCodeExplorerSpecialistStore,
  PostgresPrInvestigationStore,
  PostgresSpecialistToolExecutionCoordinator,
  PrAssessmentRuntimeRepository,
  RunRepository,
  S3PrivateObjectStore,
  createPostgresDatabase,
  getSharedNeo4jGraphDatabase,
  loadNeo4jEnvironment,
  loadStorageEnvironment,
  type PrAssessmentRuntimeContext,
} from "@sentinel/storage"

import { logWorkerError } from "./logger.ts"

const zeroBudget: MissionBudget = {
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

function databaseRunId(runId: string) {
  if (!runId.startsWith("run:")) throw new Error("Invalid stable run identity")
  return runId.slice("run:".length)
}

function eventSink(runs: RunRepository): OrchestrationEventSink {
  const sinks = new Map<string, Promise<DurableRunEventSink>>()
  return {
    append: async (event, options) => {
      let sink = sinks.get(event.runId)
      if (sink === undefined) {
        sink = runs
          .listEvents(databaseRunId(event.runId))
          .then(
            (events) =>
              new DurableRunEventSink(
                (projected, idempotencyKey) =>
                  runs.appendEvent(projected, idempotencyKey),
                events.length
              )
          )
        sinks.set(event.runId, sink)
      }
      await (await sink).append(event, options)
    },
  }
}

function runtimeDependencies(
  workerId: string,
  runs: RunRepository,
  signal?: AbortSignal
): RuntimeDependencies {
  const assertActive = async (runId: string) => {
    if (signal?.aborted === true) throw signal.reason
    const state = await runs.controlState(databaseRunId(runId), workerId)
    if (state !== "active") {
      const error = new Error(state)
      error.name = state === "lease_lost" ? "LeaseOwnershipError" : "CancelledOrchestrationError"
      throw error
    }
  }
  return {
    owner: workerId,
    control: { assertActive: ({ runId }) => assertActive(runId) },
    events: eventSink(runs),
    effects: {
      execute: async ({ runId, signal: effectSignal }) => {
        if (effectSignal.aborted) throw effectSignal.reason
        await assertActive(runId)
      },
    },
    resumeAuthorization: { authorize: async () => true },
    resumeCoordinator: new InMemoryResumeCoordinator(),
    ...(signal === undefined ? {} : { executionSignal: signal }),
  }
}

class WorkerGithubCheckPublisher {
  constructor(
    private readonly repository: GithubAssessmentRepository,
    private readonly github: GithubAppClient
  ) {}

  async publishCheck(input: {
    readonly assessmentId: string
    readonly headSha: string
    readonly lifecycle: GithubCheckLifecycle
  }): Promise<"published" | "sync_pending" | "superseded"> {
    const lifecycle = githubCheckLifecycleSchema.parse(input.lifecycle)
    let target = await this.repository.getCurrentCheck(
      input.assessmentId,
      input.headSha
    )
    if (target === null) return "superseded"
    if (target.checkRunId === null) {
      const claimed = await this.repository.claimCheck(
        input.assessmentId,
        input.headSha
      )
      if (claimed === null || claimed.syncLeaseToken === null) {
        return "sync_pending"
      }
      try {
        const checkRunId = await this.github.ensureQueuedCheck(claimed)
        const bound = await this.repository.bindCheck({
          assessmentId: claimed.assessmentId,
          headSha: claimed.headSha,
          syncLeaseToken: claimed.syncLeaseToken,
          checkRunId,
        })
        if (!bound) return "sync_pending"
      } catch (error) {
        await this.repository
          .releaseCheck({
            assessmentId: claimed.assessmentId,
            headSha: claimed.headSha,
            syncLeaseToken: claimed.syncLeaseToken,
          })
          .catch(() => undefined)
        throw error
      }
      target = await this.repository.getCurrentCheck(
        input.assessmentId,
        input.headSha
      )
      if (target === null) return "superseded"
      if (target.checkRunId === null) return "sync_pending"
    }
    await this.github.updateCheck(target, {
      schemaVersion: 1,
      assessmentId: target.assessmentId,
      headSha: target.headSha,
      detailsUrl: this.github.assessmentDetailsUrl(target.assessmentId),
      lifecycle,
    })
    return "published"
  }
}

function operationsBySymbol(
  analysis: Awaited<ReturnType<PostgresPrInvestigationStore["loadAnalysis"]>>
) {
  return Object.fromEntries(
    analysis.symbols.flatMap((symbol) =>
      [symbol.base?.id, symbol.head?.id]
        .filter((id): id is NonNullable<typeof id> => id !== undefined)
        .map((id) => [id, symbol.operation] as const)
    )
  )
}

function endpointsFor(
  applicationId: ApplicationId,
  repository: PrAssessmentRuntimeContext["repository"],
  commitSha: CommitSha,
  typescript: Awaited<ReturnType<typeof indexTypeScriptSource>>,
  php: Awaited<ReturnType<PhpLaravelIndexer["indexCheckout"]>> | undefined
) {
  const endpoints: EndpointEvidence[] = []
  for (const candidate of typescript.apiCallCandidates) {
    const file = typescript.files.find(({ path }) => path === candidate.filePath)
    if (file === undefined) continue
    endpoints.push(
      ...endpointFromFrontendCandidate({
        applicationId,
        repository,
        commitSha,
        indexerVersion: typescript.indexerVersion,
        contentHash: file.contentHash,
        candidate,
      }).endpoints
    )
  }
  if (php !== undefined) {
    for (const file of php.files) {
      for (const route of file.routes) {
        endpoints.push(
          ...endpointsFromLaravelRoute({ response: php, file, route }).endpoints
        )
      }
    }
  }
  return endpoints
}

export async function createPrAssessmentGraph(input: {
  readonly databaseUrl: string
  readonly workerId: string
  readonly checkpointer: Parameters<typeof createPrInvestigation>[0]["checkpointer"]
}): Promise<CompiledRunGraph> {
  const database = createPostgresDatabase(input.databaseUrl, {
    maxConnections: 1,
  })
  const runs = new RunRepository(database)
  const runtimeRepository = new PrAssessmentRuntimeRepository(database)
  const investigationStore = new PostgresPrInvestigationStore(database)
  const graph = new Neo4jGraphQueryRepository(
    getSharedNeo4jGraphDatabase(loadNeo4jEnvironment(process.env))
  )
  const githubConfiguration = await loadGithubAppConfiguration(process.env)
  const github = new GithubAppClient(githubConfiguration)
  const checks = new WorkerGithubCheckPublisher(
    new GithubAssessmentRepository(database),
    github
  )
  const model = createAzureOpenAIModelGateway(
    loadAzureOpenAIEnvironment(process.env),
    {
      maxInputCharacters: 32_000,
      maxOutputTokens: 1_024,
      maxTools: 16,
      maxToolCalls: 1,
      maxToolOutputCharacters: 32_768,
      timeoutMs: 30_000,
      maxRetries: 1,
    }
  )
  const contexts = new Map<string, PrAssessmentRuntimeContext>()
  const changedPaths = new Map<string, readonly string[]>()

  const connectorFor = async (context: PrAssessmentRuntimeContext) =>
    startGitHubSourceConnector({
      token: await github.getInstallationToken(
        context.installationId,
        context.repository
      ),
      limits: {
        maxFiles: 100_000,
        maxTotalBytes: 1_000_000_000,
        maxFileBytes: 16 * 1_024 * 1_024,
        timeoutMs: 10 * 60_000,
      },
    })

  const workflow = createPrInvestigation({
    checkpointer: input.checkpointer,
    dependencies: {
      ...runtimeDependencies(input.workerId, runs),
      store: investigationStore,
      currentHead: { isCurrent: (value) => runtimeRepository.isCurrent(value) },
      baselineGraph: {
        isCurrent: (value) => runtimeRepository.isGraphCurrent(value),
      },
      diff: {
        analyze: async (start, signal) => {
          try {
            const context = contexts.get(start.runId)
            if (context === undefined) throw new Error("PR runtime context is missing")
            const connector = await connectorFor(context)
            const [base, head] = await Promise.all([
              connector.resolveCommit(
                `https://github.com/${context.repository.owner}/${context.repository.name}`,
                context.baseSha,
                signal
              ),
              connector.resolveCommit(
                `https://github.com/${context.repository.owner}/${context.repository.name}`,
                context.headSha,
                signal
              ),
            ])
            try {
              const baseSnapshot = base.checkout.snapshots.get("source")
              const headSnapshot = head.checkout.snapshots.get("source")
              if (baseSnapshot === undefined || headSnapshot === undefined) {
                throw new Error("PR checkout snapshots are unavailable")
              }
              const indexedPaths = await graph.listIndexedRepositoryPaths({
                applicationId: context.applicationId,
                graphRevision: context.graphRevision,
                limit: 100_000,
              })
              const analysis = await new PrDiffAnalyzer().analyze({
                  pullRequestId: start.pullRequest.id,
                  applicationId: start.applicationId,
                  runId: start.runId,
                  repository: context.repository,
                  baseSha: context.baseSha,
                  headSha: context.headSha,
                  graphCommitSha: context.graphCommitSha,
                  indexedPaths,
                  baseSnapshot,
                  headSnapshot,
                  ...(signal === undefined ? {} : { signal }),
                })
              changedPaths.set(
                start.runId,
                [
                  ...new Set(
                    analysis.files.flatMap((file) =>
                      [file.oldPath, file.newPath].filter(
                        (path): path is string => path !== undefined
                      )
                    )
                  ),
                ].sort()
              )
              return { analysis, hints: [] }
            } finally {
              await Promise.all([
                base.checkout.dispose(),
                head.checkout.dispose(),
              ])
            }
          } catch (error) {
            logWorkerError("pr_diff_failed", error, {
              runId: start.runId,
              assessmentId: start.assessmentId,
            })
            throw error
          }
        },
      },
      code: {
        investigate: async (mission, signal) => {
          try {
            const context = contexts.get(mission.runId)
            if (context === undefined) throw new Error("PR runtime context is missing")
            const connector = await connectorFor(context)
            const investigationPaths =
              changedPaths.get(mission.runId) ?? mission.scope.repositoryPaths
            const resolved = await connector.resolveCommit(
              `https://github.com/${context.repository.owner}/${context.repository.name}`,
              context.headSha,
              signal
            )
            try {
              const snapshot = resolved.checkout.snapshots.get("source")
              if (snapshot === undefined) throw new Error("PR head checkout is unavailable")
              const typescript = await indexTypeScriptSource({
              reader: snapshot,
              applicationId: context.applicationId,
              runId: mission.runId,
              repository: context.repository,
              commitSha: context.headSha,
              roots: investigationPaths,
              ...(signal === undefined ? {} : { signal }),
              limits: {
                timeoutMs: Math.min(mission.budget.elapsedMs, 8 * 60_000),
                maxTotalBytes: Math.min(mission.budget.repositoryBytes, 512 * 1_024 * 1_024),
                maxFiles: Math.min(mission.budget.repositoryFiles, 50_000),
                maxTotalNodes: 40_000_000,
              },
            })
            const phpPaths = snapshot
              .enumerate()
              .filter(
                (entry) =>
                  entry.kind === "file" &&
                  entry.path.endsWith(".php") &&
                  investigationPaths.some(
                    (root) => entry.path === root || entry.path.startsWith(`${root}/`)
                  )
              )
              .map((entry) => entry.path)
            const php =
              phpPaths.length === 0
                ? undefined
                : await new PhpLaravelIndexer({
                    limits: {
                      maxFiles: Math.min(
                        10_000,
                        mission.budget.repositoryFiles
                      ),
                      maxTotalBytes: Math.min(
                        256 * 1_024 * 1_024,
                        mission.budget.repositoryBytes
                      ),
                      maxFacts: 1_000_000,
                      maxRequestBytes: 4 * 1_024 * 1_024,
                      maxOutputBytes: 256 * 1_024 * 1_024,
                      timeoutMs: Math.min(
                        mission.budget.elapsedMs,
                        8 * 60_000
                      ),
                    },
                  }).indexCheckout(
                    snapshot,
                    phpPaths,
                    {
                      applicationId: context.applicationId,
                      repository: context.repository,
                      commitSha: context.headSha,
                    }
                  )
            const endpoints = endpointsFor(
              context.applicationId,
              context.repository,
              context.headSha,
              typescript,
              php
            )
            const scope = {
              applicationDatabaseId: context.applicationDatabaseId,
              applicationStableId: context.applicationId,
              runDatabaseId: context.runDatabaseId,
              runStableId: mission.runId,
            }
            const specialist = createCodeExplorerSpecialist({
              mission,
              model,
              tools: new CodeExplorerTools(
                new CodeExplorerRepository({
                  applicationId: context.applicationId,
                  runId: mission.runId,
                  typescript: {
                    index: typescript,
                    query: createTypeScriptIndexQuery(typescript, snapshot),
                  },
                  ...(php === undefined
                    ? {}
                    : { php: { index: new PhpCodeIndex(php), snapshot } }),
                  endpoints,
                }),
                mission
              ),
              store: new PostgresCodeExplorerSpecialistStore(database, scope),
              executionCoordinator:
                new PostgresSpecialistToolExecutionCoordinator(database, scope),
              runtime: runtimeDependencies(input.workerId, runs, signal),
              checkpointer: input.checkpointer,
              options: { maxIterations: 30, maxTotalResultItems: 2_000 },
            })
              for (let attempt = 0; attempt < 4; attempt += 1) {
                try {
                  const result =
                    attempt === 0
                      ? await specialist.service.start()
                      : await specialist.service.continue()
                  if (result.codeMission !== undefined) {
                    return codeMissionResultSchema.parse(result.codeMission)
                  }
                } catch (error) {
                  if (!(error instanceof Error) || error.name !== "GraphInterrupt") {
                    throw error
                  }
                  const interrupted = await specialist.service.getCodeResult()
                  if (interrupted !== undefined) {
                    return codeMissionResultSchema.parse(interrupted)
                  }
                }
              }
              throw new Error("Code Explorer did not reach a terminal result")
            } finally {
              await resolved.checkout.dispose()
            }
          } catch (error) {
            logWorkerError("pr_code_investigation_failed", error, {
              runId: mission.runId,
              missionId: mission.id,
            })
            throw error
          }
        },
      },
      graph,
      overlay: {
        stageAssessmentEvidence: async ({ start, codeResults, graphPaths }) => ({
          curatorEvidenceStateId: hashCanonical({
            kind: "pr-assessment-evidence-state",
            applicationId: start.applicationId,
            runId: start.runId,
            codeResults: codeResults.map(({ missionId }) => missionId),
            graphPaths: graphPaths.map(({ id }) => id),
            version: 1,
          }),
          validatedClaimIds: [],
          rejectedClaimIds: codeResults.flatMap(({ claims }) => claims.map(({ id }) => id)),
          conflictIds: [],
        }),
        loadReconciledAssessmentEvidence: async ({ originalOverlay }) =>
          originalOverlay,
      },
      curator: {
        reconcile: async ({ applicationId, runId, evidenceStateId }) => {
          const overlay = await investigationStore.findOverlayByEvidenceStateId(
            evidenceStateId
          )
          if (overlay === null) throw new Error("PR assessment overlay is missing")
          const nodes = new Set(
            overlay.graphPaths.flatMap(({ path }) => path.nodes.map(({ id }) => id))
          )
          const entityKinds = overlay.graphPaths.flatMap(({ path }) =>
            path.nodes.map(({ kind }) => kind)
          )
          return evidenceCuratorResultSchema.parse({
            schemaVersion: 1,
            applicationId,
            runId,
            status: "complete",
            stopReason: "evidence_sufficient",
            roundsUsed: 0,
            budgetUsed: zeroBudget,
            matrix: {
              schemaVersion: 1,
              applicationId,
              runId,
              evidenceStateId,
              evidenceFingerprint: hashCanonical({ evidenceStateId, overlayId: overlay.id }),
              gaps: [],
              stats: {
                entityCount: nodes.size,
                confidentLinkCount: overlay.graphPaths.reduce(
                  (total, { path }) => total + path.relationships.length,
                  0
                ),
                requirementCount: entityKinds.filter((kind) => kind === "requirement").length,
                workflowCount: entityKinds.filter((kind) => kind === "workflow").length,
                endpointCount: entityKinds.filter((kind) => kind === "api-endpoint").length,
                codeSymbolCount: entityKinds.filter((kind) => kind === "code-symbol").length,
                gapCount: 0,
                humanGapCount: 0,
              },
              readiness: "ready",
              publicationReady: true,
            },
            missionReceipts: [],
            missionRejections: [],
            reviews: [],
          })
        },
      },
      deployment: { resolveTrustedHead: async () => null },
      publisher: {
        publishCurrent: async ({ assessmentId, headSha, result }) =>
          runtimeRepository.publishCurrent({
            assessmentId,
            headSha,
            result,
            analysis: await investigationStore.loadAnalysis(result.diffAnalysisId),
          }),
      },
    },
  })

  const storageEnvironment = loadStorageEnvironment(process.env)
  const artifacts = new ArtifactService(
    storageEnvironment.SUPABASE_STORAGE_BUCKET,
    new S3PrivateObjectStore(storageEnvironment),
    new ArtifactMetadataRepository(database)
  )
  let artifactReady: Promise<void> | undefined
  const reports = new AssessmentReportDeliveryService(
    new AssessmentReportRepository(database),
    artifacts
  )
  const finalizer = createAssessmentReportRunFinalizer({
    currentHead: { isCurrent: (value) => runtimeRepository.isCurrent(value) },
    checks,
    publisher: {
      publish: async ({ view, markdown }) => {
        const context = contexts.get(view.runId)
        if (context === undefined) throw new Error("PR report context is missing")
        await (artifactReady ??= artifacts.initialize())
        return reports.publish({
          applicationDatabaseId: context.applicationDatabaseId,
          runDatabaseId: context.runDatabaseId,
          view,
          markdown,
        })
      },
    },
    source: {
      resolve: async ({ investigation }) => {
        const context = contexts.get(investigation.runId)
        if (context === undefined) throw new Error("PR report context is missing")
        const analysis = await investigationStore.loadAnalysis(
          investigation.diffAnalysisId
        )
        let overlay: PrInvestigationOverlay | undefined
        if (investigation.status === "completed") {
          overlay = await investigationStore.loadOverlay(investigation.overlayId)
        }
        const candidates =
          overlay === undefined
            ? []
            : createBlastRadiusCandidatesFromInvestigation({
                investigation,
                overlay,
                operationsBySymbol: operationsBySymbol(analysis),
              })
        const blastRadius = computeBlastRadius({
          schemaVersion: 1,
          applicationId: investigation.applicationId,
          assessmentId: investigation.assessmentId,
          pullRequestId: investigation.pullRequest.id,
          graphRevision: investigation.graphRevision,
          graphCommitSha: investigation.graphCommitSha,
          policyVersion: BLAST_RADIUS_POLICY_VERSION,
          candidates,
          unknowns: investigation.unknowns,
          criticalities: [],
        })
        return assessmentReportSourceSchema.parse({
          schemaVersion: 1,
          assessmentId: investigation.assessmentId,
          applicationId: investigation.applicationId,
          runId: investigation.runId,
          pullRequest: {
            id: investigation.pullRequest.id,
            repository: investigation.pullRequest.repository,
            number: investigation.pullRequest.number,
            title: investigation.pullRequest.title,
            baseSha: investigation.pullRequest.baseSha,
            headSha: investigation.pullRequest.headSha,
          },
          baseline: analysis.baseline,
          blastRadius,
          coverage: [],
          exclusions: [
            ...(investigation.status === "action_required"
              ? ["The active knowledge graph must be refreshed before this pull request can be assessed safely."]
              : []),
            ...investigation.unknowns.map(
              ({ unresolvedReasons }) =>
                `Unknown pull-request scope: ${unresolvedReasons.join(", ")}.`
            ),
          ],
          verification: {
            status: "verification_unavailable" as const,
            results: [],
            reason: "No trusted deployment of this pull-request head is registered.",
            version: 0,
          },
          generatedAt: new Date().toISOString(),
          templateVersion: REPORT_TEMPLATE_VERSION,
          wordingPromptVersion: REPORT_WORDING_PROMPT_VERSION,
        })
      },
    },
  })

  return createPrInvestigationCompiledRunGraph({
    service: workflow.service,
    checks,
    reports: finalizer,
    resolver: {
      resolve: async (graphInput) => {
        const context = await runtimeRepository.resolve({
          applicationDatabaseId: graphInput.applicationId,
          runDatabaseId: graphInput.runId,
        })
        if (context === null) throw new Error("Current PR assessment context is unavailable")
        const resolved = await github.resolvePullRequest({
          installationId: context.installationId,
          pullRequestUrl: `https://github.com/${context.repository.owner}/${context.repository.name}/pull/${context.pullRequestNumber}`,
          expectedRepository: context.repository,
        })
        if (
          resolved.state !== "open" ||
          resolved.baseSha !== context.baseSha ||
          resolved.headSha !== context.headSha
        ) {
          throw new Error("Pull request head changed before assessment execution")
        }
        const runId = `run:${graphInput.runId}`
        contexts.set(runId, context)
        return prInvestigationStartInputSchema.parse({
          schemaVersion: 1,
          assessmentId: context.assessmentId,
          runId,
          applicationId: context.applicationId,
          pullRequest: {
            schemaVersion: 1,
            id: createStableKey({
              kind: "pull-request",
              applicationId: context.applicationId,
              repository: context.repository,
              number: context.pullRequestNumber,
              baseSha: context.baseSha,
              headSha: context.headSha,
            }),
            applicationId: context.applicationId,
            repository: context.repository,
            number: context.pullRequestNumber,
            title: resolved.title,
            baseSha: context.baseSha,
            headSha: context.headSha,
            analyzedAt: new Date().toISOString(),
          },
          graphRevision: context.graphRevision,
          graphCommitSha: context.graphCommitSha,
          repositoryPaths: context.repositoryPaths,
          budget: graphInput.budget,
          startedAtMs: Date.now(),
        })
      },
    },
  })
}
