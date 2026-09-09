import {
  applicationIdSchema,
  entityKindSchema,
  evidenceIdSchema,
  hashCanonical,
  persistedTextSchema,
  runIdSchema,
  stableEntityIdSchema,
  type EntityKind,
  type ApplicationId,
} from "@sentinel/contracts"
import { z } from "zod"

import type { GraphDatabase, GraphTransaction } from "./database.ts"
import {
  constraintStatements,
  legacyConstraintDropStatements,
  legacyRelationshipConstraintDropStatements,
  nodeRevisionIndexStatements,
  relationshipConstraintStatements,
  relationshipEndpointKinds,
  relationshipRevisionIndexStatements,
  resolveNodeLabel,
  resolveRelationshipType,
} from "./schema.ts"
import { toNativeGraphValue, type NativeGraphValue } from "./values.ts"

const graphRevisionSchema = z.number().int().nonnegative()
const propertyKeySchema = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9_]*$/)
const reservedNodeProperties = new Set([
  "application_id",
  "stable_key",
  "graph_revision",
  "entity_kind",
  "publication_hash",
  "publication_status",
  "created_at",
  "updated_at",
])
const sensitivePropertySegments = new Set([
  "auth",
  "authorization",
  "cookie",
  "credential",
  "password",
  "secret",
  "session",
  "sid",
  "signature",
  "token",
])
const sensitiveNormalizedProperties = new Set([
  "accesskey",
  "accesskeyid",
  "accesstoken",
  "apikey",
  "clientsecret",
  "connectsid",
  "idtoken",
  "oauthtoken",
  "phpsessid",
  "privatekey",
  "refreshtoken",
  "sessionid",
  "xamzsignature",
  "xgoogsignature",
])

function isSensitivePropertyKey(key: string): boolean {
  const segments = key.split("_")
  const normalized = segments.join("")
  const hasSensitiveKeyPair = segments.some(
    (segment, index) =>
      ["access", "api", "private"].includes(segment) &&
      segments[index + 1] === "key"
  )
  return (
    segments.some((segment) => sensitivePropertySegments.has(segment)) ||
    hasSensitiveKeyPair ||
    sensitiveNormalizedProperties.has(normalized) ||
    /(?:accesskey|apikey|clientsecret|privatekey|sessionid)$/.test(normalized)
  )
}

function parseOptionalRunId(input: string | undefined): string | undefined {
  if (input === undefined) return undefined
  const result = runIdSchema.safeParse(input)
  if (!result.success) throw new Error("Invalid graph run identifier")
  return result.data
}

function isNativeGraphRecord(
  value: NativeGraphValue
): value is Readonly<Record<string, NativeGraphValue>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export type GraphPropertyValue =
  null | boolean | number | string | readonly (boolean | number | string)[]
export type GraphProperties = Readonly<Record<string, GraphPropertyValue>>

export function parseGraphProperties(input: GraphProperties): GraphProperties {
  if (Object.keys(input).length > 128) {
    throw new Error("Graph facts are limited to 128 properties")
  }
  const output: Record<string, GraphPropertyValue> = {}
  for (const [key, value] of Object.entries(input)) {
    propertyKeySchema.parse(key)
    if (isSensitivePropertyKey(key)) {
      throw new Error("Graph properties cannot contain sensitive fields")
    }
    if (reservedNodeProperties.has(key)) {
      throw new Error(`Graph property ${key} is reserved`)
    }
    if (
      value !== null &&
      typeof value !== "boolean" &&
      typeof value !== "number" &&
      typeof value !== "string" &&
      !Array.isArray(value)
    ) {
      throw new Error(`Graph property ${key} has an unsupported value`)
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Graph property ${key} must be finite`)
    }
    if (typeof value === "string") {
      const result = persistedTextSchema.safeParse(value)
      if (!result.success) {
        throw new Error("Graph properties contain unsafe persisted text")
      }
      output[key] = result.data
      continue
    }
    if (Array.isArray(value)) {
      if (
        value.length > 256 ||
        value.some(
          (item) => !["boolean", "number", "string"].includes(typeof item)
        ) ||
        value.some(
          (item) => typeof item === "number" && !Number.isFinite(item)
        ) ||
        new Set(value.map((item) => typeof item)).size > 1
      ) {
        throw new Error(`Graph property ${key} has an unsupported array`)
      }
      if (value.every((item): item is string => typeof item === "string")) {
        const parsed: string[] = []
        for (const item of value) {
          const result = persistedTextSchema.safeParse(item)
          if (!result.success) {
            throw new Error("Graph properties contain unsafe persisted text")
          }
          parsed.push(result.data)
        }
        output[key] = parsed
        continue
      }
    }
    output[key] = value
  }
  if (new TextEncoder().encode(JSON.stringify(output)).byteLength > 65_536) {
    throw new Error("Graph properties exceed the 64 KiB persistence limit")
  }
  return output
}

export interface GraphNodeFact {
  readonly applicationId: string
  readonly kind: EntityKind
  readonly stableKey: string
  readonly graphRevision: number
  readonly properties: GraphProperties
}

export interface GraphRelationshipFact {
  readonly applicationId: string
  readonly stableKey: string
  readonly type: string
  readonly fromStableKey: string
  readonly toStableKey: string
  readonly graphRevision: number
  readonly properties: GraphProperties
}

function parseNodeFact(input: GraphNodeFact) {
  const applicationId = applicationIdSchema.parse(input.applicationId)
  const kind = entityKindSchema.parse(input.kind)
  const stableKey = stableEntityIdSchema.parse(input.stableKey)
  if (!stableKey.startsWith(`${kind}:v1:`)) {
    throw new Error(`Stable key does not match node kind ${kind}`)
  }
  if (kind === "application" && String(stableKey) !== String(applicationId)) {
    throw new Error("Application root stable key must equal its namespace")
  }
  return {
    applicationId,
    kind,
    stableKey,
    graphRevision: graphRevisionSchema.parse(input.graphRevision),
    properties: parseGraphProperties(input.properties),
  }
}

function nodeMergeStatement(kind: EntityKind): string {
  const label = resolveNodeLabel(kind)
  return `OPTIONAL MATCH (newer:${label} {
  application_id: $applicationId,
  stable_key: $stableKey
})
WHERE newer.graph_revision > $graphRevision
WITH count(newer) AS newerCount
WHERE newerCount = 0
MERGE (n:${label} {
  application_id: $applicationId,
  stable_key: $stableKey,
  graph_revision: $graphRevision
})
ON CREATE SET n.created_at = datetime()
SET n += $properties,
    n.updated_at = datetime()
RETURN n`
}

function relationshipMergeStatement(typeInput: unknown): string {
  const type = resolveRelationshipType(typeInput)
  return `OPTIONAL MATCH ()-[newer:${type} {
  application_id: $applicationId,
  stable_key: $stableKey
}]-()
WHERE newer.graph_revision > $graphRevision
WITH count(newer) AS newerCount
WHERE newerCount = 0
MATCH (from {
  application_id: $applicationId,
  stable_key: $fromStableKey,
  graph_revision: $graphRevision
})
MATCH (to {
  application_id: $applicationId,
  stable_key: $toStableKey,
  graph_revision: $graphRevision
})
MERGE (from)-[r:${type} {
  application_id: $applicationId,
  stable_key: $stableKey,
  graph_revision: $graphRevision
}]->(to)
ON CREATE SET r.created_at = datetime()
SET r += $properties,
    r.updated_at = datetime()
RETURN r`
}

export class Neo4jFactRepository {
  constructor(private readonly database: GraphDatabase) {}

  async bootstrap(): Promise<void> {
    await this.database.write(
      { operation: "bootstrap_graph_schema" },
      async (transaction) => {
        for (const statement of [
          ...legacyRelationshipConstraintDropStatements,
          ...legacyConstraintDropStatements,
          ...constraintStatements,
          ...relationshipConstraintStatements,
          ...nodeRevisionIndexStatements,
          ...relationshipRevisionIndexStatements,
        ]) {
          await transaction.run(statement)
        }
      }
    )
  }

  async mergeNode(input: GraphNodeFact, runId?: string): Promise<void> {
    const fact = parseNodeFact(input)
    const parsedRunId = parseOptionalRunId(runId)
    await this.database.write(
      {
        applicationId: fact.applicationId,
        ...(parsedRunId === undefined ? {} : { runId: parsedRunId }),
        operation: "merge_graph_node",
      },
      (transaction) => this.mergeNodeInTransaction(transaction, fact)
    )
  }

  private async mergeNodeInTransaction(
    transaction: GraphTransaction,
    factInput: GraphNodeFact
  ): Promise<void> {
    const fact = parseNodeFact(factInput)
    const result = await transaction.run(nodeMergeStatement(fact.kind), {
      applicationId: fact.applicationId,
      stableKey: fact.stableKey,
      graphRevision: fact.graphRevision,
      properties: fact.properties,
    })
    if (result.records.length !== 1) {
      throw new Error("Neo4j node merge rejected a stale graph revision")
    }
  }

  async mergeRelationship(
    input: GraphRelationshipFact,
    runId?: string
  ): Promise<void> {
    const applicationId = applicationIdSchema.parse(input.applicationId)
    const stableKey = evidenceIdSchema.parse(input.stableKey)
    const fromStableKey = stableEntityIdSchema.parse(input.fromStableKey)
    const toStableKey = stableEntityIdSchema.parse(input.toStableKey)
    const type = resolveRelationshipType(input.type)
    const endpoints = relationshipEndpointKinds[type]
    if (
      !endpoints.from.some((kind) => fromStableKey.startsWith(`${kind}:v1:`))
    ) {
      throw new Error(`Relationship ${type} has an invalid source kind`)
    }
    if (!endpoints.to.some((kind) => toStableKey.startsWith(`${kind}:v1:`))) {
      throw new Error(`Relationship ${type} has an invalid target kind`)
    }
    const graphRevision = graphRevisionSchema.parse(input.graphRevision)
    const properties = parseGraphProperties(input.properties)
    const parsedRunId = parseOptionalRunId(runId)
    await this.database.write(
      {
        applicationId,
        ...(parsedRunId === undefined ? {} : { runId: parsedRunId }),
        operation: "merge_graph_relationship",
      },
      async (transaction) => {
        const result = await transaction.run(relationshipMergeStatement(type), {
          applicationId,
          stableKey,
          fromStableKey,
          toStableKey,
          graphRevision,
          properties,
        })
        if (result.records.length !== 1) {
          throw new Error(
            "Neo4j relationship merge endpoints were not found or graph revision is stale"
          )
        }
      }
    )
  }

  async mergeNodesAtomically(
    inputs: readonly GraphNodeFact[],
    context: { readonly applicationId: string; readonly runId?: string }
  ): Promise<void> {
    const applicationId = applicationIdSchema.parse(context.applicationId)
    const runId = parseOptionalRunId(context.runId)
    const facts = inputs.map(parseNodeFact)
    if (facts.some((fact) => fact.applicationId !== applicationId)) {
      throw new Error("Atomic graph writes cannot cross application namespaces")
    }
    await this.database.write(
      {
        applicationId,
        ...(runId === undefined ? {} : { runId }),
        operation: "merge_graph_nodes_atomically",
      },
      async (transaction) => {
        for (const fact of facts) {
          await this.mergeNodeInTransaction(transaction, fact)
        }
      }
    )
  }

  async readNode(
    applicationIdInput: string,
    stableKeyInput: string
  ): Promise<Readonly<Record<string, NativeGraphValue>> | null> {
    const applicationId = applicationIdSchema.parse(applicationIdInput)
    const stableKey = stableEntityIdSchema.parse(stableKeyInput)
    return this.database.read(
      { applicationId, operation: "read_graph_node" },
      async (transaction) => {
        const result = await transaction.run(
          `MATCH (n {application_id: $applicationId, stable_key: $stableKey})
           RETURN n ORDER BY n.graph_revision DESC LIMIT 1`,
          { applicationId, stableKey }
        )
        const record = result.records[0]
        if (record === undefined) return null
        const value = toNativeGraphValue(record.get("n"))
        if (!isNativeGraphRecord(value)) {
          throw new Error("Neo4j node mapping returned an invalid value")
        }
        return value
      }
    )
  }

  async cleanupTestNamespace(
    applicationIdInput: string,
    testPrefixInput: string
  ): Promise<number> {
    const applicationId = applicationIdSchema.parse(applicationIdInput)
    const testPrefix = z
      .string()
      .regex(/^sentinel-test-[a-f0-9]{8,32}$/)
      .parse(testPrefixInput)
    const expectedApplicationId =
      createTestGraphNamespace(testPrefix).applicationId
    if (String(applicationId) !== String(expectedApplicationId)) {
      throw new Error("Test graph namespace identity does not match its prefix")
    }
    return this.database.write(
      { applicationId, operation: "cleanup_test_graph_namespace" },
      async (transaction) => {
        const result = await transaction.run(
          `MATCH (root:Application {
             application_id: $applicationId,
             stable_key: $applicationId,
             test_namespace: $testPrefix
           })
           WITH root
           MATCH (n {application_id: $applicationId})
           WITH n
           DETACH DELETE n
           RETURN count(n) AS deletedCount`,
          { applicationId, testPrefix }
        )
        const record = result.records[0]
        if (record === undefined) return 0
        const count = toNativeGraphValue(record.get("deletedCount"))
        return typeof count === "number" ? count : Number(count)
      }
    )
  }
}

export function createTestGraphNamespace(
  testPrefixInput: string,
  graphRevisionInput = 1
): {
  readonly applicationId: ApplicationId
  readonly graphRevision: number
  readonly testPrefix: string
} {
  const testPrefix = z
    .string()
    .regex(/^sentinel-test-[a-f0-9]{8,32}$/)
    .parse(testPrefixInput)
  const digest = hashCanonical({
    kind: "neo4j-test-application",
    testPrefix,
  }).slice("sha256:".length)
  return {
    applicationId: applicationIdSchema.parse(`application:v1:${digest}`),
    graphRevision: graphRevisionSchema.parse(graphRevisionInput),
    testPrefix,
  }
}

export function createGraphRevisionNamespace(
  applicationIdInput: string,
  graphRevisionInput: number
): {
  readonly applicationId: ApplicationId
  readonly graphRevision: number
} {
  return {
    applicationId: applicationIdSchema.parse(applicationIdInput),
    graphRevision: graphRevisionSchema.parse(graphRevisionInput),
  }
}
