import { z } from "zod"

const allowedNeo4jProtocols = new Set([
  "neo4j:",
  "neo4j+s:",
  "neo4j+ssc:",
  "bolt:",
  "bolt+s:",
  "bolt+ssc:",
])

const neo4jUriSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .superRefine((value, context) => {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      context.addIssue({ code: "custom", message: "Invalid Neo4j URI" })
      return
    }
    if (!allowedNeo4jProtocols.has(parsed.protocol)) {
      context.addIssue({
        code: "custom",
        message: "Unsupported Neo4j protocol",
      })
    }
    if (
      !["", "/"].includes(parsed.pathname) ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Neo4j URI cannot contain credentials, a path, query, or fragment",
      })
    }
  })

export const neo4jEnvironmentSchema = z.strictObject({
  NEO4J_URI: neo4jUriSchema,
  NEO4J_USERNAME: z.string().trim().min(1).max(256),
  NEO4J_PASSWORD: z.string().min(1).max(4096),
  NEO4J_DATABASE: z.string().trim().min(1).max(256),
})

export const neo4jIntegrationEnvironmentSchema = z.strictObject({
  RUN_NEO4J_INTEGRATION_TESTS: z.literal("1"),
  SENTINEL_NEO4J_TEST_PREFIX: z
    .string()
    .regex(/^sentinel-test-[a-f0-9]{8,32}$/),
})

export type Neo4jEnvironment = z.infer<typeof neo4jEnvironmentSchema>
export type Neo4jIntegrationEnvironment = z.infer<
  typeof neo4jIntegrationEnvironmentSchema
>

export class Neo4jConfigurationError extends Error {
  readonly fields: readonly string[]

  constructor(fields: readonly string[]) {
    super(`Invalid Neo4j configuration: ${fields.join(", ")}`)
    this.name = "Neo4jConfigurationError"
    this.fields = fields
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  throw new Neo4jConfigurationError([
    ...new Set(result.error.issues.map((issue) => String(issue.path[0]))),
  ])
}

export function loadNeo4jEnvironment(
  source: Readonly<Record<string, string | undefined>>
): Neo4jEnvironment {
  return parseOrThrow(neo4jEnvironmentSchema, {
    NEO4J_URI: source["NEO4J_URI"],
    NEO4J_USERNAME: source["NEO4J_USERNAME"],
    NEO4J_PASSWORD: source["NEO4J_PASSWORD"],
    NEO4J_DATABASE: source["NEO4J_DATABASE"],
  })
}

export function loadNeo4jIntegrationEnvironment(
  source: Readonly<Record<string, string | undefined>>
): Neo4jIntegrationEnvironment {
  return parseOrThrow(neo4jIntegrationEnvironmentSchema, {
    RUN_NEO4J_INTEGRATION_TESTS: source["RUN_NEO4J_INTEGRATION_TESTS"],
    SENTINEL_NEO4J_TEST_PREFIX: source["SENTINEL_NEO4J_TEST_PREFIX"],
  })
}
