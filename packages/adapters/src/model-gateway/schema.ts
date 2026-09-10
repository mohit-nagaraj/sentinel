import { z } from "zod"

import { assertModelSafeValue, ModelGatewayError } from "./contracts.ts"

type JsonSchema = Record<string, unknown>

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sourceJsonSchema(schema: z.ZodType): JsonSchema {
  const result = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
  })
  if (!isRecord(result)) throw new Error("Model schema is not an object")
  const source = { ...result }
  delete source["$schema"]
  return source
}

function isNullable(schema: JsonSchema): boolean {
  const type = schema["type"]
  return (
    type === "null" ||
    (Array.isArray(type) && type.includes("null")) ||
    (Array.isArray(schema["anyOf"]) &&
      schema["anyOf"].some(
        (branch) => isRecord(branch) && branch["type"] === "null"
      ))
  )
}

function nullable(schema: JsonSchema): JsonSchema {
  return isNullable(schema) ? schema : { anyOf: [schema, { type: "null" }] }
}

function strictSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictSchema)
  if (!isRecord(value)) return value

  const result = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "$schema" && key !== "default")
      .map(([key, child]) => [key, strictSchema(child)])
  ) as JsonSchema
  if (Array.isArray(result["oneOf"])) {
    result["anyOf"] = result["oneOf"]
    delete result["oneOf"]
  }
  const sourceProperties = value["properties"]
  if (isRecord(sourceProperties)) {
    const required = new Set(
      Array.isArray(value["required"])
        ? value["required"].filter(
            (item): item is string => typeof item === "string"
          )
        : []
    )
    result["properties"] = Object.fromEntries(
      Object.entries(sourceProperties).map(([key, child]) => {
        const normalized = strictSchema(child)
        if (!isRecord(normalized)) {
          throw new Error("Model property schema is invalid")
        }
        return [key, required.has(key) ? normalized : nullable(normalized)]
      })
    )
    result["required"] = Object.keys(sourceProperties)
    result["additionalProperties"] = false
  }
  return result
}

function branchMatches(value: unknown, schema: JsonSchema): boolean {
  if ("const" in schema) return value === schema["const"]
  if (Array.isArray(schema["enum"])) return schema["enum"].includes(value)
  const type = schema["type"]
  if (type === "null") return value === null
  if (type === "object") {
    if (!isRecord(value)) return false
    const properties = schema["properties"]
    if (!isRecord(properties)) return true
    return Object.entries(properties).every(([key, child]) => {
      if (!isRecord(child) || !("const" in child)) return true
      return value[key] === child["const"]
    })
  }
  if (type === "array") return Array.isArray(value)
  if (type === "string") return typeof value === "string"
  if (type === "number" || type === "integer") return typeof value === "number"
  if (type === "boolean") return typeof value === "boolean"
  return true
}

function normalizeValue(value: unknown, schema: JsonSchema): unknown {
  const union = schema["anyOf"] ?? schema["oneOf"]
  if (Array.isArray(union)) {
    const branch = union.find(
      (candidate) => isRecord(candidate) && branchMatches(value, candidate)
    )
    return isRecord(branch) ? normalizeValue(value, branch) : value
  }
  if (Array.isArray(value) && isRecord(schema["items"])) {
    return value.map((item) =>
      normalizeValue(item, schema["items"] as JsonSchema)
    )
  }
  if (!isRecord(value) || !isRecord(schema["properties"])) return value

  const required = new Set(
    Array.isArray(schema["required"])
      ? schema["required"].filter(
          (item): item is string => typeof item === "string"
        )
      : []
  )
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      const childSchema = (schema["properties"] as JsonSchema)[key]
      if (child === null && !required.has(key)) return []
      return [
        [
          key,
          isRecord(childSchema) ? normalizeValue(child, childSchema) : child,
        ],
      ]
    })
  )
}

export function normalizeModelJsonValue(
  schema: z.ZodType,
  value: unknown
): unknown {
  try {
    return normalizeValue(value, sourceJsonSchema(schema))
  } catch (error) {
    if (error instanceof ModelGatewayError) throw error
    throw new ModelGatewayError("invalid_request", false)
  }
}

export function createStrictModelJsonSchema(
  schema: z.ZodType,
  schemaName: string
): Record<string, unknown> {
  try {
    void schemaName
    const source = sourceJsonSchema(schema)
    const normalized = strictSchema(source)
    if (!isRecord(normalized) || normalized["type"] !== "object") {
      throw new Error("Strict model schemas require an object root")
    }
    assertModelSafeValue(normalized)
    if (JSON.stringify(normalized).length > 32_768) {
      throw new ModelGatewayError("limit_exceeded", false)
    }
    return normalized
  } catch (error) {
    if (error instanceof ModelGatewayError) throw error
    throw new ModelGatewayError("invalid_request", false)
  }
}
