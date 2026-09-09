import {
  graphPublicationInputSchema,
  type GraphPublicationInput,
} from "@sentinel/contracts"
import type { Record as Neo4jRecord } from "neo4j-driver"
import { describe, expect, it, vi } from "vitest"

import type {
  GraphDatabase,
  GraphParameter,
  GraphQueryResult,
  GraphTransaction,
  GraphTransactionContext,
  Neo4jHealthResult,
} from "./database.ts"
import {
  GraphPublicationError,
  Neo4jGraphPublicationRepository,
} from "./publication-repository.ts"

const applicationId = `application:v1:${"a".repeat(64)}`
const runId = "run:11111111-1111-4111-8111-111111111111"
const commitSha = "b".repeat(40)
const timestamp = "2026-09-09T00:00:00.000Z"

function id(kind: string, digit: string): string {
  return `${kind}:v1:${digit.repeat(64)}`
}

const ids = {
  source: id("document-source", "1"),
  page: id("document-page", "2"),
  section: id("document-section", "3"),
  requirement: id("requirement", "4"),
  workflow: id("workflow", "5"),
  step: id("flow-step", "6"),
  element: id("ui-element", "7"),
  endpoint: id("api-endpoint", "8"),
  symbol: id("code-symbol", "9"),
  coverage: id("coverage-assessment", "c"),
}

const provenance = { sourceKind: "system" as const, observedAt: timestamp }

function link(
  digit: string,
  relationship: string,
  fromId: string,
  toId: string,
  graphRevision: number
) {
  const evidenceId = id("evidence", digit)
  return {
    link: {
      schemaVersion: 1 as const,
      id: evidenceId,
      applicationId,
      fromId,
      relationship,
      toId,
      extractionMethod: "source_reference",
      evidenceTier: "A" as const,
      explanation: `Evidence ${digit}`,
      evidenceIds: [evidenceId],
      reviewState: "not_required" as const,
      graphRevision,
      lastConfirmedAt: timestamp,
    },
    evidence: {
      reference: {
        schemaVersion: 1 as const,
        id: evidenceId,
        applicationId,
        runId,
        status: "validated" as const,
        kind: "graph_fixture",
        capturedAt: timestamp,
      },
      provenance,
      extractionMethod: "source_reference" as const,
      bindings: [{ fromId, relationship, toId }],
      summary: `Validated fixture evidence ${digit}`,
    },
  }
}

function publication(
  graphRevision = 1,
  replacement: unknown = { kind: "full" },
  batchSize = 250
): GraphPublicationInput {
  const expectedGraphRevision = graphRevision - 1
  const nodes = [
    {
      kind: "application",
      fact: {
        id: applicationId,
        applicationId,
        name: "Sentinel fixture",
        indexedCommitSha: commitSha,
      },
    },
    {
      kind: "document-source",
      fact: {
        id: ids.source,
        applicationId,
        kind: "web",
        rootUri: "https://example.test/docs",
        contentHash: `sha256:${"1".repeat(64)}`,
      },
    },
    {
      kind: "document-page",
      fact: {
        id: ids.page,
        applicationId,
        sourceId: ids.source,
        canonicalUri: "https://example.test/docs/checkout",
        title: "Checkout",
        contentHash: `sha256:${"2".repeat(64)}`,
        linkedPageIds: [],
      },
    },
    {
      kind: "document-section",
      fact: {
        id: ids.section,
        applicationId,
        pageId: ids.page,
        headingPath: ["Checkout"],
        excerpt: "Buyers can submit an order.",
        contentHash: `sha256:${"3".repeat(64)}`,
      },
    },
    {
      kind: "requirement",
      fact: {
        schemaVersion: 1,
        id: ids.requirement,
        applicationId,
        statement: "Buyers can submit an order.",
        capability: "submit order",
        testable: true,
        source: {
          sectionId: ids.section,
          uri: "https://example.test/docs/checkout",
          heading: "Checkout",
          excerpt: "Buyers can submit an order.",
          contentHash: `sha256:${"3".repeat(64)}`,
        },
      },
    },
    {
      kind: "workflow",
      fact: {
        id: ids.workflow,
        applicationId,
        name: "Submit checkout",
        actor: "buyer",
        sourceRunId: runId,
      },
    },
    {
      kind: "flow-step",
      fact: {
        id: ids.step,
        applicationId,
        workflowId: ids.workflow,
        ordinal: 0,
        actionType: "click",
        sourceRunId: runId,
      },
    },
    {
      kind: "ui-element",
      fact: {
        id: ids.element,
        applicationId,
        screenId: id("screen", "d"),
        role: "button",
        accessibleName: "Submit order",
        contextFingerprint: `sha256:${"4".repeat(64)}`,
        observedAt: timestamp,
        sourceRunId: runId,
      },
    },
    {
      kind: "api-endpoint",
      fact: {
        id: ids.endpoint,
        applicationId,
        method: "POST",
        normalizedPath: "/orders",
        sourceHash: `sha256:${"5".repeat(64)}`,
      },
    },
    {
      kind: "code-symbol",
      fact: {
        schemaVersion: 1,
        id: ids.symbol,
        applicationId,
        repository: { host: "github.com", owner: "Acme", name: "Shop" },
        commitSha,
        language: "typescript",
        kind: "handler",
        qualifiedName: "createOrder",
        filePath: "src/orders.ts",
        range: { startLine: 1, endLine: 10 },
      },
    },
    {
      kind: "coverage-assessment",
      fact: {
        schemaVersion: 1,
        id: ids.coverage,
        applicationId,
        requirementId: ids.requirement,
        status: "not_observed",
        scopeFingerprint: `sha256:${"6".repeat(64)}`,
        scopeSummary: "Checkout submit step",
        reasonCode: "bounded_attempt_no_observation",
        wording:
          "The behavior was not observed within the checkout states explored during this run.",
        attemptSummary: "The submit control and request were checked.",
        runId,
        graphRevision,
        evidenceIds: [],
        attemptEvidenceIds: [id("evidence", "f")],
        blockerKinds: [],
        requirementSourceHash: `sha256:${"3".repeat(64)}`,
        crawlConfigurationHash: `sha256:${"7".repeat(64)}`,
        authenticationRevision: 0,
        evaluatedAt: timestamp,
      },
    },
  ].map((node) => ({
    ...node,
    extractionMethod: "source_reference",
    evidenceTier: "A",
    evidenceIds: [],
    provenance,
    reviewState: "not_required",
  }))

  const linked = [
    link("1", "HAS_PAGE", ids.source, ids.page, graphRevision),
    link("2", "HAS_SECTION", ids.page, ids.section, graphRevision),
    link("3", "STATES", ids.section, ids.requirement, graphRevision),
    link("4", "COVERED_BY", ids.requirement, ids.workflow, graphRevision),
    link("5", "HAS_STEP", ids.workflow, ids.step, graphRevision),
    link("6", "ACTS_ON", ids.step, ids.element, graphRevision),
    link("7", "TRIGGERS_API", ids.element, ids.endpoint, graphRevision),
    link("8", "HANDLED_BY", ids.endpoint, ids.symbol, graphRevision),
    link("9", "HAS_ASSESSMENT", ids.requirement, ids.coverage, graphRevision),
  ]

  return graphPublicationInputSchema.parse({
    schemaVersion: 1,
    applicationId,
    runId,
    inputFingerprint: `sha256:${"a".repeat(64)}`,
    indexedCommitSha: commitSha,
    expectedGraphRevision,
    graphRevision,
    replacement,
    nodes: nodes.sort((left, right) =>
      left.fact.id.localeCompare(right.fact.id)
    ),
    links: linked
      .map(({ link }) => link)
      .sort((left, right) => left.id.localeCompare(right.id)),
    evidence: linked
      .map(({ evidence }) => evidence)
      .sort((left, right) =>
        left.reference.id.localeCompare(right.reference.id)
      ),
    retainedEvidenceIds: [],
    batchSize,
  })
}

function record(values: Readonly<Record<string, unknown>>): Neo4jRecord {
  return { get: (key: string) => values[key] } as unknown as Neo4jRecord
}

interface CapturedQuery {
  readonly cypher: string
  readonly parameters: Readonly<Record<string, GraphParameter>>
  readonly context: GraphTransactionContext
}

class PublicationDatabase implements GraphDatabase {
  readonly queries: CapturedQuery[] = []
  readonly events: string[] = []
  private context: GraphTransactionContext | undefined

  constructor(
    private readonly options: {
      readonly completePathCount?: number
      readonly failStage?: boolean
      readonly currentPublication?: boolean
    } = {}
  ) {}

  private readonly transaction: GraphTransaction = {
    run: async (cypher, parameters = {}): Promise<GraphQueryResult> => {
      if (this.context === undefined) throw new Error("missing context")
      this.queries.push({ cypher, parameters, context: this.context })
      this.events.push(
        cypher.includes("completePathCount") ? "validate" : "query"
      )
      if (this.options.failStage && cypher.includes("UNWIND $facts AS fact")) {
        throw new Error("injected stage failure")
      }
      if (cypher.includes("sourceCount")) {
        return { records: [record({ sourceCount: 1 })] }
      }
      if (cypher.includes("conflictCount")) {
        return { records: [record({ conflictCount: 0 })] }
      }
      if (cypher.includes("currentCount")) {
        return {
          records: [
            record({
              currentCount: this.options.currentPublication ? 1 : 0,
              historicalCount: 0,
            }),
          ],
        }
      }
      if (cypher.includes("writtenCount")) {
        return {
          records: [
            record({ writtenCount: (parameters["facts"] as unknown[]).length }),
          ],
        }
      }
      if (cypher.includes("copiedCount")) {
        return { records: [record({ copiedCount: 0 })] }
      }
      if (cypher.includes("completePathCount")) {
        return {
          records: [
            record({
              nodeCount: 11,
              rootCount: 1,
              forbiddenNodeCount: 0,
              relationshipCount: 9,
              invalidRelationshipCount: 0,
              completePathCount: this.options.completePathCount ?? 1,
            }),
          ],
        }
      }
      if (cypher.includes("RETURN n.entity_kind AS key")) {
        return {
          records: [
            record({ key: "application", count: 1 }),
            record({ key: "requirement", count: 1 }),
            record({ key: "coverage-assessment", count: 1 }),
          ],
        }
      }
      if (cypher.includes("RETURN type(r) AS key")) {
        return { records: [record({ key: "COVERED_BY", count: 1 })] }
      }
      if (cypher.includes("RETURN n.coverage_status AS key")) {
        return { records: [record({ key: "not_observed", count: 1 })] }
      }
      if (cypher.includes("RETURN r.evidence_tier AS key")) {
        return { records: [record({ key: "A", count: 9 })] }
      }
      return { records: [] }
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

describe("Neo4j graph publication", () => {
  it("rejects evidence that is not bound to the published endpoints", async () => {
    const database = new PublicationDatabase()
    const valid = publication()
    const invalid: GraphPublicationInput = {
      ...valid,
      evidence: valid.evidence.map((record, index) =>
        index === 0 ? { ...record, bindings: [] } : record
      ),
    }

    await expect(
      new Neo4jGraphPublicationRepository(database).publish(
        invalid,
        async () => "activated"
      )
    ).rejects.toThrow("bind the published relationship endpoints")
    expect(database.queries).toHaveLength(0)
  })

  it("stages, validates, activates, summarizes, and finalizes one revision", async () => {
    const database = new PublicationDatabase()
    const activate = vi.fn(async ({ terminalPublication }) => {
      database.events.push("activate")
      expect(terminalPublication).toEqual({
        kind: "knowledge",
        inputFingerprint: `sha256:${"a".repeat(64)}`,
        expectedGraphRevision: 0,
        indexedCommitSha: commitSha,
      })
      return "activated" as const
    })
    const repository = new Neo4jGraphPublicationRepository(
      database,
      () => new Date(timestamp)
    )

    const summary = await repository.publish(publication(), activate)

    expect(summary).toMatchObject({
      applicationId,
      runId,
      graphRevision: 1,
      nodeCount: 11,
      relationshipCount: 9,
      coverageCounts: { not_observed: 1 },
      evidenceTierCounts: { A: 9, B: 0, C: 0 },
      publishedAt: timestamp,
    })
    expect(database.events.indexOf("validate")).toBeLessThan(
      database.events.indexOf("activate")
    )
    expect(activate).toHaveBeenCalledOnce()
    expect(
      database.queries.some((query) =>
        query.cypher.includes("SET n.publication_status = 'current'")
      )
    ).toBe(true)
    expect(
      database.queries
        .filter((query) => query.cypher.includes("UNWIND $facts AS fact"))
        .every((query) =>
          query.cypher.includes("graph_revision: $graphRevision")
        )
    ).toBe(true)
    const coverageStage = database.queries.find((query) =>
      query.cypher.includes("MERGE (n:CoverageAssessment")
    )
    expect(
      (
        coverageStage?.parameters["facts"] as readonly {
          readonly properties: Readonly<Record<string, unknown>>
        }[]
      )[0]?.properties
    ).toMatchObject({
      status: "not_observed",
      summary:
        "The behavior was not observed within the checkout states explored during this run.",
      scope: "Checkout submit step",
      stale: false,
    })
    const relationshipStage = database.queries.find((query) =>
      query.cypher.includes("MERGE (from)-[r:COVERED_BY")
    )
    expect(
      (
        relationshipStage?.parameters["facts"] as readonly {
          readonly properties: Readonly<Record<string, unknown>>
        }[]
      )[0]?.properties
    ).toMatchObject({
      evidence_explanation: "Evidence 4",
      source_identity_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      stale: false,
    })
  })

  it("keeps the prior revision current after validation or activation failure", async () => {
    for (const [database, activate] of [
      [
        new PublicationDatabase({ completePathCount: 0 }),
        vi.fn(async () => "activated" as const),
      ],
      [new PublicationDatabase(), vi.fn(async () => "rejected" as const)],
    ] as const) {
      const repository = new Neo4jGraphPublicationRepository(database)
      await expect(
        repository.publish(publication(), activate)
      ).rejects.toBeInstanceOf(GraphPublicationError)
      expect(
        database.queries.some((query) =>
          query.cypher.includes("DETACH DELETE n")
        )
      ).toBe(true)
      expect(
        database.queries.some((query) =>
          query.cypher.includes("SET n.publication_status = 'current'")
        )
      ).toBe(false)
    }
  })

  it("copies unaffected facts in bounded batches for an affected refresh", async () => {
    const database = new PublicationDatabase()
    const input = publication(
      2,
      {
        kind: "affected",
        stableKeys: [ids.requirement],
      },
      2
    )
    await new Neo4jGraphPublicationRepository(database).publish(
      input,
      async () => "activated"
    )

    expect(
      database.queries.some((query) => query.cypher.includes("sourceCount"))
    ).toBe(true)
    const copyQueries = database.queries.filter((query) =>
      query.cypher.includes("RETURN count(copy) AS copiedCount")
    )
    expect(copyQueries).toHaveLength(17 + 22)
    expect(
      copyQueries.every((query) => query.parameters["batchSize"] === 2)
    ).toBe(true)
    expect(
      copyQueries.every((query) =>
        (query.parameters["affectedStableKeys"] as readonly string[]).includes(
          ids.requirement
        )
      )
    ).toBe(true)
    const relationshipCopy = copyQueries.find((query) =>
      query.cypher.includes("MATCH (oldFrom)-[old:")
    )
    expect(relationshipCopy?.cypher).toContain(
      "NOT oldFrom.stable_key IN $affectedStableKeys"
    )
    expect(relationshipCopy?.cypher).toContain(
      "NOT oldTo.stable_key IN $affectedStableKeys"
    )
  })

  it("treats unowned target-revision facts as publication conflicts", async () => {
    const database = new PublicationDatabase()
    await new Neo4jGraphPublicationRepository(database).publish(
      publication(),
      async () => "activated"
    )

    const conflictQuery = database.queries.find((query) =>
      query.cypher.includes("AS conflictCount")
    )
    expect(conflictQuery?.cypher).toContain("n.publication_hash IS NULL")
    expect(conflictQuery?.cypher).toContain("r.publication_hash IS NULL")
  })

  it("returns an already-current replay without staging or activating again", async () => {
    const database = new PublicationDatabase({ currentPublication: true })
    const activate = vi.fn(async () => "rejected" as const)

    const summary = await new Neo4jGraphPublicationRepository(
      database,
      () => new Date(timestamp)
    ).publish(publication(), activate)

    expect(summary.publicationHash).toMatch(/^sha256:/)
    expect(activate).not.toHaveBeenCalled()
    expect(
      database.queries.some((query) =>
        query.cypher.includes("UNWIND $facts AS fact")
      )
    ).toBe(false)
    expect(
      database.queries.some((query) => query.cypher.includes("DETACH DELETE n"))
    ).toBe(false)
  })

  it("rolls back partial staging and never calls activation after a write fails", async () => {
    const database = new PublicationDatabase({ failStage: true })
    const activate = vi.fn(async () => "activated" as const)

    await expect(
      new Neo4jGraphPublicationRepository(database).publish(
        publication(),
        activate
      )
    ).rejects.toThrow("injected stage failure")
    expect(activate).not.toHaveBeenCalled()
    expect(database.queries.at(-1)?.cypher.includes("DETACH DELETE n")).toBe(
      true
    )
  })

  it("preserves validated staging when activation outcome is indeterminate", async () => {
    const database = new PublicationDatabase()

    await expect(
      new Neo4jGraphPublicationRepository(database).publish(
        publication(),
        async () => {
          throw new Error("connection closed after commit")
        }
      )
    ).rejects.toMatchObject({ code: "activation_indeterminate" })
    expect(
      database.queries.some((query) => query.cypher.includes("DETACH DELETE n"))
    ).toBe(false)
    expect(
      database.queries.some((query) =>
        query.cypher.includes("SET n.publication_status = 'current'")
      )
    ).toBe(false)
  })
})
