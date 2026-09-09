import {
  applicationIdSchema,
  applicationStatusSchema,
  compatibilityReportSchema,
  contentHashSchema,
  createOnboardingInputFingerprint,
  createStableKey,
  onboardingConfigurationSchema,
  onboardingCompletedStepSchema,
  publicOnboardingApplicationSchema,
  publicHttpUrlSchema,
  shortTextSchema,
  type CompatibilityReport,
  type OnboardingConfiguration,
  type OnboardingCompletedStep,
  type PublicOnboardingApplication,
} from "@sentinel/contracts"
import { z } from "zod"

import type { DatabaseClient, DatabaseExecutor } from "./database.ts"

const operatorIdSchema = z.uuid()
const databaseIdSchema = z.uuid()
const onboardingStepOrder: readonly OnboardingCompletedStep[] = [
  "none",
  "sources",
  "access",
  "safety",
  "review",
]

function furthestCompletedStep(
  left: OnboardingCompletedStep,
  right: OnboardingCompletedStep
): OnboardingCompletedStep {
  return onboardingStepOrder.indexOf(left) >= onboardingStepOrder.indexOf(right)
    ? left
    : right
}

const onboardingRowSchema = z.object({
  id: databaseIdSchema,
  stable_key: applicationIdSchema,
  name: shortTextSchema,
  deployment_url: publicHttpUrlSchema,
  status: applicationStatusSchema,
  indexed_commit_sha: z.string().nullable(),
  graph_revision: z.coerce.number().int().nonnegative(),
  refreshed_at: z.coerce.date().nullable(),
  configuration: z.unknown(),
  input_fingerprint: contentHashSchema,
  inspected_fingerprint: contentHashSchema.nullable(),
  compatibility_report: z.unknown().nullable(),
  confirmation_fingerprint: contentHashSchema.nullable(),
  knowledge_stale: z.boolean(),
  inspected_at: z.coerce.date().nullable(),
  confirmed_at: z.coerce.date().nullable(),
  updated_at: z.coerce.date(),
  completed_through: onboardingCompletedStepSchema.default("safety"),
})
type OnboardingRow = z.infer<typeof onboardingRowSchema> &
  Record<string, unknown>

export interface OnboardingRecord {
  readonly id: string
  readonly stableKey: string
  readonly name: string
  readonly deploymentUrl: string
  readonly status: z.infer<typeof applicationStatusSchema>
  readonly indexedCommitSha: string | null
  readonly graphRevision: number
  readonly refreshedAt: Date | null
  readonly configuration: OnboardingConfiguration
  readonly inputFingerprint: z.infer<typeof contentHashSchema>
  readonly inspectedFingerprint: z.infer<typeof contentHashSchema> | null
  readonly compatibility: CompatibilityReport | null
  readonly confirmationFingerprint: z.infer<typeof contentHashSchema> | null
  readonly knowledgeStale: boolean
  readonly inspectedAt: Date | null
  readonly confirmedAt: Date | null
  readonly updatedAt: Date
  readonly completedThrough: OnboardingCompletedStep
}

export interface SaveOnboardingDraftResult {
  readonly record: OnboardingRecord
  readonly relevantChanged: boolean
}

const selectColumns = `
  application.id,
  application.stable_key,
  application.name,
  application.deployment_url,
  application.status,
  application.indexed_commit_sha,
  application.graph_revision,
  application.refreshed_at,
  onboarding.configuration,
  onboarding.input_fingerprint,
  onboarding.inspected_fingerprint,
  onboarding.compatibility_report,
  onboarding.confirmation_fingerprint,
  onboarding.knowledge_stale,
  onboarding.inspected_at,
  onboarding.confirmed_at,
  onboarding.updated_at,
  onboarding.completed_through
`

function mapRow(row: OnboardingRow): OnboardingRecord {
  const parsed = onboardingRowSchema.parse(row)
  const configuration = onboardingConfigurationSchema.parse(
    parsed.configuration
  )
  const compatibility =
    parsed.compatibility_report === null
      ? null
      : compatibilityReportSchema.parse(parsed.compatibility_report)
  if (
    compatibility !== null &&
    compatibility.inputFingerprint !== parsed.inspected_fingerprint
  ) {
    throw new Error("Stored compatibility fingerprint is inconsistent")
  }
  return {
    id: parsed.id,
    stableKey: parsed.stable_key,
    name: parsed.name,
    deploymentUrl: parsed.deployment_url,
    status: parsed.status,
    indexedCommitSha: parsed.indexed_commit_sha,
    graphRevision: parsed.graph_revision,
    refreshedAt: parsed.refreshed_at,
    configuration,
    inputFingerprint: parsed.input_fingerprint,
    inspectedFingerprint: parsed.inspected_fingerprint,
    compatibility,
    confirmationFingerprint: parsed.confirmation_fingerprint,
    knowledgeStale: parsed.knowledge_stale,
    inspectedAt: parsed.inspected_at,
    confirmedAt: parsed.confirmed_at,
    updatedAt: parsed.updated_at,
    completedThrough: parsed.completed_through,
  }
}

function storedConfiguration(
  configuration: OnboardingConfiguration
): OnboardingConfiguration {
  const stored = { ...configuration }
  delete stored.recordId
  return onboardingConfigurationSchema.parse(stored)
}

function sourceStatus(
  report: CompatibilityReport,
  capability:
    "application_reachable" | "documentation_reachable" | "repository_resolved"
): "ready" | "warning" | "blocked" {
  const status = report.evidence.find(
    (entry) => entry.capability === capability
  )?.status
  return status === "detected"
    ? "ready"
    : status === "missing"
      ? "warning"
      : "blocked"
}

function sourceEntries(
  stableKey: z.infer<typeof applicationIdSchema>,
  configuration: OnboardingConfiguration,
  statuses?: {
    readonly application: "ready" | "warning" | "blocked"
    readonly documentation: "ready" | "warning" | "blocked"
    readonly repository: "ready" | "warning" | "blocked"
  }
) {
  const pending = "pending" as const
  const sources = [
    {
      stableKey,
      kind: "application",
      uri: configuration.deploymentUrl,
      status: statuses?.application ?? pending,
    },
    {
      stableKey: createStableKey({
        kind: "document-source",
        applicationId: stableKey,
        rootUri: configuration.repository.url,
      }),
      kind: "repository",
      uri: configuration.repository.url,
      status: statuses?.repository ?? pending,
    },
    ...configuration.documentationSources.map((uri) => ({
      stableKey: createStableKey({
        kind: "document-source" as const,
        applicationId: stableKey,
        rootUri: uri,
      }),
      kind: "documentation" as const,
      uri,
      status: statuses?.documentation ?? pending,
    })),
  ]
  return [
    ...new Map(sources.map((source) => [source.stableKey, source])).values(),
  ]
}

async function syncSources(
  database: DatabaseExecutor,
  applicationId: string,
  stableKey: z.infer<typeof applicationIdSchema>,
  configuration: OnboardingConfiguration,
  statuses?: {
    readonly application: "ready" | "warning" | "blocked"
    readonly documentation: "ready" | "warning" | "blocked"
    readonly repository: "ready" | "warning" | "blocked"
  }
): Promise<void> {
  const desired = sourceEntries(stableKey, configuration, statuses)
  await database.query(
    `with desired as (
       select * from jsonb_to_recordset($2::text::jsonb) as source(
         stable_key text, kind text, uri text, status text
       )
     ), upserted as (
       insert into sentinel.sources (
         application_id, stable_key, kind, uri, status, checked_at
       )
       select $1::uuid, stable_key, kind, uri, status,
              case when status = 'pending' then null else now() end
       from desired
       on conflict (application_id, stable_key) do update
       set kind = excluded.kind,
           uri = excluded.uri,
           status = excluded.status,
           checked_at = excluded.checked_at
       returning stable_key
     )
     delete from sentinel.sources as existing
     where existing.application_id = $1::uuid
       and not exists (
         select 1 from desired
         where desired.stable_key = existing.stable_key
       )`,
    [
      applicationId,
      JSON.stringify(
        desired.map((source) => ({
          stable_key: source.stableKey,
          kind: source.kind,
          uri: source.uri,
          status: source.status,
        }))
      ),
    ]
  )
}

async function selectOwned(
  database: DatabaseExecutor,
  operatorId: string,
  applicationId: string,
  forUpdate = false
): Promise<OnboardingRecord | null> {
  const rows = await database.query<OnboardingRow>(
    `select ${selectColumns}
     from sentinel.applications as application
     join sentinel.onboarding_configurations as onboarding
       on onboarding.application_id = application.id
     where onboarding.operator_id = $1::uuid
       and application.id = $2::uuid
     ${forUpdate ? "for update of application, onboarding" : ""}`,
    [operatorIdSchema.parse(operatorId), databaseIdSchema.parse(applicationId)]
  )
  return rows[0] === undefined ? null : mapRow(rows[0])
}

export function toPublicOnboardingApplication(
  record: OnboardingRecord
): PublicOnboardingApplication {
  const authentication = record.configuration.authentication
  const configuredFields =
    authentication.method === "credentials"
      ? authentication.fields.map(({ key, label }) => ({ key, label }))
      : authentication.method === "storage_state"
        ? [{ key: "storage_state", label: "Encrypted storage state" }]
        : []
  return publicOnboardingApplicationSchema.parse({
    id: record.id,
    name: record.name,
    deploymentUrl: record.deploymentUrl,
    status: record.status,
    ...(record.indexedCommitSha === null
      ? {}
      : { indexedCommitSha: record.indexedCommitSha }),
    graphRevision: record.graphRevision,
    ...(record.refreshedAt === null
      ? {}
      : { refreshedAt: record.refreshedAt.toISOString() }),
    knowledgeStale: record.knowledgeStale,
    configuration: {
      repository: record.configuration.repository,
      documentationSources: record.configuration.documentationSources,
      ...(record.configuration.previewUrlPattern === undefined
        ? {}
        : { previewUrlPattern: record.configuration.previewUrlPattern }),
      authentication: {
        method: authentication.method,
        configuredFields,
        revision: authentication.revision,
        automationConfirmed:
          authentication.method === "none"
            ? true
            : authentication.automationConfirmed,
      },
      crawl: record.configuration.crawl,
      capabilityHints: record.configuration.capabilityHints,
      ...(record.configuration.testDataSetupReference === undefined
        ? {}
        : {
            testDataSetupReference: record.configuration.testDataSetupReference,
          }),
      ...(record.configuration.testDataResetReference === undefined
        ? {}
        : {
            testDataResetReference: record.configuration.testDataResetReference,
          }),
    },
    ...(record.compatibility === null
      ? {}
      : { compatibility: record.compatibility }),
    confirmed:
      record.confirmationFingerprint !== null &&
      record.confirmationFingerprint === record.inputFingerprint,
    completedThrough: record.completedThrough,
    updatedAt: record.updatedAt.toISOString(),
  })
}

export class OnboardingRepository {
  constructor(private readonly database: DatabaseClient) {}

  async list(operatorIdInput: string): Promise<readonly OnboardingRecord[]> {
    const operatorId = operatorIdSchema.parse(operatorIdInput)
    const rows = await this.database.query<OnboardingRow>(
      `select ${selectColumns}
       from sentinel.applications as application
       join sentinel.onboarding_configurations as onboarding
         on onboarding.application_id = application.id
       where onboarding.operator_id = $1::uuid
       order by onboarding.updated_at desc, application.id`,
      [operatorId]
    )
    return rows.map(mapRow)
  }

  async get(
    operatorIdInput: string,
    applicationIdInput: string
  ): Promise<OnboardingRecord | null> {
    return selectOwned(
      this.database,
      operatorIdSchema.parse(operatorIdInput),
      databaseIdSchema.parse(applicationIdInput)
    )
  }

  async deleteDraft(
    operatorIdInput: string,
    applicationIdInput: string
  ): Promise<boolean> {
    const operatorId = operatorIdSchema.parse(operatorIdInput)
    const applicationId = databaseIdSchema.parse(applicationIdInput)
    const rows = await this.database.query<{ id: string }>(
      `delete from sentinel.applications as application
       using sentinel.onboarding_configurations as onboarding
       where application.id = $2::uuid
         and onboarding.application_id = application.id
         and onboarding.operator_id = $1::uuid
         and application.graph_revision = 0
         and application.indexed_commit_sha is null
         and application.status in (
           'not_configured', 'inspecting', 'awaiting_confirmation', 'failed'
         )
       returning application.id`,
      [operatorId, applicationId]
    )
    return rows[0] !== undefined
  }

  async saveDraft(input: {
    readonly operatorId: string
    readonly stableKey: string
    readonly configuration: OnboardingConfiguration
    readonly completedThrough?: OnboardingCompletedStep
  }): Promise<SaveOnboardingDraftResult> {
    const operatorId = operatorIdSchema.parse(input.operatorId)
    const stableKey = applicationIdSchema.parse(input.stableKey)
    const configuration = storedConfiguration(input.configuration)
    const inputFingerprint = createOnboardingInputFingerprint(configuration)
    const recordId = input.configuration.recordId
    const completedThrough = onboardingCompletedStepSchema.parse(
      input.completedThrough ?? "safety"
    )

    return this.database.transaction(async (transaction) => {
      if (recordId === undefined) {
        const applicationRows = await transaction.query<{
          id: string
          knowledge_stale: boolean
        }>(
          `insert into sentinel.applications (
             stable_key, name, deployment_url, status
           ) values ($1, $2, $3, $4)
           on conflict (stable_key) do update
           set name = excluded.name,
               deployment_url = excluded.deployment_url,
               status = case
                 when sentinel.applications.graph_revision > 0
                   or sentinel.applications.indexed_commit_sha is not null
                 then 'stale'
                 else $4
               end
           returning id,
             (graph_revision > 0 or indexed_commit_sha is not null)
               as knowledge_stale`,
          [
            stableKey,
            configuration.name,
            configuration.deploymentUrl,
            completedThrough === "safety" ? "inspecting" : "not_configured",
          ]
        )
        const application = applicationRows[0]
        const applicationId = application?.id
        if (applicationId === undefined) {
          throw new Error("Application already exists or could not be created")
        }
        await transaction.query(
          `insert into sentinel.onboarding_configurations (
             application_id, operator_id, configuration, input_fingerprint,
             knowledge_stale, completed_through
           ) values ($1::uuid, $2::uuid, $3::text::jsonb, $4, $5, $6)`,
          [
            applicationId,
            operatorId,
            JSON.stringify(configuration),
            inputFingerprint,
            application?.knowledge_stale ?? false,
            completedThrough,
          ]
        )
        await syncSources(transaction, applicationId, stableKey, configuration)
        const created = await selectOwned(
          transaction,
          operatorId,
          applicationId
        )
        if (created === null)
          throw new Error("Created application was not found")
        return { record: created, relevantChanged: true }
      }

      const applicationId = databaseIdSchema.parse(recordId)
      const current = await selectOwned(
        transaction,
        operatorId,
        applicationId,
        true
      )
      if (current === null) throw new Error("Application not found")
      const persistedCompletedThrough = furthestCompletedStep(
        current.completedThrough,
        completedThrough
      )
      const relevantChanged = current.inputFingerprint !== inputFingerprint
      const hasCurrentKnowledge =
        current.graphRevision > 0 || current.indexedCommitSha !== null
      const knowledgeStale =
        current.knowledgeStale || (relevantChanged && hasCurrentKnowledge)
      const status = relevantChanged
        ? knowledgeStale
          ? "stale"
          : onboardingStepOrder.indexOf(persistedCompletedThrough) >=
              onboardingStepOrder.indexOf("safety")
            ? "inspecting"
            : "not_configured"
        : current.status

      await transaction.query(
        `update sentinel.applications
         set name = $3, deployment_url = $4, status = $5
         where id = $1::uuid
           and exists (
             select 1 from sentinel.onboarding_configurations
             where application_id = $1::uuid and operator_id = $2::uuid
           )`,
        [
          applicationId,
          operatorId,
          configuration.name,
          configuration.deploymentUrl,
          status,
        ]
      )
      await transaction.query(
        `update sentinel.onboarding_configurations
         set configuration = $3::text::jsonb,
             input_fingerprint = $4,
             knowledge_stale = $5,
             inspected_fingerprint = case when $6 then null else inspected_fingerprint end,
             compatibility_report = case when $6 then null else compatibility_report end,
             inspected_at = case when $6 then null else inspected_at end,
             confirmation_fingerprint = case when $6 then null else confirmation_fingerprint end,
             confirmed_at = case when $6 then null else confirmed_at end,
             completed_through = $7
         where application_id = $1::uuid and operator_id = $2::uuid`,
        [
          applicationId,
          operatorId,
          JSON.stringify(configuration),
          inputFingerprint,
          knowledgeStale,
          relevantChanged,
          persistedCompletedThrough,
        ]
      )
      if (relevantChanged) {
        await syncSources(
          transaction,
          applicationId,
          current.stableKey as z.infer<typeof applicationIdSchema>,
          configuration
        )
      }
      const saved = await selectOwned(transaction, operatorId, applicationId)
      if (saved === null) throw new Error("Saved application was not found")
      return { record: saved, relevantChanged }
    })
  }

  async recordInspection(input: {
    readonly operatorId: string
    readonly applicationId: string
    readonly expectedFingerprint: string
    readonly report: CompatibilityReport
  }): Promise<OnboardingRecord | null> {
    const operatorId = operatorIdSchema.parse(input.operatorId)
    const applicationId = databaseIdSchema.parse(input.applicationId)
    const expectedFingerprint = contentHashSchema.parse(
      input.expectedFingerprint
    )
    const report = compatibilityReportSchema.parse(input.report)
    if (report.inputFingerprint !== expectedFingerprint) {
      throw new Error("Compatibility report belongs to another configuration")
    }

    return this.database.transaction(async (transaction) => {
      const current = await selectOwned(
        transaction,
        operatorId,
        applicationId,
        true
      )
      if (
        current === null ||
        current.inputFingerprint !== expectedFingerprint
      ) {
        return null
      }
      const repositoryInput = {
        url: current.configuration.repository.url,
        ref: current.configuration.repository.ref,
        accessMode: current.configuration.repository.accessMode,
        ...(current.configuration.repository.installationId === undefined
          ? {}
          : {
              installationId: current.configuration.repository.installationId,
            }),
      }
      const repository = {
        ...repositoryInput,
        ...(report.resolvedCommitSha === undefined
          ? {}
          : { resolvedCommitSha: report.resolvedCommitSha }),
      }
      const configuration = onboardingConfigurationSchema.parse({
        ...current.configuration,
        repository,
      })
      const status =
        report.status === "blocked"
          ? "failed"
          : current.knowledgeStale
            ? "stale"
            : "awaiting_confirmation"

      await transaction.query(
        `update sentinel.onboarding_configurations
         set configuration = $3::text::jsonb,
             inspected_fingerprint = $4,
             compatibility_report = $5::text::jsonb,
             inspected_at = $6,
             confirmation_fingerprint = null,
             confirmed_at = null
         where application_id = $1::uuid
           and operator_id = $2::uuid
           and input_fingerprint = $4`,
        [
          applicationId,
          operatorId,
          JSON.stringify(configuration),
          expectedFingerprint,
          JSON.stringify(report),
          new Date(report.inspectedAt),
        ]
      )
      await transaction.query(
        `update sentinel.applications
         set status = $3
         where id = $1::uuid
           and exists (
             select 1 from sentinel.onboarding_configurations
             where application_id = $1::uuid and operator_id = $2::uuid
           )`,
        [applicationId, operatorId, status]
      )
      await syncSources(
        transaction,
        applicationId,
        current.stableKey as z.infer<typeof applicationIdSchema>,
        configuration,
        {
          application: sourceStatus(report, "application_reachable"),
          documentation: sourceStatus(report, "documentation_reachable"),
          repository: sourceStatus(report, "repository_resolved"),
        }
      )
      return selectOwned(transaction, operatorId, applicationId)
    })
  }

  async confirm(input: {
    readonly operatorId: string
    readonly applicationId: string
    readonly expectedFingerprint: string
  }): Promise<OnboardingRecord | null> {
    const operatorId = operatorIdSchema.parse(input.operatorId)
    const applicationId = databaseIdSchema.parse(input.applicationId)
    const expectedFingerprint = contentHashSchema.parse(
      input.expectedFingerprint
    )
    return this.database.transaction(async (transaction) => {
      const rows = await transaction.query<{ application_id: string }>(
        `update sentinel.onboarding_configurations
         set confirmation_fingerprint = $3,
             confirmed_at = now(),
             completed_through = 'review'
         where application_id = $1::uuid
           and operator_id = $2::uuid
           and input_fingerprint = $3
           and inspected_fingerprint = $3
           and compatibility_report ->> 'status' <> 'blocked'
         returning application_id`,
        [applicationId, operatorId, expectedFingerprint]
      )
      if (rows[0] === undefined) return null
      return selectOwned(transaction, operatorId, applicationId)
    })
  }
}
