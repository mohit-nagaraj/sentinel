import "server-only"

import {
  coveragePageSchema,
  databaseApplicationIdSchema,
  evidenceIdSchema,
  evidencePathSchema,
  knowledgeOverviewSchema,
  knowledgePageLimitSchema,
  knowledgeReviewDecisionResultSchema,
  knowledgeReviewDecisionSchema,
  knowledgeReviewPageSchema,
  linkReviewItemSchema,
  privateArtifactExcerptSchema,
  workflowCoveragePageSchema,
  type CoverageItem,
  type CoveragePage,
  type EvidencePath,
  type KnowledgeCounts,
  type KnowledgeReviewDecision,
  type KnowledgeReviewPage,
  type LinkReviewItem,
  type PrivateArtifactExcerpt,
  type PublicRun,
  type PublicRunInterrupt,
  type WorkflowCoverageItem,
  type WorkflowCoveragePage,
} from "@sentinel/contracts"
import {
  ArtifactMetadataRepository,
  ArtifactService,
  createPostgresDatabase,
  getSharedNeo4jGraphDatabase,
  KnowledgeGraphQueryRepository,
  KnowledgeReviewConflictError,
  KnowledgeSummaryRepository,
  loadNeo4jEnvironment,
  loadStorageEnvironment,
  S3PrivateObjectStore,
  type KnowledgeGraphPage,
  type KnowledgeInterruptRecord,
  type KnowledgeSourceRecord,
  type OwnedKnowledgeApplication,
  type StoredLinkReview,
} from "@sentinel/storage"
import { z } from "zod"

import { isControlPlaneFixture } from "./operator-auth"
import { getRunControlService } from "./run-control"
import { getKnowledgeFixtureService } from "./knowledge-fixture"

export interface KnowledgeSummaryStore {
  getOwnedApplication(
    operatorId: string,
    applicationId: string
  ): Promise<OwnedKnowledgeApplication | null>
  listOwnedSources(
    operatorId: string,
    applicationId: string
  ): Promise<readonly KnowledgeSourceRecord[]>
  lastSuccessfulRunAt(
    operatorId: string,
    applicationId: string
  ): Promise<Date | null>
  listOwnedPendingInterrupts(
    operatorId: string,
    applicationId: string,
    limit?: unknown
  ): Promise<readonly KnowledgeInterruptRecord[]>
  listOwnedLinkReviews(
    operatorId: string,
    applicationId: string,
    linkIds: readonly string[]
  ): Promise<readonly StoredLinkReview[]>
  recordOwnedLinkReview(input: {
    readonly operatorId: string
    readonly applicationId: string
    readonly linkStableKey: string
    readonly sourceIdentityHash: string
    readonly decision: "accepted" | "rejected"
    readonly reason: string
  }): Promise<{
    readonly review: StoredLinkReview
    readonly idempotent: boolean
  }>
}

export interface KnowledgeGraphStore {
  counts(input: {
    readonly applicationId: string
    readonly graphRevision: number
  }): Promise<Omit<KnowledgeCounts, "pendingReviews">>
  coverage(input: {
    readonly applicationId: string
    readonly graphRevision: number
    readonly status?: unknown
    readonly query?: unknown
    readonly cursor?: unknown
    readonly limit?: unknown
  }): Promise<KnowledgeGraphPage<CoverageItem>>
  workflows(input: {
    readonly applicationId: string
    readonly graphRevision: number
    readonly cursor?: unknown
    readonly limit?: unknown
  }): Promise<KnowledgeGraphPage<WorkflowCoverageItem>>
  evidencePath(input: {
    readonly applicationId: string
    readonly graphRevision: number
    readonly requirementId: string
  }): Promise<EvidencePath | null>
  reviewCandidates(input: {
    readonly applicationId: string
    readonly graphRevision: number
    readonly cursor?: unknown
    readonly limit?: unknown
    readonly linkId?: unknown
  }): Promise<KnowledgeGraphPage<LinkReviewItem>>
  reviewCandidate(input: {
    readonly applicationId: string
    readonly graphRevision: number
    readonly linkId: string
  }): Promise<LinkReviewItem | null>
}

export interface KnowledgeInterruptService {
  get(runId: string): Promise<PublicRun | null>
  respond(
    runId: string,
    decisionId: string,
    input: unknown
  ): Promise<{
    readonly interrupt: PublicRunInterrupt
    readonly idempotent: boolean
  }>
}

export interface KnowledgeArtifactReader {
  readTextExcerpt(
    applicationId: string,
    artifactId: string,
    maximumCharacters?: number
  ): Promise<{
    readonly schemaVersion?: 1
    readonly artifactId: string
    readonly mimeType:
      "application/json" | "text/html" | "text/markdown" | "text/plain"
    readonly excerpt: string
    readonly truncated: boolean
  } | null>
}

export class KnowledgeNotFoundError extends Error {
  constructor(
    readonly resource: "application" | "path" | "review" | "artifact"
  ) {
    super(`Knowledge ${resource} was not found`)
    this.name = "KnowledgeNotFoundError"
  }
}

export class KnowledgeSourceChangedError extends Error {
  constructor() {
    super("The evidence source changed before the review was recorded")
    this.name = "KnowledgeSourceChangedError"
  }
}

function sourceFreshness(
  source: KnowledgeSourceRecord,
  application: OwnedKnowledgeApplication
): "current" | "stale" | "unknown" {
  if (application.knowledgeStale) return "stale"
  if (source.checkedAt === null || application.refreshedAt === null)
    return "unknown"
  return source.checkedAt < application.refreshedAt ? "stale" : "current"
}

function reviewRecord(
  review: StoredLinkReview,
  currentSourceIdentityHash: string
) {
  return {
    id: review.id,
    decision: review.decision,
    reason: review.reason,
    sourceIdentityHash: review.sourceIdentityHash,
    decidedAt: review.decidedAt.toISOString(),
    stale: review.sourceIdentityHash !== currentSourceIdentityHash,
  } as const
}

function decorateCandidate(
  candidate: LinkReviewItem,
  reviews: readonly StoredLinkReview[]
): LinkReviewItem {
  const matching = reviews.filter(
    (review) => review.linkStableKey === candidate.id
  )
  const current = matching.find(
    (review) => review.sourceIdentityHash === candidate.sourceIdentityHash
  )
  return linkReviewItemSchema.parse({
    ...candidate,
    ...(current === undefined
      ? {}
      : { currentReview: reviewRecord(current, candidate.sourceIdentityHash) }),
    previousReviews: matching
      .filter(
        (review) => review.sourceIdentityHash !== candidate.sourceIdentityHash
      )
      .map((review) => reviewRecord(review, candidate.sourceIdentityHash)),
  })
}

export class KnowledgeService {
  private readonly operatorId: string

  constructor(
    operatorId: string,
    private readonly summary: KnowledgeSummaryStore,
    private readonly graph: KnowledgeGraphStore,
    private readonly interrupts: KnowledgeInterruptService,
    private readonly artifacts?: KnowledgeArtifactReader
  ) {
    this.operatorId = z.uuid().parse(operatorId)
  }

  private async application(applicationIdInput: string) {
    const applicationId = databaseApplicationIdSchema.parse(applicationIdInput)
    const application = await this.summary.getOwnedApplication(
      this.operatorId,
      applicationId
    )
    if (application === null) throw new KnowledgeNotFoundError("application")
    return application
  }

  async overview(applicationIdInput: string) {
    const application = await this.application(applicationIdInput)
    const [sources, lastSuccessfulRunAt, pendingInterrupts, graphCounts] =
      await Promise.all([
        this.summary.listOwnedSources(this.operatorId, application.id),
        this.summary.lastSuccessfulRunAt(this.operatorId, application.id),
        this.summary.listOwnedPendingInterrupts(
          this.operatorId,
          application.id,
          50
        ),
        application.graphRevision === 0
          ? Promise.resolve({
              requirements: 0,
              workflows: 0,
              screens: 0,
              uiElements: 0,
              apiEndpoints: 0,
              codeSymbols: 0,
              ambiguousLinks: 0,
            })
          : this.graph.counts({
              applicationId: application.stableKey,
              graphRevision: application.graphRevision,
            }),
      ])
    return knowledgeOverviewSchema.parse({
      schemaVersion: 1,
      application: {
        id: application.id,
        name: application.name,
        deploymentUrl: application.deploymentUrl,
        status: application.status,
        ...(application.indexedCommitSha === null
          ? {}
          : { indexedCommitSha: application.indexedCommitSha }),
        graphRevision: application.graphRevision,
        ...(application.refreshedAt === null
          ? {}
          : { refreshedAt: application.refreshedAt.toISOString() }),
        stale: application.knowledgeStale,
      },
      sources: sources.map((source) => ({
        id: source.stableKey,
        kind: source.kind,
        uri: source.uri,
        status: source.status,
        freshness: sourceFreshness(source, application),
        ...(source.checkedAt === null
          ? {}
          : { checkedAt: source.checkedAt.toISOString() }),
      })),
      counts: {
        ...graphCounts,
        pendingReviews: graphCounts.ambiguousLinks + pendingInterrupts.length,
      },
      ...(lastSuccessfulRunAt === null
        ? {}
        : { lastSuccessfulRunAt: lastSuccessfulRunAt.toISOString() }),
    })
  }

  async coverage(
    applicationIdInput: string,
    input: {
      readonly status?: unknown
      readonly query?: unknown
      readonly cursor?: unknown
      readonly limit?: unknown
    }
  ): Promise<CoveragePage> {
    const application = await this.application(applicationIdInput)
    if (application.graphRevision === 0) {
      return coveragePageSchema.parse({ schemaVersion: 1, items: [] })
    }
    return coveragePageSchema.parse({
      schemaVersion: 1,
      ...(await this.graph.coverage({
        applicationId: application.stableKey,
        graphRevision: application.graphRevision,
        ...input,
      })),
    })
  }

  async workflows(
    applicationIdInput: string,
    input: { readonly cursor?: unknown; readonly limit?: unknown }
  ): Promise<WorkflowCoveragePage> {
    const application = await this.application(applicationIdInput)
    if (application.graphRevision === 0) {
      return workflowCoveragePageSchema.parse({ schemaVersion: 1, items: [] })
    }
    return workflowCoveragePageSchema.parse({
      schemaVersion: 1,
      ...(await this.graph.workflows({
        applicationId: application.stableKey,
        graphRevision: application.graphRevision,
        ...input,
      })),
    })
  }

  async evidencePath(
    applicationIdInput: string,
    requirementId: string
  ): Promise<EvidencePath> {
    const application = await this.application(applicationIdInput)
    if (application.graphRevision === 0) {
      throw new KnowledgeNotFoundError("path")
    }
    const path = await this.graph.evidencePath({
      applicationId: application.stableKey,
      graphRevision: application.graphRevision,
      requirementId,
    })
    if (path === null) throw new KnowledgeNotFoundError("path")
    const reviews = await this.summary.listOwnedLinkReviews(
      this.operatorId,
      application.id,
      path.links.map((link) => link.id)
    )
    return evidencePathSchema.parse({
      ...path,
      links: path.links.map((link) => {
        const current = reviews.find(
          (review) =>
            review.linkStableKey === link.id &&
            review.sourceIdentityHash === link.sourceIdentityHash
        )
        return current === undefined
          ? link
          : { ...link, reviewState: current.decision }
      }),
    })
  }

  async reviews(
    applicationIdInput: string,
    input: { readonly cursor?: unknown; readonly limit?: unknown }
  ): Promise<KnowledgeReviewPage> {
    const application = await this.application(applicationIdInput)
    const limit = knowledgePageLimitSchema.parse(input.limit)
    const includeInterrupts = input.cursor === undefined
    const pendingInterrupts = includeInterrupts
      ? await this.summary.listOwnedPendingInterrupts(
          this.operatorId,
          application.id,
          limit
        )
      : []
    const remaining = Math.max(0, limit - pendingInterrupts.length)
    const candidates =
      application.graphRevision === 0 || remaining === 0
        ? { items: [] as readonly LinkReviewItem[] }
        : await this.graph.reviewCandidates({
            applicationId: application.stableKey,
            graphRevision: application.graphRevision,
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            limit: remaining,
          })
    const reviews = await this.summary.listOwnedLinkReviews(
      this.operatorId,
      application.id,
      candidates.items.map((candidate) => candidate.id)
    )
    return knowledgeReviewPageSchema.parse({
      schemaVersion: 1,
      items: [
        ...pendingInterrupts.map((interrupt) => ({
          kind: "interrupt" as const,
          id: interrupt.id,
          runId: interrupt.runId,
          decisionId: interrupt.decisionId,
          title: "Operator decision required",
          summary: interrupt.prompt,
          createdAt: interrupt.createdAt.toISOString(),
          status: interrupt.status,
        })),
        ...candidates.items.map((candidate) =>
          decorateCandidate(candidate, reviews)
        ),
      ],
      ...(candidates.nextCursor === undefined
        ? {}
        : { nextCursor: candidates.nextCursor }),
    })
  }

  async reviewLink(
    applicationIdInput: string,
    linkIdInput: string,
    decisionInput: unknown
  ) {
    const application = await this.application(applicationIdInput)
    const linkId = evidenceIdSchema.parse(linkIdInput)
    const decision = knowledgeReviewDecisionSchema.parse(decisionInput)
    if (decision.sourceIdentityHash === undefined) {
      throw new KnowledgeSourceChangedError()
    }
    const candidate = await this.graph.reviewCandidate({
      applicationId: application.stableKey,
      graphRevision: application.graphRevision,
      linkId,
    })
    if (candidate === null) throw new KnowledgeNotFoundError("review")
    if (candidate.sourceIdentityHash !== decision.sourceIdentityHash) {
      throw new KnowledgeSourceChangedError()
    }
    const result = await this.summary.recordOwnedLinkReview({
      operatorId: this.operatorId,
      applicationId: application.id,
      linkStableKey: linkId,
      sourceIdentityHash: decision.sourceIdentityHash,
      decision: decision.decision,
      reason: decision.reason,
    })
    return knowledgeReviewDecisionResultSchema.parse({
      schemaVersion: 1,
      idempotent: result.idempotent,
      item: decorateCandidate(candidate, [result.review]),
    })
  }

  async reviewInterrupt(
    applicationIdInput: string,
    runId: string,
    decisionId: string,
    decisionInput: unknown
  ) {
    const application = await this.application(applicationIdInput)
    const decision: KnowledgeReviewDecision =
      knowledgeReviewDecisionSchema.parse(decisionInput)
    const run = await this.interrupts.get(runId)
    if (run === null || run.applicationId !== application.id) {
      throw new KnowledgeNotFoundError("review")
    }
    const result = await this.interrupts.respond(runId, decisionId, {
      schemaVersion: 1,
      response: {
        approved: decision.decision === "accepted",
        note: decision.reason,
      },
    })
    return knowledgeReviewDecisionResultSchema.parse({
      schemaVersion: 1,
      idempotent: result.idempotent,
      item: {
        kind: "interrupt",
        id: result.interrupt.id,
        runId: result.interrupt.runId,
        decisionId: result.interrupt.decisionId,
        title: "Operator decision recorded",
        summary: result.interrupt.prompt,
        createdAt: result.interrupt.createdAt,
        status: result.interrupt.status,
      },
    })
  }

  async artifactExcerpt(
    applicationIdInput: string,
    artifactId: string
  ): Promise<PrivateArtifactExcerpt> {
    const application = await this.application(applicationIdInput)
    if (this.artifacts === undefined) {
      throw new KnowledgeNotFoundError("artifact")
    }
    const excerpt = await this.artifacts.readTextExcerpt(
      application.id,
      artifactId,
      8_192
    )
    if (excerpt === null) throw new KnowledgeNotFoundError("artifact")
    return privateArtifactExcerptSchema.parse({ schemaVersion: 1, ...excerpt })
  }
}

interface KnowledgeGlobalState {
  production?: KnowledgeService
  fixture?: KnowledgeService
}

const globalState = globalThis as typeof globalThis & {
  __sentinelKnowledge?: KnowledgeGlobalState
}

export function getKnowledgeService(): KnowledgeService {
  const state = (globalState.__sentinelKnowledge ??= {})
  if (isControlPlaneFixture(process.env)) {
    return (state.fixture ??= getKnowledgeFixtureService())
  }
  if (state.production !== undefined) return state.production
  const operatorId = z.uuid().parse(process.env["SENTINEL_OPERATOR_ID"])
  const databaseUrl = z
    .url({ protocol: /^postgres(?:ql)?$/ })
    .parse(process.env["SUPABASE_DB_URL"])
  const database = createPostgresDatabase(databaseUrl)
  const graph = getSharedNeo4jGraphDatabase(loadNeo4jEnvironment(process.env))
  let artifacts: ArtifactService | undefined
  try {
    const storage = loadStorageEnvironment(process.env)
    artifacts = new ArtifactService(
      storage.SUPABASE_STORAGE_BUCKET,
      new S3PrivateObjectStore(storage),
      new ArtifactMetadataRepository(database)
    )
  } catch {
    artifacts = undefined
  }
  state.production = new KnowledgeService(
    operatorId,
    new KnowledgeSummaryRepository(database),
    new KnowledgeGraphQueryRepository(graph),
    getRunControlService(),
    artifacts
  )
  return state.production
}

export { KnowledgeReviewConflictError }
