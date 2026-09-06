import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"

import {
  ApplicationRepository,
  createPostgresDatabase,
  loadIntegrationEnvironment,
  TargetSecretService,
  type DatabaseClient,
} from "@sentinel/storage"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createOperationalTestApplication } from "../fixtures/operational.ts"

const enabled = process.env["RUN_SUPABASE_VAULT_TESTS"] === "1"
const describeIntegration = enabled ? describe : describe.skip
const migration = readFileSync(
  new URL(
    "../../supabase/migrations/20260907000100_operational_state.sql",
    import.meta.url
  ),
  "utf8"
)

describeIntegration("Supabase Vault target secrets", () => {
  let database: DatabaseClient
  let applicationId: string
  const applicationInput = createOperationalTestApplication(
    "sentinel-vault-integration"
  )

  beforeAll(async () => {
    const environment = loadIntegrationEnvironment({
      ...process.env,
      RUN_SUPABASE_INTEGRATION_TESTS: "1",
    })
    const migrationDatabase = createPostgresDatabase(
      environment.SENTINEL_TEST_DATABASE_URL,
      { maxConnections: 1 }
    )
    await migrationDatabase.query(migration)
    await migrationDatabase.close()
    database = createPostgresDatabase(environment.SENTINEL_TEST_DATABASE_URL)
    applicationId = (
      await new ApplicationRepository(database).upsert({
        stableKey: applicationInput.stableKey,
        name: "Vault integration fixture",
        deploymentUrl: applicationInput.deploymentUrl,
        status: "ready",
      })
    ).id
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

  it("creates, resolves, rotates, and deletes an opaque reference", async () => {
    const secrets = new TargetSecretService(database)
    const created = await secrets.create({
      applicationId,
      name: `integration_${randomUUID().replaceAll("-", "")}`,
      value: "synthetic-first-value",
    })

    await expect(
      secrets.resolve(applicationId, created.reference)
    ).resolves.toBe("synthetic-first-value")
    const rotated = await secrets.rotate({
      applicationId,
      reference: created.reference,
      value: "synthetic-second-value",
    })
    expect(rotated.reference).toBe(created.reference)
    await expect(
      secrets.resolve(applicationId, created.reference)
    ).resolves.toBe("synthetic-second-value")
    await expect(
      secrets.delete(applicationId, created.reference)
    ).resolves.toBe(true)
    await expect(
      secrets.resolve(applicationId, created.reference)
    ).rejects.toThrow("not found")
  })
})
