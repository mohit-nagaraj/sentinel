import { readFileSync } from "node:fs"

import {
  compatibilityReportSchema,
  contentHashSchema,
  createOnboardingInputFingerprint,
  onboardingConfigurationSchema,
  type CompatibilityReport,
  type OnboardingConfiguration,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import type { DatabaseClient, DatabaseExecutor } from "./database.ts"
import {
  OnboardingRepository,
  toPublicOnboardingApplication,
} from "./onboarding-repository.ts"

const operatorId = "11111111-1111-4111-8111-111111111111"
const otherOperatorId = "22222222-2222-4222-8222-222222222222"
const applicationId = "33333333-3333-4333-8333-333333333333"
const stableKey = `application:v1:${"a".repeat(64)}`

class ScriptedDatabase implements DatabaseClient {
  readonly calls: Array<{
    readonly statement: string
    readonly parameters: readonly unknown[]
  }> = []
  transactionCalls = 0

  constructor(private readonly responses: unknown[][]) {}

  async query<Row extends Record<string, unknown>>(
    statement: string,
    parameters: readonly unknown[] = []
  ): Promise<readonly Row[]> {
    this.calls.push({ statement, parameters })
    return (this.responses.shift() ?? []) as Row[]
  }

  async transaction<T>(
    work: (executor: DatabaseExecutor) => Promise<T>
  ): Promise<T> {
    this.transactionCalls += 1
    return work(this)
  }

  async close() {}
}

function configuration(
  overrides: Partial<OnboardingConfiguration> = {}
): OnboardingConfiguration {
  return onboardingConfigurationSchema.parse({
    schemaVersion: 1,
    name: "Hi.Events",
    deploymentUrl: "https://demo.hi.events",
    repository: {
      url: "https://github.com/mohit-nagaraj/Hi.Events",
      ref: "develop",
      accessMode: "manual",
    },
    documentationSources: ["https://hi.events/docs", "repository://README.md"],
    authentication: {
      method: "credentials",
      automationConfirmed: true,
      revision: 1,
      fields: [
        {
          key: "email",
          label: "Email",
          reference: `secret-ref:v1:${"b".repeat(64)}`,
        },
        {
          key: "password",
          label: "Password",
          reference: `secret-ref:v1:${"c".repeat(64)}`,
        },
      ],
    },
    crawl: {
      allowedHosts: ["demo.hi.events"],
      maxActions: 40,
      maxScreens: 20,
      maxDurationSeconds: 300,
      allowFormSubmission: true,
      denyDestructiveActions: true,
      denyRealPayments: true,
      denyExternalMessaging: true,
      denyPrivilegeChanges: true,
    },
    capabilityHints: ["Attendee checkout"],
    ...overrides,
  })
}

function report(config: OnboardingConfiguration): CompatibilityReport {
  const inputFingerprint = createOnboardingInputFingerprint(config)
  return compatibilityReportSchema.parse({
    schemaVersion: 1,
    inputFingerprint,
    status: "supported",
    resolvedCommitSha: "d".repeat(40),
    selectedAdapters: ["php_laravel", "playwright", "typescript_react"],
    evidence: [
      {
        capability: "repository_resolved",
        status: "detected",
        code: "immutable_commit_resolved",
        summary: "Repository reference resolved to an immutable commit",
        source: "repository",
        references: ["d".repeat(40)],
      },
      {
        capability: "documentation_reachable",
        status: "detected",
        code: "documentation_sources_reachable",
        summary: "Every configured documentation source is reachable",
        source: "documentation",
        references: config.documentationSources,
      },
      {
        capability: "application_reachable",
        status: "detected",
        code: "application_browser_ready",
        summary: "The deployment is reachable and browser ready",
        source: "application",
        references: [config.deploymentUrl],
      },
    ],
    findings: [],
    humanActions: [],
    proposedScope: {
      repositoryPaths: ["frontend", "app", "routes"],
      documentationSources: config.documentationSources,
      applicationOrigins: [new URL(config.deploymentUrl).origin],
      allowedActionCategories: [
        "safe_read",
        "safe_navigation",
        "safe_form_progress",
        "credential_entry",
        "unknown_submission",
      ],
      maxActions: config.crawl.maxActions,
      maxScreens: config.crawl.maxScreens,
      maxDurationSeconds: config.crawl.maxDurationSeconds,
    },
    inspectedAt: "2026-09-08T00:00:00.000Z",
  })
}

function row(input: {
  readonly config?: OnboardingConfiguration
  readonly status?: string
  readonly graphRevision?: number
  readonly indexedCommitSha?: string | null
  readonly compatibility?: CompatibilityReport | null
  readonly confirmed?: boolean
  readonly knowledgeStale?: boolean
  readonly name?: string
}) {
  const config = input.config ?? configuration()
  const compatibility = input.compatibility ?? null
  const fingerprint = createOnboardingInputFingerprint(config)
  return {
    id: applicationId,
    stable_key: stableKey,
    name: input.name ?? config.name,
    deployment_url: config.deploymentUrl,
    status: input.status ?? "inspecting",
    indexed_commit_sha: input.indexedCommitSha ?? null,
    graph_revision: input.graphRevision ?? 0,
    refreshed_at: null,
    configuration: config,
    input_fingerprint: fingerprint,
    inspected_fingerprint:
      compatibility === null ? null : compatibility.inputFingerprint,
    compatibility_report: compatibility,
    confirmation_fingerprint: input.confirmed ? fingerprint : null,
    knowledge_stale: input.knowledgeStale ?? false,
    inspected_at: compatibility === null ? null : compatibility.inspectedAt,
    confirmed_at: input.confirmed ? "2026-09-08T00:01:00.000Z" : null,
    updated_at: "2026-09-08T00:02:00.000Z",
  }
}

describe("onboarding repository", () => {
  it("creates an owned application, safe configuration, and pending sources", async () => {
    const config = configuration()
    const database = new ScriptedDatabase([
      [{ id: applicationId, knowledge_stale: false }],
      [],
      [],
      [row({ config })],
    ])
    const repository = new OnboardingRepository(database)

    const result = await repository.saveDraft({
      operatorId,
      stableKey,
      configuration: config,
    })

    expect(result.relevantChanged).toBe(true)
    expect(result.record.status).toBe("inspecting")
    expect(database.transactionCalls).toBe(1)
    expect(database.calls[1]?.parameters[1]).toBe(operatorId)
    expect(database.calls[0]?.statement).toContain(
      "on conflict (stable_key) do update"
    )
    expect(database.calls[0]?.statement).toContain("then 'stale'")
    expect(database.calls[2]?.statement).toContain("sentinel.sources")
    const persisted = JSON.stringify(database.calls[1]?.parameters)
    expect(persisted).toContain("secret-ref:v1")
    expect(persisted).not.toContain("plaintext")
  })

  it("attaches onboarding to a pre-existing application and preserves stale knowledge", async () => {
    const config = configuration()
    const database = new ScriptedDatabase([
      [{ id: applicationId, knowledge_stale: true }],
      [],
      [],
      [
        row({
          config,
          status: "stale",
          graphRevision: 2,
          indexedCommitSha: "e".repeat(40),
          knowledgeStale: true,
        }),
      ],
    ])
    const repository = new OnboardingRepository(database)

    const result = await repository.saveDraft({
      operatorId,
      stableKey,
      configuration: config,
    })

    expect(result.record).toMatchObject({
      status: "stale",
      graphRevision: 2,
      knowledgeStale: true,
    })
    expect(database.calls[0]?.statement).toContain(
      "on conflict (stable_key) do update"
    )
    expect(database.calls[1]?.parameters[4]).toBe(true)
  })

  it("scopes lists and reads to the supplied server operator", async () => {
    const config = configuration()
    const database = new ScriptedDatabase([[row({ config })], []])
    const repository = new OnboardingRepository(database)

    const listed = await repository.list(operatorId)
    const hidden = await repository.get(otherOperatorId, applicationId)

    expect(listed).toHaveLength(1)
    expect(hidden).toBeNull()
    expect(database.calls[0]?.statement).toContain(
      "onboarding.operator_id = $1::uuid"
    )
    expect(database.calls[0]?.parameters).toEqual([operatorId])
    expect(database.calls[1]?.parameters).toEqual([
      otherOperatorId,
      applicationId,
    ])
  })

  it("deletes only an owned draft with no published knowledge", async () => {
    const database = new ScriptedDatabase([[{ id: applicationId }], []])
    const repository = new OnboardingRepository(database)

    await expect(
      repository.deleteDraft(operatorId, applicationId)
    ).resolves.toBe(true)
    await expect(
      repository.deleteDraft(otherOperatorId, applicationId)
    ).resolves.toBe(false)

    expect(database.calls[0]?.statement).toContain(
      "onboarding.operator_id = $1::uuid"
    )
    expect(database.calls[0]?.statement).toContain("graph_revision = 0")
    expect(database.calls[0]?.statement).toContain("indexed_commit_sha is null")
  })

  it("marks current knowledge stale and invalidates inspection on relevant edits", async () => {
    const current = configuration()
    const changed = configuration({
      recordId: applicationId,
      repository: {
        ...current.repository,
        ref: "0497418d5c66d20693751e68be066260eda3f37f",
      },
    })
    const changedRow = row({
      config: changed,
      status: "stale",
      graphRevision: 2,
      indexedCommitSha: "e".repeat(40),
      knowledgeStale: true,
    })
    const database = new ScriptedDatabase([
      [
        row({
          config: current,
          status: "ready",
          graphRevision: 2,
          indexedCommitSha: "e".repeat(40),
          compatibility: report(current),
          confirmed: true,
        }),
      ],
      [],
      [],
      [],
      [changedRow],
    ])
    const repository = new OnboardingRepository(database)

    const result = await repository.saveDraft({
      operatorId,
      stableKey,
      configuration: changed,
    })

    expect(result.relevantChanged).toBe(true)
    expect(result.record).toMatchObject({
      status: "stale",
      knowledgeStale: true,
      compatibility: null,
      confirmationFingerprint: null,
    })
    expect(database.calls[2]?.statement).toContain(
      "confirmation_fingerprint = case when $6 then null"
    )
    expect(database.calls[3]?.statement).toContain("sentinel.sources")
  })

  it("preserves readiness and confirmation for name-only edits", async () => {
    const config = configuration({ recordId: applicationId })
    const compatibility = report(config)
    const currentRow = row({
      config,
      status: "ready",
      graphRevision: 2,
      compatibility,
      confirmed: true,
    })
    const renamedRow = row({
      config: { ...config, name: "Hi.Events demo" },
      name: "Hi.Events demo",
      status: "ready",
      graphRevision: 2,
      compatibility,
      confirmed: true,
    })
    const database = new ScriptedDatabase([[currentRow], [], [], [renamedRow]])
    const repository = new OnboardingRepository(database)

    const result = await repository.saveDraft({
      operatorId,
      stableKey,
      configuration: { ...config, name: "Hi.Events demo" },
    })

    expect(result.relevantChanged).toBe(false)
    expect(result.record).toMatchObject({
      name: "Hi.Events demo",
      status: "ready",
    })
    expect(
      database.calls.some((call) => call.statement.includes("sentinel.sources"))
    ).toBe(false)
  })

  it("records only a current inspection and requires it for confirmation", async () => {
    const config = configuration({ recordId: applicationId })
    const compatibility = report(config)
    const inspectedConfig = onboardingConfigurationSchema.parse({
      ...config,
      repository: {
        ...config.repository,
        resolvedCommitSha: compatibility.resolvedCommitSha,
      },
    })
    const inspectedRow = row({
      config: inspectedConfig,
      status: "awaiting_confirmation",
      compatibility,
    })
    const confirmedRow = row({
      config: inspectedConfig,
      status: "awaiting_confirmation",
      compatibility,
      confirmed: true,
    })
    const fingerprint = createOnboardingInputFingerprint(config)
    const database = new ScriptedDatabase([
      [row({ config })],
      [],
      [],
      [],
      [inspectedRow],
      [{ application_id: applicationId }],
      [confirmedRow],
    ])
    const repository = new OnboardingRepository(database)

    const inspected = await repository.recordInspection({
      operatorId,
      applicationId,
      expectedFingerprint: fingerprint,
      report: compatibility,
    })
    const confirmed = await repository.confirm({
      operatorId,
      applicationId,
      expectedFingerprint: fingerprint,
    })

    expect(inspected?.status).toBe("awaiting_confirmation")
    expect(confirmed?.confirmationFingerprint).toBe(fingerprint)
    expect(database.calls[5]?.statement).toContain("inspected_fingerprint = $3")
    expect(database.calls[5]?.statement).toContain(
      "compatibility_report ->> 'status' <> 'blocked'"
    )
  })

  it("rejects stale inspection and confirmation compare-and-set writes", async () => {
    const config = configuration({ recordId: applicationId })
    const staleFingerprint = contentHashSchema.parse(`sha256:${"f".repeat(64)}`)
    const database = new ScriptedDatabase([[row({ config })], []])
    const repository = new OnboardingRepository(database)

    const staleInspection = await repository.recordInspection({
      operatorId,
      applicationId,
      expectedFingerprint: staleFingerprint,
      report: {
        ...report(config),
        inputFingerprint: staleFingerprint,
      },
    })
    const staleConfirmation = await repository.confirm({
      operatorId,
      applicationId,
      expectedFingerprint: staleFingerprint,
    })

    expect(staleInspection).toBeNull()
    expect(staleConfirmation).toBeNull()
  })

  it("projects an explicit client DTO without opaque secret references", () => {
    const config = configuration({ recordId: applicationId })
    const compatibility = report(config)
    const publicApplication = toPublicOnboardingApplication(
      // Mapping through list exercises the same row parser used in production.
      {
        id: applicationId,
        stableKey,
        name: config.name,
        deploymentUrl: config.deploymentUrl,
        status: "awaiting_confirmation",
        indexedCommitSha: null,
        graphRevision: 0,
        refreshedAt: null,
        configuration: config,
        inputFingerprint: createOnboardingInputFingerprint(config),
        inspectedFingerprint: compatibility.inputFingerprint,
        compatibility,
        confirmationFingerprint: null,
        knowledgeStale: false,
        inspectedAt: new Date(compatibility.inspectedAt),
        confirmedAt: null,
        completedThrough: "safety",
        updatedAt: new Date("2026-09-08T00:02:00.000Z"),
      }
    )

    expect(publicApplication.configuration.authentication).toEqual({
      method: "credentials",
      automationConfirmed: true,
      configuredFields: [
        { key: "email", label: "Email" },
        { key: "password", label: "Password" },
      ],
      revision: 1,
    })
    expect(JSON.stringify(publicApplication)).not.toContain("secret-ref:v1")
  })
})

describe("onboarding migration", () => {
  const migration = readFileSync(
    new URL(
      "../../../supabase/migrations/20260908000100_onboarding_control_plane.sql",
      import.meta.url
    ),
    "utf8"
  )

  it("stores owner-scoped reference-only configuration and compare-and-set metadata", () => {
    expect(migration).toContain("sentinel.onboarding_configurations")
    expect(migration).toContain("operator_id uuid not null")
    expect(migration).toContain("input_fingerprint text not null")
    expect(migration).toContain("'lax $.**.keyvalue()")
    expect(migration).toContain("'{}'::jsonb")
    expect(migration).not.toContain("'strict $.**.keyvalue()")
    expect(migration).toContain("confirmation_fingerprint = input_fingerprint")
    expect(migration).toContain(
      "compatibility_report ->> 'status' <> 'blocked'"
    )
    expect(migration).toContain("enable row level security")
    expect(migration).toContain(
      "revoke all on table sentinel.onboarding_configurations from anon"
    )
    expect(migration).not.toMatch(/\b(secret_value|decrypted_secret)\b/i)
  })
})
