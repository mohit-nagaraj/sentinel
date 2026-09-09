import { describe, expect, it } from "vitest"

import {
  deploymentValidationResultSchema,
  hashCanonical,
  verificationSetupReceiptSchema,
} from "@sentinel/contracts"

import type { DatabaseExecutor, SqlParameter } from "./database.ts"
import { PostgresTargetedVerificationStore } from "./targeted-verification-store.ts"

const scope = {
  applicationDatabaseId: "123e4567-e89b-42d3-a456-426614174010",
  applicationStableId: `application:v1:${"a".repeat(64)}`,
  runDatabaseId: "123e4567-e89b-42d3-a456-426614174000",
  runStableId: "run:123e4567-e89b-42d3-a456-426614174000",
  assessmentId: "123e4567-e89b-42d3-a456-426614174001",
}

class MemoryDatabase implements DatabaseExecutor {
  readonly rows = new Map<string, Record<string, unknown>>()
  readonly statements: string[] = []

  async query<Row extends Record<string, unknown>>(
    statement: string,
    parameters: readonly SqlParameter[] = []
  ): Promise<readonly Row[]> {
    this.statements.push(statement)
    if (statement.startsWith("insert into sentinel.verification_records")) {
      const key = String(parameters[4])
      if (!this.rows.has(key)) {
        this.rows.set(key, {
          application_id: parameters[0],
          run_id: parameters[2],
          assessment_id: parameters[3],
          stable_key: key,
          record_kind: parameters[5],
          payload: JSON.parse(String(parameters[6])) as unknown,
        })
      }
      return []
    }
    const row = this.rows.get(String(parameters[3]))
    return (row === undefined ? [] : [row]) as Row[]
  }
}

function validation(applicationId = scope.applicationStableId) {
  return deploymentValidationResultSchema.parse({
    schemaVersion: 1,
    applicationId,
    registrationId: `sha256:${"b".repeat(64)}`,
    purpose: "pr_head_verification",
    assessmentId: scope.assessmentId,
    pullRequestId: `pull-request:v1:${"c".repeat(64)}`,
    expectedCommitSha: "d".repeat(40),
    identityState: "exact",
    trustState: "trusted",
    readinessState: "ready",
    browserAccessAllowed: true,
    credentialAccessAllowed: true,
    reason: "deployment_ready",
    proof: {
      schemaVersion: 1,
      provider: "render",
      serviceId: "srv-head",
      deployId: "dep-head",
      repository: {
        host: "github.com",
        owner: "hieventsdev",
        name: "hi.events",
      },
      commitSha: "d".repeat(40),
      publicUrl: "https://head.onrender.com",
      status: "live",
      observedAt: "2026-09-09T10:00:00.000Z",
    },
    validatedAt: "2026-09-09T10:00:00.000Z",
  })
}

function setup(summary = "Fixture setup completed") {
  const draft = {
    schemaVersion: 1 as const,
    missionId: `mission:v1:${"e".repeat(64)}`,
    classification: "outside_blast_radius" as const,
    method: "trusted_fixture_api" as const,
    status: "prepared" as const,
    idempotencyKey: `sha256:${"f".repeat(64)}`,
    evidenceIds: [],
    artifacts: [],
    cleanupRequired: true,
    reasonCode: "fixture_prepared",
    summary,
    preparedAt: "2026-09-09T10:00:00.000Z",
  }
  return verificationSetupReceiptSchema.parse({
    ...draft,
    id: `sha256:${"1".repeat(64)}`,
  })
}

describe("PostgresTargetedVerificationStore", () => {
  it("persists and reloads provider validation in application/run/assessment scope", async () => {
    const database = new MemoryDatabase()
    const store = new PostgresTargetedVerificationStore(database, scope)
    const value = validation()

    const id = await store.saveValidation(value)

    expect(id).toBe(
      hashCanonical({
        kind: "deployment-validation",
        validation: value,
        version: 1,
      })
    )
    await expect(store.loadValidation(id)).resolves.toEqual(value)
    expect(database.statements[0]).toContain(
      "join sentinel.pr_assessments assessment"
    )
    expect(database.statements[0]).toContain(
      "on conflict (application_id, run_id, stable_key) do nothing"
    )
  })

  it("rejects cross-application records before writing", async () => {
    const database = new MemoryDatabase()
    const store = new PostgresTargetedVerificationStore(database, scope)
    await expect(
      store.saveValidation(validation(`application:v1:${"2".repeat(64)}`))
    ).rejects.toThrow("crosses its storage scope")
    expect(database.statements).toEqual([])
  })

  it("rejects conflicting content under an existing stable record key", async () => {
    const database = new MemoryDatabase()
    const store = new PostgresTargetedVerificationStore(database, scope)
    await store.saveSetup(setup())
    await expect(
      store.saveSetup(setup("Different setup result"))
    ).rejects.toThrow("idempotency conflict")
  })

  it("requires the stable run ID to derive from the scoped database run", () => {
    expect(
      () =>
        new PostgresTargetedVerificationStore(new MemoryDatabase(), {
          ...scope,
          runStableId: "run:123e4567-e89b-42d3-a456-426614174099",
        })
    ).toThrow("run identities do not match")
  })
})
