import {
  apiEndpointFactSchema,
  capabilityFactSchema,
  codeFileFactSchema,
  codeSymbolFactSchema,
  coverageAssessmentGraphFactSchema,
  coverageStatusSchema,
  documentPageFactSchema,
  documentSectionFactSchema,
  documentSourceFactSchema,
  domainEntityFactSchema,
  entityKindSchema,
  evidenceRelationshipSchema,
  flowStepFactSchema,
  frontendRouteFactSchema,
  graphApplicationFactSchema,
  graphPublicationInputSchema,
  graphPublicationSummarySchema,
  hashCanonical,
  pullRequestSchema,
  requirementCandidateSchema,
  screenFactSchema,
  uiElementFactSchema,
  workflowFactSchema,
  type GraphPublicationInput,
  type GraphPublicationNode,
  type GraphPublicationSummary,
  type RunTerminalPublication,
} from "@sentinel/contracts"

import type {
  GraphDatabase,
  GraphParameter,
  GraphTransaction,
} from "./database.ts"
import {
  constraintStatements,
  legacyConstraintDropStatements,
  legacyRelationshipConstraintDropStatements,
  nodeRevisionIndexStatements,
  relationshipConstraintStatements,
  relationshipRevisionIndexStatements,
  resolveNodeLabel,
  resolveRelationshipType,
} from "./schema.ts"
import { parseGraphProperties, type GraphProperties } from "./repository.ts"
import { toNativeGraphValue } from "./values.ts"

type KnowledgeTerminalPublication = Extract<
  RunTerminalPublication,
  { readonly kind: "knowledge" }
>

export interface GraphPublicationActivation {
  readonly summary: GraphPublicationSummary
  readonly terminalPublication: KnowledgeTerminalPublication
}

export type ActivateGraphPublication = (
  publication: GraphPublicationActivation
) => Promise<"activated" | "already_active" | "rejected">

export class GraphPublicationError extends Error {
  constructor(
    readonly code:
      | "revision_conflict"
      | "staging_conflict"
      | "validation_failed"
      | "activation_failed"
      | "activation_indeterminate"
      | "finalization_failed",
    options?: ErrorOptions
  ) {
    super(code, options)
    this.name = "GraphPublicationError"
  }
}

interface StagedNode {
  readonly kind: GraphPublicationNode["kind"]
  readonly stableKey: string
  readonly properties: GraphProperties
  readonly extractionMethod: string
  readonly evidenceTier: "A" | "B" | "C"
  readonly evidenceIds: readonly string[]
  readonly provenanceJson: string
  readonly reviewState: string
}

interface StagedRelationship {
  readonly type: string
  readonly stableKey: string
  readonly fromStableKey: string
  readonly toStableKey: string
  readonly properties: GraphProperties
}

function withoutUndefined(
  entries: Readonly<Record<string, unknown>>
): GraphProperties {
  return parseGraphProperties(
    Object.fromEntries(
      Object.entries(entries).filter((entry) => entry[1] !== undefined)
    ) as GraphProperties
  )
}

function nodeProperties(node: GraphPublicationNode): GraphProperties {
  switch (node.kind) {
    case "application": {
      const fact = graphApplicationFactSchema.parse(node.fact)
      return withoutUndefined({
        name: fact.name,
        indexed_commit_sha: fact.indexedCommitSha,
      })
    }
    case "document-source": {
      const fact = documentSourceFactSchema.parse(node.fact)
      return withoutUndefined({
        source_kind: fact.kind,
        root_uri: fact.rootUri,
        content_hash: fact.contentHash,
      })
    }
    case "document-page": {
      const fact = documentPageFactSchema.parse(node.fact)
      return withoutUndefined({
        source_id: fact.sourceId,
        canonical_uri: fact.canonicalUri,
        title: fact.title,
        content_hash: fact.contentHash,
      })
    }
    case "document-section": {
      const fact = documentSectionFactSchema.parse(node.fact)
      return withoutUndefined({
        page_id: fact.pageId,
        heading_path: fact.headingPath,
        excerpt: fact.excerpt,
        content_hash: fact.contentHash,
      })
    }
    case "requirement": {
      const fact = requirementCandidateSchema.parse(node.fact)
      return withoutUndefined({
        statement: fact.statement,
        actor: fact.actor,
        capability: fact.capability,
        expected_outcome: fact.expectedOutcome,
        testable: fact.testable,
        source_section_id: fact.source.sectionId,
        source_uri: fact.source.uri,
        source_heading: fact.source.heading,
        source_excerpt: fact.source.excerpt,
        source_content_hash: fact.source.contentHash,
      })
    }
    case "capability": {
      const fact = capabilityFactSchema.parse(node.fact)
      return withoutUndefined({ normalized_name: fact.normalizedName })
    }
    case "workflow": {
      const fact = workflowFactSchema.parse(node.fact)
      return withoutUndefined({
        name: fact.name,
        actor: fact.actor,
        source_run_id: fact.sourceRunId,
      })
    }
    case "flow-step": {
      const fact = flowStepFactSchema.parse(node.fact)
      return withoutUndefined({
        workflow_id: fact.workflowId,
        ordinal: fact.ordinal,
        action_type: fact.actionType,
        expected_checkpoint: fact.expectedCheckpoint,
        source_run_id: fact.sourceRunId,
      })
    }
    case "screen": {
      const fact = screenFactSchema.parse(node.fact)
      return withoutUndefined({
        normalized_route: fact.normalizedRoute,
        title: fact.title,
        state_fingerprint: fact.stateFingerprint,
      })
    }
    case "ui-element": {
      const fact = uiElementFactSchema.parse(node.fact)
      return withoutUndefined({
        screen_id: fact.screenId,
        role: fact.role,
        accessible_name: fact.accessibleName,
        context_fingerprint: fact.contextFingerprint,
        selector_hint: fact.selectorHint,
        observed_at: fact.observedAt,
        source_run_id: fact.sourceRunId,
      })
    }
    case "frontend-route": {
      const fact = frontendRouteFactSchema.parse(node.fact)
      return withoutUndefined({
        repository_host: fact.repository.host,
        repository_owner: fact.repository.owner,
        repository_name: fact.repository.name,
        commit_sha: fact.commitSha,
        path_pattern: fact.pathPattern,
        component_symbol_ids: fact.componentSymbolIds,
        source_start_line: fact.sourceRange.startLine,
        source_end_line: fact.sourceRange.endLine,
      })
    }
    case "code-file": {
      const fact = codeFileFactSchema.parse(node.fact)
      return withoutUndefined({
        repository_host: fact.repository.host,
        repository_owner: fact.repository.owner,
        repository_name: fact.repository.name,
        commit_sha: fact.commitSha,
        path: fact.path,
        language: fact.language,
        content_hash: fact.contentHash,
      })
    }
    case "code-symbol": {
      const fact = codeSymbolFactSchema.parse(node.fact)
      return withoutUndefined({
        repository_host: fact.repository.host,
        repository_owner: fact.repository.owner,
        repository_name: fact.repository.name,
        commit_sha: fact.commitSha,
        language: fact.language,
        symbol_kind: fact.kind,
        qualified_name: fact.qualifiedName,
        file_path: fact.filePath,
        start_line: fact.range.startLine,
        end_line: fact.range.endLine,
      })
    }
    case "api-endpoint": {
      const fact = apiEndpointFactSchema.parse(node.fact)
      return withoutUndefined({
        method: fact.method,
        normalized_path: fact.normalizedPath,
        operation_id: fact.operationId,
        openapi_version: fact.openApiVersion,
        tags: fact.tags,
        source_hash: fact.sourceHash,
      })
    }
    case "domain-entity": {
      const fact = domainEntityFactSchema.parse(node.fact)
      return withoutUndefined({
        normalized_name: fact.normalizedName,
        source_symbol_ids: fact.sourceSymbolIds,
      })
    }
    case "coverage-assessment": {
      const fact = coverageAssessmentGraphFactSchema.parse(node.fact)
      return withoutUndefined({
        requirement_id: fact.requirementId,
        status: fact.status,
        coverage_status: fact.status,
        summary: fact.wording,
        scope: fact.scopeSummary,
        scope_fingerprint: fact.scopeFingerprint,
        scope_summary: fact.scopeSummary,
        reason_code: fact.reasonCode,
        wording: fact.wording,
        attempt_summary: fact.attemptSummary,
        source_run_id: fact.runId,
        coverage_evidence_ids: fact.evidenceIds,
        attempt_evidence_ids: fact.attemptEvidenceIds,
        blocker_kinds: fact.blockerKinds,
        requirement_source_hash: fact.requirementSourceHash,
        crawl_configuration_hash: fact.crawlConfigurationHash,
        authentication_revision: fact.authenticationRevision,
        test_data_revision: fact.testDataRevision,
        evaluated_at: fact.evaluatedAt,
        possible_causes: [],
        reviewer_actions: [],
        stale: false,
      })
    }
    case "pull-request": {
      const fact = pullRequestSchema.parse(node.fact)
      return withoutUndefined({
        repository_host: fact.repository.host,
        repository_owner: fact.repository.owner,
        repository_name: fact.repository.name,
        number: fact.number,
        title: fact.title,
        base_sha: fact.baseSha,
        head_sha: fact.headSha,
        analyzed_at: fact.analyzedAt,
      })
    }
  }
}

function toStagedNode(node: GraphPublicationNode): StagedNode {
  return {
    kind: node.kind,
    stableKey: node.fact.id,
    properties: nodeProperties(node),
    extractionMethod: node.extractionMethod,
    evidenceTier: node.evidenceTier,
    evidenceIds: node.evidenceIds,
    provenanceJson: JSON.stringify(node.provenance),
    reviewState: node.reviewState,
  }
}

function chunks<T>(values: readonly T[], size: number): readonly T[][] {
  const output: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size))
  }
  return output
}

function countFromResult(
  records: readonly { get(key: string): unknown }[],
  key: string
): number {
  const value = toNativeGraphValue(records[0]?.get(key))
  const count = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new GraphPublicationError("validation_failed")
  }
  return count
}

function groupedCounts(
  records: readonly { get(key: string): unknown }[],
  keys: readonly string[]
): Record<string, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0]))
  for (const record of records) {
    const key = toNativeGraphValue(record.get("key"))
    const count = toNativeGraphValue(record.get("count"))
    if (
      typeof key !== "string" ||
      !(key in counts) ||
      (typeof count !== "number" && typeof count !== "string")
    ) {
      throw new GraphPublicationError("validation_failed")
    }
    const numericCount = Number(count)
    if (!Number.isSafeInteger(numericCount) || numericCount < 0) {
      throw new GraphPublicationError("validation_failed")
    }
    counts[key] = numericCount
  }
  return counts
}

function nodeStageStatement(kind: GraphPublicationNode["kind"]): string {
  const label = resolveNodeLabel(kind)
  return `UNWIND $facts AS fact
MERGE (n:${label} {
  application_id: $applicationId,
  stable_key: fact.stableKey,
  graph_revision: $graphRevision
})
ON CREATE SET n.created_at = datetime()
WITH n, fact
WHERE n.publication_hash IS NULL OR n.publication_hash = $publicationHash
SET n += fact.properties,
    n.entity_kind = $entityKind,
    n.extraction_method = fact.extractionMethod,
    n.evidence_tier = fact.evidenceTier,
    n.evidence_ids = fact.evidenceIds,
    n.provenance_json = fact.provenanceJson,
    n.review_state = fact.reviewState,
    n.publication_hash = $publicationHash,
    n.publication_status = 'pending',
    n.updated_at = datetime()
RETURN count(n) AS writtenCount`
}

function relationshipStageStatement(typeInput: unknown): string {
  const type = resolveRelationshipType(typeInput)
  return `UNWIND $facts AS fact
MATCH (from {
  application_id: $applicationId,
  stable_key: fact.fromStableKey,
  graph_revision: $graphRevision,
  publication_hash: $publicationHash
})
MATCH (to {
  application_id: $applicationId,
  stable_key: fact.toStableKey,
  graph_revision: $graphRevision,
  publication_hash: $publicationHash
})
MERGE (from)-[r:${type} {
  application_id: $applicationId,
  stable_key: fact.stableKey,
  graph_revision: $graphRevision
}]->(to)
ON CREATE SET r.created_at = datetime()
WITH r, fact
WHERE r.publication_hash IS NULL OR r.publication_hash = $publicationHash
SET r += fact.properties,
    r.publication_hash = $publicationHash,
    r.publication_status = 'pending',
    r.updated_at = datetime()
RETURN count(r) AS writtenCount`
}

function nodeCopyStatement(kind: GraphPublicationNode["kind"]): string {
  const label = resolveNodeLabel(kind)
  return `MATCH (old:${label} {
  application_id: $applicationId,
  graph_revision: $expectedGraphRevision
})
WHERE NOT old.stable_key IN $affectedStableKeys
  AND NOT EXISTS {
    MATCH (copy:${label} {
      application_id: $applicationId,
      stable_key: old.stable_key,
      graph_revision: $graphRevision
    })
  }
WITH old LIMIT $batchSize
CREATE (copy:${label})
SET copy = properties(old),
    copy.graph_revision = $graphRevision,
    copy.publication_hash = $publicationHash,
    copy.publication_status = 'pending',
    copy.created_at = datetime(),
    copy.updated_at = datetime()
RETURN count(copy) AS copiedCount`
}

function relationshipCopyStatement(typeInput: unknown): string {
  const type = resolveRelationshipType(typeInput)
  return `MATCH (oldFrom)-[old:${type} {
  application_id: $applicationId,
  graph_revision: $expectedGraphRevision
}]->(oldTo)
WHERE NOT old.stable_key IN $affectedStableKeys
  AND NOT oldFrom.stable_key IN $affectedStableKeys
  AND NOT oldTo.stable_key IN $affectedStableKeys
MATCH (newFrom {
  application_id: $applicationId,
  stable_key: oldFrom.stable_key,
  graph_revision: $graphRevision,
  publication_hash: $publicationHash
})
MATCH (newTo {
  application_id: $applicationId,
  stable_key: oldTo.stable_key,
  graph_revision: $graphRevision,
  publication_hash: $publicationHash
})
WHERE NOT EXISTS {
  MATCH (newFrom)-[:${type} {
    application_id: $applicationId,
    stable_key: old.stable_key,
    graph_revision: $graphRevision
  }]->(newTo)
}
WITH old, newFrom, newTo LIMIT $batchSize
CREATE (newFrom)-[copy:${type}]->(newTo)
SET copy = properties(old),
    copy.graph_revision = $graphRevision,
    copy.publication_hash = $publicationHash,
    copy.publication_status = 'pending',
    copy.created_at = datetime(),
    copy.updated_at = datetime()
RETURN count(copy) AS copiedCount`
}

export class Neo4jGraphPublicationRepository {
  constructor(
    private readonly database: GraphDatabase,
    private readonly now: () => Date = () => new Date()
  ) {}

  async bootstrap(): Promise<void> {
    await this.database.write(
      { operation: "bootstrap_graph_publication" },
      async (transaction) => {
        for (const statement of [
          ...legacyRelationshipConstraintDropStatements,
          ...legacyConstraintDropStatements,
          ...constraintStatements,
          ...relationshipConstraintStatements,
          ...nodeRevisionIndexStatements,
          ...relationshipRevisionIndexStatements,
        ]) {
          await transaction.run(statement)
        }
      }
    )
  }

  async publish(
    inputValue: GraphPublicationInput,
    activate: ActivateGraphPublication
  ): Promise<GraphPublicationSummary> {
    const input = graphPublicationInputSchema.parse(inputValue)
    const publicationContent = Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== "batchSize")
    )
    const publicationHash = hashCanonical({
      kind: "current_graph_publication",
      publication: publicationContent,
    })

    const revisionState = await this.assertRevisionAvailable(
      input,
      publicationHash
    )
    if (revisionState === "current") {
      return this.validateAndSummarize(input, publicationHash, false)
    }

    try {
      const affectedStableKeys = [
        ...(input.replacement.kind === "affected"
          ? input.replacement.stableKeys
          : []),
        ...input.nodes.map(({ fact }) => fact.id),
        ...input.links.map(({ id }) => id),
      ]
      const uniqueAffectedStableKeys = [...new Set(affectedStableKeys)].sort()

      if (input.replacement.kind === "affected") {
        await this.copyUnaffectedNodes(
          input,
          publicationHash,
          uniqueAffectedStableKeys
        )
      }
      await this.stageNodes(input, publicationHash)
      if (input.replacement.kind === "affected") {
        await this.copyUnaffectedRelationships(
          input,
          publicationHash,
          uniqueAffectedStableKeys
        )
      }
      await this.stageRelationships(input, publicationHash)
      const summary = await this.validateAndSummarize(input, publicationHash)
      const terminalPublication: KnowledgeTerminalPublication = {
        kind: "knowledge",
        inputFingerprint: input.inputFingerprint,
        expectedGraphRevision: input.expectedGraphRevision,
        indexedCommitSha: input.indexedCommitSha,
      }

      let activationResult: "activated" | "already_active" | "rejected"
      try {
        activationResult = await activate({ summary, terminalPublication })
      } catch (error) {
        throw new GraphPublicationError("activation_indeterminate", {
          cause: error,
        })
      }
      if (!["activated", "already_active"].includes(activationResult)) {
        throw new GraphPublicationError("activation_failed")
      }

      try {
        await this.finalize(input, publicationHash)
      } catch (error) {
        throw new GraphPublicationError("finalization_failed", { cause: error })
      }
      return summary
    } catch (error) {
      if (
        !(error instanceof GraphPublicationError) ||
        !["activation_indeterminate", "finalization_failed"].includes(
          error.code
        )
      ) {
        await this.rollbackPending(input, publicationHash).catch(
          () => undefined
        )
      }
      throw error
    }
  }

  private async assertRevisionAvailable(
    input: GraphPublicationInput,
    publicationHash: string
  ): Promise<"current" | "new"> {
    return this.database.read(
      {
        applicationId: input.applicationId,
        runId: input.runId,
        operation: "check_graph_revision",
      },
      async (transaction) => {
        if (input.replacement.kind === "affected") {
          const source = await transaction.run(
            `MATCH (root:Application {
               application_id: $applicationId,
               stable_key: $applicationId,
               graph_revision: $expectedGraphRevision
             })
             RETURN count(root) AS sourceCount`,
            {
              applicationId: input.applicationId,
              expectedGraphRevision: input.expectedGraphRevision,
            }
          )
          if (countFromResult(source.records, "sourceCount") !== 1) {
            throw new GraphPublicationError("revision_conflict")
          }
        }
        const conflict = await transaction.run(
          `CALL {
             MATCH (n {
               application_id: $applicationId,
               graph_revision: $graphRevision
             })
             WHERE n.publication_hash IS NULL OR
                   n.publication_hash <> $publicationHash
             RETURN count(n) AS nodeConflicts
           }
           CALL {
             MATCH ()-[r {
               application_id: $applicationId,
               graph_revision: $graphRevision
             }]-()
             WHERE r.publication_hash IS NULL OR
                   r.publication_hash <> $publicationHash
             RETURN count(r) AS relationshipConflicts
           }
           RETURN nodeConflicts + relationshipConflicts AS conflictCount`,
          {
            applicationId: input.applicationId,
            graphRevision: input.graphRevision,
            publicationHash,
          }
        )
        if (countFromResult(conflict.records, "conflictCount") > 0) {
          throw new GraphPublicationError("staging_conflict")
        }
        const state = await transaction.run(
          `MATCH (root:Application {
             application_id: $applicationId,
             stable_key: $applicationId,
             graph_revision: $graphRevision,
             publication_hash: $publicationHash
           })
           RETURN count(CASE WHEN root.publication_status = 'current' THEN 1 END) AS currentCount,
                  count(CASE WHEN root.publication_status = 'historical' THEN 1 END) AS historicalCount`,
          {
            applicationId: input.applicationId,
            graphRevision: input.graphRevision,
            publicationHash,
          }
        )
        if (countFromResult(state.records, "historicalCount") > 0) {
          throw new GraphPublicationError("revision_conflict")
        }
        return countFromResult(state.records, "currentCount") === 1
          ? "current"
          : "new"
      }
    )
  }

  private async copyUnaffectedNodes(
    input: GraphPublicationInput,
    publicationHash: string,
    affectedStableKeys: readonly string[]
  ): Promise<void> {
    for (const kind of entityKindSchema.options) {
      let copiedCount: number
      do {
        copiedCount = await this.database.write(
          {
            applicationId: input.applicationId,
            runId: input.runId,
            operation: "copy_graph_nodes",
          },
          async (transaction) => {
            const result = await transaction.run(nodeCopyStatement(kind), {
              applicationId: input.applicationId,
              expectedGraphRevision: input.expectedGraphRevision,
              graphRevision: input.graphRevision,
              publicationHash,
              affectedStableKeys,
              batchSize: input.batchSize,
            })
            return countFromResult(result.records, "copiedCount")
          }
        )
      } while (copiedCount === input.batchSize)
    }
  }

  private async copyUnaffectedRelationships(
    input: GraphPublicationInput,
    publicationHash: string,
    affectedStableKeys: readonly string[]
  ): Promise<void> {
    for (const type of evidenceRelationshipSchema.options) {
      let copiedCount: number
      do {
        copiedCount = await this.database.write(
          {
            applicationId: input.applicationId,
            runId: input.runId,
            operation: "copy_graph_links",
          },
          async (transaction) => {
            const result = await transaction.run(
              relationshipCopyStatement(type),
              {
                applicationId: input.applicationId,
                expectedGraphRevision: input.expectedGraphRevision,
                graphRevision: input.graphRevision,
                publicationHash,
                affectedStableKeys,
                batchSize: input.batchSize,
              }
            )
            return countFromResult(result.records, "copiedCount")
          }
        )
      } while (copiedCount === input.batchSize)
    }
  }

  private async stageNodes(
    input: GraphPublicationInput,
    publicationHash: string
  ): Promise<void> {
    const staged = input.nodes.map(toStagedNode)
    for (const kind of entityKindSchema.options) {
      const matching = staged.filter((node) => node.kind === kind)
      for (const batch of chunks(matching, input.batchSize)) {
        await this.database.write(
          {
            applicationId: input.applicationId,
            runId: input.runId,
            operation: "stage_graph_nodes",
          },
          async (transaction) => {
            const result = await transaction.run(nodeStageStatement(kind), {
              applicationId: input.applicationId,
              graphRevision: input.graphRevision,
              publicationHash,
              entityKind: kind,
              facts: batch.map((node) => ({
                stableKey: node.stableKey,
                properties: node.properties,
                extractionMethod: node.extractionMethod,
                evidenceTier: node.evidenceTier,
                evidenceIds: node.evidenceIds,
                provenanceJson: node.provenanceJson,
                reviewState: node.reviewState,
              })) as readonly GraphParameter[],
            })
            if (
              countFromResult(result.records, "writtenCount") !== batch.length
            ) {
              throw new GraphPublicationError("staging_conflict")
            }
          }
        )
      }
    }
  }

  private relationshipFacts(
    input: GraphPublicationInput
  ): readonly StagedRelationship[] {
    const evidenceById = new Map(
      input.evidence.map((record) => [String(record.reference.id), record])
    )
    return input.links.map((link) => {
      const evidence = link.evidenceIds.map((evidenceId) => {
        const record = evidenceById.get(String(evidenceId))
        if (record === undefined) {
          throw new GraphPublicationError("validation_failed")
        }
        return {
          evidenceId: record.reference.id,
          extractionMethod: record.extractionMethod,
          provenance: record.provenance,
        }
      })
      const sourceUri = evidence
        .map(({ provenance }) =>
          "sourceUri" in provenance ? provenance.sourceUri : undefined
        )
        .find((value) => value !== undefined)
      const sourceIdentityHash = hashCanonical({
        kind: "published_graph_link_evidence",
        evidence,
      })
      return {
        type: link.relationship,
        stableKey: link.id,
        fromStableKey: link.fromId,
        toStableKey: link.toId,
        properties: withoutUndefined({
          extraction_method: link.extractionMethod,
          evidence_tier: link.evidenceTier,
          explanation: link.explanation,
          evidence_explanation: link.explanation,
          evidence_ids: link.evidenceIds,
          evidence_provenance_json: evidence.map((item) =>
            JSON.stringify(item)
          ),
          source_commit_sha: link.sourceCommitSha,
          crawl_run_id: link.crawlRunId,
          source_run_id: link.crawlRunId,
          source_identity_hash: sourceIdentityHash,
          source_uri: sourceUri,
          artifact_id: link.artifactId,
          evidence_ref: link.evidenceIds[0],
          review_state: link.reviewState,
          last_confirmed_at: link.lastConfirmedAt,
          stale: false,
        }),
      }
    })
  }

  private async stageRelationships(
    input: GraphPublicationInput,
    publicationHash: string
  ): Promise<void> {
    const staged = this.relationshipFacts(input)
    for (const type of evidenceRelationshipSchema.options) {
      const matching = staged.filter(
        (relationship) => relationship.type === type
      )
      for (const batch of chunks(matching, input.batchSize)) {
        await this.database.write(
          {
            applicationId: input.applicationId,
            runId: input.runId,
            operation: "stage_graph_links",
          },
          async (transaction) => {
            const result = await transaction.run(
              relationshipStageStatement(type),
              {
                applicationId: input.applicationId,
                graphRevision: input.graphRevision,
                publicationHash,
                facts: batch.map((relationship) => ({
                  stableKey: relationship.stableKey,
                  fromStableKey: relationship.fromStableKey,
                  toStableKey: relationship.toStableKey,
                  properties: relationship.properties,
                })) as readonly GraphParameter[],
              }
            )
            if (
              countFromResult(result.records, "writtenCount") !== batch.length
            ) {
              throw new GraphPublicationError("validation_failed")
            }
          }
        )
      }
    }
  }

  private async validateAndSummarize(
    input: GraphPublicationInput,
    publicationHash: string,
    markValidated = true
  ): Promise<GraphPublicationSummary> {
    return this.database.write(
      {
        applicationId: input.applicationId,
        runId: input.runId,
        operation: "validate_graph_publication",
      },
      async (transaction) => {
        const parameters = {
          applicationId: input.applicationId,
          graphRevision: input.graphRevision,
          publicationHash,
        }
        const validation = await transaction.run(
          `CALL {
             MATCH (n {
               application_id: $applicationId,
               graph_revision: $graphRevision,
               publication_hash: $publicationHash
             })
             RETURN count(n) AS nodeCount,
                    count(CASE WHEN n:Application AND n.stable_key = $applicationId THEN 1 END) AS rootCount,
                    count(CASE WHEN n.evidence_tier = 'D' THEN 1 END) AS forbiddenNodeCount
           }
           CALL {
             MATCH (from)-[r {
               application_id: $applicationId,
               graph_revision: $graphRevision,
               publication_hash: $publicationHash
             }]->(to)
             RETURN count(r) AS relationshipCount,
                    count(CASE WHEN
                      r.evidence_tier = 'D' OR
                      r.review_state IN ['pending', 'rejected'] OR
                      size(coalesce(r.evidence_ids, [])) = 0 OR
                      r.evidence_provenance_json IS NULL OR
                      from.application_id <> $applicationId OR
                      to.application_id <> $applicationId OR
                      from.graph_revision <> $graphRevision OR
                      to.graph_revision <> $graphRevision OR
                      from.publication_hash <> $publicationHash OR
                      to.publication_hash <> $publicationHash
                    THEN 1 END) AS invalidRelationshipCount
           }
           CALL {
             MATCH path = (:DocumentSource {
               application_id: $applicationId,
               graph_revision: $graphRevision,
               publication_hash: $publicationHash
             })-[:HAS_PAGE {graph_revision: $graphRevision}]->
             (:DocumentPage)-[:HAS_SECTION {graph_revision: $graphRevision}]->
             (:DocumentSection)-[:STATES {graph_revision: $graphRevision}]->
             (requirement:Requirement)-[:COVERED_BY {graph_revision: $graphRevision}]->
             (:Workflow)-[:HAS_STEP {graph_revision: $graphRevision}]->
             (:FlowStep)-[:ACTS_ON {graph_revision: $graphRevision}]->
             (:UIElement)-[:TRIGGERS_API {graph_revision: $graphRevision}]->
             (:APIEndpoint)-[:HANDLED_BY {graph_revision: $graphRevision}]->
             (:CodeSymbol)
             WHERE all(n IN nodes(path) WHERE
               n.application_id = $applicationId AND
               n.graph_revision = $graphRevision AND
               n.publication_hash = $publicationHash
             ) AND all(r IN relationships(path) WHERE
               r.application_id = $applicationId AND
               r.graph_revision = $graphRevision AND
               r.publication_hash = $publicationHash
             )
             MATCH (requirement)-[:HAS_ASSESSMENT {
               application_id: $applicationId,
               graph_revision: $graphRevision,
               publication_hash: $publicationHash
             }]->(:CoverageAssessment {
               application_id: $applicationId,
               graph_revision: $graphRevision,
               publication_hash: $publicationHash
             })
             RETURN count(requirement) AS completePathCount
           }
           RETURN nodeCount, rootCount, forbiddenNodeCount,
                  relationshipCount, invalidRelationshipCount,
                  completePathCount`,
          parameters
        )
        const nodeCount = countFromResult(validation.records, "nodeCount")
        const relationshipCount = countFromResult(
          validation.records,
          "relationshipCount"
        )
        if (
          countFromResult(validation.records, "rootCount") !== 1 ||
          countFromResult(validation.records, "forbiddenNodeCount") !== 0 ||
          countFromResult(validation.records, "invalidRelationshipCount") !==
            0 ||
          countFromResult(validation.records, "completePathCount") < 1
        ) {
          throw new GraphPublicationError("validation_failed")
        }

        const nodeCountsResult = await transaction.run(
          `MATCH (n {
             application_id: $applicationId,
             graph_revision: $graphRevision,
             publication_hash: $publicationHash
           })
           RETURN n.entity_kind AS key, count(n) AS count`,
          parameters
        )
        const relationshipCountsResult = await transaction.run(
          `MATCH ()-[r {
             application_id: $applicationId,
             graph_revision: $graphRevision,
             publication_hash: $publicationHash
           }]->()
           RETURN type(r) AS key, count(r) AS count`,
          parameters
        )
        const coverageCountsResult = await transaction.run(
          `MATCH (n:CoverageAssessment {
             application_id: $applicationId,
             graph_revision: $graphRevision,
             publication_hash: $publicationHash
           })
           RETURN n.coverage_status AS key, count(n) AS count`,
          parameters
        )
        const tierCountsResult = await transaction.run(
          `MATCH ()-[r {
             application_id: $applicationId,
             graph_revision: $graphRevision,
             publication_hash: $publicationHash
           }]->()
           RETURN r.evidence_tier AS key, count(r) AS count`,
          parameters
        )
        if (markValidated) {
          await transaction.run(
            `MATCH (n {
               application_id: $applicationId,
               graph_revision: $graphRevision,
               publication_hash: $publicationHash
             })
             SET n.publication_status = 'validated'
             WITH count(n) AS nodes
             MATCH ()-[r {
               application_id: $applicationId,
               graph_revision: $graphRevision,
               publication_hash: $publicationHash
             }]->()
             SET r.publication_status = 'validated'
             RETURN nodes, count(r) AS relationships`,
            parameters
          )
        }

        return graphPublicationSummarySchema.parse({
          schemaVersion: 1,
          applicationId: input.applicationId,
          runId: input.runId,
          inputFingerprint: input.inputFingerprint,
          indexedCommitSha: input.indexedCommitSha,
          expectedGraphRevision: input.expectedGraphRevision,
          graphRevision: input.graphRevision,
          publicationHash,
          replacementKind: input.replacement.kind,
          nodeCounts: groupedCounts(
            nodeCountsResult.records,
            entityKindSchema.options
          ),
          relationshipCounts: groupedCounts(
            relationshipCountsResult.records,
            evidenceRelationshipSchema.options
          ),
          coverageCounts: groupedCounts(
            coverageCountsResult.records,
            coverageStatusSchema.options
          ),
          evidenceTierCounts: groupedCounts(tierCountsResult.records, [
            "A",
            "B",
            "C",
          ]),
          nodeCount,
          relationshipCount,
          retainedEvidenceCount: input.retainedEvidenceIds.length,
          publishedAt: this.now().toISOString(),
        })
      }
    )
  }

  private async finalize(
    input: GraphPublicationInput,
    publicationHash: string
  ): Promise<void> {
    await this.database.write(
      {
        applicationId: input.applicationId,
        runId: input.runId,
        operation: "finalize_graph_publication",
      },
      async (transaction) => {
        const parameters = {
          applicationId: input.applicationId,
          expectedGraphRevision: input.expectedGraphRevision,
          graphRevision: input.graphRevision,
          publicationHash,
          retainedEvidenceIds: input.retainedEvidenceIds,
        }
        await transaction.run(
          `MATCH (n {
             application_id: $applicationId,
             graph_revision: $graphRevision,
             publication_hash: $publicationHash
           })
           SET n.publication_status = 'current', n.updated_at = datetime()
           WITH count(n) AS nodes
           MATCH ()-[r {
             application_id: $applicationId,
             graph_revision: $graphRevision,
             publication_hash: $publicationHash
           }]->()
           SET r.publication_status = 'current', r.updated_at = datetime()
           RETURN nodes, count(r) AS relationships`,
          parameters
        )
        await transaction.run(
          `MATCH (from)-[r {
             application_id: $applicationId,
             graph_revision: $expectedGraphRevision
           }]->(to)
           WHERE r.stable_key IN $retainedEvidenceIds OR
                 any(id IN coalesce(r.evidence_ids, []) WHERE id IN $retainedEvidenceIds)
           SET r.publication_status = 'historical',
               from.publication_status = 'historical',
               to.publication_status = 'historical'`,
          parameters
        )
        await transaction.run(
          `MATCH ()-[r {
             application_id: $applicationId,
             graph_revision: $expectedGraphRevision
           }]->()
           WHERE r.publication_status <> 'historical' OR
                 r.publication_status IS NULL
           DELETE r`,
          parameters
        )
        await transaction.run(
          `MATCH (n {
             application_id: $applicationId,
             graph_revision: $expectedGraphRevision
           })
           WHERE n.publication_status <> 'historical' OR
                 n.publication_status IS NULL
           DETACH DELETE n`,
          parameters
        )
      }
    )
  }

  private async rollbackPending(
    input: GraphPublicationInput,
    publicationHash: string
  ): Promise<void> {
    await this.database.write(
      {
        applicationId: input.applicationId,
        runId: input.runId,
        operation: "rollback_graph_publication",
      },
      async (transaction: GraphTransaction) => {
        await transaction.run(
          `MATCH (n {
             application_id: $applicationId,
             graph_revision: $graphRevision,
             publication_hash: $publicationHash
           })
           DETACH DELETE n`,
          {
            applicationId: input.applicationId,
            graphRevision: input.graphRevision,
            publicationHash,
          }
        )
      }
    )
  }
}
