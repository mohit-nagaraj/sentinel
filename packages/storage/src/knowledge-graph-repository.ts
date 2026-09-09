import {
  applicationIdSchema,
  coverageItemSchema,
  evidenceIdSchema,
  evidencePathSchema,
  knowledgeCountsSchema,
  knowledgeCursorSchema,
  knowledgePageLimitSchema,
  linkReviewItemSchema,
  knowledgeCoverageStatusSchema,
  stableEntityIdSchema,
  workflowCoverageItemSchema,
  type CoverageItem,
  type EvidencePath,
  type KnowledgeCounts,
  type LinkReviewItem,
  type WorkflowCoverageItem,
} from "@sentinel/contracts"
import { z } from "zod"

import type { GraphDatabase, GraphTransaction } from "./neo4j/database.ts"
import { toNativeGraphValue } from "./neo4j/values.ts"

const graphRevisionSchema = z.number().int().positive()
const coverageQuerySchema = z.string().trim().max(200).default("")

const countsByLabelSchema = z.record(z.string(), z.number().int().nonnegative())

const labelCountKeys = {
  Requirement: "requirements",
  Workflow: "workflows",
  Screen: "screens",
  UIElement: "uiElements",
  APIEndpoint: "apiEndpoints",
  CodeSymbol: "codeSymbols",
} as const

function nativeRecordValue(
  transactionRecord: { get(key: string): unknown },
  key: string
): unknown {
  return omitNullish(toNativeGraphValue(transactionRecord.get(key)))
}

function omitNullish(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNullish)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== null && child !== undefined)
      .map(([key, child]) => [key, omitNullish(child)])
  )
}

function pageResult<Item extends { readonly [key: string]: unknown }>(
  items: readonly Item[],
  limit: number,
  cursorKey: keyof Item
): { readonly items: readonly Item[]; readonly nextCursor?: string } {
  const page = items.slice(0, limit)
  const tail = items.length > limit ? page.at(-1) : undefined
  const cursor = tail?.[cursorKey]
  return {
    items: page,
    ...(typeof cursor === "string" ? { nextCursor: cursor } : {}),
  }
}

function scopedRead<T>(
  database: GraphDatabase,
  operation: string,
  applicationId: string,
  graphRevision: number,
  work: (transaction: GraphTransaction) => Promise<T>
): Promise<T> {
  return database.read(
    {
      applicationId,
      operation,
      timeoutMs: 10_000,
    },
    work
  )
}

export interface KnowledgeGraphPage<T> {
  readonly items: readonly T[]
  readonly nextCursor?: string
}

export class KnowledgeGraphQueryRepository {
  constructor(private readonly database: GraphDatabase) {}

  async counts(input: {
    readonly applicationId: string
    readonly graphRevision: number
  }): Promise<Omit<KnowledgeCounts, "pendingReviews">> {
    const applicationId = applicationIdSchema.parse(input.applicationId)
    const graphRevision = graphRevisionSchema.parse(input.graphRevision)
    return scopedRead(
      this.database,
      "knowledge_overview_counts",
      applicationId,
      graphRevision,
      async (transaction) => {
        const result = await transaction.run(
          `MATCH (node)
           WHERE node.application_id = $applicationId
             AND node.graph_revision = $graphRevision
           WITH labels(node)[0] AS label, count(node) AS count
           WITH collect([label, count]) AS entries
           OPTIONAL MATCH ()-[link]->()
           WHERE link.application_id = $applicationId
             AND link.graph_revision = $graphRevision
             AND (link.evidence_tier IN ['C', 'D'] OR link.review_state = 'pending')
           RETURN entries, count(DISTINCT link) AS ambiguousLinks`,
          { applicationId, graphRevision }
        )
        const record = result.records[0]
        const labelCounts: Record<string, number> = {}
        if (record !== undefined) {
          const entries = z
            .array(z.tuple([z.string(), z.coerce.number().int().nonnegative()]))
            .parse(nativeRecordValue(record, "entries"))
          for (const [label, count] of entries) labelCounts[label] = count
        }
        const parsedCounts = countsByLabelSchema.parse(labelCounts)
        const ambiguousLinks =
          record === undefined
            ? 0
            : z.coerce
                .number()
                .int()
                .nonnegative()
                .parse(nativeRecordValue(record, "ambiguousLinks"))
        return knowledgeCountsSchema.omit({ pendingReviews: true }).parse({
          ...Object.fromEntries(
            Object.entries(labelCountKeys).map(([label, key]) => [
              key,
              parsedCounts[label] ?? 0,
            ])
          ),
          ambiguousLinks,
        })
      }
    )
  }

  async coverage(input: {
    readonly applicationId: string
    readonly graphRevision: number
    readonly status?: unknown
    readonly query?: unknown
    readonly cursor?: unknown
    readonly limit?: unknown
  }): Promise<KnowledgeGraphPage<CoverageItem>> {
    const applicationId = applicationIdSchema.parse(input.applicationId)
    const graphRevision = graphRevisionSchema.parse(input.graphRevision)
    const status =
      input.status === undefined || input.status === "all"
        ? null
        : knowledgeCoverageStatusSchema.parse(input.status)
    const query = coverageQuerySchema.parse(input.query)
    const cursor =
      input.cursor === undefined
        ? null
        : knowledgeCursorSchema.parse(input.cursor)
    const limit = knowledgePageLimitSchema.parse(input.limit)
    return scopedRead(
      this.database,
      "knowledge_requirement_coverage",
      applicationId,
      graphRevision,
      async (transaction) => {
        const result = await transaction.run(
          `MATCH (requirement:Requirement)
           WHERE requirement.application_id = $applicationId
             AND requirement.graph_revision = $graphRevision
             AND ($cursor IS NULL OR requirement.stable_key > $cursor)
             AND ($query = '' OR toLower(requirement.statement) CONTAINS toLower($query)
               OR toLower(requirement.capability) CONTAINS toLower($query))
           OPTIONAL MATCH (requirement)-[assessmentLink:HAS_ASSESSMENT]->(assessment:CoverageAssessment)
           WHERE assessmentLink.application_id = $applicationId
             AND assessmentLink.graph_revision = $graphRevision
             AND assessment.application_id = $applicationId
             AND assessment.graph_revision = $graphRevision
           OPTIONAL MATCH (requirement)-[coverage:COVERED_BY]->(workflow:Workflow)
           WHERE coverage.application_id = $applicationId
             AND coverage.graph_revision = $graphRevision
             AND workflow.application_id = $applicationId
             AND workflow.graph_revision = $graphRevision
           WITH requirement, head(collect(DISTINCT assessment)) AS assessment,
                count(DISTINCT workflow) AS workflowCount,
                [tier IN collect(DISTINCT coverage.evidence_tier) WHERE tier IS NOT NULL] AS evidenceTiers
           WITH requirement, assessment, workflowCount, evidenceTiers,
                coalesce(assessment.status, requirement.coverage_status, 'not_evaluated') AS status
           WHERE $status IS NULL OR status = $status
           RETURN {
             requirementId: requirement.stable_key,
             statement: requirement.statement,
             actor: requirement.actor,
             capability: coalesce(requirement.capability, 'Unclassified capability'),
             status: status,
             summary: coalesce(assessment.summary, requirement.coverage_summary,
               'This requirement has not been evaluated within a completed exploration scope.'),
             scope: assessment.scope,
             possibleCauses: coalesce(assessment.possible_causes, []),
             reviewerActions: coalesce(assessment.reviewer_actions, []),
             workflowCount: workflowCount,
             evidenceTiers: evidenceTiers,
             stale: coalesce(assessment.stale, requirement.stale, false)
           } AS item
           ORDER BY requirement.stable_key
           LIMIT $limit`,
          {
            applicationId,
            graphRevision,
            cursor,
            query,
            status,
            limit: limit + 1,
          }
        )
        const items = result.records.map((record) =>
          coverageItemSchema.parse(nativeRecordValue(record, "item"))
        )
        return pageResult(items, limit, "requirementId")
      }
    )
  }

  async workflows(input: {
    readonly applicationId: string
    readonly graphRevision: number
    readonly cursor?: unknown
    readonly limit?: unknown
  }): Promise<KnowledgeGraphPage<WorkflowCoverageItem>> {
    const applicationId = applicationIdSchema.parse(input.applicationId)
    const graphRevision = graphRevisionSchema.parse(input.graphRevision)
    const cursor =
      input.cursor === undefined
        ? null
        : knowledgeCursorSchema.parse(input.cursor)
    const limit = knowledgePageLimitSchema.parse(input.limit)
    return scopedRead(
      this.database,
      "knowledge_workflow_coverage",
      applicationId,
      graphRevision,
      async (transaction) => {
        const result = await transaction.run(
          `MATCH (workflow:Workflow)
           WHERE workflow.application_id = $applicationId
             AND workflow.graph_revision = $graphRevision
             AND ($cursor IS NULL OR workflow.stable_key > $cursor)
           OPTIONAL MATCH (requirement:Requirement)-[coverage:COVERED_BY]->(workflow)
           WHERE requirement.application_id = $applicationId
             AND requirement.graph_revision = $graphRevision
             AND coverage.application_id = $applicationId
             AND coverage.graph_revision = $graphRevision
           OPTIONAL MATCH (workflow)-[stepLink:HAS_STEP]->(step:FlowStep)
           WHERE stepLink.application_id = $applicationId
             AND stepLink.graph_revision = $graphRevision
             AND step.application_id = $applicationId
             AND step.graph_revision = $graphRevision
           OPTIONAL MATCH (step)-[screenLink:ON_SCREEN]->(screen:Screen)
           WHERE screenLink.application_id = $applicationId
             AND screenLink.graph_revision = $graphRevision
             AND screen.application_id = $applicationId
             AND screen.graph_revision = $graphRevision
           WITH workflow, count(DISTINCT requirement) AS requirementCount,
                count(DISTINCT step) AS stepCount, count(DISTINCT screen) AS screenCount
           RETURN {
             workflowId: workflow.stable_key,
             name: workflow.name,
             actor: coalesce(workflow.actor, 'Unknown actor'),
             requirementCount: requirementCount,
             screenCount: screenCount,
             stepCount: stepCount,
             status: CASE
               WHEN screenCount > 0 AND requirementCount > 0 THEN 'observed'
               WHEN screenCount > 0 OR requirementCount > 0 THEN 'partial'
               ELSE 'unlinked'
             END,
             stale: coalesce(workflow.stale, false)
           } AS item
           ORDER BY workflow.stable_key
           LIMIT $limit`,
          { applicationId, graphRevision, cursor, limit: limit + 1 }
        )
        const items = result.records.map((record) =>
          workflowCoverageItemSchema.parse(nativeRecordValue(record, "item"))
        )
        return pageResult(items, limit, "workflowId")
      }
    )
  }

  async evidencePath(input: {
    readonly applicationId: string
    readonly graphRevision: number
    readonly requirementId: string
  }): Promise<EvidencePath | null> {
    const applicationId = applicationIdSchema.parse(input.applicationId)
    const graphRevision = graphRevisionSchema.parse(input.graphRevision)
    const requirementId = stableEntityIdSchema
      .refine((value) => value.startsWith("requirement:v1:"))
      .parse(input.requirementId)
    return scopedRead(
      this.database,
      "knowledge_selected_evidence_path",
      applicationId,
      graphRevision,
      async (transaction) => {
        const result = await transaction.run(
          `MATCH path=(section:DocumentSection)-[:STATES|COVERED_BY|HAS_STEP|ON_SCREEN|ACTS_ON|CONTAINS|MATCHES_ROUTE|RENDERED_BY|BINDS|TRIGGERS_API|CALLS_API|HANDLED_BY|CALLS|READS|WRITES*1..9]->(target)
           WHERE ALL(node IN nodes(path) WHERE node.application_id = $applicationId
             AND node.graph_revision = $graphRevision)
             AND ALL(link IN relationships(path) WHERE link.application_id = $applicationId
               AND link.graph_revision = $graphRevision)
             AND ANY(node IN nodes(path) WHERE node:Requirement
               AND node.stable_key = $requirementId)
             AND (target:CodeSymbol OR target:DomainEntity)
           WITH path
           ORDER BY length(path) DESC
           LIMIT 1
           RETURN [node IN nodes(path) | {
             id: node.stable_key,
             kind: CASE
               WHEN node:DocumentSection THEN 'document-section'
               WHEN node:Requirement THEN 'requirement'
               WHEN node:Workflow THEN 'workflow'
               WHEN node:FlowStep THEN 'flow-step'
               WHEN node:Screen THEN 'screen'
               WHEN node:UIElement THEN 'ui-element'
               WHEN node:FrontendRoute THEN 'frontend-route'
               WHEN node:APIEndpoint THEN 'api-endpoint'
               WHEN node:CodeSymbol THEN 'code-symbol'
               ELSE 'domain-entity'
             END,
             label: coalesce(node.statement, node.name, node.title,
               node.accessible_name, node.qualified_name, node.normalized_path,
               node.path_pattern, node.heading, node.stable_key),
             detail: coalesce(node.excerpt, node.expected_outcome, node.file_path,
               node.normalized_route, node.role),
             sourceUri: node.source_uri,
             artifactId: node.artifact_id
           }] AS nodes,
           [link IN relationships(path) | {
             id: link.stable_key,
             relationship: toLower(type(link)),
             tier: link.evidence_tier,
             reviewState: coalesce(link.review_state,
               CASE WHEN link.evidence_tier IN ['C', 'D'] THEN 'pending' ELSE 'not_required' END),
             extractionMethod: link.extraction_method,
             sourceIdentityHash: link.source_identity_hash,
             sourceCommitSha: link.source_commit_sha,
             sourceRunId: coalesce(link.crawl_run_id, link.source_run_id),
             capturedAt: toString(link.last_confirmed_at),
             explanation: link.evidence_explanation,
             sourceUri: link.source_uri,
             artifactId: coalesce(link.artifact_id, link.evidence_ref),
             stale: coalesce(link.stale, false)
           }] AS links`,
          { applicationId, graphRevision, requirementId }
        )
        const record = result.records[0]
        if (record === undefined) return null
        const nodes = z
          .array(z.unknown())
          .parse(nativeRecordValue(record, "nodes"))
        const links = z
          .array(z.unknown())
          .parse(nativeRecordValue(record, "links"))
        return evidencePathSchema.parse({
          schemaVersion: 1,
          id: `${requirementId}:representative`,
          requirementId,
          complete:
            nodes.some(
              (node) =>
                typeof node === "object" &&
                node !== null &&
                "kind" in node &&
                (node.kind === "code-symbol" || node.kind === "domain-entity")
            ) &&
            links.every(
              (link) =>
                typeof link === "object" &&
                link !== null &&
                "tier" in link &&
                link.tier !== "D"
            ),
          nodes,
          links,
        })
      }
    )
  }

  async reviewCandidates(input: {
    readonly applicationId: string
    readonly graphRevision: number
    readonly cursor?: unknown
    readonly limit?: unknown
    readonly linkId?: unknown
  }): Promise<KnowledgeGraphPage<LinkReviewItem>> {
    const applicationId = applicationIdSchema.parse(input.applicationId)
    const graphRevision = graphRevisionSchema.parse(input.graphRevision)
    const cursor =
      input.cursor === undefined
        ? null
        : knowledgeCursorSchema.parse(input.cursor)
    const limit = knowledgePageLimitSchema.parse(input.limit)
    const linkId =
      input.linkId === undefined ? null : evidenceIdSchema.parse(input.linkId)
    return scopedRead(
      this.database,
      "knowledge_link_review_candidates",
      applicationId,
      graphRevision,
      async (transaction) => {
        const result = await transaction.run(
          `MATCH (from)-[candidate]->(to)
           WHERE candidate.application_id = $applicationId
             AND candidate.graph_revision = $graphRevision
             AND from.application_id = $applicationId
             AND from.graph_revision = $graphRevision
             AND to.application_id = $applicationId
             AND to.graph_revision = $graphRevision
             AND candidate.evidence_tier IN ['C', 'D']
             AND ($linkId IS NULL OR candidate.stable_key = $linkId)
             AND ($cursor IS NULL OR candidate.stable_key > $cursor)
           OPTIONAL MATCH (from)-[alternative]->(to)
           WHERE alternative.application_id = $applicationId
             AND alternative.graph_revision = $graphRevision
             AND alternative.stable_key <> candidate.stable_key
           WITH from, candidate, to,
             [link IN collect(alternative) WHERE link IS NOT NULL | {
               id: link.stable_key,
               relationship: toLower(type(link)),
               tier: link.evidence_tier,
               reviewState: coalesce(link.review_state, 'pending'),
               extractionMethod: link.extraction_method,
               sourceIdentityHash: link.source_identity_hash,
               sourceCommitSha: link.source_commit_sha,
               sourceRunId: coalesce(link.crawl_run_id, link.source_run_id),
               capturedAt: toString(link.last_confirmed_at),
               explanation: link.evidence_explanation,
               sourceUri: link.source_uri,
               artifactId: coalesce(link.artifact_id, link.evidence_ref),
               stale: coalesce(link.stale, false)
             }] AS competingEvidence
           RETURN {
             kind: 'link',
             id: candidate.stable_key,
             relationship: toLower(type(candidate)),
             title: coalesce(candidate.review_title, 'Ambiguous evidence link'),
             summary: candidate.evidence_explanation,
             tier: candidate.evidence_tier,
             sourceIdentityHash: candidate.source_identity_hash,
             from: {
               id: from.stable_key,
               kind: CASE
                 WHEN from:DocumentSection THEN 'document-section'
                 WHEN from:Requirement THEN 'requirement'
                 WHEN from:Workflow THEN 'workflow'
                 WHEN from:FlowStep THEN 'flow-step'
                 WHEN from:Screen THEN 'screen'
                 WHEN from:UIElement THEN 'ui-element'
                 WHEN from:FrontendRoute THEN 'frontend-route'
                 WHEN from:APIEndpoint THEN 'api-endpoint'
                 WHEN from:CodeSymbol THEN 'code-symbol'
                 ELSE 'domain-entity'
               END,
               label: coalesce(from.statement, from.name, from.title,
                 from.accessible_name, from.qualified_name, from.stable_key),
               detail: coalesce(from.excerpt, from.file_path, from.normalized_route)
             },
             to: {
               id: to.stable_key,
               kind: CASE
                 WHEN to:DocumentSection THEN 'document-section'
                 WHEN to:Requirement THEN 'requirement'
                 WHEN to:Workflow THEN 'workflow'
                 WHEN to:FlowStep THEN 'flow-step'
                 WHEN to:Screen THEN 'screen'
                 WHEN to:UIElement THEN 'ui-element'
                 WHEN to:FrontendRoute THEN 'frontend-route'
                 WHEN to:APIEndpoint THEN 'api-endpoint'
                 WHEN to:CodeSymbol THEN 'code-symbol'
                 ELSE 'domain-entity'
               END,
               label: coalesce(to.statement, to.name, to.title,
                 to.accessible_name, to.qualified_name, to.stable_key),
               detail: coalesce(to.excerpt, to.file_path, to.normalized_route)
             },
             competingEvidence: competingEvidence,
             previousReviews: []
           } AS item
           ORDER BY candidate.stable_key
           LIMIT $limit`,
          { applicationId, graphRevision, cursor, linkId, limit: limit + 1 }
        )
        const items = result.records.map((record) =>
          linkReviewItemSchema.parse(nativeRecordValue(record, "item"))
        )
        return pageResult(items, limit, "id")
      }
    )
  }

  async reviewCandidate(input: {
    readonly applicationId: string
    readonly graphRevision: number
    readonly linkId: string
  }): Promise<LinkReviewItem | null> {
    const linkId = evidenceIdSchema.parse(input.linkId)
    const page = await this.reviewCandidates({
      applicationId: input.applicationId,
      graphRevision: input.graphRevision,
      linkId,
      limit: 1,
    })
    return page.items.find((item) => item.id === linkId) ?? null
  }
}
