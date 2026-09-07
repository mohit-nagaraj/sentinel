import { zodTextFormat } from "openai/helpers/zod"
import { z } from "zod"

import { assertModelSafeValue, ModelGatewayError } from "./contracts.ts"

export function createStrictModelJsonSchema(
  schema: z.ZodType,
  schemaName: string
): Record<string, unknown> {
  try {
    const format = z
      .looseObject({
        type: z.literal("json_schema"),
        name: z.string(),
        strict: z.literal(true),
        schema: z.record(z.string(), z.unknown()),
      })
      .parse(zodTextFormat(schema, schemaName))
    assertModelSafeValue(format.schema)
    if (JSON.stringify(format.schema).length > 32_768) {
      throw new ModelGatewayError("limit_exceeded", false)
    }
    return format.schema
  } catch (error) {
    if (error instanceof ModelGatewayError) throw error
    throw new ModelGatewayError("invalid_request", false)
  }
}
