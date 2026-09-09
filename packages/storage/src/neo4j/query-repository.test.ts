import { applicationIdSchema, stableEntityIdSchema } from "@sentinel/contracts"
import type { Record as Neo4jRecord } from "neo4j-driver"
import { describe, expect, it } from "vitest"

import type {
  GraphDatabase,
  GraphParameter,
  GraphQueryResult,
  GraphTransaction,
  GraphTransactionContext,
  Neo4jHealthResult,
} from "./database.ts"
import { Neo4jGraphQueryRepository } from "./query-repository.ts"

const applicationId = applicationIdSchema.parse(
  `application:v1:${"a".repeat(64)}`
)
const requirementId = stableEntityIdSchema.parse(
  `requirement:v1:${"b".repeat(64)}`
)
const symbolId = stableEntityIdSchema.parse(`code-symbol:v1:${"c".repeat(64)}`)
const evidenceId = `evidence:v1:${"d".repeat(64)}`
const artifactId = `artifact:v1:${"e".repeat(64)}`
const timestamp = "2026-09-09T00:00:00.000Z"

function entity(id: string, kind: string, title: string) {
  return {
    id,
    kind,
    title,
    evidenceTier: "A",
    evidenceIds: [],
    provenanceJson: JSON.stringify({
      sourceKind: "system",
      observedAt: timestamp,
    }),
    reviewState: "not_required",
    graphRevision: 3,
  }
}

const evidencePath = {
  nodes: [
    entity(symbolId, "code-symbol", "createOrder"),
    entity(requirementId, "requirement", "Buyers submit orders"),
  ],
  relationships: [
    {
      id: evidenceId,
      type: "CALLS",
      fromId: symbolId,
      toId: requirementId,
      evidenceTier: "A",
      extractionMethod: "source_reference",
      evidenceIds: [evidenceId],
      evidenceJson: [
        JSON.stringify({
          evidenceId,
          extractionMethod: "source_reference",
          provenance: { sourceKind: "system", observedAt: timestamp },
        }),
      ],
      sourceUri: "repository://src/order-service.ts",
      artifactId,
      reviewState: "not_required",
      graphRevision: 3,
    },
  ],
}

function record(values: Readonly<Record<string, unknown>>): Neo4jRecord {
  return { get: (key: string) => values[key] } as unknown as Neo4jRecord
}

class QueryDatabase implements GraphDatabase {
  readonly queries: {
    readonly cypher: string
    readonly parameters: Readonly<Record<string, GraphParameter>>
    readonly context: GraphTransactionContext
  }[] = []
  private context: GraphTransactionContext | undefined

  private readonly transaction: GraphTransaction = {
    run: async (cypher, parameters = {}): Promise<GraphQueryResult> => {
      if (this.context === undefined) throw new Error("missing context")
      this.queries.push({ cypher, parameters, context: this.context })
      if (cypher.includes("AS evidencePath")) {
        return { records: [record({ evidencePath })] }
      }
      if (cypher.includes("AS coverage")) {
        return {
          records: [
            record({
              coverage: {
                ...entity(
                  `coverage-assessment:v1:${"e".repeat(64)}`,
                  "coverage-assessment",
                  `coverage-assessment:v1:${"e".repeat(64)}`
                ),
                requirementId,
                status: "not_observed",
                scope: "Checkout",
                wording:
                  "The behavior was not observed within the explored scope.",
                reasonCode: "bounded_attempt_no_observation",
              },
            }),
          ],
        }
      }
      return {
        records: [
          record({ entity: entity(requirementId, "requirement", "Checkout") }),
        ],
      }
    },
  }

  private async execute<T>(
    context: GraphTransactionContext,
    work: (transaction: GraphTransaction) => Promise<T>
  ): Promise<T> {
    this.context = context
    try {
      return await work(this.transaction)
    } finally {
      this.context = undefined
    }
  }

  read<T>(
    context: GraphTransactionContext,
    work: (transaction: GraphTransaction) => Promise<T>
  ): Promise<T> {
    return this.execute(context, work)
  }

  write<T>(
    context: GraphTransactionContext,
    work: (transaction: GraphTransaction) => Promise<T>
  ): Promise<T> {
    return this.execute(context, work)
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

describe("Neo4j graph query repository", () => {
  it("returns typed requirement, workflow, UI, code, and coverage projections", async () => {
    const database = new QueryDatabase()
    const repository = new Neo4jGraphQueryRepository(database)
    const scope = { applicationId, graphRevision: 3 }

    await expect(repository.listRequirements(scope)).resolves.toHaveLength(1)
    await expect(repository.listWorkflows(scope)).resolves.toHaveLength(1)
    await expect(repository.listUserInterface(scope)).resolves.toHaveLength(1)
    await expect(repository.listCode(scope)).resolves.toHaveLength(1)
    await expect(repository.listCoverage(scope)).resolves.toMatchObject([
      { requirementId, status: "not_observed" },
    ])

    for (const query of database.queries) {
      expect(query.cypher).not.toContain(applicationId)
      expect(query.parameters).toMatchObject({
        applicationId,
        graphRevision: 3,
      })
    }
    expect(database.queries[0]?.parameters["kinds"]).toEqual([
      "requirement",
      "capability",
    ])
  })

  it("binds selected path filters and returns evidence with provenance", async () => {
    const database = new QueryDatabase()
    const repository = new Neo4jGraphQueryRepository(database)

    const paths = await repository.findEvidencePaths({
      applicationId,
      graphRevision: 3,
      startId: symbolId,
      endId: requirementId,
      relationshipTypes: ["CALLS"],
      evidenceTiers: ["A", "B"],
      maxDepth: 6,
      limit: 5,
    })

    expect(paths).toMatchObject([
      {
        relationships: [
          {
            id: evidenceId,
            evidenceTier: "A",
            evidence: [{ evidenceId, provenance: { sourceKind: "system" } }],
            sourceUri: "repository://src/order-service.ts",
            artifactId,
          },
        ],
      },
    ])
    const query = database.queries[0]
    expect(query?.cypher).toContain("[*1..12]")
    expect(query?.cypher).not.toContain(symbolId)
    expect(query?.cypher).not.toContain(requirementId)
    expect(query?.parameters).toMatchObject({
      startId: symbolId,
      endId: requirementId,
      maxDepth: 6,
      relationshipTypes: ["CALLS"],
    })
  })

  it("uses fixed PR traversal types and rejects unbounded or Tier D queries", async () => {
    const database = new QueryDatabase()
    const repository = new Neo4jGraphQueryRepository(database)

    await expect(
      repository.findPullRequestSeedPaths({
        applicationId,
        graphRevision: 3,
        changedSymbolIds: [symbolId],
        evidenceTiers: ["A"],
        maxDepth: 8,
        limit: 10,
      })
    ).resolves.toHaveLength(1)
    expect(database.queries[0]?.parameters["relationshipTypes"]).toContain(
      "HANDLED_BY"
    )

    await expect(
      repository.findEvidencePaths({
        applicationId,
        graphRevision: 3,
        startId: symbolId,
        endId: requirementId,
        relationshipTypes: ["CALLS"],
        evidenceTiers: ["D" as "A"],
        maxDepth: 13,
        limit: 5,
      })
    ).rejects.toThrow()
    expect(database.queries).toHaveLength(1)
  })

  it("accepts bounded file, symbol, endpoint, and domain PR impact seeds", async () => {
    const database = new QueryDatabase()
    const repository = new Neo4jGraphQueryRepository(database)
    const seeds = [
      `code-file:v1:${"1".repeat(64)}`,
      symbolId,
      `api-endpoint:v1:${"2".repeat(64)}`,
      `domain-entity:v1:${"3".repeat(64)}`,
    ].map((id) => stableEntityIdSchema.parse(id))

    await expect(
      repository.findPullRequestImpactPaths({
        applicationId,
        graphRevision: 3,
        seedIds: seeds,
        evidenceTiers: ["A", "B"],
        maxDepth: 8,
        limit: 20,
      })
    ).resolves.toHaveLength(1)

    expect(database.queries[0]?.context.operation).toBe("query_pr_impact_seeds")
    expect(database.queries[0]?.parameters).toMatchObject({ seedIds: seeds })
    expect(database.queries[0]?.cypher).not.toContain(seeds[0])
    expect(database.queries[0]?.cypher).not.toContain("shortestPath")
    expect(database.queries[0]?.cypher).toContain("allShortestPaths")
    expect(database.queries[0]?.cypher).toContain(
      "[r IN relationships(path) | r.stable_key]"
    )
    await expect(
      repository.findPullRequestImpactPaths({
        applicationId,
        graphRevision: 3,
        seedIds: [requirementId],
        evidenceTiers: ["A"],
        maxDepth: 8,
        limit: 20,
      })
    ).rejects.toThrow("PR impact seeds")
    expect(database.queries).toHaveLength(1)
  })

  it("queries bounded acyclic blast-radius candidates with fixed targets", async () => {
    const database = new QueryDatabase()
    const repository = new Neo4jGraphQueryRepository(database)

    await expect(
      repository.findBlastRadiusCandidates({
        applicationId,
        graphRevision: 3,
        seedIds: [symbolId],
        evidenceTiers: ["A", "B", "C"],
        maxDepth: 10,
        limit: 200,
      })
    ).resolves.toHaveLength(1)

    const query = database.queries[0]!
    expect(query.context.operation).toBe("query_blast_radius_candidates")
    expect(query.parameters).toMatchObject({
      seedIds: [symbolId],
      targetKinds: ["ui-element", "screen", "workflow", "requirement"],
      maxDepth: 10,
      limit: 200,
    })
    expect(query.parameters["relationshipTypes"]).toContain("NEXT")
    expect(query.parameters["relationshipTypes"]).not.toContain("STATES")
    expect(query.parameters["relationshipTypes"]).not.toContain("REQUIRES")
    expect(query.cypher).toContain("allShortestPaths")
    expect(query.cypher).toContain(":COVERED_BY|HAS_STEP|NEXT")
    expect(query.cypher).toContain(
      "single(other IN nodes(path) WHERE other = n)"
    )
    expect(query.cypher).not.toContain(symbolId)
    await expect(
      repository.findBlastRadiusCandidates({
        applicationId,
        graphRevision: 3,
        seedIds: [symbolId],
        evidenceTiers: ["D" as "A"],
        maxDepth: 11,
        limit: 501,
      })
    ).rejects.toThrow()
    expect(database.queries).toHaveLength(1)
  })
})
