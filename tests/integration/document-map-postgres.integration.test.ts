import { readFileSync } from "node:fs"

import {
  buildDocumentationMap,
  documentMapPersistenceView,
  parseMarkdownDocument,
} from "@sentinel/adapters"
import {
  ApplicationRepository,
  createPostgresDatabase,
  DocumentMapRepository,
  loadIntegrationEnvironment,
  type DatabaseClient,
} from "@sentinel/storage"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createOperationalTestApplication } from "../fixtures/operational.ts"

const enabled = process.env["RUN_SUPABASE_INTEGRATION_TESTS"] === "1"
const describeIntegration = enabled ? describe : describe.skip
const operationalMigration = readFileSync(
  new URL(
    "../../supabase/migrations/20260907000100_operational_state.sql",
    import.meta.url
  ),
  "utf8"
)
const documentMigration = readFileSync(
  new URL(
    "../../supabase/migrations/20260907000200_documentation_maps.sql",
    import.meta.url
  ),
  "utf8"
)

describeIntegration("documentation map Postgres persistence", () => {
  let database: DatabaseClient
  let applicationDatabaseId: string
  const application = createOperationalTestApplication(
    "sentinel-document-map-integration"
  )

  beforeAll(async () => {
    const environment = loadIntegrationEnvironment(process.env)
    const migrations = createPostgresDatabase(
      environment.SENTINEL_TEST_DATABASE_URL,
      { maxConnections: 1 }
    )
    await migrations.query(operationalMigration)
    await migrations.query(documentMigration)
    await migrations.query(documentMigration)
    await migrations.close()
    database = createPostgresDatabase(environment.SENTINEL_TEST_DATABASE_URL)
    applicationDatabaseId = (
      await new ApplicationRepository(database).upsert(application)
    ).id
  }, 60_000)

  afterAll(async () => {
    if (database !== undefined && applicationDatabaseId !== undefined) {
      await database.query(
        "delete from sentinel.applications where id = $1::uuid",
        [applicationDatabaseId]
      )
      await database.close()
    }
  })

  it("atomically replaces sanitized facts and denies browser roles", async () => {
    const uri =
      "repository://github.com/acme/app/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/docs/index.md"
    const document = parseMarkdownDocument(
      "# Checkout\n\nChoose a ticket and create an order.\n\n<script>steal()</script>",
      uri
    )
    const map = buildDocumentationMap({
      applicationId: application.stableKey,
      kind: "repository",
      rootUri:
        "repository://github.com/acme/app/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      pages: [
        {
          sourceUri: uri,
          canonicalUri: uri,
          mediaType: "text/markdown",
          document,
        },
      ],
    })
    const repository = new DocumentMapRepository(database)
    const persistence = documentMapPersistenceView(map)
    const jsonShape = await database.query<{ kind: string; bytes: number }>(
      `select jsonb_typeof($1::text::jsonb) as kind,
              octet_length(($1::text::jsonb)::text)::int as bytes`,
      [JSON.stringify(persistence.coverage)]
    )
    expect(jsonShape[0]).toMatchObject({ kind: "object" })
    expect(jsonShape[0]?.bytes).toBeLessThan(16_384)
    await repository.replace(applicationDatabaseId, persistence)
    await repository.replace(applicationDatabaseId, persistence)

    const rows = await database.query<{
      pages: number
      sections: number
      unsafe: boolean
    }>(
      `select
         (select count(*)::int from sentinel.document_pages
          where application_id = $1::uuid) as pages,
         (select count(*)::int from sentinel.document_sections
          where application_id = $1::uuid) as sections,
         exists(
           select 1 from sentinel.document_sections
           where application_id = $1::uuid and excerpt ~* '<script|steal\\('
         ) as unsafe`,
      [applicationDatabaseId]
    )
    expect(rows[0]).toEqual({ pages: 1, sections: 1, unsafe: false })
    await expect(
      repository.previousPages(applicationDatabaseId, map.source.id)
    ).resolves.toEqual([
      {
        canonicalUri: uri,
        contentHash: map.pages[0]?.fact.contentHash,
      },
    ])

    for (const role of ["anon", "authenticated"]) {
      await expect(
        database.transaction(async (transaction) => {
          await transaction.query(`set local role ${role}`)
          await transaction.query("select * from sentinel.document_sections")
        })
      ).rejects.toThrow()
    }
  })
})
