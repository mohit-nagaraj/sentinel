import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"

import {
  ApplicationRepository,
  createPostgresDatabase,
  GithubAssessmentRepository,
  loadIntegrationEnvironment,
  type DatabaseClient,
} from "@sentinel/storage"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  createOperationalTestApplication,
  operationalTestBudget,
} from "../fixtures/operational.ts"

const enabled = process.env["RUN_SUPABASE_INTEGRATION_TESTS"] === "1"
const describeIntegration = enabled ? describe : describe.skip
const migrations = [
  "../../supabase/migrations/20260907000100_operational_state.sql",
  "../../supabase/migrations/20260908000100_onboarding_control_plane.sql",
  "../../supabase/migrations/20260908000300_run_control.sql",
  "../../supabase/migrations/20260908000400_github_app_checks.sql",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))

describeIntegration("GitHub App assessment PostgreSQL lifecycle", () => {
  let database: DatabaseClient
  let assessments: GithubAssessmentRepository
  let applicationId: string
  const operatorId = randomUUID()
  const repository = {
    host: "github.com",
    owner: "owner",
    name: `repo-${randomUUID().slice(0, 8)}`,
  }
  const installationId = String(Math.floor(Date.now() / 1_000))
  const repositoryId = String(Math.floor(Date.now() / 100))
  const pullRequestId = String(Math.floor(Date.now() / 10))
  const baseSha = "a".repeat(40)
  const firstHeadSha = "b".repeat(40)

  beforeAll(async () => {
    const environment = loadIntegrationEnvironment(process.env)
    const migrationDatabase = createPostgresDatabase(
      environment.SENTINEL_TEST_DATABASE_URL,
      { maxConnections: 1 }
    )
    for (const migration of migrations) await migrationDatabase.query(migration)
    await migrationDatabase.close()

    database = createPostgresDatabase(environment.SENTINEL_TEST_DATABASE_URL, {
      maxConnections: 8,
    })
    const application = await new ApplicationRepository(database).upsert({
      ...createOperationalTestApplication(`github-app-${randomUUID()}`),
      status: "ready",
    })
    applicationId = application.id
    await database.query(
      `update sentinel.applications
       set graph_revision = 1, indexed_commit_sha = $2
       where id = $1::uuid`,
      [applicationId, baseSha]
    )
    const fingerprint = `sha256:${"d".repeat(64)}`
    await database.query(
      `insert into sentinel.onboarding_configurations (
         application_id, operator_id, configuration, input_fingerprint,
         inspected_fingerprint, compatibility_report, confirmation_fingerprint,
         confirmed_at
       ) values (
         $1::uuid, $2::uuid, $3::text::jsonb, $4, $4,
         jsonb_build_object('inputFingerprint', $4::text, 'status', 'supported'),
         $4, now()
       )`,
      [
        applicationId,
        operatorId,
        JSON.stringify({
          repository: {
            url: `https://github.com/${repository.owner}/${repository.name}`,
            accessMode: "github_app",
            installationId,
          },
        }),
        fingerprint,
      ]
    )
    assessments = new GithubAssessmentRepository(database)
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

  function webhook(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1 as const,
      source: "webhook" as const,
      event: "pull_request" as const,
      action: "opened" as const,
      deliveryId: "delivery-1",
      installationId,
      repositoryId,
      repository,
      pullRequestId,
      pullRequestNumber: 7,
      pullRequestUrl: `https://github.com/${repository.owner}/${repository.name}/pull/7`,
      baseSha,
      headSha: firstHeadSha,
      providerUpdatedAt: "2026-09-08T12:00:00Z",
      sender: { id: "42", login: "octocat", type: "User" },
      ...overrides,
    }
  }

  it("deduplicates, supersedes, rejects stale heads, and binds one check", async () => {
    const concurrent = await Promise.all([
      assessments.enqueue(webhook(), operationalTestBudget),
      assessments.enqueue(webhook(), operationalTestBudget),
    ])
    expect(concurrent.map(({ disposition }) => disposition).sort()).toEqual([
      "created",
      "duplicate",
    ])
    expect(concurrent[0]?.assessmentId).toBe(concurrent[1]?.assessmentId)
    expect(concurrent[0]?.runId).toBe(concurrent[1]?.runId)
    const first = concurrent[0]!

    const sameHead = await assessments.enqueue(
      webhook({
        action: "reopened",
        deliveryId: "delivery-2",
        providerUpdatedAt: "2026-09-08T12:01:00Z",
      }),
      operationalTestBudget
    )
    expect(sameHead).toMatchObject({
      disposition: "duplicate",
      assessmentId: first.assessmentId,
      runId: first.runId,
    })
    const timestamps = await database.query<{ provider_updated_at: Date }>(
      "select provider_updated_at from sentinel.pr_assessments where id = $1::uuid",
      [first.assessmentId]
    )
    expect(timestamps[0]?.provider_updated_at.toISOString()).toBe(
      "2026-09-08T12:01:00.000Z"
    )

    const claims = await Promise.all([
      assessments.claimCheck(first.assessmentId, firstHeadSha, 30),
      assessments.claimCheck(first.assessmentId, firstHeadSha, 30),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
    const initialClaim = claims.find((claim) => claim !== null)!
    expect(initialClaim.recovering).toBe(false)
    await expect(
      assessments.releaseCheck({
        assessmentId: first.assessmentId,
        headSha: firstHeadSha,
        syncLeaseToken: initialClaim.syncLeaseToken!,
      })
    ).resolves.toBe(true)
    const recovery = await assessments.claimCheck(
      first.assessmentId,
      firstHeadSha,
      30
    )
    expect(recovery).toMatchObject({ recovering: true })
    await expect(
      assessments.bindCheck({
        assessmentId: first.assessmentId,
        headSha: firstHeadSha,
        syncLeaseToken: recovery!.syncLeaseToken!,
        checkRunId: "9876543210",
      })
    ).resolves.toBe(true)

    const secondHeadSha = "c".repeat(40)
    const synchronized = await assessments.enqueue(
      webhook({
        action: "synchronize",
        deliveryId: "delivery-3",
        headSha: secondHeadSha,
        providerUpdatedAt: "2026-09-08T12:02:00Z",
      }),
      operationalTestBudget
    )
    expect(synchronized).toMatchObject({
      disposition: "created",
      headSha: secondHeadSha,
      isCurrent: true,
    })
    const oldRuns = await database.query<{ status: string }>(
      "select status from sentinel.runs where id = $1::uuid",
      [first.runId!]
    )
    expect(oldRuns[0]?.status).toBe("cancelled")
    await expect(
      assessments.getCurrentCheck(first.assessmentId, firstHeadSha)
    ).resolves.toBeNull()
    await expect(
      assessments.enqueue(webhook(), operationalTestBudget)
    ).resolves.toMatchObject({
      disposition: "stale",
      assessmentId: first.assessmentId,
      runId: null,
      isCurrent: false,
    })

    const stale = await assessments.enqueue(
      webhook({
        deliveryId: "delivery-4",
        headSha: "e".repeat(40),
        providerUpdatedAt: "2026-09-08T12:01:30Z",
      }),
      operationalTestBudget
    )
    expect(stale).toMatchObject({
      disposition: "stale",
      runId: null,
      isCurrent: false,
    })
    const current = await database.query<{
      id: string
      head_sha: string
      current_count: number
    }>(
      `select min(id::text)::uuid as id, min(head_sha) as head_sha,
              count(*)::int as current_count
       from sentinel.pr_assessments
       where application_id = $1::uuid and pull_request_number = 7 and is_current`,
      [applicationId]
    )
    expect(current[0]).toMatchObject({
      id: synchronized.assessmentId,
      head_sha: secondHeadSha,
      current_count: 1,
    })
  })
})
