import {
  applicationIdSchema,
  contentHashSchema,
  createTargetedVerificationInputId,
  deploymentValidationResultSchema,
  hashCanonical,
  runIdSchema,
  targetedVerificationResultSchema,
  targetedVerificationStartInputSchema,
  verificationMissionEvidenceSchema,
  verificationMissionResultSchema,
  verificationSetupReceiptSchema,
  type DeploymentValidationResult,
  type TargetedVerificationResult,
  type TargetedVerificationStartInput,
  type VerificationMissionEvidence,
  type VerificationMissionResult,
  type VerificationSetupReceipt,
} from "@sentinel/contracts"
import { z } from "zod"

import type { DatabaseExecutor } from "./database.ts"

const databaseIdSchema = z.uuid()
const recordKindSchema = z.enum([
  "start_input",
  "deployment_validation",
  "setup_receipt",
  "execution_cache",
  "mission_evidence",
  "mission_result",
  "aggregate_result",
])

type VerificationRecordKind = z.infer<typeof recordKindSchema>

const verificationRecordRowSchema = z.object({
  application_id: databaseIdSchema,
  run_id: databaseIdSchema,
  assessment_id: z.uuid(),
  stable_key: contentHashSchema,
  record_kind: recordKindSchema,
  payload: z.unknown(),
})

type VerificationRecordRow = z.infer<typeof verificationRecordRowSchema> &
  Record<string, unknown>

export interface TargetedVerificationStoreScope {
  readonly applicationDatabaseId: string
  readonly applicationStableId: string
  readonly runDatabaseId: string
  readonly runStableId: string
  readonly assessmentId: string
}

function parsePayload(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error("Stored verification record is not valid JSON")
  }
}

export class PostgresTargetedVerificationStore {
  private readonly scope: {
    readonly applicationDatabaseId: string
    readonly applicationStableId: string
    readonly runDatabaseId: string
    readonly runStableId: string
    readonly assessmentId: string
  }

  constructor(
    private readonly database: DatabaseExecutor,
    scope: TargetedVerificationStoreScope
  ) {
    this.scope = {
      applicationDatabaseId: databaseIdSchema.parse(
        scope.applicationDatabaseId
      ),
      applicationStableId: applicationIdSchema.parse(scope.applicationStableId),
      runDatabaseId: databaseIdSchema.parse(scope.runDatabaseId),
      runStableId: runIdSchema.parse(scope.runStableId),
      assessmentId: z.uuid().parse(scope.assessmentId),
    }
    if (this.scope.runStableId !== `run:${this.scope.runDatabaseId}`) {
      throw new Error("Verification run identities do not match")
    }
  }

  private assertScope(kind: VerificationRecordKind, value: unknown): void {
    if (kind === "start_input") {
      const input = targetedVerificationStartInputSchema.parse(value)
      if (
        input.plan.applicationId !== this.scope.applicationStableId ||
        input.plan.runId !== this.scope.runStableId ||
        input.plan.assessmentId !== this.scope.assessmentId
      ) {
        throw new Error("Verification start input crosses its storage scope")
      }
    } else if (kind === "deployment_validation") {
      const validation = deploymentValidationResultSchema.parse(value)
      if (
        validation.applicationId !== this.scope.applicationStableId ||
        (validation.assessmentId !== undefined &&
          validation.assessmentId !== this.scope.assessmentId)
      ) {
        throw new Error("Deployment validation crosses its storage scope")
      }
    } else if (kind === "mission_evidence" || kind === "execution_cache") {
      const evidence = verificationMissionEvidenceSchema.parse(value)
      if (
        evidence.applicationId !== this.scope.applicationStableId ||
        evidence.runId !== this.scope.runStableId
      ) {
        throw new Error("Verification evidence crosses its storage scope")
      }
    } else if (kind === "aggregate_result") {
      const result = targetedVerificationResultSchema.parse(value)
      if (
        result.applicationId !== this.scope.applicationStableId ||
        result.runId !== this.scope.runStableId ||
        result.assessmentId !== this.scope.assessmentId
      ) {
        throw new Error("Verification result crosses its storage scope")
      }
    }
  }

  private async save(
    kind: VerificationRecordKind,
    stableKeyInput: string,
    value: unknown
  ): Promise<string> {
    const stableKey = contentHashSchema.parse(stableKeyInput)
    this.assertScope(kind, value)
    const payload = JSON.stringify(value)
    if (new TextEncoder().encode(payload).byteLength > 5 * 1024 * 1024) {
      throw new Error("Verification record exceeds the storage byte limit")
    }
    await this.database.query(
      `insert into sentinel.verification_records (
         application_id, run_id, assessment_id, stable_key, record_kind, payload
       )
       select app.id, run.id, assessment.id, $5, $6, $7::jsonb
       from sentinel.applications app
       join sentinel.runs run
         on run.id = $3::uuid and run.application_id = app.id
       join sentinel.pr_assessments assessment
         on assessment.id = $5::uuid and assessment.application_id = app.id
       where app.id = $1::uuid and app.stable_key = $2
         and run.id = $3::uuid
       on conflict (application_id, run_id, stable_key) do nothing`,
      [
        this.scope.applicationDatabaseId,
        this.scope.applicationStableId,
        this.scope.runDatabaseId,
        this.scope.assessmentId,
        stableKey,
        kind,
        payload,
      ]
    )
    const row = await this.readRow(stableKey)
    if (
      row.record_kind !== kind ||
      hashCanonical(parsePayload(row.payload)) !== hashCanonical(value)
    ) {
      throw new Error("Verification record idempotency conflict")
    }
    return stableKey
  }

  private async readRow(
    stableKeyInput: string
  ): Promise<VerificationRecordRow> {
    const row = await this.findRow(stableKeyInput)
    if (row === null) {
      throw new Error("Verification record was not persisted in its scope")
    }
    return row
  }

  private async findRow(
    stableKeyInput: string
  ): Promise<VerificationRecordRow | null> {
    const stableKey = contentHashSchema.parse(stableKeyInput)
    const rows = await this.database.query<VerificationRecordRow>(
      `select application_id, run_id, assessment_id, stable_key,
              record_kind, payload
       from sentinel.verification_records
       where application_id = $1::uuid and run_id = $2::uuid
         and assessment_id = $3::uuid and stable_key = $4`,
      [
        this.scope.applicationDatabaseId,
        this.scope.runDatabaseId,
        this.scope.assessmentId,
        stableKey,
      ]
    )
    return rows[0] === undefined
      ? null
      : verificationRecordRowSchema.parse(rows[0])
  }

  private async load(kind: VerificationRecordKind, id: string) {
    const row = await this.readRow(id)
    if (row.record_kind !== kind) {
      throw new Error("Verification record kind does not match its reference")
    }
    const payload = parsePayload(row.payload)
    this.assertScope(kind, payload)
    return payload
  }

  saveInput(inputValue: TargetedVerificationStartInput): Promise<string> {
    const input = targetedVerificationStartInputSchema.parse(inputValue)
    return this.save(
      "start_input",
      createTargetedVerificationInputId(input),
      input
    )
  }

  async loadInput(id: string): Promise<TargetedVerificationStartInput> {
    return targetedVerificationStartInputSchema.parse(
      await this.load("start_input", id)
    )
  }

  saveValidation(value: DeploymentValidationResult): Promise<string> {
    const validation = deploymentValidationResultSchema.parse(value)
    return this.save(
      "deployment_validation",
      hashCanonical({ kind: "deployment-validation", validation, version: 1 }),
      validation
    )
  }

  async loadValidation(id: string): Promise<DeploymentValidationResult> {
    return deploymentValidationResultSchema.parse(
      await this.load("deployment_validation", id)
    )
  }

  saveSetup(value: VerificationSetupReceipt): Promise<string> {
    const receipt = verificationSetupReceiptSchema.parse(value)
    return this.save("setup_receipt", receipt.id, receipt)
  }

  async loadSetup(id: string): Promise<VerificationSetupReceipt> {
    return verificationSetupReceiptSchema.parse(
      await this.load("setup_receipt", id)
    )
  }

  saveEvidence(value: VerificationMissionEvidence): Promise<string> {
    const evidence = verificationMissionEvidenceSchema.parse(value)
    return this.save(
      "mission_evidence",
      hashCanonical({
        kind: "verification-mission-evidence",
        evidence,
        version: 1,
      }),
      evidence
    )
  }

  async loadEvidence(id: string): Promise<VerificationMissionEvidence> {
    return verificationMissionEvidenceSchema.parse(
      await this.load("mission_evidence", id)
    )
  }

  async get(
    idempotencyKey: string
  ): Promise<VerificationMissionEvidence | null> {
    const row = await this.findRow(idempotencyKey)
    if (row === null) return null
    if (row.record_kind !== "execution_cache") {
      throw new Error(
        "Verification execution key references another record kind"
      )
    }
    const payload = parsePayload(row.payload)
    this.assertScope("execution_cache", payload)
    return verificationMissionEvidenceSchema.parse(payload)
  }

  async put(
    idempotencyKey: string,
    value: VerificationMissionEvidence
  ): Promise<VerificationMissionEvidence> {
    const evidence = verificationMissionEvidenceSchema.parse(value)
    await this.save("execution_cache", idempotencyKey, evidence)
    return verificationMissionEvidenceSchema.parse(
      await this.load("execution_cache", idempotencyKey)
    )
  }

  saveMissionResult(value: VerificationMissionResult): Promise<string> {
    const result = verificationMissionResultSchema.parse(value)
    return this.save("mission_result", result.id, result)
  }

  async loadMissionResults(
    ids: readonly string[]
  ): Promise<VerificationMissionResult[]> {
    const results: VerificationMissionResult[] = []
    for (const id of ids) {
      results.push(
        verificationMissionResultSchema.parse(
          await this.load("mission_result", id)
        )
      )
    }
    return results
  }

  saveResult(value: TargetedVerificationResult): Promise<string> {
    const result = targetedVerificationResultSchema.parse(value)
    return this.save("aggregate_result", result.id, result)
  }

  async loadResult(id: string): Promise<TargetedVerificationResult> {
    return targetedVerificationResultSchema.parse(
      await this.load("aggregate_result", id)
    )
  }
}
