import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"

import { createEventId, runIdSchema } from "@sentinel/contracts"
import {
  ApplicationRepository,
  AssessmentRepository,
  createPostgresDatabase,
  loadIntegrationEnvironment,
  RecordsRepository,
  RunRepository,
  type DatabaseClient,
  WebhookDeliveryRepository,
} from "@sentinel/storage"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  createOperationalTestApplication,
  operationalTestBudget as budget,
} from "../fixtures/operational.ts"

const enabled = process.env["RUN_SUPABASE_INTEGRATION_TESTS"] === "1"
const describeIntegration = enabled ? describe : describe.skip
const migration = readFileSync(
  new URL(
    "../../supabase/migrations/20260907000100_operational_state.sql",
    import.meta.url
  ),
  "utf8"
)

describeIntegration("Supabase operational database", () => {
  let database: DatabaseClient
  let applicationId: string
  const applicationInput = createOperationalTestApplication(
    "sentinel-database-integration"
  )
  const stableKey = applicationInput.stableKey

  beforeAll(async () => {
    const environment = loadIntegrationEnvironment(process.env)
    const migrationDatabase = createPostgresDatabase(
      environment.SENTINEL_TEST_DATABASE_URL,
      { maxConnections: 1 }
    )
    await migrationDatabase.query(migration)
    await migrationDatabase.query(migration)
    await migrationDatabase.close()
    database = createPostgresDatabase(environment.SENTINEL_TEST_DATABASE_URL, {
      maxConnections: 6,
    })
    const application = await new ApplicationRepository(database).upsert(
      applicationInput
    )
    applicationId = application.id
  }, 60_000)

  afterAll(async () => {
    if (database !== undefined && applicationId !== undefined) {
      await database.query(
        "delete from sentinel.applications where id = $1::uuid",
        [applicationId]
      )
      await database.close()
    }
  })

  it("deduplicates enqueue and gives one owner an atomic claim", async () => {
    const runs = new RunRepository(database)
    const input = {
      applicationId,
      runType: "initialize_knowledge",
      idempotencyKey: `initialize:${stableKey}`,
      budget,
    }
    const first = await runs.enqueue(input)
    const duplicate = await runs.enqueue(input)
    expect(duplicate.id).toBe(first.id)

    const [workerA, workerB] = await Promise.all([
      runs.claim("integration-worker-a", 60),
      runs.claim("integration-worker-b", 60),
    ])
    const claimed = [workerA, workerB].filter((run) => run !== null)
    expect(claimed).toHaveLength(1)

    await database.query(
      "update sentinel.runs set lease_expires_at = now() - interval '1 second' where id = $1::uuid",
      [first.id]
    )
    const reclaimed = await runs.claim("integration-worker-c", 60)
    expect(reclaimed?.id).toBe(first.id)
    expect(reclaimed?.attemptCount).toBe(2)
    await expect(
      runs.heartbeat(first.id, "integration-worker-a", 60)
    ).resolves.toBe(false)
    await expect(
      runs.heartbeat(first.id, "integration-worker-c", 60)
    ).resolves.toBe(true)
    await expect(runs.requestCancellation(first.id)).resolves.toBe("cancelling")
    await database.query(
      "update sentinel.runs set lease_expires_at = now() - interval '1 second' where id = $1::uuid",
      [first.id]
    )
    await expect(
      runs.finish({
        runId: first.id,
        owner: "integration-worker-c",
        status: "cancelled",
      })
    ).resolves.toBe(false)
    const cancellationRecovery = await runs.claim("integration-worker-d", 60)
    expect(cancellationRecovery).toMatchObject({
      id: first.id,
      status: "cancelling",
      leaseOwner: "integration-worker-d",
    })
    await expect(
      runs.finish({
        runId: first.id,
        owner: "integration-worker-d",
        status: "cancelled",
      })
    ).resolves.toBe(true)
    await expect(
      database.query(
        "update sentinel.runs set status = 'running' where id = $1::uuid",
        [first.id]
      )
    ).rejects.toThrow("invalid run status transition")

    const interruptible = await runs.enqueue({
      applicationId,
      runType: "run_eval",
      idempotencyKey: `interrupt:${stableKey}`,
      budget,
    })
    await runs.claim("integration-worker-e", 60)
    await database.query(
      "update sentinel.runs set status = 'interrupted' where id = $1::uuid",
      [interruptible.id]
    )
    await expect(runs.requestCancellation(interruptible.id)).resolves.toBe(
      "cancelled"
    )
  })

  it("allocates durable event order under concurrent appends", async () => {
    const runs = new RunRepository(database)
    const run = await runs.enqueue({
      applicationId,
      runType: "run_eval",
      idempotencyKey: `events:${stableKey}`,
      budget,
    })
    const contractRunId = runIdSchema.parse(`run:${run.id}`)
    const baseEvent = {
      schemaVersion: 1 as const,
      runId: contractRunId,
      occurredAt: "2026-09-07T00:00:00.000Z",
      graphName: "run_eval",
      kind: "run_status" as const,
      status: "running" as const,
      summary: "Run started.",
      reasonCode: "run_started",
      evidenceIds: [],
    }

    await Promise.all([
      runs.appendEvent({
        ...baseEvent,
        id: createEventId(contractRunId, 1),
        sequence: 99,
      }),
      runs.appendEvent({
        ...baseEvent,
        id: createEventId(contractRunId, 2),
        sequence: 99,
      }),
    ])

    const events = await runs.listEvents(run.id)
    expect(events.map((event) => event.sequence)).toEqual([1, 2])
    for (const event of events) {
      expect(event.id).toBe(createEventId(contractRunId, event.sequence))
    }
  })

  it("rolls transactions back and denies direct anon/authenticated table access", async () => {
    const rollbackKey = createOperationalTestApplication(
      `rollback-${randomUUID()}`
    ).stableKey
    await expect(
      database.transaction(async (transaction) => {
        await transaction.query(
          `insert into sentinel.applications
             (stable_key, name, deployment_url, status)
           values ($1, 'rollback', 'https://fixture.example.com', 'ready')`,
          [rollbackKey]
        )
        throw new Error("force rollback")
      })
    ).rejects.toThrow("force rollback")
    const rows = await database.query<{ count: number }>(
      "select count(*)::int as count from sentinel.applications where stable_key = $1",
      [rollbackKey]
    )
    expect(rows[0]?.count).toBe(0)

    for (const role of ["anon", "authenticated"]) {
      await expect(
        database.transaction(async (transaction) => {
          await transaction.query(`set local role ${role}`)
          await transaction.query("select * from sentinel.target_secrets")
        })
      ).rejects.toThrow()
    }
  })

  it("deduplicates one PR head and supersedes it atomically with the next head", async () => {
    const assessments = new AssessmentRepository(database)
    const repository = {
      host: "github.com",
      owner: "mohit-nagaraj",
      name: "sentinel",
    }
    const firstInput = {
      applicationId,
      repository,
      pullRequestNumber: 42,
      baseSha: "1111111111111111111111111111111111111111",
      headSha: "2222222222222222222222222222222222222222",
      diffHash:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      baselineStatus: "compatible",
    }
    const first = await assessments.createOrGet(firstInput)
    const duplicate = await assessments.createOrGet(firstInput)
    expect(duplicate.id).toBe(first.id)

    const second = await assessments.createOrGet({
      ...firstInput,
      headSha: "3333333333333333333333333333333333333333",
      diffHash:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    })
    expect(second.id).not.toBe(first.id)
    const rows = await database.query<{
      id: string
      is_current: boolean
      superseded_by_id: string | null
    }>(
      `select id, is_current, superseded_by_id
       from sentinel.pr_assessments
       where application_id = $1::uuid and pull_request_number = 42
       order by created_at`,
      [applicationId]
    )
    expect(rows).toEqual([
      expect.objectContaining({
        id: first.id,
        is_current: false,
        superseded_by_id: second.id,
      }),
      expect.objectContaining({
        id: second.id,
        is_current: true,
        superseded_by_id: null,
      }),
    ])

    const reactivated = await assessments.createOrGet(firstInput)
    expect(reactivated).toMatchObject({ id: first.id, isCurrent: true })
    const current = await database.query<{
      id: string
      is_current: boolean
      superseded_by_id: string | null
    }>(
      `select id, is_current, superseded_by_id
       from sentinel.pr_assessments
       where application_id = $1::uuid and pull_request_number = 42
       order by created_at`,
      [applicationId]
    )
    expect(current).toEqual([
      expect.objectContaining({
        id: first.id,
        is_current: true,
        superseded_by_id: null,
      }),
      expect.objectContaining({
        id: second.id,
        is_current: false,
        superseded_by_id: first.id,
      }),
    ])

    await expect(
      assessments.createOrGet({
        ...firstInput,
        baseSha: "7777777777777777777777777777777777777777",
      })
    ).rejects.toThrow("idempotency conflict")
  })

  it("deduplicates webhook delivery identifiers", async () => {
    const deliveries = new WebhookDeliveryRepository(database)
    const input = {
      deliveryId: randomUUID(),
      applicationId,
      repository: {
        host: "github.com",
        owner: "mohit-nagaraj",
        name: "sentinel",
      },
      eventName: "pull_request",
      action: "synchronize",
      headSha: "6666666666666666666666666666666666666666",
    }
    await expect(deliveries.record(input)).resolves.toBe(true)
    await expect(deliveries.record(input)).resolves.toBe(false)
  })

  it("advances the active commit and graph revision with compare-and-swap", async () => {
    const applications = new ApplicationRepository(database)
    const advanced = await applications.activateGraphRevision({
      applicationId,
      expectedRevision: 0,
      indexedCommitSha: "4444444444444444444444444444444444444444",
    })
    expect(advanced).toMatchObject({
      graphRevision: 1,
      indexedCommitSha: "4444444444444444444444444444444444444444",
      status: "ready",
    })
    await expect(
      applications.activateGraphRevision({
        applicationId,
        expectedRevision: 0,
        indexedCommitSha: "5555555555555555555555555555555555555555",
      })
    ).resolves.toBeNull()
  })

  it("isolates run-less eval idempotency and run ownership by application", async () => {
    const applications = new ApplicationRepository(database)
    const secondApplication = await applications.upsert(
      createOperationalTestApplication("sentinel-eval-integration")
    )
    const records = new RecordsRepository(database)
    const shared = {
      runId: null,
      fixtureKey: "stable-identities",
      metricKey: "repeatability",
      outcome: "passed" as const,
      value: 1,
      details: { repeats: 100 },
    }
    const firstId = await records.recordEvalResult({
      ...shared,
      applicationId,
    })
    const secondId = await records.recordEvalResult({
      ...shared,
      applicationId: secondApplication.id,
    })
    expect(secondId).not.toBe(firstId)

    const run = await new RunRepository(database).enqueue({
      applicationId,
      runType: "run_eval",
      idempotencyKey: `ownership:${stableKey}`,
      budget,
    })
    await expect(
      records.recordEvalResult({
        ...shared,
        applicationId: secondApplication.id,
        runId: run.id,
      })
    ).rejects.toThrow()

    const runA = await new RunRepository(database).enqueue({
      applicationId,
      runType: "run_eval",
      idempotencyKey: `eval-a:${stableKey}`,
      budget,
    })
    const runB = await new RunRepository(database).enqueue({
      applicationId,
      runType: "run_eval",
      idempotencyKey: `eval-b:${stableKey}`,
      budget,
    })
    await records.recordEvalResult({
      ...shared,
      applicationId,
      runId: runA.id,
    })
    await records.recordEvalResult({
      ...shared,
      applicationId,
      runId: runB.id,
    })
    await expect(
      database.query("delete from sentinel.runs where id = any($1::uuid[])", [
        `{${runA.id},${runB.id}}`,
      ])
    ).resolves.toBeDefined()

    await database.query(
      "delete from sentinel.applications where id = $1::uuid",
      [secondApplication.id]
    )
  })
})
