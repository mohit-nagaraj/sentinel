import {
  compatibilityReportSchema,
  contentHashSchema,
  createOnboardingInputFingerprint,
  onboardingConfigurationSchema,
  secretReferenceSchema,
  type CompatibilityReport,
  type OnboardingConfiguration,
} from "@sentinel/contracts"
import type {
  OnboardingRecord,
  SaveOnboardingDraftResult,
  SecretReferenceRecord,
} from "@sentinel/storage"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  createControlPlane,
  type OnboardingInspector,
  type OnboardingSecretStore,
  type OnboardingStore,
} from "./control-plane"

const operatorId = "11111111-1111-4111-8111-111111111111"
const applicationId = "22222222-2222-4222-8222-222222222222"
const stableKey = `application:v1:${"a".repeat(64)}`

function validForm(
  authentication: "none" | "credentials" | "storage_state" = "none"
) {
  const form = new FormData()
  form.set("name", "Hi.Events")
  form.set("deploymentUrl", "https://demo.hi.events")
  form.set("repositoryUrl", "https://github.com/mohit-nagaraj/Hi.Events")
  form.set("repositoryRef", "develop")
  form.set("repositoryAccessMode", "manual")
  form.set(
    "documentationSources",
    "https://hi.events/docs\nrepository://README.md"
  )
  form.set("authenticationMethod", authentication)
  form.set("allowedHosts", "demo.hi.events")
  form.set("maxActions", "40")
  form.set("maxScreens", "20")
  form.set("maxDurationSeconds", "300")
  form.set("allowFormSubmission", "on")
  form.set("denyDestructiveActions", "on")
  form.set("denyRealPayments", "on")
  form.set("denyExternalMessaging", "on")
  form.set("denyPrivilegeChanges", "on")
  form.set("capabilityHints", "Attendee checkout")
  if (authentication === "credentials") {
    form.set("authenticationAutomationConfirmed", "on")
    form.append("credentialKey", "email")
    form.append("credentialLabel", "Email")
    form.append("credentialValue", "operator@example.com")
    form.append("credentialKey", "password")
    form.append("credentialLabel", "Password")
    form.append("credentialValue", "super-private-target-password")
  }
  if (authentication === "storage_state") {
    form.set("authenticationAutomationConfirmed", "on")
    form.set("storageState", JSON.stringify({ cookies: [], origins: [] }))
  }
  return form
}

function makeRecord(
  configurationInput: OnboardingConfiguration,
  overrides: Partial<OnboardingRecord> = {}
): OnboardingRecord {
  const configuration = onboardingConfigurationSchema.parse({
    ...configurationInput,
    recordId: overrides.id ?? configurationInput.recordId ?? applicationId,
  })
  const inputFingerprint = createOnboardingInputFingerprint(configuration)
  return {
    id: applicationId,
    stableKey,
    name: configuration.name,
    deploymentUrl: configuration.deploymentUrl,
    status: "inspecting",
    indexedCommitSha: null,
    graphRevision: 0,
    refreshedAt: null,
    configuration,
    inputFingerprint,
    inspectedFingerprint: null,
    compatibility: null,
    confirmationFingerprint: null,
    knowledgeStale: false,
    inspectedAt: null,
    confirmedAt: null,
    updatedAt: new Date("2026-09-08T00:00:00.000Z"),
    ...overrides,
  }
}

class FakeStore implements OnboardingStore {
  readonly actorIds: string[] = []
  readonly saveCalls: OnboardingConfiguration[] = []
  readonly deleteDraftCalls: string[] = []
  record: OnboardingRecord | null = null
  failSaveAt = 0

  async list(operator: string) {
    this.actorIds.push(operator)
    return this.record === null ? [] : [this.record]
  }

  async get(operator: string, id: string) {
    this.actorIds.push(operator)
    return this.record?.id === id ? this.record : null
  }

  async deleteDraft(operator: string, id: string) {
    this.actorIds.push(operator)
    this.deleteDraftCalls.push(id)
    if (this.record?.id !== id) return false
    this.record = null
    return true
  }

  async saveDraft(input: {
    readonly operatorId: string
    readonly stableKey: string
    readonly configuration: OnboardingConfiguration
  }): Promise<SaveOnboardingDraftResult> {
    this.actorIds.push(input.operatorId)
    this.saveCalls.push(input.configuration)
    if (this.failSaveAt === this.saveCalls.length) {
      throw new Error("database password=must-not-leak")
    }
    const id = input.configuration.recordId ?? applicationId
    const configuration = onboardingConfigurationSchema.parse({
      ...input.configuration,
      recordId: id,
    })
    const previous = this.record
    const inputFingerprint = createOnboardingInputFingerprint(configuration)
    const relevantChanged =
      previous === null || previous.inputFingerprint !== inputFingerprint
    this.record = makeRecord(configuration, {
      id,
      stableKey: input.stableKey,
      inputFingerprint,
      status: relevantChanged
        ? "inspecting"
        : (previous?.status ?? "inspecting"),
      compatibility: relevantChanged ? null : (previous?.compatibility ?? null),
      inspectedFingerprint: relevantChanged
        ? null
        : (previous?.inspectedFingerprint ?? null),
      confirmationFingerprint: relevantChanged
        ? null
        : (previous?.confirmationFingerprint ?? null),
    })
    return { record: this.record, relevantChanged }
  }

  async recordInspection(input: {
    readonly operatorId: string
    readonly applicationId: string
    readonly expectedFingerprint: string
    readonly report: CompatibilityReport
  }) {
    this.actorIds.push(input.operatorId)
    if (
      this.record?.id !== input.applicationId ||
      this.record.inputFingerprint !== input.expectedFingerprint
    ) {
      return null
    }
    const configuration = onboardingConfigurationSchema.parse({
      ...this.record.configuration,
      repository: {
        ...this.record.configuration.repository,
        resolvedCommitSha: input.report.resolvedCommitSha,
      },
    })
    this.record = makeRecord(configuration, {
      ...this.record,
      configuration,
      status:
        input.report.status === "blocked" ? "failed" : "awaiting_confirmation",
      compatibility: input.report,
      inspectedFingerprint: contentHashSchema.parse(input.expectedFingerprint),
      inspectedAt: new Date(input.report.inspectedAt),
    })
    return this.record
  }

  async confirm(input: {
    readonly operatorId: string
    readonly applicationId: string
    readonly expectedFingerprint: string
  }) {
    this.actorIds.push(input.operatorId)
    if (
      this.record?.id !== input.applicationId ||
      this.record.inputFingerprint !== input.expectedFingerprint ||
      this.record.inspectedFingerprint !== input.expectedFingerprint ||
      this.record.compatibility?.status === "blocked"
    ) {
      return null
    }
    this.record = {
      ...this.record,
      confirmationFingerprint: this.record.inputFingerprint,
      confirmedAt: new Date("2026-09-08T00:01:00.000Z"),
    }
    return this.record
  }
}

class FakeSecrets implements OnboardingSecretStore {
  readonly created: Array<{
    readonly applicationId: string
    readonly name: string
    readonly value: string
    readonly reference: string
  }> = []
  readonly deleted: string[] = []
  failAt = 0

  async create(input: {
    readonly applicationId: string
    readonly name: string
    readonly value: string
  }): Promise<SecretReferenceRecord> {
    if (this.failAt === this.created.length + 1) {
      throw new Error("Vault failure secret=must-not-leak")
    }
    const reference = secretReferenceSchema.parse(
      `secret-ref:v1:${String(this.created.length + 1).padStart(64, "a")}`
    )
    this.created.push({ ...input, reference })
    return { reference, name: input.name, rotatedAt: null }
  }

  async delete(_applicationId: string, reference: string) {
    this.deleted.push(reference)
    return true
  }
}

function compatibility(
  configuration: OnboardingConfiguration,
  blocked = false
): CompatibilityReport {
  const finding = blocked
    ? [
        {
          severity: "blocker" as const,
          code: "application_unreachable",
          summary: "The application is unavailable",
          humanAction: "Correct the deployment URL and inspect again",
        },
      ]
    : []
  return compatibilityReportSchema.parse({
    schemaVersion: 1,
    inputFingerprint: createOnboardingInputFingerprint(configuration),
    status: blocked ? "blocked" : "supported",
    resolvedCommitSha: "d".repeat(40),
    selectedAdapters: ["php_laravel", "playwright", "typescript_react"],
    evidence: [
      {
        capability: "repository_resolved",
        status: "detected",
        code: "immutable_commit_resolved",
        summary: "Repository reference resolved to an immutable commit",
        source: "repository",
        references: ["composer.json"],
      },
      {
        capability: "documentation_reachable",
        status: "detected",
        code: "documentation_sources_reachable",
        summary: "Every configured documentation source is reachable",
        source: "documentation",
        references: configuration.documentationSources,
      },
      {
        capability: "application_reachable",
        status: blocked ? "blocked" : "detected",
        code: blocked ? "application_unreachable" : "application_browser_ready",
        summary: blocked
          ? "The application is unavailable"
          : "The application is browser ready",
        source: "application",
        references: [configuration.deploymentUrl],
      },
    ],
    findings: finding,
    humanActions: finding.map((item) => item.humanAction),
    proposedScope: {
      repositoryPaths: ["frontend", "app"],
      documentationSources: configuration.documentationSources,
      applicationOrigins: [new URL(configuration.deploymentUrl).origin],
      allowedActionCategories: ["safe_read", "safe_navigation"],
      maxActions: configuration.crawl.maxActions,
      maxScreens: configuration.crawl.maxScreens,
      maxDurationSeconds: configuration.crawl.maxDurationSeconds,
    },
    inspectedAt: "2026-09-08T00:00:00.000Z",
  })
}

class FakeInspector implements OnboardingInspector {
  readonly inputs: OnboardingConfiguration[] = []

  constructor(
    private readonly blocked = false,
    private readonly failure?: Error
  ) {}

  async inspect(configuration: OnboardingConfiguration) {
    this.inputs.push(configuration)
    if (this.failure !== undefined) throw this.failure
    return compatibility(configuration, this.blocked)
  }
}

describe("onboarding control plane", () => {
  let store: FakeStore
  let secrets: FakeSecrets

  beforeEach(() => {
    store = new FakeStore()
    secrets = new FakeSecrets()
  })

  it("validates on the server and preserves only non-secret form state", async () => {
    const controlPlane = createControlPlane({
      operatorId,
      store,
      secrets,
      inspector: new FakeInspector(),
    })
    const form = validForm("credentials")
    form.set("deploymentUrl", "not-a-url")
    form.delete("denyRealPayments")

    const result = await controlPlane.inspect(form)

    expect(result.status).toBe("validation_error")
    expect(result.values.name).toBe("Hi.Events")
    expect(result.fieldErrors).toMatchObject({
      deploymentUrl: expect.any(Array),
      denyRealPayments: expect.any(Array),
    })
    expect(JSON.stringify(result)).not.toContain(
      "super-private-target-password"
    )
    expect(store.saveCalls).toHaveLength(0)
    expect(secrets.created).toHaveLength(0)
  })

  it("creates restricted credential references, inspects, and confirms safely", async () => {
    const inspector = new FakeInspector()
    const controlPlane = createControlPlane({
      operatorId,
      store,
      secrets,
      inspector,
    })
    const form = validForm("credentials")

    const inspected = await controlPlane.inspect(form)

    expect(inspected.status).toBe("inspected")
    expect(inspected.application).toMatchObject({
      status: "awaiting_confirmation",
      confirmed: false,
      configuration: {
        authentication: {
          method: "credentials",
          automationConfirmed: true,
          configuredFields: [
            { key: "email", label: "Email" },
            { key: "password", label: "Password" },
          ],
        },
      },
    })
    expect(secrets.created.map((entry) => entry.value)).toEqual([
      "operator@example.com",
      "super-private-target-password",
    ])
    expect(JSON.stringify(store.record?.configuration)).toContain(
      "secret-ref:v1"
    )
    expect(JSON.stringify(inspector.inputs)).not.toContain(
      "super-private-target-password"
    )
    expect(JSON.stringify(inspected)).not.toContain("secret-ref:v1")
    expect(JSON.stringify(inspected)).not.toContain(
      "super-private-target-password"
    )

    form.set("recordId", inspected.application?.id ?? "")
    form.set(
      "inputFingerprint",
      inspected.application?.compatibility?.inputFingerprint ?? ""
    )
    form.delete("credentialValue")
    form.append("credentialValue", "")
    form.append("credentialValue", "")
    form.set("repositoryRef", "main")
    const staleConfirmation = await controlPlane.confirm(form)
    expect(staleConfirmation.status).toBe("validation_error")
    expect(staleConfirmation.fieldErrors["form"]).toContain(
      "Configuration changed; inspect the current values again"
    )

    form.set("repositoryRef", "develop")
    const confirmed = await controlPlane.confirm(form)

    expect(confirmed).toMatchObject({
      status: "confirmed",
      application: { confirmed: true },
    })
    expect(store.actorIds.every((actor) => actor === operatorId)).toBe(true)
  })

  it("replaces changed credentials and deletes superseded references", async () => {
    const config = onboardingConfigurationSchema.parse({
      schemaVersion: 1,
      recordId: applicationId,
      name: "Hi.Events",
      deploymentUrl: "https://demo.hi.events",
      repository: {
        url: "https://github.com/mohit-nagaraj/Hi.Events",
        ref: "develop",
        accessMode: "manual",
      },
      documentationSources: [
        "https://hi.events/docs",
        "repository://README.md",
      ],
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
      capabilityHints: [],
    })
    store.record = makeRecord(config)
    const controlPlane = createControlPlane({
      operatorId,
      store,
      secrets,
      inspector: new FakeInspector(),
    })
    const form = validForm("credentials")
    form.set("recordId", applicationId)
    form.delete("credentialValue")
    form.append("credentialValue", "")
    form.append("credentialValue", "replacement-password")

    const result = await controlPlane.inspect(form)

    expect(result.status).toBe("inspected")
    expect(secrets.created).toHaveLength(1)
    expect(secrets.created[0]).toMatchObject({
      name: "onboarding_password_2",
      value: "replacement-password",
    })
    expect(secrets.deleted).toEqual([`secret-ref:v1:${"c".repeat(64)}`])
    expect(store.record?.configuration.authentication).toMatchObject({
      method: "credentials",
      automationConfirmed: true,
      revision: 2,
    })
  })

  it("cleans up a reserved application and created secrets on setup failure", async () => {
    secrets.failAt = 2
    const controlPlane = createControlPlane({
      operatorId,
      store,
      secrets,
      inspector: new FakeInspector(),
    })

    const result = await controlPlane.inspect(validForm("credentials"))

    expect(result.status).toBe("error")
    expect(store.deleteDraftCalls).toEqual([applicationId])
    expect(secrets.created).toHaveLength(1)
    expect(secrets.deleted).toEqual([secrets.created[0]?.reference])
    expect(JSON.stringify(result)).not.toContain("must-not-leak")
  })

  it("cleans newly created Vault references when an existing edit fails to save", async () => {
    const existingForm = validForm("credentials")
    const bootstrap = createControlPlane({
      operatorId,
      store,
      secrets,
      inspector: new FakeInspector(),
    })
    const initial = await bootstrap.inspect(existingForm)
    expect(initial.status).toBe("inspected")
    const previousReferences = [
      ...secrets.created.map((entry) => entry.reference),
    ]

    store.saveCalls.length = 0
    store.failSaveAt = 1
    const edit = validForm("credentials")
    edit.set("recordId", applicationId)
    edit.delete("credentialValue")
    edit.append("credentialValue", "")
    edit.append("credentialValue", "replacement-after-failure")

    const result = await bootstrap.inspect(edit)

    expect(result.status).toBe("error")
    const replacement = secrets.created.at(-1)?.reference
    expect(replacement).toBeDefined()
    expect(previousReferences).not.toContain(replacement)
    expect(secrets.deleted).toContain(replacement)
    expect(store.deleteDraftCalls).toHaveLength(0)
  })

  it("blocks protected targets until no-CAPTCHA automation is confirmed", async () => {
    const controlPlane = createControlPlane({
      operatorId,
      store,
      secrets,
      inspector: {
        inspect: async (configuration) => {
          const supported = compatibility(configuration)
          const finding = {
            severity: "blocker" as const,
            code: "authentication_requires_confirmation",
            summary: "Automated authentication has not been confirmed",
            humanAction:
              "Verify automated login without CAPTCHA and inspect again",
          }
          return compatibilityReportSchema.parse({
            ...supported,
            status: "blocked",
            findings: [finding],
            humanActions: [finding.humanAction],
          })
        },
      },
    })
    const form = validForm("credentials")
    form.delete("authenticationAutomationConfirmed")

    const result = await controlPlane.inspect(form)

    expect(result.application?.compatibility).toMatchObject({
      status: "blocked",
      findings: [
        expect.objectContaining({
          code: "authentication_requires_confirmation",
        }),
      ],
    })
  })

  it("blocks cross-operator identifiers before secret or inspection work", async () => {
    const inspector = new FakeInspector()
    const controlPlane = createControlPlane({
      operatorId,
      store,
      secrets,
      inspector,
    })
    const form = validForm("credentials")
    form.set("recordId", "99999999-9999-4999-8999-999999999999")

    const result = await controlPlane.inspect(form)

    expect(result.status).toBe("validation_error")
    expect(result.fieldErrors["form"]).toContain(
      "The application is unavailable for this operator"
    )
    expect(secrets.created).toHaveLength(0)
    expect(inspector.inputs).toHaveLength(0)
  })

  it("surfaces compatibility blockers and refuses their confirmation", async () => {
    const controlPlane = createControlPlane({
      operatorId,
      store,
      secrets,
      inspector: new FakeInspector(true),
    })
    const form = validForm()
    const inspected = await controlPlane.inspect(form)

    expect(inspected).toMatchObject({
      status: "inspected",
      application: {
        status: "failed",
        compatibility: { status: "blocked" },
      },
    })
    form.set("recordId", inspected.application?.id ?? "")
    form.set(
      "inputFingerprint",
      inspected.application?.compatibility?.inputFingerprint ?? ""
    )

    const confirmed = await controlPlane.confirm(form)

    expect(confirmed.status).toBe("validation_error")
    expect(confirmed.fieldErrors["form"]).toContain(
      "Configuration changed or still has blockers; inspect again"
    )
  })

  it("redacts unexpected inspector failures after safe persistence", async () => {
    const controlPlane = createControlPlane({
      operatorId,
      store,
      secrets,
      inspector: new FakeInspector(
        false,
        new Error("provider token=ultra-sensitive")
      ),
    })

    const result = await controlPlane.inspect(validForm("storage_state"))

    expect(result.status).toBe("error")
    expect(store.record).not.toBeNull()
    expect(JSON.stringify(result)).not.toContain("ultra-sensitive")
    expect(JSON.stringify(result)).not.toContain("cookies")
  })
})
