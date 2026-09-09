import {
  entityKindSchema,
  graphCoverageViewSchema,
  graphEntitySummarySchema,
  graphEvidencePathSchema,
  graphPathQuerySchema,
  graphPullRequestImpactQuerySchema,
  graphPullRequestSeedQuerySchema,
  graphReadScopeSchema,
  provenanceSchema,
  type EntityKind,
  type GraphCoverageView,
  type GraphEntitySummary,
  type GraphEvidencePath,
  type GraphPathQuery,
  type GraphPullRequestImpactQuery,
  type GraphPullRequestSeedQuery,
  type GraphReadScope,
} from "@sentinel/contracts"
import { z } from "zod"

import type { GraphDatabase, GraphTransaction } from "./database.ts"
import { toNativeGraphValue, type NativeGraphValue } from "./values.ts"

const listLimitSchema = z.number().int().positive().max(200).default(100)

const prSeedRelationshipTypes = [
  "STATES",
  "REQUIRES",
  "COVERED_BY",
  "HAS_STEP",
  "ON_SCREEN",
  "ACTS_ON",
  "CONTAINS",
  "MATCHES_ROUTE",
  "RENDERED_BY",
  "BINDS",
  "TRIGGERS_API",
  "CALLS_API",
  "HANDLED_BY",
  "CALLS",
  "READS",
  "WRITES",
] as const

function nativeRecord(
  value: unknown
): Readonly<Record<string, NativeGraphValue>> {
  const native = toNativeGraphValue(value)
  if (native === null || typeof native !== "object" || Array.isArray(native)) {
    throw new Error("Neo4j query returned an invalid record")
  }
  return native as Readonly<Record<string, NativeGraphValue>>
}

function nativeArray(value: unknown): readonly NativeGraphValue[] {
  const native = toNativeGraphValue(value)
  if (!Array.isArray(native)) {
    throw new Error("Neo4j query returned an invalid collection")
  }
  return native
}

function stringValue(
  record: Readonly<Record<string, NativeGraphValue>>,
  key: string
): string {
  const value = record[key]
  if (typeof value !== "string") {
    throw new Error(`Neo4j query omitted ${key}`)
  }
  return value
}

function stringArrayValue(
  record: Readonly<Record<string, NativeGraphValue>>,
  key: string
): readonly string[] {
  const value = record[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Neo4j query returned invalid ${key}`)
  }
  return value as readonly string[]
}

function numberValue(
  record: Readonly<Record<string, NativeGraphValue>>,
  key: string
): number {
  const value = record[key]
  const number = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Neo4j query returned invalid ${key}`)
  }
  return number
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error("Neo4j query returned invalid provenance")
  }
}

function mapEntity(value: unknown): GraphEntitySummary {
  const record = nativeRecord(value)
  return graphEntitySummarySchema.parse({
    id: stringValue(record, "id"),
    kind: stringValue(record, "kind"),
    title: stringValue(record, "title"),
    evidenceTier: stringValue(record, "evidenceTier"),
    evidenceIds: stringArrayValue(record, "evidenceIds"),
    provenance: provenanceSchema.parse(
      parseJson(stringValue(record, "provenanceJson"))
    ),
    reviewState: stringValue(record, "reviewState"),
    graphRevision: numberValue(record, "graphRevision"),
  })
}

function mapEvidencePath(value: unknown): GraphEvidencePath {
  const record = nativeRecord(value)
  const nodes = nativeArray(record["nodes"]).map(mapEntity)
  const relationships = nativeArray(record["relationships"]).map((value) => {
    const relationship = nativeRecord(value)
    return {
      id: stringValue(relationship, "id"),
      type: stringValue(relationship, "type"),
      fromId: stringValue(relationship, "fromId"),
      toId: stringValue(relationship, "toId"),
      evidenceTier: stringValue(relationship, "evidenceTier"),
      extractionMethod: stringValue(relationship, "extractionMethod"),
      evidenceIds: stringArrayValue(relationship, "evidenceIds"),
      evidence: stringArrayValue(relationship, "evidenceJson").map(parseJson),
      reviewState: stringValue(relationship, "reviewState"),
      graphRevision: numberValue(relationship, "graphRevision"),
    }
  })
  return graphEvidencePathSchema.parse({ nodes, relationships })
}

const entityProjection = `{
  id: n.stable_key,
  kind: n.entity_kind,
  title: coalesce(
    n.statement,
    n.name,
    n.title,
    n.accessible_name,
    n.qualified_name,
    n.normalized_name,
    n.normalized_route,
    n.path_pattern,
    n.path,
    n.normalized_path,
    n.stable_key
  ),
  evidenceTier: n.evidence_tier,
  evidenceIds: coalesce(n.evidence_ids, []),
  provenanceJson: n.provenance_json,
  reviewState: n.review_state,
  graphRevision: n.graph_revision
}`

const pathProjection = `{
  nodes: [n IN nodes(path) | {
    id: n.stable_key,
    kind: n.entity_kind,
    title: coalesce(
      n.statement,
      n.name,
      n.title,
      n.accessible_name,
      n.qualified_name,
      n.normalized_name,
      n.normalized_route,
      n.path_pattern,
      n.path,
      n.normalized_path,
      n.stable_key
    ),
    evidenceTier: n.evidence_tier,
    evidenceIds: coalesce(n.evidence_ids, []),
    provenanceJson: n.provenance_json,
    reviewState: n.review_state,
    graphRevision: n.graph_revision
  }],
  relationships: [r IN relationships(path) | {
    id: r.stable_key,
    type: type(r),
    fromId: startNode(r).stable_key,
    toId: endNode(r).stable_key,
    evidenceTier: r.evidence_tier,
    extractionMethod: r.extraction_method,
    evidenceIds: r.evidence_ids,
    evidenceJson: r.evidence_provenance_json,
    reviewState: r.review_state,
    graphRevision: r.graph_revision
  }]
}`

export class Neo4jGraphQueryRepository {
  constructor(private readonly database: GraphDatabase) {}

  private async listEntities(
    scopeValue: GraphReadScope,
    kindsValue: readonly EntityKind[],
    limitValue?: number
  ): Promise<readonly GraphEntitySummary[]> {
    const scope = graphReadScopeSchema.parse(scopeValue)
    const kinds = z.array(entityKindSchema).min(1).max(17).parse(kindsValue)
    const limit = listLimitSchema.parse(limitValue)
    return this.database.read(
      {
        applicationId: scope.applicationId,
        operation: "query_graph_entities",
      },
      async (transaction) => {
        const result = await transaction.run(
          `MATCH (n {
             application_id: $applicationId,
             graph_revision: $graphRevision
           })
           WHERE n.entity_kind IN $kinds
           RETURN ${entityProjection} AS entity
           ORDER BY entity.title, entity.id
           LIMIT $limit`,
          {
            applicationId: scope.applicationId,
            graphRevision: scope.graphRevision,
            kinds,
            limit,
          }
        )
        return result.records.map((record) => mapEntity(record.get("entity")))
      }
    )
  }

  listRequirements(
    scope: GraphReadScope,
    limit?: number
  ): Promise<readonly GraphEntitySummary[]> {
    return this.listEntities(scope, ["requirement", "capability"], limit)
  }

  listWorkflows(
    scope: GraphReadScope,
    limit?: number
  ): Promise<readonly GraphEntitySummary[]> {
    return this.listEntities(scope, ["workflow", "flow-step"], limit)
  }

  listUserInterface(
    scope: GraphReadScope,
    limit?: number
  ): Promise<readonly GraphEntitySummary[]> {
    return this.listEntities(
      scope,
      ["screen", "ui-element", "frontend-route"],
      limit
    )
  }

  listCode(
    scope: GraphReadScope,
    limit?: number
  ): Promise<readonly GraphEntitySummary[]> {
    return this.listEntities(
      scope,
      ["code-file", "code-symbol", "api-endpoint", "domain-entity"],
      limit
    )
  }

  async listCoverage(
    scopeValue: GraphReadScope,
    limitValue?: number
  ): Promise<readonly GraphCoverageView[]> {
    const scope = graphReadScopeSchema.parse(scopeValue)
    const limit = listLimitSchema.parse(limitValue)
    return this.database.read(
      {
        applicationId: scope.applicationId,
        operation: "query_graph_coverage",
      },
      async (transaction) => {
        const result = await transaction.run(
          `MATCH (n:CoverageAssessment {
             application_id: $applicationId,
             graph_revision: $graphRevision
           })
           RETURN ${entityProjection} + {
             requirementId: n.requirement_id,
             status: n.coverage_status,
             scope: n.scope_summary,
             wording: n.wording,
             reasonCode: n.reason_code
           } AS coverage
           ORDER BY coverage.title, coverage.id
           LIMIT $limit`,
          {
            applicationId: scope.applicationId,
            graphRevision: scope.graphRevision,
            limit,
          }
        )
        return result.records.map((row) => {
          const record = nativeRecord(row.get("coverage"))
          const entity = mapEntity(record)
          return graphCoverageViewSchema.parse({
            ...entity,
            requirementId: stringValue(record, "requirementId"),
            status: stringValue(record, "status"),
            scope: stringValue(record, "scope"),
            wording: stringValue(record, "wording"),
            reasonCode: stringValue(record, "reasonCode"),
          })
        })
      }
    )
  }

  async findEvidencePaths(
    inputValue: GraphPathQuery
  ): Promise<readonly GraphEvidencePath[]> {
    const input = graphPathQuerySchema.parse(inputValue)
    return this.database.read(
      {
        applicationId: input.applicationId,
        operation: "query_evidence_paths",
      },
      (transaction) => this.queryPaths(transaction, input)
    )
  }

  private async queryPaths(
    transaction: GraphTransaction,
    input: GraphPathQuery
  ): Promise<readonly GraphEvidencePath[]> {
    const result = await transaction.run(
      `MATCH (start {
         application_id: $applicationId,
         stable_key: $startId,
         graph_revision: $graphRevision
       })
       MATCH (end {
         application_id: $applicationId,
         stable_key: $endId,
         graph_revision: $graphRevision
       })
       MATCH path = (start)-[*1..12]-(end)
       WHERE length(path) <= $maxDepth
         AND all(n IN nodes(path) WHERE
           n.application_id = $applicationId AND
           n.graph_revision = $graphRevision
         )
         AND all(r IN relationships(path) WHERE
           r.application_id = $applicationId AND
           r.graph_revision = $graphRevision AND
           type(r) IN $relationshipTypes AND
           r.evidence_tier IN $evidenceTiers AND
           r.review_state IN ['not_required', 'accepted']
         )
       RETURN ${pathProjection} AS evidencePath
       ORDER BY length(path), [n IN nodes(path) | n.stable_key]
       LIMIT $limit`,
      {
        applicationId: input.applicationId,
        graphRevision: input.graphRevision,
        startId: input.startId,
        endId: input.endId,
        relationshipTypes: input.relationshipTypes,
        evidenceTiers: input.evidenceTiers,
        maxDepth: input.maxDepth,
        limit: input.limit,
      }
    )
    return result.records.map((record) =>
      mapEvidencePath(record.get("evidencePath"))
    )
  }

  async findPullRequestSeedPaths(
    inputValue: GraphPullRequestSeedQuery
  ): Promise<readonly GraphEvidencePath[]> {
    const input = graphPullRequestSeedQuerySchema.parse(inputValue)
    return this.database.read(
      {
        applicationId: input.applicationId,
        operation: "query_pr_graph_seeds",
      },
      async (transaction) => {
        const result = await transaction.run(
          `UNWIND $changedSymbolIds AS changedSymbolId
           MATCH (changed:CodeSymbol {
             application_id: $applicationId,
             stable_key: changedSymbolId,
             graph_revision: $graphRevision
           })
           MATCH (requirement:Requirement {
             application_id: $applicationId,
             graph_revision: $graphRevision
           })
           MATCH path = shortestPath((changed)-[*1..12]-(requirement))
           WHERE length(path) <= $maxDepth
             AND all(n IN nodes(path) WHERE
               n.application_id = $applicationId AND
               n.graph_revision = $graphRevision
             )
             AND all(r IN relationships(path) WHERE
               r.application_id = $applicationId AND
               r.graph_revision = $graphRevision AND
               type(r) IN $relationshipTypes AND
               r.evidence_tier IN $evidenceTiers AND
               r.review_state IN ['not_required', 'accepted']
             )
           RETURN ${pathProjection} AS evidencePath
           ORDER BY length(path), changedSymbolId, requirement.stable_key
           LIMIT $limit`,
          {
            applicationId: input.applicationId,
            graphRevision: input.graphRevision,
            changedSymbolIds: input.changedSymbolIds,
            relationshipTypes: prSeedRelationshipTypes,
            evidenceTiers: input.evidenceTiers,
            maxDepth: input.maxDepth,
            limit: input.limit,
          }
        )
        return result.records.map((record) =>
          mapEvidencePath(record.get("evidencePath"))
        )
      }
    )
  }

  async findPullRequestImpactPaths(
    inputValue: GraphPullRequestImpactQuery
  ): Promise<readonly GraphEvidencePath[]> {
    const input = graphPullRequestImpactQuerySchema.parse(inputValue)
    return this.database.read(
      {
        applicationId: input.applicationId,
        operation: "query_pr_impact_seeds",
      },
      async (transaction) => {
        const result = await transaction.run(
          `UNWIND $seedIds AS seedId
           MATCH (seed {
             application_id: $applicationId,
             stable_key: seedId,
             graph_revision: $graphRevision
           })
           MATCH (requirement:Requirement {
             application_id: $applicationId,
             graph_revision: $graphRevision
           })
           MATCH path = allShortestPaths((seed)-[*1..12]-(requirement))
           WHERE length(path) <= $maxDepth
             AND all(n IN nodes(path) WHERE
               n.application_id = $applicationId AND
               n.graph_revision = $graphRevision
             )
             AND all(r IN relationships(path) WHERE
               r.application_id = $applicationId AND
               r.graph_revision = $graphRevision AND
               type(r) IN $relationshipTypes AND
               r.evidence_tier IN $evidenceTiers AND
               r.review_state IN ['not_required', 'accepted']
             )
           RETURN ${pathProjection} AS evidencePath
           ORDER BY length(path), seedId, requirement.stable_key,
             [n IN nodes(path) | n.stable_key],
             [r IN relationships(path) | r.stable_key]
           LIMIT $limit`,
          {
            applicationId: input.applicationId,
            graphRevision: input.graphRevision,
            seedIds: input.seedIds,
            relationshipTypes: prSeedRelationshipTypes,
            evidenceTiers: input.evidenceTiers,
            maxDepth: input.maxDepth,
            limit: input.limit,
          }
        )
        return result.records.map((record) =>
          mapEvidencePath(record.get("evidencePath"))
        )
      }
    )
  }
}
