import {
  createNeo4jGraphDatabase,
  createTestGraphNamespace,
  loadNeo4jEnvironment,
  loadNeo4jIntegrationEnvironment,
  KnowledgeGraphQueryRepository,
  Neo4jFactRepository,
  Neo4jGraphPublicationRepository,
  Neo4jGraphQueryRepository,
  toNativeGraphValue,
  type GraphDatabase,
} from "@sentinel/storage"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { createGraphPublicationFixture } from "../fixtures/graph-publication.ts"

const enabled = process.env["RUN_NEO4J_INTEGRATION_TESTS"] === "1"
const describeIntegration = enabled ? describe : describe.skip

describeIntegration("atomic graph publication and queries", () => {
  let database: GraphDatabase
  let facts: Neo4jFactRepository
  let publisher: Neo4jGraphPublicationRepository
  let queries: Neo4jGraphQueryRepository
  let knowledgeQueries: KnowledgeGraphQueryRepository
  let namespace: ReturnType<typeof createTestGraphNamespace>

  beforeAll(async () => {
    const environment = loadNeo4jEnvironment(process.env)
    const integration = loadNeo4jIntegrationEnvironment(process.env)
    const suffix = integration.SENTINEL_NEO4J_TEST_PREFIX.endsWith("e")
      ? "d"
      : "e"
    namespace = createTestGraphNamespace(
      `${integration.SENTINEL_NEO4J_TEST_PREFIX.slice(0, -1)}${suffix}`
    )
    database = createNeo4jGraphDatabase(environment)
    facts = new Neo4jFactRepository(database)
    publisher = new Neo4jGraphPublicationRepository(database)
    queries = new Neo4jGraphQueryRepository(database)
    knowledgeQueries = new KnowledgeGraphQueryRepository(database)
    await publisher.bootstrap()
  }, 60_000)

  afterAll(async () => {
    if (facts !== undefined && namespace !== undefined) {
      await facts.mergeNode({
        applicationId: namespace.applicationId,
        kind: "application",
        stableKey: namespace.applicationId,
        graphRevision: 1_000_000,
        properties: { test_namespace: namespace.testPrefix },
      })
      await facts.cleanupTestNamespace(
        namespace.applicationId,
        namespace.testPrefix
      )
    }
    await database?.close()
  }, 60_000)

  it("publishes, replays, rolls back invalid refresh, and replaces affected scope", async () => {
    const first = createGraphPublicationFixture({
      applicationId: namespace.applicationId,
      graphRevision: 1,
    })
    const activateFirst = vi.fn(async () => "activated" as const)
    const firstSummary = await publisher.publish(
      first.publication,
      activateFirst
    )
    expect(firstSummary.nodeCount).toBe(12)
    expect(activateFirst).toHaveBeenCalledOnce()

    await expect(
      queries.findEvidencePaths({
        applicationId: namespace.applicationId,
        graphRevision: 1,
        startId: first.ids.requirement,
        endId: first.ids.symbol,
        relationshipTypes: [
          "COVERED_BY",
          "HAS_STEP",
          "ACTS_ON",
          "TRIGGERS_API",
          "HANDLED_BY",
        ],
        evidenceTiers: ["A"],
        maxDepth: 8,
        limit: 5,
      })
    ).resolves.toHaveLength(1)
    await expect(
      queries.listCoverage({
        applicationId: namespace.applicationId,
        graphRevision: 1,
      })
    ).resolves.toMatchObject([{ status: "not_observed" }])
    await expect(
      knowledgeQueries.coverage({
        applicationId: namespace.applicationId,
        graphRevision: 1,
      })
    ).resolves.toMatchObject({
      items: [{ requirementId: first.ids.requirement, status: "not_observed" }],
    })
    await expect(
      knowledgeQueries.evidencePath({
        applicationId: namespace.applicationId,
        graphRevision: 1,
        requirementId: first.ids.requirement,
      })
    ).resolves.toMatchObject({ complete: true })

    const replayActivation = vi.fn(async () => "rejected" as const)
    await expect(
      publisher.publish(first.publication, replayActivation)
    ).resolves.toMatchObject({ publicationHash: firstSummary.publicationHash })
    expect(replayActivation).not.toHaveBeenCalled()

    const invalid = createGraphPublicationFixture({
      applicationId: namespace.applicationId,
      graphRevision: 2,
      omitRelationship: "HANDLED_BY",
    })
    const invalidActivation = vi.fn(async () => "activated" as const)
    await expect(
      publisher.publish(invalid.publication, invalidActivation)
    ).rejects.toMatchObject({ code: "validation_failed" })
    expect(invalidActivation).not.toHaveBeenCalled()
    await expect(
      queries.listRequirements({
        applicationId: namespace.applicationId,
        graphRevision: 1,
      })
    ).resolves.not.toHaveLength(0)

    const retainedEvidenceId = first.publication.links[0]!.id
    const refreshed = createGraphPublicationFixture({
      applicationId: namespace.applicationId,
      graphRevision: 2,
      replacement: {
        kind: "affected",
        stableKeys: [first.ids.requirement],
      },
      retainedEvidenceIds: [retainedEvidenceId],
      omitCapability: true,
    })
    await publisher.publish(refreshed.publication, async () => "activated")
    await expect(
      queries.listRequirements({
        applicationId: namespace.applicationId,
        graphRevision: 2,
      })
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.ids.capability }),
      ])
    )

    const retainedCount = await database.read(
      {
        applicationId: namespace.applicationId,
        operation: "verify_retained_graph_evidence",
      },
      async (transaction) => {
        const result = await transaction.run(
          `MATCH ()-[r {
             application_id: $applicationId,
             graph_revision: 1,
             stable_key: $evidenceId,
             publication_status: 'historical'
           }]->()
           RETURN count(r) AS count`,
          {
            applicationId: namespace.applicationId,
            evidenceId: retainedEvidenceId,
          }
        )
        return Number(toNativeGraphValue(result.records[0]?.get("count")))
      }
    )
    expect(retainedCount).toBe(1)
  }, 60_000)
})
