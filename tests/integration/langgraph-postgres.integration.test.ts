import { readFileSync } from "node:fs"

import {
  ApplicationRepository,
  createPostgresDatabase,
  loadIntegrationEnvironment,
  RunRepository,
  type DatabaseClient,
} from "@sentinel/storage"
import {
  CancelledOrchestrationError,
  DurableRunEventSink,
  LeaseOwnershipError,
  PostgresResumeCoordinator,
  SyntheticOrchestrationService,
  buildSyntheticGraph,
  createSyntheticInitialState,
  initializePostgresCheckpointSaver,
  type RuntimeDependencies,
} from "@sentinel/orchestration"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  createOperationalTestApplication,
  operationalTestBudget,
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

describeIntegration("LangGraph Postgres checkpoint runtime", () => {
  let database: DatabaseClient
  let saver:
    Awaited<ReturnType<typeof initializePostgresCheckpointSaver>> | undefined
  let resumeCoordinator: PostgresResumeCoordinator | undefined
  let applicationDatabaseId: string
  let runDatabaseId: string
  let contractRunId: string
  const owner = "langgraph-integration-worker"
  const applicationInput = createOperationalTestApplication(
    "sentinel-langgraph-integration"
  )

  beforeAll(async () => {
    const environment = loadIntegrationEnvironment(process.env)
    const migrationDatabase = createPostgresDatabase(
      environment.SENTINEL_TEST_DATABASE_URL,
      { maxConnections: 1 }
    )
    await migrationDatabase.query(migration)
    await migrationDatabase.close()
    database = createPostgresDatabase(environment.SENTINEL_TEST_DATABASE_URL, {
      maxConnections: 6,
    })
    const application = await new ApplicationRepository(database).upsert(
      applicationInput
    )
    applicationDatabaseId = application.id
    const runs = new RunRepository(database)
    const queued = await runs.enqueue({
      applicationId: application.id,
      runType: "initialize_knowledge",
      idempotencyKey: `langgraph:${applicationInput.stableKey}`,
      budget: operationalTestBudget,
    })
    const claimed = await runs.claim(owner, 120)
    expect(claimed?.id).toBe(queued.id)
    runDatabaseId = queued.id
    contractRunId = `run:${queued.id}`
    saver = await initializePostgresCheckpointSaver(
      environment.SENTINEL_TEST_DATABASE_URL
    )
    resumeCoordinator = new PostgresResumeCoordinator(
      environment.SENTINEL_TEST_DATABASE_URL
    )
  }, 60_000)

  afterAll(async () => {
    if (saver !== undefined && contractRunId !== undefined) {
      await saver.deleteThread(contractRunId)
      await saver.end()
    }
    await resumeCoordinator?.close()
    if (database !== undefined && applicationDatabaseId !== undefined) {
      await database.query(
        "delete from sentinel.applications where id = $1::uuid",
        [applicationDatabaseId]
      )
      await database.close()
    }
  }, 60_000)

  it("keeps checkpoint tables private and resumes an interrupt after restart", async () => {
    const access = await database.query<{
      public_revoked: boolean
      browser_roles_with_usage: number
    }>(
      `select
         not exists (
           select 1
           from pg_namespace n,
                aclexplode(n.nspacl) acl
           where n.nspname = 'langgraph_checkpoint'
             and acl.grantee = 0
             and acl.privilege_type in ('USAGE', 'CREATE')
         ) as public_revoked,
         (
           select count(*)::int
           from pg_roles r
           where r.rolname in ('anon', 'authenticated')
             and has_schema_privilege(
               r.rolname,
               'langgraph_checkpoint',
               'USAGE'
             )
         )::int as browser_roles_with_usage`
    )
    expect(access[0]).toEqual({
      public_revoked: true,
      browser_roles_with_usage: 0,
    })

    const runs = new RunRepository(database)
    const effects = new Set<string>()
    const effectAttempts = new Map<string, number>()
    const dependencies: RuntimeDependencies = {
      owner,
      control: {
        assertActive: async ({ runId, owner: requestedOwner }) => {
          const id = runId.slice("run:".length)
          const rows = await database.query<{
            status: string
            lease_owner: string | null
            lease_active: boolean
            cancelled: boolean
          }>(
            `select status,
                    lease_owner,
                    lease_expires_at > now() as lease_active,
                    cancel_requested_at is not null as cancelled
             from sentinel.runs
             where id = $1::uuid`,
            [id]
          )
          const row = rows[0]
          if (row?.cancelled === true) throw new CancelledOrchestrationError()
          if (
            row?.status !== "running" ||
            row.lease_owner !== requestedOwner ||
            !row.lease_active
          ) {
            throw new LeaseOwnershipError()
          }
        },
      },
      events: new DurableRunEventSink(async (event, idempotencyKey) => {
        await runs.appendEvent(event, idempotencyKey)
      }),
      effects: {
        execute: async ({ effectId }) => {
          effectAttempts.set(effectId, (effectAttempts.get(effectId) ?? 0) + 1)
          effects.add(effectId)
        },
      },
      resumeAuthorization: { authorize: async () => true },
      resumeCoordinator: resumeCoordinator!,
    }

    const firstGraph = buildSyntheticGraph(dependencies, saver!)
    const firstService = new SyntheticOrchestrationService(
      firstGraph,
      dependencies
    )
    const paused = await firstService.start(
      createSyntheticInitialState({
        runId: contractRunId,
        applicationId: applicationInput.stableKey,
        budget: operationalTestBudget,
      })
    )
    expect(paused.status).toBe("interrupted")

    await saver!.end()
    saver = await initializePostgresCheckpointSaver(
      loadIntegrationEnvironment(process.env).SENTINEL_TEST_DATABASE_URL
    )
    const restartedGraph = buildSyntheticGraph(dependencies, saver)
    const restartedService = new SyntheticOrchestrationService(
      restartedGraph,
      dependencies
    )
    const resumeInput = {
      runId: contractRunId,
      actorId: "integration-reviewer",
      decisionId: "synthetic_review",
      approved: true,
    } as const
    const [resumed, duplicate] = await Promise.all([
      restartedService.resume(resumeInput),
      restartedService.resume(resumeInput),
    ])
    expect(resumed.state.terminalStatus).toBe("complete")
    expect(effects).toContain("finalize")
    expect([resumed.idempotent, duplicate.idempotent].sort()).toEqual([
      false,
      true,
    ])
    expect(effectAttempts.get("finalize")).toBe(1)
    const events = await runs.listEvents(runDatabaseId)
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "node_started",
        "tool_started",
        "interrupt_requested",
        "interrupt_resumed",
      ])
    )
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index + 1)
    )
  }, 60_000)
})
