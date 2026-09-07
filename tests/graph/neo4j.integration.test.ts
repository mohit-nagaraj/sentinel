import { hashCanonical, stableEntityIdSchema } from "@sentinel/contracts"
import {
  createNeo4jGraphDatabase,
  createTestGraphNamespace,
  loadNeo4jEnvironment,
  loadNeo4jIntegrationEnvironment,
  Neo4jFactRepository,
  toNativeGraphValue,
  type GraphDatabase,
} from "@sentinel/storage"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const enabled = process.env["RUN_NEO4J_INTEGRATION_TESTS"] === "1"
const describeIntegration = enabled ? describe : describe.skip

function entityId(kind: "requirement" | "workflow", seed: string): string {
  const digest = hashCanonical({ kind, seed }).slice("sha256:".length)
  return stableEntityIdSchema.parse(`${kind}:v1:${digest}`)
}

describeIntegration("Neo4j Aura graph foundation", () => {
  let database: GraphDatabase
  let repository: Neo4jFactRepository
  let namespaceA: ReturnType<typeof createTestGraphNamespace>
  let namespaceB: ReturnType<typeof createTestGraphNamespace>
  let requirementId: string
  let workflowId: string

  beforeAll(async () => {
    const environment = loadNeo4jEnvironment(process.env)
    const integration = loadNeo4jIntegrationEnvironment(process.env)
    namespaceA = createTestGraphNamespace(
      integration.SENTINEL_NEO4J_TEST_PREFIX
    )
    namespaceB = createTestGraphNamespace(
      `${integration.SENTINEL_NEO4J_TEST_PREFIX.slice(0, -1)}${
        integration.SENTINEL_NEO4J_TEST_PREFIX.endsWith("f") ? "0" : "f"
      }`
    )
    requirementId = entityId("requirement", namespaceA.applicationId)
    workflowId = entityId("workflow", namespaceA.applicationId)
    database = createNeo4jGraphDatabase(environment)
    repository = new Neo4jFactRepository(database)

    expect(await database.health()).toMatchObject({ status: "ok" })
    await repository.bootstrap()
    await repository.bootstrap()
    for (const namespace of [namespaceA, namespaceB]) {
      await repository.mergeNode({
        applicationId: namespace.applicationId,
        kind: "application",
        stableKey: namespace.applicationId,
        graphRevision: 1,
        properties: { test_namespace: namespace.testPrefix },
      })
    }
  }, 60_000)

  afterAll(async () => {
    if (repository !== undefined) {
      if (namespaceA !== undefined) {
        await repository.cleanupTestNamespace(
          namespaceA.applicationId,
          namespaceA.testPrefix
        )
      }
      if (namespaceB !== undefined) {
        await repository.cleanupTestNamespace(
          namespaceB.applicationId,
          namespaceB.testPrefix
        )
      }
    }
    await database?.close()
  }, 60_000)

  it("creates the full idempotent constraint set", async () => {
    const count = await database.read(
      { operation: "verify_graph_constraints" },
      async (transaction) => {
        const result = await transaction.run(
          `SHOW CONSTRAINTS YIELD name
           WHERE name STARTS WITH 'sentinel_'
           RETURN count(*) AS count`
        )
        return toNativeGraphValue(result.records[0]?.get("count"))
      }
    )
    expect(count).toBeGreaterThanOrEqual(39)
  })

  it("merges duplicate facts and round-trips a relationship", async () => {
    const requirement = {
      applicationId: namespaceA.applicationId,
      kind: "requirement" as const,
      stableKey: requirementId,
      graphRevision: 1,
      properties: {
        statement: "literal '}) MATCH (n) DETACH DELETE n //",
      },
    }
    await repository.mergeNode(requirement)
    await repository.mergeNode({
      ...requirement,
      graphRevision: 2,
      properties: { statement: "updated requirement" },
    })
    await expect(
      repository.mergeNode({
        ...requirement,
        properties: { statement: "stale requirement" },
      })
    ).rejects.toThrow("stale graph revision")
    await repository.mergeNode({
      applicationId: namespaceA.applicationId,
      kind: "workflow",
      stableKey: workflowId,
      graphRevision: 2,
      properties: { name: "checkout" },
    })
    const relationshipId = `evidence:v1:${hashCanonical({
      requirementId,
      workflowId,
    }).slice("sha256:".length)}`
    await repository.mergeRelationship({
      applicationId: namespaceA.applicationId,
      stableKey: relationshipId,
      type: "COVERED_BY",
      fromStableKey: requirementId,
      toStableKey: workflowId,
      graphRevision: 2,
      properties: { confidence: 0.95 },
    })

    const result = await database.read(
      {
        applicationId: namespaceA.applicationId,
        operation: "verify_graph_round_trip",
      },
      async (transaction) => {
        const query = await transaction.run(
          `MATCH (requirement:Requirement {
             application_id: $applicationId,
             stable_key: $requirementId
           })-[relationship:COVERED_BY]->(workflow:Workflow {
             application_id: $applicationId,
             stable_key: $workflowId
           })
           RETURN count(requirement) AS nodeCount,
                  requirement.graph_revision AS revision,
                  requirement.statement AS statement,
                  relationship.confidence AS confidence`,
          {
            applicationId: namespaceA.applicationId,
            requirementId,
            workflowId,
          }
        )
        const row = query.records[0]
        return {
          nodeCount: toNativeGraphValue(row?.get("nodeCount")),
          revision: toNativeGraphValue(row?.get("revision")),
          statement: toNativeGraphValue(row?.get("statement")),
          confidence: toNativeGraphValue(row?.get("confidence")),
        }
      }
    )
    expect(result).toEqual({
      nodeCount: 1,
      revision: 2,
      statement: "updated requirement",
      confidence: 0.95,
    })
  })

  it("rolls back a partial multi-write transaction", async () => {
    const rollbackId = entityId(
      "requirement",
      `${namespaceA.applicationId}:rollback`
    )
    await expect(
      database.write(
        {
          applicationId: namespaceA.applicationId,
          operation: "verify_graph_rollback",
        },
        async (transaction) => {
          await transaction.run(
            `CREATE (:Requirement {
               application_id: $applicationId,
               stable_key: $stableKey,
               graph_revision: 1
             })`,
            {
              applicationId: namespaceA.applicationId,
              stableKey: rollbackId,
            }
          )
          await transaction.run("THIS IS INTENTIONALLY INVALID CYPHER")
        }
      )
    ).rejects.toThrow()
    await expect(
      repository.readNode(namespaceA.applicationId, rollbackId)
    ).resolves.toBeNull()
  })

  it("cleans only the explicitly marked application namespace", async () => {
    await expect(
      repository.cleanupTestNamespace(
        namespaceA.applicationId,
        namespaceA.testPrefix
      )
    ).resolves.toBeGreaterThanOrEqual(3)
    await expect(
      repository.readNode(namespaceA.applicationId, requirementId)
    ).resolves.toBeNull()
    await expect(
      repository.readNode(namespaceB.applicationId, namespaceB.applicationId)
    ).resolves.toMatchObject({
      application_id: namespaceB.applicationId,
      test_namespace: namespaceB.testPrefix,
    })
  })
})
