import {
  applicationIdSchema,
  entityKindSchema,
  evidenceIdSchema,
  hashCanonical,
  stableEntityIdSchema,
  type EntityKind,
  type ApplicationId,
} from "@sentinel/contracts"
import { z } from "zod"

import type { GraphDatabase, GraphTransaction } from "./database.ts"
import {
  constraintStatements,
  relationshipConstraintStatements,
  relationshipEndpointKinds,
  resolveNodeLabel,
  resolveRelationshipType,
} from "./schema.ts"
import { toNativeGraphValue, type NativeGraphValue } from "./values.ts"

const graphRevisionSchema = z.number().int().nonnegative()
const propertyKeySchema = z.string().regex(/^[a-z][a-z0-9_]*$/)
const reservedNodeProperties = new Set([
  "application_id",
  "stable_key",
  "graph_revision",
  "created_at",
  "updated_at",
])

function isNativeGraphRecord(
  value: NativeGraphValue
): value is Readonly<Record<string, NativeGraphValue>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export type GraphPropertyValue =
  null | boolean | number | string | readonly (boolean | number | string)[]
export type GraphProperties = Readonly<Record<string, GraphPropertyValue>>

function parseProperties(input: GraphProperties): GraphProperties {
  const output: Record<string, GraphPropertyValue> = {}
  for (const [key, value] of Object.entries(input)) {
    propertyKeySchema.parse(key)
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
    if (
      Array.isArray(value) &&
      (value.some(
        (item) => !["boolean", "number", "string"].includes(typeof item)
      ) ||
        value.some(
          (item) => typeof item === "number" && !Number.isFinite(item)
        ) ||
        new Set(value.map((item) => typeof item)).size > 1)
    ) {
      throw new Error(`Graph property ${key} has an unsupported array`)
    }
    output[key] = value
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
    properties: parseProperties(input.properties),
  }
}

function nodeMergeStatement(kind: EntityKind): string {
  const label = resolveNodeLabel(kind)
  return `MERGE (n:${label} {application_id: $applicationId, stable_key: $stableKey})
ON CREATE SET n.created_at = datetime()
SET n += $properties,
    n.graph_revision = $graphRevision,
    n.updated_at = datetime()
RETURN n`
}

function relationshipMergeStatement(typeInput: unknown): string {
  const type = resolveRelationshipType(typeInput)
  return `MATCH (from {application_id: $applicationId, stable_key: $fromStableKey})
MATCH (to {application_id: $applicationId, stable_key: $toStableKey})
MERGE (from)-[r:${type} {application_id: $applicationId, stable_key: $stableKey}]->(to)
ON CREATE SET r.created_at = datetime()
SET r += $properties,
    r.graph_revision = $graphRevision,
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
          ...constraintStatements,
          ...relationshipConstraintStatements,
        ]) {
          await transaction.run(statement)
        }
      }
    )
  }

  async mergeNode(input: GraphNodeFact, runId?: string): Promise<void> {
    const fact = parseNodeFact(input)
    await this.database.write(
      {
        applicationId: fact.applicationId,
        ...(runId === undefined ? {} : { runId }),
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
      throw new Error("Neo4j node merge returned no record")
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
    const properties = parseProperties(input.properties)
    await this.database.write(
      {
        applicationId,
        ...(runId === undefined ? {} : { runId }),
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
          throw new Error("Neo4j relationship merge endpoints were not found")
        }
      }
    )
  }

  async mergeNodesAtomically(
    inputs: readonly GraphNodeFact[],
    context: { readonly applicationId: string; readonly runId?: string }
  ): Promise<void> {
    const applicationId = applicationIdSchema.parse(context.applicationId)
    const facts = inputs.map(parseNodeFact)
    if (facts.some((fact) => fact.applicationId !== applicationId)) {
      throw new Error("Atomic graph writes cannot cross application namespaces")
    }
    await this.database.write(
      {
        applicationId,
        ...(context.runId === undefined ? {} : { runId: context.runId }),
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
           RETURN n LIMIT 1`,
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
