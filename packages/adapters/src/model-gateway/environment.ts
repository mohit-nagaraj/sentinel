import { z } from "zod"

export const azureOpenAIEnvironmentSchema = z.strictObject({
  AZURE_OPENAI_ENDPOINT: z
    .url({ protocol: /^https$/ })
    .refine((value) => new URL(value).pathname === "/openai/v1/", {
      message: "Azure OpenAI endpoint must end with /openai/v1/",
    })
    .refine(
      (value) =>
        /^[a-z0-9-]+\.(?:openai\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com)$/i.test(
          new URL(value).hostname
        ),
      { message: "Azure OpenAI endpoint host is invalid" }
    )
    .refine((value) => {
      const url = new URL(value)
      return (
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === ""
      )
    }),
  AZURE_OPENAI_API_KEY: z.string().min(16).max(4_096),
  AZURE_OPENAI_DEPLOYMENT: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
})

export const azureCompatibilityEnvironmentSchema = z.strictObject({
  RUN_AZURE_OPENAI_COMPATIBILITY: z.literal("1"),
  AZURE_OPENAI_COMPATIBILITY_MAX_TOKENS: z.coerce
    .number()
    .int()
    .min(32)
    .max(1_024)
    .default(256),
})

export type AzureOpenAIEnvironment = z.infer<
  typeof azureOpenAIEnvironmentSchema
>
export type AzureCompatibilityEnvironment = z.infer<
  typeof azureCompatibilityEnvironmentSchema
>

export class AzureOpenAIConfigurationError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`Invalid Azure OpenAI configuration: ${fields.join(", ")}`)
    this.name = "AzureOpenAIConfigurationError"
  }
}

function parseOrThrow<Output>(
  schema: z.ZodType<Output>,
  input: unknown
): Output {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  throw new AzureOpenAIConfigurationError([
    ...new Set(result.error.issues.map((issue) => String(issue.path[0]))),
  ])
}

export function loadAzureOpenAIEnvironment(
  source: Readonly<Record<string, string | undefined>>
): AzureOpenAIEnvironment {
  return parseOrThrow(azureOpenAIEnvironmentSchema, {
    AZURE_OPENAI_ENDPOINT: source["AZURE_OPENAI_ENDPOINT"],
    AZURE_OPENAI_API_KEY: source["AZURE_OPENAI_API_KEY"],
    AZURE_OPENAI_DEPLOYMENT: source["AZURE_OPENAI_DEPLOYMENT"],
  })
}

export function loadAzureCompatibilityEnvironment(
  source: Readonly<Record<string, string | undefined>>
): AzureCompatibilityEnvironment {
  return parseOrThrow(azureCompatibilityEnvironmentSchema, {
    RUN_AZURE_OPENAI_COMPATIBILITY: source["RUN_AZURE_OPENAI_COMPATIBILITY"],
    AZURE_OPENAI_COMPATIBILITY_MAX_TOKENS:
      source["AZURE_OPENAI_COMPATIBILITY_MAX_TOKENS"],
  })
}
