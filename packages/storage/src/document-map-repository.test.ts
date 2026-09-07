import { describe, expect, it } from "vitest"

import type {
  DatabaseClient,
  DatabaseExecutor,
  SqlParameter,
} from "./database.ts"
import {
  DocumentMapRepository,
  type PersistedDocumentMap,
} from "./document-map-repository.ts"

const applicationDatabaseId = "123e4567-e89b-42d3-a456-426614174000"
const applicationId = `application:v1:${"a".repeat(64)}`
const sourceId = `document-source:v1:${"b".repeat(64)}`
const pageId = `document-page:v1:${"c".repeat(64)}`
const sectionId = `document-section:v1:${"d".repeat(64)}`
const hash = `sha256:${"e".repeat(64)}`

class RecordingDatabase implements DatabaseClient {
  readonly calls: { statement: string; parameters: readonly SqlParameter[] }[] =
    []
  transactions = 0

  async query<Row extends Record<string, unknown>>(
    statement: string,
    parameters: readonly SqlParameter[] = []
  ): Promise<readonly Row[]> {
    this.calls.push({ statement, parameters })
    if (statement.includes("select canonical_uri")) {
      return [
        { canonical_uri: "https://docs.example.com/docs", content_hash: hash },
      ] as unknown as Row[]
    }
    return []
  }

  async transaction<T>(
    work: (executor: DatabaseExecutor) => Promise<T>
  ): Promise<T> {
    this.transactions += 1
    return work(this)
  }

  async close(): Promise<void> {}
}

const map: PersistedDocumentMap = {
  source: {
    id: sourceId,
    applicationId,
    rootUri: "https://docs.example.com/docs",
    contentHash: hash,
  },
  pages: [
    {
      id: pageId,
      canonicalUri: "https://docs.example.com/docs",
      sourceUri: "https://docs.example.com/docs",
      title: "Docs",
      mediaType: "text/html",
      contentHash: hash,
      sanitizedText: "Safe durable documentation.",
      change: "added",
    },
  ],
  sections: [
    {
      id: sectionId,
      pageId,
      sourceUri: "https://docs.example.com/docs",
      headingPath: ["Docs"],
      excerpt: "Safe durable documentation.",
      startOffset: 0,
      endOffset: 27,
      contentHash: hash,
    },
  ],
  links: [],
  coverage: {
    attemptedPages: 1,
    successfulPages: 1,
    failedPages: 0,
    duplicatePages: 0,
    removedPages: 0,
    fetchedBytes: 27,
    complete: true,
  },
  warnings: [],
}

describe("document map repository", () => {
  it("replaces sanitized facts transactionally and reads bounded previous identities", async () => {
    const database = new RecordingDatabase()
    const repository = new DocumentMapRepository(database)
    await repository.replace(applicationDatabaseId, map)
    expect(database.transactions).toBe(1)
    expect(
      database.calls.some((call) =>
        call.statement.includes("delete from sentinel.document_pages")
      )
    ).toBe(true)
    expect(
      database.calls.some((call) =>
        call.statement.includes("insert into sentinel.document_sections")
      )
    ).toBe(true)
    expect(database.calls.flatMap((call) => call.parameters)).not.toContain(
      "<script>"
    )
    await expect(
      repository.previousPages(applicationDatabaseId, sourceId)
    ).resolves.toEqual([
      { canonicalUri: "https://docs.example.com/docs", contentHash: hash },
    ])
  })
})
