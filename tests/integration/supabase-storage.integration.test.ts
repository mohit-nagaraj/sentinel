import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"

import { artifactIdSchema } from "@sentinel/contracts"
import {
  ApplicationRepository,
  ArtifactMetadataRepository,
  ArtifactService,
  createPostgresDatabase,
  loadIntegrationEnvironment,
  loadStorageEnvironment,
  RunRepository,
  S3PrivateObjectStore,
  type ArtifactMetadata,
  type DatabaseClient,
} from "@sentinel/storage"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  createOperationalTestApplication,
  operationalTestBudget,
} from "../fixtures/operational.ts"

const enabled = process.env["RUN_SUPABASE_STORAGE_TESTS"] === "1"
const describeIntegration = enabled ? describe : describe.skip
const migrations = [
  "../../supabase/migrations/20260907000100_operational_state.sql",
  "../../supabase/migrations/20260908000100_onboarding_control_plane.sql",
  "../../supabase/migrations/20260908000200_run_event_idempotency.sql",
  "../../supabase/migrations/20260908000300_run_control.sql",
  "../../supabase/migrations/20260908000500_realtime_activity.sql",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))

describeIntegration("Supabase private Storage", () => {
  let database: DatabaseClient
  let service: ArtifactService
  let objects: S3PrivateObjectStore
  let saved: ArtifactMetadata | undefined
  let applicationId: string
  let publicObjectRoot: string
  const applicationInput = createOperationalTestApplication(
    "sentinel-storage-integration"
  )
  const bucketName = `sentinel-test-${randomUUID().replaceAll("-", "").slice(0, 20)}`

  beforeAll(async () => {
    const storageEnvironment = loadStorageEnvironment(process.env)
    const integrationEnvironment = loadIntegrationEnvironment({
      ...process.env,
      RUN_SUPABASE_INTEGRATION_TESTS: "1",
    })
    const migrationDatabase = createPostgresDatabase(
      integrationEnvironment.SENTINEL_TEST_DATABASE_URL,
      { maxConnections: 1 }
    )
    for (const migration of migrations) {
      await migrationDatabase.query(migration)
    }
    await migrationDatabase.close()
    database = createPostgresDatabase(
      integrationEnvironment.SENTINEL_TEST_DATABASE_URL
    )
    applicationId = (
      await new ApplicationRepository(database).upsert(applicationInput)
    ).id

    objects = new S3PrivateObjectStore(storageEnvironment)
    service = new ArtifactService(
      bucketName,
      objects,
      new ArtifactMetadataRepository(database)
    )
    publicObjectRoot = `${new URL(storageEnvironment.SUPABASE_S3_ENDPOINT).origin}/storage/v1/object/public/${bucketName}`
    await service.initialize()
  }, 60_000)

  afterAll(async () => {
    if (service !== undefined && saved !== undefined) {
      await service.delete(applicationId, saved.id).catch(() => undefined)
    }
    if (database !== undefined && applicationId !== undefined) {
      if (objects !== undefined) {
        await objects.deleteEmptyBucket(bucketName).catch(() => undefined)
      }
      await database.query(
        "delete from sentinel.applications where id = $1::uuid",
        [applicationId]
      )
      await database.close()
    }
  })

  it("persists a stable private artifact, signs briefly, and deletes it", async () => {
    const body = new TextEncoder().encode('{"fixture":"sentinel"}')
    saved = await service.persist({
      applicationId,
      applicationStableId: applicationInput.stableKey,
      runId: null,
      artifactType: "browser_snapshot",
      mimeType: "application/json",
      body,
      retainUntil: null,
    })
    expect(artifactIdSchema.parse(saved.id)).toBe(saved.id)

    const publicResponse = await fetch(`${publicObjectRoot}/${saved.objectKey}`)
    expect(publicResponse.ok).toBe(false)

    const signedUrl = await service.signedDownloadUrl(
      applicationId,
      saved.id,
      2
    )
    const response = await fetch(signedUrl)
    expect(response.ok).toBe(true)
    expect(await response.text()).toBe('{"fixture":"sentinel"}')

    await new Promise((resolve) => setTimeout(resolve, 2_200))
    const expiredResponse = await fetch(signedUrl)
    expect(expiredResponse.ok).toBe(false)

    await expect(service.delete(applicationId, saved.id)).resolves.toBe(true)
    await expect(
      service.signedDownloadUrl(applicationId, saved.id, 30)
    ).rejects.toThrow("Artifact not found")

    const originalStableId = saved.id
    saved = await service.persist({
      applicationId,
      applicationStableId: applicationInput.stableKey,
      runId: null,
      artifactType: "browser_snapshot",
      mimeType: "application/json",
      body,
      retainUntil: null,
    })
    expect(saved.id).toBe(originalStableId)
    await expect(
      service.signedDownloadUrl(applicationId, saved.id, 30)
    ).resolves.toMatch(/^http/)
    await expect(service.delete(applicationId, saved.id)).resolves.toBe(true)
    saved = undefined
  })

  it("associates one content-addressed screenshot with both capturing runs", async () => {
    const runs = new RunRepository(database)
    const [firstRun, secondRun] = await Promise.all([
      runs.enqueue({
        applicationId,
        runType: "run_eval",
        idempotencyKey: `storage:first:${randomUUID()}`,
        budget: operationalTestBudget,
      }),
      runs.enqueue({
        applicationId,
        runType: "run_eval",
        idempotencyKey: `storage:second:${randomUUID()}`,
        budget: operationalTestBudget,
      }),
    ])
    const body = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const first = await service.persist({
      applicationId,
      applicationStableId: applicationInput.stableKey,
      runId: firstRun.id,
      artifactType: "screenshot",
      mimeType: "image/png",
      body,
      retainUntil: null,
    })
    saved = first
    const second = await service.persist({
      applicationId,
      applicationStableId: applicationInput.stableKey,
      runId: secondRun.id,
      artifactType: "screenshot",
      mimeType: "image/png",
      body,
      retainUntil: null,
    })
    expect(second.id).toBe(first.id)
    await expect(
      service.signedRunDownloadUrl(applicationId, firstRun.id, first.id, 30)
    ).resolves.toMatch(/^http/)
    await expect(
      service.signedRunDownloadUrl(applicationId, secondRun.id, first.id, 30)
    ).resolves.toMatch(/^http/)
    await expect(service.delete(applicationId, first.id)).resolves.toBe(true)
    saved = undefined
  })
})
