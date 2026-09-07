import {
  applicationIdSchema,
  contentHashSchema,
  documentPageIdSchema,
  documentSectionIdSchema,
  documentSourceIdSchema,
} from "@sentinel/contracts"
import { z } from "zod"

import type { DatabaseClient, DatabaseExecutor } from "./database.ts"

const databaseIdSchema = z.uuid()

export interface PersistedDocumentMap {
  readonly source: {
    readonly id: string
    readonly applicationId: string
    readonly rootUri: string
    readonly contentHash: string
  }
  readonly pages: readonly {
    readonly id: string
    readonly canonicalUri: string
    readonly sourceUri: string
    readonly title: string
    readonly mediaType: "text/html" | "text/markdown"
    readonly contentHash: string
    readonly sanitizedText: string
    readonly change: "added" | "changed" | "unchanged"
  }[]
  readonly sections: readonly {
    readonly id: string
    readonly pageId: string
    readonly sourceUri: string
    readonly headingPath: readonly string[]
    readonly excerpt: string
    readonly startOffset: number
    readonly endOffset: number
    readonly contentHash: string
  }[]
  readonly links: readonly {
    readonly fromPageId: string
    readonly toPageId: string
    readonly relation: "LINKS_TO"
  }[]
  readonly coverage: {
    readonly attemptedPages: number
    readonly successfulPages: number
    readonly failedPages: number
    readonly duplicatePages: number
    readonly removedPages: number
    readonly fetchedBytes: number
    readonly complete: boolean
  }
  readonly warnings: readonly {
    readonly code: string
    readonly message: string
    readonly sourceUri?: string
  }[]
}

function validateMap(map: PersistedDocumentMap): void {
  applicationIdSchema.parse(map.source.applicationId)
  documentSourceIdSchema.parse(map.source.id)
  contentHashSchema.parse(map.source.contentHash)
  for (const page of map.pages) {
    documentPageIdSchema.parse(page.id)
    contentHashSchema.parse(page.contentHash)
    if (
      page.sanitizedText.length === 0 ||
      Buffer.byteLength(page.sanitizedText) > 2 * 1_024 * 1_024
    ) {
      throw new Error("Document page sanitized text exceeds the durable limit")
    }
  }
  for (const section of map.sections) {
    documentSectionIdSchema.parse(section.id)
    documentPageIdSchema.parse(section.pageId)
    contentHashSchema.parse(section.contentHash)
    if (
      section.excerpt.length === 0 ||
      section.excerpt.length > 4_096 ||
      section.endOffset <= section.startOffset
    ) {
      throw new Error("Document section violates durable excerpt boundaries")
    }
  }
}

async function insertMap(
  database: DatabaseExecutor,
  applicationDatabaseId: string,
  map: PersistedDocumentMap
): Promise<void> {
  const status =
    map.pages.length === 0
      ? "blocked"
      : map.warnings.length === 0
        ? "ready"
        : "warning"
  await database.query(
    `insert into sentinel.document_maps (
       application_id, source_stable_key, root_uri, map_hash, status, coverage, warnings
     ) values ($1::uuid, $2, $3, $4, $5, $6::text::jsonb, $7::text::jsonb)
     on conflict (application_id, source_stable_key) do update
     set root_uri = excluded.root_uri,
         map_hash = excluded.map_hash,
         status = excluded.status,
         coverage = excluded.coverage,
         warnings = excluded.warnings,
         updated_at = now()`,
    [
      applicationDatabaseId,
      map.source.id,
      map.source.rootUri,
      map.source.contentHash,
      status,
      JSON.stringify(map.coverage),
      JSON.stringify(map.warnings),
    ]
  )
  await database.query(
    `delete from sentinel.document_pages
     where application_id = $1::uuid and source_stable_key = $2`,
    [applicationDatabaseId, map.source.id]
  )
  for (const page of map.pages) {
    await database.query(
      `insert into sentinel.document_pages (
         application_id, source_stable_key, stable_key, canonical_uri, source_uri,
         title, media_type, content_hash, sanitized_text, change_status
       ) values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        applicationDatabaseId,
        map.source.id,
        page.id,
        page.canonicalUri,
        page.sourceUri,
        page.title,
        page.mediaType,
        page.contentHash,
        page.sanitizedText,
        page.change,
      ]
    )
  }
  for (const section of map.sections) {
    await database.query(
      `insert into sentinel.document_sections (
         application_id, source_stable_key, page_stable_key, stable_key, source_uri,
         heading_path, excerpt, start_offset, end_offset, content_hash
       ) values ($1::uuid, $2, $3, $4, $5, $6::text::jsonb, $7, $8, $9, $10)`,
      [
        applicationDatabaseId,
        map.source.id,
        section.pageId,
        section.id,
        section.sourceUri,
        JSON.stringify(section.headingPath),
        section.excerpt,
        section.startOffset,
        section.endOffset,
        section.contentHash,
      ]
    )
  }
  for (const link of map.links) {
    await database.query(
      `insert into sentinel.document_links (
         application_id, source_stable_key, from_page_stable_key,
         to_page_stable_key, relation
       ) values ($1::uuid, $2, $3, $4, 'LINKS_TO')`,
      [applicationDatabaseId, map.source.id, link.fromPageId, link.toPageId]
    )
  }
}

export class DocumentMapRepository {
  constructor(private readonly database: DatabaseClient) {}

  async replace(
    applicationDatabaseIdInput: string,
    map: PersistedDocumentMap
  ): Promise<void> {
    const applicationDatabaseId = databaseIdSchema.parse(
      applicationDatabaseIdInput
    )
    validateMap(map)
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        "select id from sentinel.applications where id = $1::uuid for update",
        [applicationDatabaseId]
      )
      await insertMap(transaction, applicationDatabaseId, map)
    })
  }

  async previousPages(
    applicationDatabaseIdInput: string,
    sourceStableIdInput: string
  ): Promise<readonly { canonicalUri: string; contentHash: string }[]> {
    const applicationDatabaseId = databaseIdSchema.parse(
      applicationDatabaseIdInput
    )
    const sourceStableId = documentSourceIdSchema.parse(sourceStableIdInput)
    const rows = await this.database.query<{
      canonical_uri: string
      content_hash: string
    }>(
      `select canonical_uri, content_hash
       from sentinel.document_pages
       where application_id = $1::uuid and source_stable_key = $2
       order by canonical_uri
       limit 10000`,
      [applicationDatabaseId, sourceStableId]
    )
    return rows.map((row) => ({
      canonicalUri: row.canonical_uri,
      contentHash: contentHashSchema.parse(row.content_hash),
    }))
  }
}
