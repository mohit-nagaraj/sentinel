import "server-only"

import { randomUUID } from "node:crypto"

import { createProductionCompatibilityInspector } from "@sentinel/adapters/onboarding"
import {
  compatibilityReportSchema,
  contentHashSchema,
  createOnboardingInputFingerprint,
  createStableKey,
  hashCanonical,
  onboardingActionStateSchema,
  onboardingAuthenticationConfigurationSchema,
  onboardingAuthenticationInputSchema,
  onboardingConfigurationSchema,
  onboardingCompletedStepSchema,
  onboardingFormValuesSchema,
  secretReferenceSchema,
  type CompatibilityReport,
  type OnboardingActionState,
  type OnboardingAuthenticationConfiguration,
  type OnboardingConfiguration,
  type OnboardingCompletedStep,
  type OnboardingFormValues,
  type PublicOnboardingApplication,
} from "@sentinel/contracts"
import {
  createPostgresDatabase,
  OnboardingRepository,
  TargetSecretService,
  toPublicOnboardingApplication,
  type OnboardingRecord,
  type SaveOnboardingDraftResult,
  type SecretReferenceRecord,
} from "@sentinel/storage"
import { z, type ZodIssue } from "zod"

export interface OnboardingStore {
  list(operatorId: string): Promise<readonly OnboardingRecord[]>
  get(
    operatorId: string,
    applicationId: string
  ): Promise<OnboardingRecord | null>
  deleteDraft(operatorId: string, applicationId: string): Promise<boolean>
  saveDraft(input: {
    readonly operatorId: string
    readonly stableKey: string
    readonly configuration: OnboardingConfiguration
    readonly completedThrough?: OnboardingCompletedStep
  }): Promise<SaveOnboardingDraftResult>
  recordInspection(input: {
    readonly operatorId: string
    readonly applicationId: string
    readonly expectedFingerprint: string
    readonly report: CompatibilityReport
  }): Promise<OnboardingRecord | null>
  confirm(input: {
    readonly operatorId: string
    readonly applicationId: string
    readonly expectedFingerprint: string
  }): Promise<OnboardingRecord | null>
}

export interface OnboardingSecretStore {
  create(input: {
    readonly applicationId: string
    readonly name: string
    readonly value: string
  }): Promise<SecretReferenceRecord>
  delete(applicationId: string, reference: string): Promise<boolean>
}

export interface OnboardingInspector {
  inspect(
    configuration: OnboardingConfiguration,
    signal?: AbortSignal
  ): Promise<CompatibilityReport>
}

export interface ControlPlaneOptions {
  readonly operatorId: string
  readonly store: OnboardingStore
  readonly secrets: OnboardingSecretStore
  readonly inspector: OnboardingInspector
}

const operatorIdSchema = z.uuid()
const databaseIdSchema = z.uuid()
const secretValueLimit = 16_384
const storageStateLimit = 256 * 1_024
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

export const emptyOnboardingFormValues = onboardingFormValuesSchema.parse({
  name: "",
  deploymentUrl: "",
  repositoryUrl: "",
  repositoryRef: "develop",
  repositoryAccessMode: "manual",
  githubInstallationId: "",
  documentationSources: "",
  previewUrlPattern: "",
  authenticationMethod: "none",
  authenticationAutomationConfirmed: false,
  credentialFields: [
    { key: "email", label: "Email" },
    { key: "password", label: "Password" },
  ],
  allowedHosts: "",
  maxActions: "40",
  maxScreens: "20",
  maxDurationSeconds: "300",
  allowFormSubmission: false,
  denyDestructiveActions: true,
  denyRealPayments: true,
  denyExternalMessaging: true,
  denyPrivilegeChanges: true,
  capabilityHints: "",
  testDataSetupReference: "",
  testDataResetReference: "",
})

export const initialOnboardingActionState = onboardingActionStateSchema.parse({
  status: "idle",
  fieldErrors: {},
  values: emptyOnboardingFormValues,
})

class FormValidationError extends Error {
  constructor(
    readonly fieldErrors: Readonly<Record<string, readonly string[]>>
  ) {
    super("Onboarding form is invalid")
    this.name = "FormValidationError"
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

function readText(formData: FormData, name: string, maxLength: number): string {
  const value = formData.get(name)
  return typeof value === "string" ? value.slice(0, maxLength) : ""
}

function readTexts(
  formData: FormData,
  name: string,
  maxItems: number,
  maxLength: number
): string[] {
  return formData
    .getAll(name)
    .filter((value): value is string => typeof value === "string")
    .slice(0, maxItems)
    .map((value) => value.slice(0, maxLength))
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function hosts(value: string): string[] {
  return value
    .split(/[\r\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function selected<T extends string>(
  value: string,
  allowed: readonly T[],
  fallback: T
): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

export function readSafeOnboardingValues(
  formData: FormData
): OnboardingFormValues {
  const recordIdInput = readText(formData, "recordId", 64)
  const recordId = databaseIdSchema.safeParse(recordIdInput)
  const keys = readTexts(formData, "credentialKey", 10, 96)
  const labels = readTexts(formData, "credentialLabel", 10, 80)
  const credentialFields = Array.from(
    { length: Math.max(keys.length, labels.length) },
    (_, index) => ({ key: keys[index] ?? "", label: labels[index] ?? "" })
  )
  return onboardingFormValuesSchema.parse({
    ...(recordId.success ? { recordId: recordId.data } : {}),
    name: readText(formData, "name", 512),
    deploymentUrl: readText(formData, "deploymentUrl", 2_048),
    repositoryUrl: readText(formData, "repositoryUrl", 2_048),
    repositoryRef: readText(formData, "repositoryRef", 255),
    repositoryAccessMode: selected(
      readText(formData, "repositoryAccessMode", 32),
      ["manual", "github_app"] as const,
      "manual"
    ),
    githubInstallationId: readText(formData, "githubInstallationId", 20),
    documentationSources: readText(formData, "documentationSources", 16_384),
    previewUrlPattern: readText(formData, "previewUrlPattern", 2_048),
    authenticationMethod: selected(
      readText(formData, "authenticationMethod", 32),
      ["none", "credentials", "storage_state"] as const,
      "none"
    ),
    authenticationAutomationConfirmed: formData.has(
      "authenticationAutomationConfirmed"
    ),
    credentialFields,
    allowedHosts: readText(formData, "allowedHosts", 4_096),
    maxActions: readText(formData, "maxActions", 8),
    maxScreens: readText(formData, "maxScreens", 8),
    maxDurationSeconds: readText(formData, "maxDurationSeconds", 8),
    allowFormSubmission: formData.has("allowFormSubmission"),
    denyDestructiveActions: formData.has("denyDestructiveActions"),
    denyRealPayments: formData.has("denyRealPayments"),
    denyExternalMessaging: formData.has("denyExternalMessaging"),
    denyPrivilegeChanges: formData.has("denyPrivilegeChanges"),
    capabilityHints: readText(formData, "capabilityHints", 8_192),
    testDataSetupReference: readText(formData, "testDataSetupReference", 4_096),
    testDataResetReference: readText(formData, "testDataResetReference", 4_096),
  })
}

const fieldByPath: Readonly<Record<string, string>> = {
  name: "name",
  deploymentUrl: "deploymentUrl",
  "repository.url": "repositoryUrl",
  "repository.ref": "repositoryRef",
  "repository.accessMode": "repositoryAccessMode",
  "repository.installationId": "githubInstallationId",
  documentationSources: "documentationSources",
  previewUrlPattern: "previewUrlPattern",
  authentication: "authentication",
  "crawl.allowedHosts": "allowedHosts",
  "crawl.maxActions": "maxActions",
  "crawl.maxScreens": "maxScreens",
  "crawl.maxDurationSeconds": "maxDurationSeconds",
  "crawl.allowFormSubmission": "allowFormSubmission",
  "crawl.denyDestructiveActions": "denyDestructiveActions",
  "crawl.denyRealPayments": "denyRealPayments",
  "crawl.denyExternalMessaging": "denyExternalMessaging",
  "crawl.denyPrivilegeChanges": "denyPrivilegeChanges",
  capabilityHints: "capabilityHints",
  testDataSetupReference: "testDataSetupReference",
  testDataResetReference: "testDataResetReference",
}

function issuesToFields(issues: readonly ZodIssue[]) {
  const result: Record<string, string[]> = {}
  for (const issue of issues) {
    const path = issue.path.map(String).join(".")
    const normalizedPath = path.replace(
      /^authentication(?:\..*)?$/,
      "authentication"
    )
    const field = fieldByPath[normalizedPath] ?? fieldByPath[path] ?? "form"
    result[field] = [...(result[field] ?? []), issue.message]
  }
  return result
}

function validationState(
  values: OnboardingFormValues,
  fieldErrors: Readonly<Record<string, readonly string[]>>
): OnboardingActionState {
  return onboardingActionStateSchema.parse({
    status: "validation_error",
    message: "Review the highlighted fields and run inspection again",
    fieldErrors,
    values,
  })
}

function errorState(values: OnboardingFormValues): OnboardingActionState {
  return onboardingActionStateSchema.parse({
    status: "error",
    message: "Onboarding could not be completed safely; retry the operation",
    fieldErrors: {},
    values,
  })
}

function baseConfiguration(
  values: OnboardingFormValues
): OnboardingConfiguration {
  const repository = {
    url: values.repositoryUrl,
    ref: values.repositoryRef,
    accessMode: values.repositoryAccessMode,
    ...(values.repositoryAccessMode === "github_app" &&
    values.githubInstallationId.trim().length > 0
      ? { installationId: values.githubInstallationId }
      : {}),
  }
  const candidate = {
    schemaVersion: 1,
    ...(values.recordId === undefined ? {} : { recordId: values.recordId }),
    name: values.name,
    deploymentUrl: values.deploymentUrl,
    repository,
    documentationSources: lines(values.documentationSources),
    ...(values.previewUrlPattern.trim().length === 0
      ? {}
      : { previewUrlPattern: values.previewUrlPattern }),
    authentication: { method: "none", revision: 0 },
    crawl: {
      allowedHosts: hosts(values.allowedHosts),
      maxActions: Number(values.maxActions),
      maxScreens: Number(values.maxScreens),
      maxDurationSeconds: Number(values.maxDurationSeconds),
      allowFormSubmission: values.allowFormSubmission,
      denyDestructiveActions: values.denyDestructiveActions,
      denyRealPayments: values.denyRealPayments,
      denyExternalMessaging: values.denyExternalMessaging,
      denyPrivilegeChanges: values.denyPrivilegeChanges,
    },
    capabilityHints: lines(values.capabilityHints),
    ...(values.testDataSetupReference.trim().length === 0
      ? {}
      : { testDataSetupReference: values.testDataSetupReference }),
    ...(values.testDataResetReference.trim().length === 0
      ? {}
      : { testDataResetReference: values.testDataResetReference }),
  }
  const parsed = onboardingConfigurationSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new FormValidationError(issuesToFields(parsed.error.issues))
  }
  return parsed.data
}

function stableApplicationKey(configuration: OnboardingConfiguration): string {
  const url = new URL(configuration.repository.url)
  const [owner = "", nameWithSuffix = ""] = url.pathname
    .split("/")
    .filter(Boolean)
  return createStableKey({
    kind: "application",
    deploymentUrl: configuration.deploymentUrl,
    repository: {
      host: "github.com",
      owner,
      name: nameWithSuffix.replace(/\.git$/i, ""),
    },
  })
}

function authenticationReferences(
  authentication: OnboardingAuthenticationConfiguration | undefined
): readonly string[] {
  if (authentication?.method === "credentials") {
    return authentication.fields.map((field) => field.reference)
  }
  return authentication?.method === "storage_state"
    ? [authentication.reference]
    : []
}

interface PreparedAuthentication {
  readonly authentication: OnboardingAuthenticationConfiguration
  readonly createdReferences: readonly string[]
  readonly supersededReferences: readonly string[]
}

async function prepareAuthentication(input: {
  readonly applicationId: string
  readonly values: OnboardingFormValues
  readonly formData: FormData
  readonly previous?: OnboardingAuthenticationConfiguration
  readonly secrets: OnboardingSecretStore
}): Promise<PreparedAuthentication> {
  const previous = input.previous
  const previousReferences = authenticationReferences(previous)
  if (input.values.authenticationMethod === "none") {
    return {
      authentication: { method: "none", revision: 0 },
      createdReferences: [],
      supersededReferences: previousReferences,
    }
  }

  if (input.values.authenticationMethod === "storage_state") {
    const raw = readText(input.formData, "storageState", storageStateLimit + 1)
    if (raw.length === 0 && previous?.method === "storage_state") {
      return {
        authentication: {
          ...previous,
          automationConfirmed: input.values.authenticationAutomationConfirmed,
        },
        createdReferences: [],
        supersededReferences: [],
      }
    }
    const parsed = onboardingAuthenticationInputSchema.safeParse({
      method: "storage_state",
      automationConfirmed: input.values.authenticationAutomationConfirmed,
      value: raw,
    })
    if (!parsed.success) {
      throw new FormValidationError({
        authentication: parsed.error.issues.map((issue) => issue.message),
      })
    }
    const revision =
      previous?.method === "storage_state" ? previous.revision + 1 : 1
    const created = await input.secrets.create({
      applicationId: input.applicationId,
      name: `onboarding_storage_state_${revision}`,
      value: raw,
    })
    return {
      authentication: {
        method: "storage_state",
        automationConfirmed: input.values.authenticationAutomationConfirmed,
        revision,
        reference: created.reference,
      },
      createdReferences: [created.reference],
      supersededReferences: previousReferences,
    }
  }

  const rawValues = readTexts(
    input.formData,
    "credentialValue",
    10,
    secretValueLimit + 1
  )
  const previousFields =
    previous?.method === "credentials" ? previous.fields : []
  const normalizedValues = input.values.credentialFields.map(
    (_, index) => rawValues[index] ?? ""
  )
  const validation = onboardingAuthenticationInputSchema.safeParse({
    method: "credentials",
    automationConfirmed: input.values.authenticationAutomationConfirmed,
    fields: input.values.credentialFields.map(({ key, label }, index) => ({
      key,
      label,
      value:
        normalizedValues[index]?.length === 0 &&
        previousFields.some((field) => field.key === key)
          ? "configured"
          : normalizedValues[index],
    })),
  })
  if (!validation.success) {
    throw new FormValidationError({
      authentication: validation.error.issues.map((issue) => issue.message),
    })
  }
  const changed = normalizedValues.some((value) => value.length > 0)
  const revision =
    previous?.method === "credentials"
      ? previous.revision + (changed ? 1 : 0)
      : 1
  const createdReferences: string[] = []
  try {
    const fields = []
    for (const [index, field] of input.values.credentialFields.entries()) {
      const value = normalizedValues[index] ?? ""
      const existing = previousFields.find(
        (candidate) => candidate.key === field.key
      )
      if (value.length === 0 && existing !== undefined) {
        fields.push({ ...field, reference: existing.reference })
        continue
      }
      const created = await input.secrets.create({
        applicationId: input.applicationId,
        name: `onboarding_${field.key}_${revision}`,
        value,
      })
      createdReferences.push(created.reference)
      fields.push({ ...field, reference: created.reference })
    }
    const authentication = onboardingAuthenticationConfigurationSchema.parse({
      method: "credentials",
      automationConfirmed: input.values.authenticationAutomationConfirmed,
      revision,
      fields,
    })
    const retained = new Set(authenticationReferences(authentication))
    return {
      authentication,
      createdReferences,
      supersededReferences: previousReferences.filter(
        (reference) => !retained.has(reference)
      ),
    }
  } catch (error) {
    await Promise.allSettled(
      createdReferences.map((reference) =>
        input.secrets.delete(input.applicationId, reference)
      )
    )
    throw error
  }
}

export class ControlPlane {
  private readonly operatorId: string

  constructor(private readonly options: ControlPlaneOptions) {
    this.operatorId = operatorIdSchema.parse(options.operatorId)
  }

  async listApplications(): Promise<readonly PublicOnboardingApplication[]> {
    return (await this.options.store.list(this.operatorId)).map(
      toPublicOnboardingApplication
    )
  }

  async inspect(formData: FormData): Promise<OnboardingActionState> {
    const submittedValues = readSafeOnboardingValues(formData)
    const completedThrough = onboardingCompletedStepSchema.parse(
      readText(formData, "completedThrough", 16) || "safety"
    )
    const values =
      completedThrough === "sources" &&
      submittedValues.allowedHosts.trim().length === 0
        ? {
            ...submittedValues,
            allowedHosts: (() => {
              try {
                return new URL(submittedValues.deploymentUrl).hostname
              } catch {
                return ""
              }
            })(),
          }
        : submittedValues
    const rawRecordId = readText(formData, "recordId", 64)
    if (rawRecordId.length > 0 && values.recordId === undefined) {
      return validationState(values, {
        form: ["The application identifier is invalid"],
      })
    }
    let provisionalApplicationId: string | undefined
    let secretApplicationId: string | undefined
    let createdReferences: readonly string[] = []
    let committedConfiguration = false
    try {
      const base = baseConfiguration(values)
      const existing =
        values.recordId === undefined
          ? null
          : await this.options.store.get(this.operatorId, values.recordId)
      if (values.recordId !== undefined && existing === null) {
        return validationState(values, {
          form: ["The application is unavailable for this operator"],
        })
      }
      const stableKey = stableApplicationKey(base)
      let applicationId = existing?.id

      if (
        applicationId === undefined &&
        values.authenticationMethod !== "none"
      ) {
        const provisional = await this.options.store.saveDraft({
          operatorId: this.operatorId,
          stableKey,
          configuration: base,
          completedThrough,
        })
        applicationId = provisional.record.id
        provisionalApplicationId = applicationId
      }
      secretApplicationId = applicationId

      const prepared =
        applicationId === undefined
          ? {
              authentication: {
                method: "none" as const,
                revision: 0 as const,
              },
              createdReferences: [],
              supersededReferences: [],
            }
          : await prepareAuthentication({
              applicationId,
              values,
              formData,
              ...(existing === null
                ? {}
                : { previous: existing.configuration.authentication }),
              secrets: this.options.secrets,
            })
      createdReferences = prepared.createdReferences
      const configuration = onboardingConfigurationSchema.parse({
        ...base,
        ...(applicationId === undefined ? {} : { recordId: applicationId }),
        authentication: prepared.authentication,
      })
      const saved = await this.options.store.saveDraft({
        operatorId: this.operatorId,
        stableKey,
        configuration,
        completedThrough,
      })
      committedConfiguration = true
      await Promise.allSettled(
        prepared.supersededReferences.map((reference) =>
          this.options.secrets.delete(saved.record.id, reference)
        )
      )
      if (completedThrough !== "safety") {
        return onboardingActionStateSchema.parse({
          status: "saved",
          message: `${completedThrough === "sources" ? "Sources" : "Access"} saved`,
          fieldErrors: {},
          values: { ...values, recordId: saved.record.id },
          application: toPublicOnboardingApplication(saved.record),
        })
      }
      const compatibility = await this.options.inspector.inspect(
        saved.record.configuration
      )
      const inspected = await this.options.store.recordInspection({
        operatorId: this.operatorId,
        applicationId: saved.record.id,
        expectedFingerprint: saved.record.inputFingerprint,
        report: compatibility,
      })
      if (inspected === null) return errorState(values)
      return onboardingActionStateSchema.parse({
        status: "inspected",
        message:
          compatibility.status === "blocked"
            ? "Inspection found blockers that require operator action"
            : "Inspection complete; review and confirm the proposed scope",
        fieldErrors: {},
        values: { ...values, recordId: inspected.id },
        application: toPublicOnboardingApplication(inspected),
      })
    } catch (error) {
      if (error instanceof FormValidationError) {
        if (provisionalApplicationId !== undefined) {
          await this.options.store.deleteDraft(
            this.operatorId,
            provisionalApplicationId
          )
        }
        return validationState(values, error.fieldErrors)
      }
      if (!committedConfiguration) {
        await Promise.allSettled(
          createdReferences.map((reference) =>
            secretApplicationId === undefined
              ? Promise.resolve(false)
              : this.options.secrets.delete(secretApplicationId, reference)
          )
        )
        if (provisionalApplicationId !== undefined) {
          await this.options.store.deleteDraft(
            this.operatorId,
            provisionalApplicationId
          )
        }
      }
      return errorState(values)
    }
  }

  async confirm(formData: FormData): Promise<OnboardingActionState> {
    const values = readSafeOnboardingValues(formData)
    const applicationId = databaseIdSchema.safeParse(
      readText(formData, "recordId", 64)
    )
    const fingerprint = contentHashSchema.safeParse(
      readText(formData, "inputFingerprint", 80)
    )
    if (!applicationId.success || !fingerprint.success) {
      return validationState(values, {
        form: ["The inspected scope identifier is invalid"],
      })
    }
    try {
      const current = await this.options.store.get(
        this.operatorId,
        applicationId.data
      )
      if (current === null) {
        return validationState(values, {
          form: ["The application is unavailable for this operator"],
        })
      }
      const submittedSecrets = [
        ...readTexts(formData, "credentialValue", 10, secretValueLimit + 1),
        readText(formData, "storageState", storageStateLimit + 1),
      ]
      const currentAuthentication = current.configuration.authentication
      const credentialDefinitionsMatch =
        currentAuthentication.method !== "credentials" ||
        (currentAuthentication.fields.length ===
          values.credentialFields.length &&
          currentAuthentication.fields.every(
            (field, index) =>
              field.key === values.credentialFields[index]?.key &&
              field.label === values.credentialFields[index]?.label
          ))
      const automationMatches =
        currentAuthentication.method === "none" ||
        currentAuthentication.automationConfirmed ===
          values.authenticationAutomationConfirmed
      if (
        currentAuthentication.method !== values.authenticationMethod ||
        !credentialDefinitionsMatch ||
        !automationMatches ||
        submittedSecrets.some((value) => value.length > 0)
      ) {
        return validationState(values, {
          authentication: [
            "Authentication changes require a new compatibility inspection",
          ],
        })
      }
      const submittedConfiguration = onboardingConfigurationSchema.parse({
        ...baseConfiguration(values),
        authentication: currentAuthentication,
      })
      if (
        createOnboardingInputFingerprint(submittedConfiguration) !==
        fingerprint.data
      ) {
        return validationState(values, {
          form: ["Configuration changed; inspect the current values again"],
        })
      }
      const confirmed = await this.options.store.confirm({
        operatorId: this.operatorId,
        applicationId: applicationId.data,
        expectedFingerprint: fingerprint.data,
      })
      if (confirmed === null) {
        return validationState(values, {
          form: ["Configuration changed or still has blockers; inspect again"],
        })
      }
      return onboardingActionStateSchema.parse({
        status: "confirmed",
        message: "Scope confirmed; the application is ready for initialization",
        fieldErrors: {},
        values: { ...values, recordId: confirmed.id },
        application: toPublicOnboardingApplication(confirmed),
      })
    } catch (error) {
      if (error instanceof FormValidationError) {
        return validationState(values, error.fieldErrors)
      }
      return errorState(values)
    }
  }
}

class MemorySecretStore implements OnboardingSecretStore {
  private readonly values = new Map<string, string>()

  async create(input: {
    readonly applicationId: string
    readonly name: string
    readonly value: string
  }): Promise<SecretReferenceRecord> {
    const reference = secretReferenceSchema.parse(
      `secret-ref:v1:${hashCanonical({
        applicationId: input.applicationId,
        name: input.name,
        nonce: randomUUID(),
      }).slice("sha256:".length)}`
    )
    this.values.set(reference, input.value)
    return { reference, name: input.name, rotatedAt: null }
  }

  async delete(_applicationId: string, reference: string): Promise<boolean> {
    return this.values.delete(reference)
  }
}

class MemoryOnboardingStore implements OnboardingStore {
  private readonly records = new Map<string, OnboardingRecord>()

  async list(): Promise<readonly OnboardingRecord[]> {
    return [...this.records.values()].sort(
      (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()
    )
  }

  async get(_operatorId: string, applicationId: string) {
    return this.records.get(applicationId) ?? null
  }

  async deleteDraft(_operatorId: string, applicationId: string) {
    const record = this.records.get(applicationId)
    if (
      record === undefined ||
      record.graphRevision > 0 ||
      record.indexedCommitSha !== null
    ) {
      return false
    }
    return this.records.delete(applicationId)
  }

  async saveDraft(input: {
    readonly stableKey: string
    readonly configuration: OnboardingConfiguration
    readonly completedThrough?: OnboardingCompletedStep
  }): Promise<SaveOnboardingDraftResult> {
    const current =
      input.configuration.recordId === undefined
        ? undefined
        : this.records.get(input.configuration.recordId)
    const id = current?.id ?? randomUUID()
    const configuration = onboardingConfigurationSchema.parse({
      ...input.configuration,
      recordId: id,
    })
    const fingerprint = createOnboardingInputFingerprint(configuration)
    const relevantChanged =
      current === undefined || current.inputFingerprint !== fingerprint
    const completedThrough = furthestCompletedStep(
      current?.completedThrough ?? "none",
      input.completedThrough ?? "safety"
    )
    const now = new Date()
    const record: OnboardingRecord = {
      id,
      stableKey: input.stableKey,
      name: configuration.name,
      deploymentUrl: configuration.deploymentUrl,
      status: relevantChanged
        ? onboardingStepOrder.indexOf(completedThrough) >=
          onboardingStepOrder.indexOf("safety")
          ? "inspecting"
          : "not_configured"
        : (current?.status ?? "inspecting"),
      indexedCommitSha: current?.indexedCommitSha ?? null,
      graphRevision: current?.graphRevision ?? 0,
      refreshedAt: current?.refreshedAt ?? null,
      configuration,
      inputFingerprint: fingerprint,
      inspectedFingerprint: relevantChanged
        ? null
        : (current?.inspectedFingerprint ?? null),
      compatibility: relevantChanged ? null : (current?.compatibility ?? null),
      confirmationFingerprint: relevantChanged
        ? null
        : (current?.confirmationFingerprint ?? null),
      knowledgeStale:
        (current?.knowledgeStale ?? false) ||
        Boolean(
          relevantChanged &&
          current !== undefined &&
          (current.graphRevision > 0 || current.indexedCommitSha !== null)
        ),
      inspectedAt: relevantChanged ? null : (current?.inspectedAt ?? null),
      confirmedAt: relevantChanged ? null : (current?.confirmedAt ?? null),
      updatedAt: now,
      completedThrough,
    }
    this.records.set(id, record)
    return { record, relevantChanged }
  }

  async recordInspection(input: {
    readonly applicationId: string
    readonly expectedFingerprint: string
    readonly report: CompatibilityReport
  }) {
    const current = this.records.get(input.applicationId)
    if (
      current === undefined ||
      current.inputFingerprint !== input.expectedFingerprint
    ) {
      return null
    }
    const configuration = onboardingConfigurationSchema.parse({
      ...current.configuration,
      repository: {
        ...current.configuration.repository,
        ...(input.report.resolvedCommitSha === undefined
          ? {}
          : { resolvedCommitSha: input.report.resolvedCommitSha }),
      },
    })
    const updated: OnboardingRecord = {
      ...current,
      configuration,
      status:
        input.report.status === "blocked"
          ? "failed"
          : current.knowledgeStale
            ? "stale"
            : "awaiting_confirmation",
      compatibility: input.report,
      inspectedFingerprint: contentHashSchema.parse(input.expectedFingerprint),
      confirmationFingerprint: null,
      inspectedAt: new Date(input.report.inspectedAt),
      confirmedAt: null,
      updatedAt: new Date(),
    }
    this.records.set(current.id, updated)
    return updated
  }

  async confirm(input: {
    readonly applicationId: string
    readonly expectedFingerprint: string
  }) {
    const current = this.records.get(input.applicationId)
    if (
      current === undefined ||
      current.inputFingerprint !== input.expectedFingerprint ||
      current.inspectedFingerprint !== input.expectedFingerprint ||
      current.compatibility?.status === "blocked"
    ) {
      return null
    }
    const updated: OnboardingRecord = {
      ...current,
      confirmationFingerprint: current.inputFingerprint,
      confirmedAt: new Date(),
      completedThrough: "review",
      updatedAt: new Date(),
    }
    this.records.set(current.id, updated)
    return updated
  }
}

class FixtureCompatibilityInspector implements OnboardingInspector {
  async inspect(configuration: OnboardingConfiguration) {
    const applicationBlocked = new URL(
      configuration.deploymentUrl
    ).hostname.startsWith("blocked.")
    const authenticationBlocked =
      configuration.authentication.method !== "none" &&
      !configuration.authentication.automationConfirmed
    const finding = [
      ...(applicationBlocked
        ? [
            {
              severity: "blocker" as const,
              code: "application_unreachable",
              summary: "The fixture application is intentionally unavailable",
              humanAction:
                "Use a reachable fixture application host and inspect again",
            },
          ]
        : []),
      ...(authenticationBlocked
        ? [
            {
              severity: "blocker" as const,
              code: "authentication_requires_confirmation",
              summary: "Automated authentication has not been confirmed",
              humanAction:
                "Verify automated login without CAPTCHA and inspect again",
            },
          ]
        : []),
    ]
    const blocked = finding.length > 0
    return compatibilityReportSchema.parse({
      schemaVersion: 1,
      inputFingerprint: createOnboardingInputFingerprint(configuration),
      status: blocked ? "blocked" : "supported",
      resolvedCommitSha: "0497418d5c66d20693751e68be066260eda3f37f",
      selectedAdapters: [
        "laravel_routes",
        "openapi_scramble",
        "php_laravel",
        "playwright",
        "playwright_network",
        "typescript_react",
      ],
      evidence: [
        {
          capability: "repository_resolved",
          status: "detected",
          code: "immutable_commit_resolved",
          summary: "Repository reference resolved to an immutable commit",
          source: "repository",
          references: ["composer.json", "frontend/package.json"],
        },
        {
          capability: "typescript_react",
          status: "detected",
          code: "typescript_react_detected",
          summary: "TypeScript React frontend evidence was detected",
          source: "repository",
          references: ["frontend/package.json", "frontend/src/App.tsx"],
        },
        {
          capability: "php_laravel",
          status: "detected",
          code: "php_laravel_detected",
          summary: "PHP Laravel backend evidence was detected",
          source: "repository",
          references: ["composer.json", "artisan"],
        },
        {
          capability: "laravel_routes",
          status: "detected",
          code: "laravel_routes_detected",
          summary: "Laravel route evidence was detected",
          source: "repository",
          references: ["routes/api.php"],
        },
        {
          capability: "openapi_scramble",
          status: "detected",
          code: "openapi_scramble_detected",
          summary: "OpenAPI Scramble evidence was detected",
          source: "repository",
          references: ["composer.json"],
        },
        {
          capability: "playwright_assets",
          status: "detected",
          code: "playwright_assets_detected",
          summary: "Playwright assets were detected",
          source: "repository",
          references: ["playwright.config.ts"],
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
          status: applicationBlocked ? "blocked" : "detected",
          code: applicationBlocked
            ? "application_unreachable"
            : "application_browser_ready",
          summary: applicationBlocked
            ? "The fixture application is unavailable"
            : "The deployment is reachable and exposes a browser document",
          source: "application",
          references: [configuration.deploymentUrl],
        },
        {
          capability: "authentication_automatable",
          status: authenticationBlocked ? "blocked" : "detected",
          code: authenticationBlocked
            ? "authentication_requires_confirmation"
            : `${configuration.authentication.method}_authentication_configured`,
          summary: authenticationBlocked
            ? "Automated authentication requires operator confirmation"
            : "Authentication configuration is ready",
          source: "configuration",
          references: [],
        },
        {
          capability: "safe_action_policy",
          status: "detected",
          code: "safe_policy_validated",
          summary: "Crawl limits and mandatory action denials are valid",
          source: "configuration",
          references: configuration.crawl.allowedHosts,
        },
      ],
      findings: finding,
      humanActions: finding.map((item) => item.humanAction),
      proposedScope: {
        repositoryPaths: ["frontend", "app", "routes"],
        documentationSources: configuration.documentationSources,
        applicationOrigins: [new URL(configuration.deploymentUrl).origin],
        allowedActionCategories: [
          "safe_read",
          "safe_navigation",
          "safe_form_progress",
          "credential_entry",
          ...(configuration.crawl.allowFormSubmission
            ? (["unknown_submission"] as const)
            : []),
        ],
        maxActions: configuration.crawl.maxActions,
        maxScreens: configuration.crawl.maxScreens,
        maxDurationSeconds: configuration.crawl.maxDurationSeconds,
      },
      inspectedAt: new Date().toISOString(),
    })
  }
}

interface ControlPlaneGlobalState {
  production?: ControlPlane
  fixture?: ControlPlane
}

const globalState = globalThis as typeof globalThis & {
  __sentinelControlPlane?: ControlPlaneGlobalState
}

export function createControlPlane(options: ControlPlaneOptions): ControlPlane {
  return new ControlPlane(options)
}

export function getControlPlane(): ControlPlane {
  const state = (globalState.__sentinelControlPlane ??= {})
  if (process.env["SENTINEL_CONTROL_PLANE_FIXTURE"] === "1") {
    state.fixture ??= new ControlPlane({
      operatorId:
        process.env["SENTINEL_OPERATOR_ID"] ??
        "00000000-0000-4000-8000-000000000022",
      store: new MemoryOnboardingStore(),
      secrets: new MemorySecretStore(),
      inspector: new FixtureCompatibilityInspector(),
    })
    return state.fixture
  }
  if (state.production !== undefined) return state.production
  const operatorId = operatorIdSchema.parse(process.env["SENTINEL_OPERATOR_ID"])
  const databaseUrl = z
    .url({ protocol: /^postgres(?:ql)?$/ })
    .parse(process.env["SUPABASE_DB_URL"])
  const database = createPostgresDatabase(databaseUrl)
  state.production = new ControlPlane({
    operatorId,
    store: new OnboardingRepository(database),
    secrets: new TargetSecretService(database),
    inspector: createProductionCompatibilityInspector({
      ...(process.env["GITHUB_TOKEN"] === undefined
        ? {}
        : { token: process.env["GITHUB_TOKEN"] }),
    }),
  })
  return state.production
}
