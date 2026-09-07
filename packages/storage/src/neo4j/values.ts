import neo4j from "neo4j-driver"

export type NativeGraphValue =
  | null
  | boolean
  | number
  | string
  | readonly NativeGraphValue[]
  | { readonly [key: string]: NativeGraphValue }

export function toNativeGraphValue(value: unknown): NativeGraphValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value
  }
  if (typeof value === "number") return value
  if (neo4j.isInt(value)) {
    return value.inSafeRange() ? value.toNumber() : value.toString()
  }
  if (Array.isArray(value)) return value.map(toNativeGraphValue)
  if (typeof value === "object") {
    if (neo4j.isNode(value) || neo4j.isRelationship(value)) {
      return toNativeGraphValue(value.properties)
    }
    if (
      "toString" in value &&
      typeof value.toString === "function" &&
      value.constructor !== Object
    ) {
      return value.toString()
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        toNativeGraphValue(child),
      ])
    )
  }
  throw new TypeError(`Unsupported Neo4j value type: ${typeof value}`)
}
