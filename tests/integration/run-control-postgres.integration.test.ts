import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"

import {
  ApplicationRepository,
  createPostgresDatabase,
  loadIntegrationEnvironment,
  RunControlRepositoryError,
  RunRepository,
  type DatabaseClient,
} from "@sentinel/storage"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  createOperationalTestApplication,
  operationalTestBudget as budget,
} from "../fixtures/operational.ts"

const enabled = process.env["RUN_SUPABASE_INTEGRATION_TESTS"] === "1"
const describeIntegration = enabled ? describe : describe.skip
const migrations = [
  "../../supabase/migrations/20260907000100_operational_state.sql",
  "../../supabase/migrations/20260908000100_onboarding_control_plane.sql",
  "../../supabase/migrations/20260908000200_run_control.sql",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))

describeIntegration("run control PostgreSQL state machine", () => {
  let database: DatabaseClient
  let runs: RunRepository
  let applicationId: string
  const operatorId = randomUUID()

  beforeAll(async () => {
    const environment = loadIntegrationEnvironment(process.env)
    const migrationDatabase = createPostgresDatabase(
      environment.SENTINEL_TEST_DATABASE_URL,
      { maxConnections: 1 }
    )
    for (const migration of migrations) await migrationDatabase.query(migration)
    await migrationDatabase.close()
    database = createPostgresDatabase(environment.SENTINEL_TEST_DATABASE_URL, {
      maxConnections: 6,
    })
    const application = await new ApplicationRepository(database).upsert({
      ...createOperationalTestApplication(`run-control-${randomUUID()}`),
      status: "ready",
    })
    applicationId = application.id
    const fingerprint = `sha256:${"a".repeat(64)}`
    await database.query(
      `insert into sentinel.onboarding_configurations (
         application_id, operator_id, configuration, input_fingerprint,
         inspected_fingerprint, compatibility_report, confirmation_fingerprint,
         confirmed_at
       ) values (
         $1::uuid, $2::uuid, '{}'::jsonb, $3, $3,
         jsonb_build_object('inputFingerprint', $3::text, 'status', 'compatible'),
         $3, now()
       )`,
      [applicationId, operatorId, fingerprint]
    )
    runs = new RunRepository(database)
  })

  afterAll(async () => {
    if (database !== undefined && applicationId !== undefined) {
      await database.query(
        "delete from sentinel.applications where id = $1::uuid",
        [applicationId]
      )
      await database.close()
    }
  })

  it("deduplicates exact work and rejects changed or overlapping mutations", async () => {
    const command = {
      schemaVersion: 1 as const,
      applicationId,
      type: "inspect_application" as const,
      idempotencyKey: "inspect:delivery-1",
      budget,
      payload: {},
    }
    const first = await runs.enqueueControl(operatorId, command)
    const replay = await runs.enqueueControl(operatorId, command)
    expect(replay).toEqual({ run: first.run, created: false })

    await expect(
      runs.enqueueControl(operatorId, {
        ...command,
        budget: { ...budget, elapsedMs: budget.elapsedMs + 1 },
      })
    ).rejects.toMatchObject({ code: "idempotency_conflict" })
    await expect(
      runs.enqueueControl(operatorId, {
        ...command,
        idempotencyKey: "inspect:delivery-2",
      })
    ).rejects.toMatchObject({ code: "active_run_conflict" })
    await expect(runs.getOwned(randomUUID(), first.run.id)).resolves.toBeNull()
  })

  it("reclaims the same lease and accepts one owner-authorized decision", async () => {
    const claimed = await runs.claim("run-control-a", 60)
    expect(claimed).not.toBeNull()
    await database.query(
      "update sentinel.runs set lease_expires_at = now() - interval '1 second' where id = $1::uuid",
      [claimed!.id]
    )
    const reclaimed = await runs.claim("run-control-b", 60)
    expect(reclaimed).toMatchObject({ id: claimed!.id, attemptCount: 2 })

    const interrupt = await runs.recordInterrupt({
      runId: reclaimed!.id,
      owner: "run-control-b",
      decisionId: "approve_scope",
      prompt: "Approve the proposed scope?",
    })
    const first = await runs.respondInterrupt({
      operatorId,
      runId: reclaimed!.id,
      decisionId: interrupt.decisionId,
      response: { approved: true, note: "Reviewed." },
    })
    const replay = await runs.respondInterrupt({
      operatorId,
      runId: reclaimed!.id,
      decisionId: interrupt.decisionId,
      response: { approved: true, note: "Reviewed." },
    })
    expect(first.idempotent).toBe(false)
    expect(replay.idempotent).toBe(true)
    await expect(
      runs.respondInterrupt({
        operatorId,
        runId: reclaimed!.id,
        decisionId: interrupt.decisionId,
        response: { approved: false },
      })
    ).rejects.toBeInstanceOf(RunControlRepositoryError)
    await expect(
      runs.respondInterrupt({
        operatorId: randomUUID(),
        runId: reclaimed!.id,
        decisionId: interrupt.decisionId,
        response: { approved: true, note: "Reviewed." },
      })
    ).rejects.toMatchObject({ code: "interrupt_not_found" })
  })
})
