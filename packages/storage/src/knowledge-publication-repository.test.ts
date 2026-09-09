import {
  coverageStatusSchema,
  entityKindSchema,
  evidenceRelationshipSchema,
  graphPublicationSummarySchema,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import type { DatabaseExecutor, SqlParameter } from "./database.ts"
import { KnowledgePublicationRepository } from "./knowledge-publication-repository.ts"

const applicationId = `application:v1:${"a".repeat(64)}`
const runId = "run:11111111-1111-4111-8111-111111111111"

const summary = graphPublicationSummarySchema.parse({
  schemaVersion: 1,
  applicationId,
  runId,
  inputFingerprint: `sha256:${"b".repeat(64)}`,
  indexedCommitSha: "c".repeat(40),
  expectedGraphRevision: 2,
  graphRevision: 3,
  publicationHash: `sha256:${"d".repeat(64)}`,
  replacementKind: "affected",
  nodeCounts: Object.fromEntries(
    entityKindSchema.options.map((kind) => [
      kind,
      kind === "requirement" ? 2 : 0,
    ])
  ),
  relationshipCounts: Object.fromEntries(
    evidenceRelationshipSchema.options.map((type) => [
      type,
      type === "COVERED_BY" ? 1 : 0,
    ])
  ),
  coverageCounts: Object.fromEntries(
    coverageStatusSchema.options.map((status) => [
      status,
      status === "not_observed" ? 1 : 0,
    ])
  ),
  evidenceTierCounts: { A: 1, B: 0, C: 0 },
  nodeCount: 2,
  relationshipCount: 1,
  retainedEvidenceCount: 0,
  publishedAt: "2026-09-09T00:00:00.000Z",
})

class RecordingDatabase implements DatabaseExecutor {
  readonly queries: {
    readonly statement: string
    readonly parameters: readonly SqlParameter[]
  }[] = []

  constructor(private readonly rows: readonly Record<string, unknown>[]) {}

  query<Row extends Record<string, unknown>>(
    statement: string,
    parameters: readonly SqlParameter[] = []
  ): Promise<readonly Row[]> {
    this.queries.push({ statement, parameters })
    return Promise.resolve(this.rows as readonly Row[])
  }
}

describe("knowledge publication summaries", () => {
  it("records a summary only through an activated application and succeeded run", async () => {
    const database = new RecordingDatabase([{ summary }])
    const repository = new KnowledgePublicationRepository(database)

    await expect(repository.recordActivated(summary)).resolves.toEqual(summary)
    expect(database.queries[0]?.statement).toContain(
      "application.graph_revision = $2"
    )
    expect(database.queries[0]?.statement).toContain("run.status = 'succeeded'")
    expect(database.queries[0]?.statement).toContain(
      "knowledge_publications.publication_hash = excluded.publication_hash"
    )
    expect(database.queries[0]?.parameters.slice(0, 5)).toEqual([
      applicationId,
      3,
      "11111111-1111-4111-8111-111111111111",
      summary.publicationHash,
      summary.indexedCommitSha,
    ])
  })

  it("fails closed when the active revision does not match", async () => {
    const repository = new KnowledgePublicationRepository(
      new RecordingDatabase([])
    )
    await expect(repository.recordActivated(summary)).rejects.toThrow(
      "not activated"
    )
  })

  it("reads only the owner-scoped summary at the application's current revision", async () => {
    const database = new RecordingDatabase([{ summary }])
    const repository = new KnowledgePublicationRepository(database)

    await expect(
      repository.getOwnedCurrent({
        operatorId: "22222222-2222-4222-8222-222222222222",
        applicationId,
      })
    ).resolves.toEqual(summary)
    expect(database.queries[0]?.statement).toContain(
      "onboarding.operator_id = $1::uuid"
    )
    expect(database.queries[0]?.statement).toContain(
      "publication.graph_revision = application.graph_revision"
    )
  })
})
