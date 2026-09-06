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
  S3PrivateObjectStore,
  type ArtifactMetadata,
  type DatabaseClient,
} from "@sentinel/storage"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createOperationalTestApplication } from "../fixtures/operational.ts"

const enabled = process.env["RUN_SUPABASE_STORAGE_TESTS"] === "1"
const describeIntegration = enabled ? describe : describe.skip
const migration = readFileSync(
  new URL(
    "../../supabase/migrations/20260907000100_operational_state.sql",
    import.meta.url
  ),
  "utf8"
)

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
    await migrationDatabase.query(migration)
    await migrationDatabase.close()
    database = createPostgresDatabase(
      integrationEnvironment.SENTINEL_TEST_DATABASE_URL
    )
    applicationId = (
      await new ApplicationRepository(database).upsert(applicationInput)
    ).id

    objects = new S3PrivateObjectStore(bucketName, storageEnvironment)
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
        await objects.deleteEmptyBucket().catch(() => undefined)
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
})
