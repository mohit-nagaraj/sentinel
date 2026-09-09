import {
  applicationIdSchema,
  graphPublicationSummarySchema,
  type GraphPublicationSummary,
} from "@sentinel/contracts"
import { z } from "zod"

import type { DatabaseExecutor } from "./database.ts"

const operatorIdSchema = z.uuid()
const databaseRunIdSchema = z.uuid()

export class KnowledgePublicationRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async recordActivated(
    summaryValue: GraphPublicationSummary
  ): Promise<GraphPublicationSummary> {
    const summary = graphPublicationSummarySchema.parse(summaryValue)
    const runId = databaseRunIdSchema.parse(
      String(summary.runId).slice("run:".length)
    )
    const rows = await this.database.query<{ summary: unknown }>(
      `insert into sentinel.knowledge_publications (
         application_id, graph_revision, run_id, publication_hash,
         indexed_commit_sha, summary
       )
       select application.id, $2, run.id, $4, $5, $6::text::jsonb
       from sentinel.applications application
       join sentinel.runs run
         on run.id = $3::uuid
        and run.application_id = application.id
        and run.status = 'succeeded'
       where application.stable_key = $1
         and application.graph_revision = $2
         and application.indexed_commit_sha = $5
       on conflict (application_id, graph_revision) do update
       set summary = excluded.summary
       where sentinel.knowledge_publications.publication_hash = excluded.publication_hash
         and sentinel.knowledge_publications.run_id = excluded.run_id
         and sentinel.knowledge_publications.indexed_commit_sha = excluded.indexed_commit_sha
       returning summary`,
      [
        applicationIdSchema.parse(summary.applicationId),
        summary.graphRevision,
        runId,
        summary.publicationHash,
        summary.indexedCommitSha,
        JSON.stringify(summary),
      ]
    )
    const row = rows[0]
    if (row === undefined) {
      throw new Error("Knowledge publication summary is not activated")
    }
    return graphPublicationSummarySchema.parse(row.summary)
  }

  async getOwnedCurrent(input: {
    readonly operatorId: string
    readonly applicationId: string
  }): Promise<GraphPublicationSummary | null> {
    const rows = await this.database.query<{ summary: unknown }>(
      `select publication.summary
       from sentinel.applications application
       join sentinel.onboarding_configurations onboarding
         on onboarding.application_id = application.id
        and onboarding.operator_id = $1::uuid
       join sentinel.knowledge_publications publication
         on publication.application_id = application.id
        and publication.graph_revision = application.graph_revision
       where application.stable_key = $2
       limit 1`,
      [
        operatorIdSchema.parse(input.operatorId),
        applicationIdSchema.parse(input.applicationId),
      ]
    )
    return rows[0] === undefined
      ? null
      : graphPublicationSummarySchema.parse(rows[0].summary)
  }
}
