import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"

import { commitShaSchema, contentHashSchema } from "@sentinel/contracts"
import {
  ApplicationRepository,
  AssessmentRepository,
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
    await database.query(
      `update sentinel.applications
       set graph_revision = 1, indexed_commit_sha = $2
       where id = $1::uuid`,
      [applicationId, "b".repeat(40)]
    )
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
    await expect(runs.ready()).resolves.toBe(true)
    const command = {
      schemaVersion: 1 as const,
      applicationId,
      type: "inspect_application" as const,
      idempotencyKey: "inspect:delivery-1",
      budget,
      payload: {},
    }
    const deliveries = await Promise.all([
      runs.enqueueControl(operatorId, command),
      runs.enqueueControl(operatorId, command),
    ])
    expect(deliveries.map((delivery) => delivery.created).sort()).toEqual([
      false,
      true,
    ])
    expect(deliveries[0]?.run.id).toBe(deliveries[1]?.run.id)
    const first = deliveries.find((delivery) => delivery.created)!
    await expect(applicationStatus()).resolves.toBe("inspecting")

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
    await expect(applicationStatus()).resolves.toBe("needs_review")
    const first = await runs.respondInterrupt({
      operatorId,
      runId: reclaimed!.id,
      decisionId: interrupt.decisionId,
      response: { approved: true },
    })
    const replay = await runs.respondInterrupt({
      operatorId,
      runId: reclaimed!.id,
      decisionId: interrupt.decisionId,
      response: { approved: true },
    })
    expect(first.idempotent).toBe(false)
    expect(replay.idempotent).toBe(true)
    await expect(applicationStatus()).resolves.toBe("inspecting")
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
        response: { approved: true },
      })
    ).rejects.toMatchObject({ code: "interrupt_not_found" })
    await expect(
      runs.requestOwnedCancellation(operatorId, reclaimed!.id)
    ).resolves.toMatchObject({ status: "cancelled" })
    await expect(applicationStatus()).resolves.toBe("ready")
    await expect(
      runs.enqueueControl(operatorId, {
        schemaVersion: 1,
        applicationId,
        type: "initialize_knowledge",
        idempotencyKey: "initialize:invalid-ready-state",
        budget,
        payload: {},
      })
    ).rejects.toMatchObject({ code: "invalid_application_state" })
  })

  it("creates linked attempts only for retryable terminal failures", async () => {
    const retryable = await runs.enqueueControl(operatorId, {
      schemaVersion: 1,
      applicationId,
      type: "run_eval",
      idempotencyKey: "eval:retryable",
      budget,
      payload: { fixtureKey: "retryable" },
    })
    const claimed = await runs.claim("run-control-retry", 60)
    expect(claimed?.id).toBe(retryable.run.id)
    await expect(
      runs.finish({
        runId: claimed!.id,
        owner: "run-control-retry",
        status: "failed",
        errorCategory: "provider",
        errorCode: "provider_timeout",
        retryable: true,
      })
    ).resolves.toBe(true)
    const created = await runs.retryOwned(
      operatorId,
      claimed!.id,
      "retry:delivery"
    )
    const replay = await runs.retryOwned(
      operatorId,
      claimed!.id,
      "retry:delivery"
    )
    expect(created).toMatchObject({
      idempotent: false,
      run: { retryOf: claimed!.id },
    })
    expect(replay).toMatchObject({
      idempotent: true,
      run: { id: created.run.id },
    })

    await expect(
      runs.retryOwned(operatorId, created.run.id, "retry:not-terminal")
    ).rejects.toMatchObject({ code: "retry_not_allowed" })
    await runs.requestOwnedCancellation(operatorId, created.run.id)
  })

  it("publishes a knowledge revision in the terminal run transaction", async () => {
    await database.query(
      `update sentinel.onboarding_configurations
       set knowledge_stale = true where application_id = $1::uuid`,
      [applicationId]
    )
    const refresh = await runs.enqueueControl(operatorId, {
      schemaVersion: 1,
      applicationId,
      type: "refresh_knowledge",
      idempotencyKey: "refresh:atomic",
      budget,
      payload: {},
    })
    const claimed = await runs.claim("run-control-publish", 60)
    expect(claimed?.id).toBe(refresh.run.id)
    await expect(
      runs.finish({
        runId: claimed!.id,
        owner: "run-control-publish",
        status: "succeeded",
        publication: {
          kind: "knowledge",
          inputFingerprint: contentHashSchema.parse(`sha256:${"a".repeat(64)}`),
          expectedGraphRevision: 1,
          indexedCommitSha: commitShaSchema.parse("c".repeat(40)),
        },
      })
    ).resolves.toBe(true)
    const rows = await database.query<{
      graph_revision: number
      indexed_commit_sha: string
      status: string
      knowledge_stale: boolean
    }>(
      `select application.graph_revision::int as graph_revision,
              application.indexed_commit_sha,
              application.status, onboarding.knowledge_stale
       from sentinel.applications application
       join sentinel.onboarding_configurations onboarding
         on onboarding.application_id = application.id
       where application.id = $1::uuid`,
      [applicationId]
    )
    expect(rows[0]).toEqual({
      graph_revision: 2,
      indexed_commit_sha: "c".repeat(40),
      status: "ready",
      knowledge_stale: false,
    })
  })

  it("rejects stale terminal publication without losing the worker lease", async () => {
    const refresh = await runs.enqueueControl(operatorId, {
      schemaVersion: 1,
      applicationId,
      type: "refresh_knowledge",
      idempotencyKey: "refresh:stale-publication",
      budget,
      payload: {},
    })
    const claimed = await runs.claim("run-control-stale", 60)
    expect(claimed?.id).toBe(refresh.run.id)
    const changedFingerprint = `sha256:${"d".repeat(64)}`
    await database.query(
      `update sentinel.onboarding_configurations
       set input_fingerprint = $2, inspected_fingerprint = null,
           compatibility_report = null, confirmation_fingerprint = null,
           inspected_at = null, confirmed_at = null
       where application_id = $1::uuid`,
      [applicationId, changedFingerprint]
    )
    await database.query(
      "update sentinel.applications set status = 'stale' where id = $1::uuid",
      [applicationId]
    )
    await expect(
      runs.finish({
        runId: claimed!.id,
        owner: "run-control-stale",
        status: "succeeded",
        publication: {
          kind: "knowledge",
          inputFingerprint: contentHashSchema.parse(`sha256:${"a".repeat(64)}`),
          expectedGraphRevision: 2,
          indexedCommitSha: commitShaSchema.parse("e".repeat(40)),
        },
      })
    ).rejects.toMatchObject({ code: "publication_conflict" })
    await expect(
      runs.finish({
        runId: claimed!.id,
        owner: "run-control-stale",
        status: "failed",
        errorCategory: "configuration",
        errorCode: "publication_conflict",
        retryable: false,
      })
    ).resolves.toBe(true)
    await expect(applicationStatus()).resolves.toBe("stale")
    await database.query(
      `update sentinel.onboarding_configurations
       set inspected_fingerprint = $2,
           compatibility_report = jsonb_build_object(
             'inputFingerprint', $2::text, 'status', 'compatible'
           ),
           confirmation_fingerprint = $2, inspected_at = now(),
           confirmed_at = now()
       where application_id = $1::uuid`,
      [applicationId, changedFingerprint]
    )
    await expect(
      runs.enqueueControl(operatorId, {
        schemaVersion: 1,
        applicationId,
        type: "run_eval",
        idempotencyKey: "eval:retryable",
        budget,
        payload: { fixtureKey: "retryable" },
      })
    ).rejects.toMatchObject({ code: "idempotency_conflict" })
  })

  it("binds assessment publication to the pull request in the run", async () => {
    const unrelated = await new AssessmentRepository(database).createOrGet({
      applicationId,
      repository: {
        host: "github.com",
        owner: "mohit-nagaraj",
        name: "sentinel",
      },
      pullRequestNumber: 42,
      baseSha: "f".repeat(40),
      headSha: "e".repeat(40),
      diffHash: `sha256:${"b".repeat(64)}`,
      baselineStatus: "compatible",
    })
    const assessment = await runs.enqueueControl(operatorId, {
      schemaVersion: 1,
      applicationId,
      type: "assess_pr",
      idempotencyKey: "assess:bound-request",
      budget,
      payload: {
        pullRequestNumber: 43,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      },
    })
    const claimed = await runs.claim("run-control-assessment", 60)
    expect(claimed?.id).toBe(assessment.run.id)
    await expect(
      runs.finish({
        runId: claimed!.id,
        owner: "run-control-assessment",
        status: "succeeded",
        publication: { kind: "assessment", assessmentId: unrelated.id },
      })
    ).rejects.toMatchObject({ code: "publication_conflict" })
    await runs.finish({
      runId: claimed!.id,
      owner: "run-control-assessment",
      status: "failed",
      errorCategory: "configuration",
      errorCode: "publication_conflict",
      retryable: false,
    })
  })

  it("keeps eval interrupt and cancellation isolated from application status", async () => {
    await database.query(
      "update sentinel.applications set status = 'ready' where id = $1::uuid",
      [applicationId]
    )
    const evaluation = await runs.enqueueControl(operatorId, {
      schemaVersion: 1,
      applicationId,
      type: "run_eval",
      idempotencyKey: "eval:interrupt-status",
      budget,
      payload: { fixtureKey: "interrupt_status" },
    })
    const claimed = await runs.claim("run-control-eval", 60)
    expect(claimed?.id).toBe(evaluation.run.id)
    await runs.recordInterrupt({
      runId: claimed!.id,
      owner: "run-control-eval",
      decisionId: "approve_eval",
      prompt: "Approve the evaluation?",
    })
    await expect(applicationStatus()).resolves.toBe("ready")
    await runs.respondInterrupt({
      operatorId,
      runId: claimed!.id,
      decisionId: "approve_eval",
      response: { approved: true },
    })
    await expect(applicationStatus()).resolves.toBe("ready")
    const resumed = await runs.claim("run-control-eval-resume", 60)
    await runs.finish({
      runId: resumed!.id,
      owner: "run-control-eval-resume",
      status: "succeeded",
      publication: { kind: "eval" },
    })

    const queuedEval = await runs.enqueueControl(operatorId, {
      schemaVersion: 1,
      applicationId,
      type: "run_eval",
      idempotencyKey: "eval:cancel-status",
      budget,
      payload: { fixtureKey: "cancel_status" },
    })
    const refresh = await runs.enqueueControl(operatorId, {
      schemaVersion: 1,
      applicationId,
      type: "refresh_knowledge",
      idempotencyKey: "refresh:alongside-eval",
      budget,
      payload: {},
    })
    await runs.requestOwnedCancellation(operatorId, queuedEval.run.id)
    await expect(applicationStatus()).resolves.toBe("refreshing")
    await runs.requestOwnedCancellation(operatorId, refresh.run.id)
    await expect(applicationStatus()).resolves.toBe("ready")
  })

  it("does not restore a stale status snapshot over newer onboarding edits", async () => {
    const refresh = await runs.enqueueControl(operatorId, {
      schemaVersion: 1,
      applicationId,
      type: "refresh_knowledge",
      idempotencyKey: "refresh:cancel-after-edit",
      budget,
      payload: {},
    })
    const editedFingerprint = `sha256:${"e".repeat(64)}`
    await database.query(
      `update sentinel.onboarding_configurations
       set input_fingerprint = $2, inspected_fingerprint = null,
           compatibility_report = null, confirmation_fingerprint = null,
           inspected_at = null, confirmed_at = null
       where application_id = $1::uuid`,
      [applicationId, editedFingerprint]
    )
    await database.query(
      "update sentinel.applications set status = 'stale' where id = $1::uuid",
      [applicationId]
    )
    await runs.requestOwnedCancellation(operatorId, refresh.run.id)
    await expect(applicationStatus()).resolves.toBe("stale")
    await database.query(
      `update sentinel.onboarding_configurations
       set inspected_fingerprint = $2,
           compatibility_report = jsonb_build_object(
             'inputFingerprint', $2::text, 'status', 'compatible'
           ),
           confirmation_fingerprint = $2, inspected_at = now(),
           confirmed_at = now()
       where application_id = $1::uuid`,
      [applicationId, editedFingerprint]
    )
  })

  it("paginates deterministically without crossing operator ownership", async () => {
    const pageRuns = await Promise.all(
      ["page_a", "page_b", "page_c"].map((fixtureKey) =>
        runs.enqueueControl(operatorId, {
          schemaVersion: 1,
          applicationId,
          type: "run_eval",
          idempotencyKey: `eval:${fixtureKey}`,
          budget,
          payload: { fixtureKey },
        })
      )
    )
    for (const [index, pageRun] of pageRuns.entries()) {
      await database.query(
        `update sentinel.runs
         set created_at = '2030-01-01T00:00:00.123400Z'::timestamptz
           + make_interval(secs => $2::double precision / 1000000)
         where id = $1::uuid`,
        [pageRun.run.id, index]
      )
    }
    const first = await runs.listOwned({ operatorId, limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBeDefined()
    const second = await runs.listOwned({
      operatorId,
      limit: 2,
      cursor: first.nextCursor!,
    })
    expect(
      new Set([...first.items, ...second.items].map((run) => run.id)).size
    ).toBeGreaterThanOrEqual(3)
    await expect(
      runs.listOwned({ operatorId: randomUUID(), limit: 100 })
    ).resolves.toEqual({ items: [] })
  })

  it("reconciles legacy overlapping mutations before adding the unique index", async () => {
    await database.query(
      "drop index sentinel.runs_active_application_mutation_idx"
    )
    for (const [runType, key] of [
      ["inspect_application", "legacy:inspect"],
      ["refresh_knowledge", "legacy:refresh"],
    ] as const) {
      await database.query(
        `insert into sentinel.runs (
           application_id, run_type, idempotency_key, budget
         ) values ($1::uuid, $2, $3, $4::text::jsonb)`,
        [applicationId, runType, key, JSON.stringify(budget)]
      )
    }
    const environment = loadIntegrationEnvironment(process.env)
    const migrationDatabase = createPostgresDatabase(
      environment.SENTINEL_TEST_DATABASE_URL,
      { maxConnections: 1 }
    )
    await migrationDatabase.query(migrations[2]!)
    await migrationDatabase.close()
    const rows = await database.query<{ active: number; cancelled: number }>(
      `select
         count(*) filter (where status in (
           'queued', 'running', 'interrupted', 'cancelling'
         ))::int as active,
         count(*) filter (where status = 'cancelled')::int as cancelled
       from sentinel.runs
       where application_id = $1::uuid and run_type <> 'run_eval'`,
      [applicationId]
    )
    expect(rows[0]).toMatchObject({ active: 1 })
    expect(rows[0]!.cancelled).toBeGreaterThanOrEqual(1)
  })

  async function applicationStatus(): Promise<string | undefined> {
    const rows = await database.query<{ status: string }>(
      "select status from sentinel.applications where id = $1::uuid",
      [applicationId]
    )
    return rows[0]?.status
  }
})
