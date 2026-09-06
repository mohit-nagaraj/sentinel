import { describe, expect, it } from "vitest"

import {
  loadIntegrationEnvironment,
  loadStorageEnvironment,
  StorageConfigurationError,
} from "./environment.ts"

const validEnvironment = {
  SUPABASE_DB_URL: "postgresql://postgres:example@localhost:5432/postgres",
  SUPABASE_S3_ENDPOINT: "https://example.supabase.co/storage/v1/s3",
  SUPABASE_S3_REGION: "local",
  SUPABASE_S3_ACCESS_KEY_ID: "access-id",
  SUPABASE_S3_SECRET_ACCESS_KEY: "do-not-log-this-value",
  SUPABASE_STORAGE_BUCKET: "sentinel-artifacts",
}

describe("storage environment", () => {
  it("parses server-only database and object-storage settings", () => {
    expect(loadStorageEnvironment(validEnvironment)).toEqual(validEnvironment)
  })

  it("reports field names without leaking invalid values", () => {
    let captured: unknown
    try {
      loadStorageEnvironment({
        ...validEnvironment,
        SUPABASE_S3_SECRET_ACCESS_KEY: "",
      })
    } catch (error) {
      captured = error
    }

    expect(captured).toBeInstanceOf(StorageConfigurationError)
    expect(String(captured)).toContain("SUPABASE_S3_SECRET_ACCESS_KEY")
    expect(String(captured)).not.toContain("do-not-log-this-value")
  })

  it("requires an explicit disposable database distinct from the configured target", () => {
    expect(() => loadIntegrationEnvironment({})).toThrow(
      StorageConfigurationError
    )
    expect(() =>
      loadIntegrationEnvironment({
        RUN_SUPABASE_INTEGRATION_TESTS: "1",
        SENTINEL_TEST_DATABASE_URL: validEnvironment.SUPABASE_DB_URL,
        SUPABASE_DB_URL: validEnvironment.SUPABASE_DB_URL,
      })
    ).toThrow("must not equal SUPABASE_DB_URL")
    expect(() =>
      loadIntegrationEnvironment({
        RUN_SUPABASE_INTEGRATION_TESTS: "1",
        SENTINEL_TEST_DATABASE_URL:
          "postgresql://different-role:other@localhost:5432/postgres?sslmode=require",
        SUPABASE_DB_URL: validEnvironment.SUPABASE_DB_URL,
      })
    ).toThrow("must not equal SUPABASE_DB_URL")
    expect(() =>
      loadIntegrationEnvironment({
        RUN_SUPABASE_INTEGRATION_TESTS: "1",
        SENTINEL_TEST_DATABASE_URL:
          "postgresql://postgres.test-project:secret@region.pooler.supabase.com:6543/postgres",
      })
    ).toThrow("SENTINEL_TEST_DATABASE_URL")
  })
})
