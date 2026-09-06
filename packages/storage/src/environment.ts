import { publicHttpUrlSchema } from "@sentinel/contracts"
import { z } from "zod"

const databaseUrlSchema = z.url({ protocol: /^postgres(?:ql)?$/ })

const disposableDatabaseUrlSchema = databaseUrlSchema.refine((value) => {
  const hostname = new URL(value).hostname.toLowerCase()
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  )
}, "Integration tests require a loopback disposable database")

const bucketSchema = z
  .string()
  .trim()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/)

export const storageEnvironmentSchema = z.strictObject({
  SUPABASE_DB_URL: databaseUrlSchema,
  SUPABASE_S3_ENDPOINT: publicHttpUrlSchema,
  SUPABASE_S3_REGION: z.string().trim().min(1).max(64),
  SUPABASE_S3_ACCESS_KEY_ID: z.string().trim().min(1).max(512),
  SUPABASE_S3_SECRET_ACCESS_KEY: z.string().min(1).max(4096),
  SUPABASE_STORAGE_BUCKET: bucketSchema,
})

export const integrationEnvironmentSchema = z.strictObject({
  RUN_SUPABASE_INTEGRATION_TESTS: z.literal("1"),
  SENTINEL_TEST_DATABASE_URL: disposableDatabaseUrlSchema,
})

export type StorageEnvironment = z.infer<typeof storageEnvironmentSchema>
export type IntegrationEnvironment = z.infer<
  typeof integrationEnvironmentSchema
>

export class StorageConfigurationError extends Error {
  readonly fields: readonly string[]

  constructor(fields: readonly string[]) {
    super(`Invalid storage configuration: ${fields.join(", ")}`)
    this.name = "StorageConfigurationError"
    this.fields = fields
  }
}

export function loadStorageEnvironment(
  source: Readonly<Record<string, string | undefined>>
): StorageEnvironment {
  const result = storageEnvironmentSchema.safeParse({
    SUPABASE_DB_URL: source["SUPABASE_DB_URL"],
    SUPABASE_S3_ENDPOINT: source["SUPABASE_S3_ENDPOINT"],
    SUPABASE_S3_REGION: source["SUPABASE_S3_REGION"],
    SUPABASE_S3_ACCESS_KEY_ID: source["SUPABASE_S3_ACCESS_KEY_ID"],
    SUPABASE_S3_SECRET_ACCESS_KEY: source["SUPABASE_S3_SECRET_ACCESS_KEY"],
    SUPABASE_STORAGE_BUCKET: source["SUPABASE_STORAGE_BUCKET"],
  })

  if (!result.success) {
    throw new StorageConfigurationError([
      ...new Set(result.error.issues.map((issue) => String(issue.path[0]))),
    ])
  }

  return result.data
}

export function loadIntegrationEnvironment(
  source: Readonly<Record<string, string | undefined>>
): IntegrationEnvironment {
  const result = integrationEnvironmentSchema.safeParse({
    RUN_SUPABASE_INTEGRATION_TESTS: source["RUN_SUPABASE_INTEGRATION_TESTS"],
    SENTINEL_TEST_DATABASE_URL: source["SENTINEL_TEST_DATABASE_URL"],
  })

  if (!result.success) {
    throw new StorageConfigurationError([
      ...new Set(result.error.issues.map((issue) => String(issue.path[0]))),
    ])
  }

  const productionUrl = source["SUPABASE_DB_URL"]
  if (
    productionUrl !== undefined &&
    databaseTarget(result.data.SENTINEL_TEST_DATABASE_URL) ===
      databaseTarget(productionUrl)
  ) {
    throw new StorageConfigurationError([
      "SENTINEL_TEST_DATABASE_URL must not equal SUPABASE_DB_URL",
    ])
  }

  return result.data
}

function databaseTarget(connectionString: string): string {
  const url = new URL(connectionString)
  url.protocol = "postgresql:"
  url.username = ""
  url.password = ""
  url.search = ""
  url.hash = ""
  return url.toString()
}
