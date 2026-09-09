import neo4j, { type Record as Neo4jRecord } from "neo4j-driver"
import { describe, expect, it } from "vitest"

import type {
  GraphDatabase,
  GraphParameter,
  GraphQueryResult,
  GraphTransaction,
  GraphTransactionContext,
  Neo4jHealthResult,
} from "./database.ts"
import {
  createGraphRevisionNamespace,
  createTestGraphNamespace,
  Neo4jFactRepository,
  type GraphNodeFact,
  type GraphProperties,
} from "./repository.ts"

const applicationId =
  "application:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const requirementId =
  "requirement:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const workflowId =
  "workflow:v1:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
const evidenceId =
  "evidence:v1:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"

interface CapturedQuery {
  readonly cypher: string
  readonly parameters: Readonly<Record<string, GraphParameter>>
  readonly context: GraphTransactionContext
  readonly mode: "read" | "write"
}

function record(values: Readonly<Record<string, unknown>>): Neo4jRecord {
  return {
    get: (key: string) => values[key],
  } as unknown as Neo4jRecord
}

class RecordingGraphDatabase implements GraphDatabase {
  readonly queries: CapturedQuery[] = []
  private activeContext: GraphTransactionContext | undefined
  private activeMode: "read" | "write" = "read"

  constructor(private readonly rejectedRevisions = new Set<number>()) {}

  private readonly transaction: GraphTransaction = {
    run: async (cypher, parameters = {}): Promise<GraphQueryResult> => {
      if (this.activeContext === undefined) throw new Error("missing context")
      this.queries.push({
        cypher,
        parameters,
        context: this.activeContext,
        mode: this.activeMode,
      })
      if (cypher.includes("deletedCount")) {
        return { records: [record({ deletedCount: 2 })] }
      }
      if (cypher.includes("RETURN n ORDER BY")) {
        return {
          records: [
            record({
              n: new neo4j.types.Node(
                neo4j.int(1),
                ["Requirement"],
                {
                  application_id: applicationId,
                  properties: "ordinary property",
                  score: 7,
                },
                "test-node"
              ),
            }),
          ],
        }
      }
      if (
        typeof parameters["graphRevision"] === "number" &&
        this.rejectedRevisions.has(parameters["graphRevision"])
      ) {
        return { records: [] }
      }
      return { records: [record({ n: {} })] }
    },
  }

  private async execute<T>(
    mode: "read" | "write",
    context: GraphTransactionContext,
    work: (transaction: GraphTransaction) => Promise<T>
  ): Promise<T> {
    this.activeMode = mode
    this.activeContext = context
    try {
      return await work(this.transaction)
    } finally {
      this.activeContext = undefined
    }
  }

  read<T>(
    context: GraphTransactionContext,
    work: (transaction: GraphTransaction) => Promise<T>
  ): Promise<T> {
    return this.execute("read", context, work)
  }

  write<T>(
    context: GraphTransactionContext,
    work: (transaction: GraphTransaction) => Promise<T>
  ): Promise<T> {
    return this.execute("write", context, work)
  }

  health(): Promise<Neo4jHealthResult> {
    return Promise.resolve({
      status: "ok",
      database: "neo4j",
      serverAgent: "test",
      protocolVersion: "test",
    })
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

function requirementFact(
  properties: GraphProperties = { statement: "delete me? no" }
): GraphNodeFact {
  return {
    applicationId,
    kind: "requirement",
    stableKey: requirementId,
    graphRevision: 1,
    properties,
  }
}

describe("Neo4j fact repository", () => {
  it("uses allowlisted labels while binding all caller-controlled values", async () => {
    const database = new RecordingGraphDatabase()
    await new Neo4jFactRepository(database).mergeNode(
      requirementFact(),
      "run:11111111-1111-4111-8111-111111111111"
    )

    expect(database.queries).toHaveLength(1)
    expect(database.queries[0]?.cypher).toContain("MERGE (n:Requirement")
    expect(database.queries[0]?.cypher).not.toContain("delete me? no")
    expect(database.queries[0]?.parameters).toMatchObject({
      applicationId,
      stableKey: requirementId,
      properties: { statement: "delete me? no" },
    })
    expect(database.queries[0]?.context).toMatchObject({
      applicationId,
      runId: "run:11111111-1111-4111-8111-111111111111",
    })
  })

  it("rejects kind mismatches, reserved properties, and mixed arrays", async () => {
    const repository = new Neo4jFactRepository(new RecordingGraphDatabase())
    await expect(
      repository.mergeNode({ ...requirementFact(), kind: "workflow" })
    ).rejects.toThrow("does not match")
    await expect(
      repository.mergeNode(requirementFact({ application_id: "override" }))
    ).rejects.toThrow("reserved")
    await expect(
      repository.mergeNode(requirementFact({ values: [1, "2"] }))
    ).rejects.toThrow("unsupported array")
    await expect(
      repository.mergeNode(requirementFact({ password: "plaintext" }))
    ).rejects.toThrow("sensitive fields")
    for (const key of [
      "api_key",
      "api_key_value",
      "access_key_value",
      "connect_sid",
      "privatekey",
      "private_key_pem",
    ] as const) {
      await expect(
        repository.mergeNode(requirementFact({ [key]: "plaintext" }))
      ).rejects.toThrow("sensitive fields")
    }
    await expect(
      repository.mergeNode(
        requirementFact({ note: "authorization: Bearer must-not-persist" })
      )
    ).rejects.toThrow("unsafe persisted text")
    await expect(
      repository.mergeNode(requirementFact(), "run-1")
    ).rejects.toThrow("Invalid graph run identifier")
    await expect(
      repository.mergeNode(
        requirementFact(
          Object.fromEntries(
            Array.from({ length: 17 }, (_, index) => [
              `field_${index}`,
              "x".repeat(4_000),
            ])
          )
        )
      )
    ).rejects.toThrow("64 KiB")
  })

  it("rejects stale graph revisions instead of overwriting newer facts", async () => {
    const repository = new Neo4jFactRepository(
      new RecordingGraphDatabase(new Set([1]))
    )
    await expect(repository.mergeNode(requirementFact())).rejects.toThrow(
      "stale graph revision"
    )
  })

  it("validates relationship endpoints and binds relationship data", async () => {
    const database = new RecordingGraphDatabase()
    const repository = new Neo4jFactRepository(database)
    await repository.mergeRelationship({
      applicationId,
      stableKey: evidenceId,
      type: "COVERED_BY",
      fromStableKey: requirementId,
      toStableKey: workflowId,
      graphRevision: 2,
      properties: { confidence: 0.9 },
    })

    expect(database.queries[0]?.cypher).toContain("[r:COVERED_BY")
    expect(database.queries[0]?.cypher).not.toContain(evidenceId)
    expect(database.queries[0]?.parameters).toMatchObject({
      stableKey: evidenceId,
      fromStableKey: requirementId,
      toStableKey: workflowId,
    })
    await expect(
      new Neo4jFactRepository(
        new RecordingGraphDatabase(new Set([2]))
      ).mergeRelationship({
        applicationId,
        stableKey: evidenceId,
        type: "COVERED_BY",
        fromStableKey: requirementId,
        toStableKey: workflowId,
        graphRevision: 2,
        properties: {},
      })
    ).rejects.toThrow("graph revision is stale")
    await expect(
      repository.mergeRelationship({
        applicationId,
        stableKey: evidenceId,
        type: "COVERED_BY",
        fromStableKey: workflowId,
        toStableKey: requirementId,
        graphRevision: 2,
        properties: {},
      })
    ).rejects.toThrow("invalid source kind")
  })

  it("keeps atomic writes inside one application namespace", async () => {
    const repository = new Neo4jFactRepository(new RecordingGraphDatabase())
    const otherApplicationId =
      "application:v1:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    await expect(
      repository.mergeNodesAtomically(
        [
          requirementFact(),
          { ...requirementFact(), applicationId: otherApplicationId },
        ],
        { applicationId }
      )
    ).rejects.toThrow("cannot cross application namespaces")
  })

  it("reads mapped properties and gates cleanup on a strict test marker", async () => {
    const database = new RecordingGraphDatabase()
    const repository = new Neo4jFactRepository(database)
    await expect(
      repository.readNode(applicationId, requirementId)
    ).resolves.toEqual({
      application_id: applicationId,
      properties: "ordinary property",
      score: 7,
    })

    const namespace = createTestGraphNamespace("sentinel-test-a1b2c3d4")
    await expect(
      repository.cleanupTestNamespace(
        namespace.applicationId,
        namespace.testPrefix
      )
    ).resolves.toBe(2)
    const cleanup = database.queries.at(-1)
    expect(cleanup?.cypher).toContain("test_namespace: $testPrefix")
    expect(cleanup?.cypher).toContain("application_id: $applicationId")
    expect(cleanup?.cypher).not.toMatch(/MATCH \(n\)\s+DETACH DELETE n/)
    await expect(
      repository.cleanupTestNamespace(namespace.applicationId, "production")
    ).rejects.toThrow()
    await expect(
      repository.cleanupTestNamespace(applicationId, namespace.testPrefix)
    ).rejects.toThrow("identity does not match")
  })

  it("creates validated application and revision namespaces", () => {
    expect(createGraphRevisionNamespace(applicationId, 7)).toEqual({
      applicationId,
      graphRevision: 7,
    })
    expect(createTestGraphNamespace("sentinel-test-a1b2c3d4", 3)).toMatchObject(
      {
        graphRevision: 3,
        testPrefix: "sentinel-test-a1b2c3d4",
      }
    )
    expect(() => createGraphRevisionNamespace(applicationId, -1)).toThrow()
  })
})
