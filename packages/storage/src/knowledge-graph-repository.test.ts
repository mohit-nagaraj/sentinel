import type { Record as Neo4jRecord } from "neo4j-driver"
import { describe, expect, it } from "vitest"

import type {
  GraphDatabase,
  GraphParameter,
  GraphQueryResult,
  GraphTransaction,
  GraphTransactionContext,
  Neo4jHealthResult,
} from "./neo4j/database.ts"
import { KnowledgeGraphQueryRepository } from "./knowledge-graph-repository.ts"

const applicationId = `application:v1:${"a".repeat(64)}`
const requirementA = `requirement:v1:${"b".repeat(64)}`
const requirementB = `requirement:v1:${"c".repeat(64)}`
const sectionId = `document-section:v1:${"d".repeat(64)}`
const symbolId = `code-symbol:v1:${"e".repeat(64)}`
const linkA = `evidence:v1:${"1".repeat(64)}`
const linkB = `evidence:v1:${"2".repeat(64)}`
const sourceHash = `sha256:${"f".repeat(64)}`

function record(values: Readonly<Record<string, unknown>>): Neo4jRecord {
  return { get: (key: string) => values[key] } as unknown as Neo4jRecord
}

class FixtureGraphDatabase implements GraphDatabase {
  readonly queries: {
    readonly context: GraphTransactionContext
    readonly cypher: string
    readonly parameters: Readonly<Record<string, GraphParameter>>
  }[] = []

  read<T>(
    context: GraphTransactionContext,
    work: (transaction: GraphTransaction) => Promise<T>
  ): Promise<T> {
    return work({
      run: async (cypher, parameters = {}): Promise<GraphQueryResult> => {
        this.queries.push({ context, cypher, parameters })
        switch (context.operation) {
          case "knowledge_overview_counts":
            return {
              records: [
                record({
                  entries: [
                    ["Requirement", 2],
                    ["Workflow", 1],
                    ["CodeSymbol", 4],
                  ],
                  ambiguousLinks: 1,
                }),
              ],
            }
          case "knowledge_requirement_coverage":
            return {
              records: [requirementA, requirementB].map((requirementId) =>
                record({
                  item: {
                    requirementId,
                    statement: "A buyer can complete checkout.",
                    capability: "complete checkout",
                    status: "not_observed",
                    summary:
                      "The behavior was not observed within the completed checkout scope.",
                    possibleCauses: ["The crawl may be incomplete."],
                    reviewerActions: ["Inspect another checkout state."],
                    workflowCount: 0,
                    evidenceTiers: [],
                    stale: false,
                  },
                })
              ),
            }
          case "knowledge_workflow_coverage":
            return {
              records: [
                record({
                  item: {
                    workflowId: `workflow:v1:${"7".repeat(64)}`,
                    name: "Buyer checkout",
                    actor: "Buyer",
                    requirementCount: 2,
                    screenCount: 3,
                    stepCount: 4,
                    status: "observed",
                    stale: false,
                  },
                }),
              ],
            }
          case "knowledge_selected_evidence_path":
            return {
              records: [
                record({
                  nodes: [
                    {
                      id: sectionId,
                      kind: "document-section",
                      label: "Checkout guide",
                      detail: null,
                    },
                    {
                      id: requirementA,
                      kind: "requirement",
                      label: "Complete checkout",
                    },
                    {
                      id: symbolId,
                      kind: "code-symbol",
                      label: "CheckoutController",
                    },
                  ],
                  links: [linkA, linkB].map((id) => ({
                    id,
                    relationship: "states",
                    tier: "A",
                    reviewState: "not_required",
                    extractionMethod: "document_parser",
                    sourceIdentityHash: sourceHash,
                    explanation: "Exact deterministic evidence.",
                    capturedAt: null,
                    stale: false,
                  })),
                }),
              ],
            }
          case "knowledge_link_review_candidates":
            return {
              records: [
                record({
                  item: {
                    kind: "link",
                    id: linkA,
                    relationship: "covered_by",
                    title: "Checkout mapping",
                    summary: "A semantic match needs review.",
                    tier: "C",
                    sourceIdentityHash: sourceHash,
                    from: {
                      id: requirementA,
                      kind: "requirement",
                      label: "Complete checkout",
                    },
                    to: {
                      id: `workflow:v1:${"7".repeat(64)}`,
                      kind: "workflow",
                      label: "Buyer checkout",
                    },
                    competingEvidence: [],
                    previousReviews: [],
                  },
                }),
              ],
            }
          default:
            return { records: [] }
        }
      },
    })
  }

  write<T>(): Promise<T> {
    throw new Error("not implemented")
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

describe("knowledge graph query repository", () => {
  it("returns bounded counts and scopes every read to application and revision", async () => {
    const database = new FixtureGraphDatabase()
    const repository = new KnowledgeGraphQueryRepository(database)
    await expect(
      repository.counts({ applicationId, graphRevision: 3 })
    ).resolves.toEqual({
      requirements: 2,
      workflows: 1,
      screens: 0,
      uiElements: 0,
      apiEndpoints: 0,
      codeSymbols: 4,
      ambiguousLinks: 1,
    })
    expect(database.queries[0]?.parameters).toMatchObject({
      applicationId,
      graphRevision: 3,
    })
    expect(database.queries[0]?.cypher).toContain(
      "node.application_id = $applicationId"
    )
    expect(database.queries[0]?.cypher).toContain(
      "link.graph_revision = $graphRevision"
    )
  })

  it("paginates requirements without interpolating filters", async () => {
    const database = new FixtureGraphDatabase()
    const repository = new KnowledgeGraphQueryRepository(database)
    const page = await repository.coverage({
      applicationId,
      graphRevision: 3,
      status: "not_observed",
      query: "checkout",
      limit: 1,
    })
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toBe(requirementA)
    expect(database.queries[0]?.parameters).toMatchObject({
      status: "not_observed",
      query: "checkout",
      limit: 2,
    })
    expect(database.queries[0]?.cypher).not.toContain("checkout")
  })

  it("returns a selected provenance-complete path and current review candidate", async () => {
    const database = new FixtureGraphDatabase()
    const repository = new KnowledgeGraphQueryRepository(database)
    const path = await repository.evidencePath({
      applicationId,
      graphRevision: 3,
      requirementId: requirementA,
    })
    const candidate = await repository.reviewCandidate({
      applicationId,
      graphRevision: 3,
      linkId: linkA,
    })
    expect(path).toMatchObject({ complete: true, requirementId: requirementA })
    expect(
      path?.links.every((link) => link.sourceIdentityHash === sourceHash)
    ).toBe(true)
    expect(candidate).toMatchObject({ id: linkA, tier: "C" })
    expect(database.queries.at(-1)?.parameters).toMatchObject({
      applicationId,
      graphRevision: 3,
      linkId: linkA,
      limit: 2,
    })
  })
})
