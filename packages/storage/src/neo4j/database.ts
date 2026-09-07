import {
  applicationIdSchema,
  reasonCodeSchema,
  runIdSchema,
} from "@sentinel/contracts"
import neo4j, {
  type Driver,
  type ManagedTransaction,
  type QueryResult,
  type Record as Neo4jRecord,
} from "neo4j-driver"
import { z } from "zod"

import type { Neo4jEnvironment } from "./environment.ts"

export type GraphParameter =
  | null
  | boolean
  | number
  | string
  | readonly GraphParameter[]
  | { readonly [key: string]: GraphParameter }

export interface GraphQueryResult {
  readonly records: readonly Neo4jRecord[]
}

export interface GraphTransaction {
  run(
    cypher: string,
    parameters?: Readonly<Record<string, GraphParameter>>
  ): Promise<GraphQueryResult>
}

export interface GraphTransactionContext {
  readonly applicationId?: string
  readonly runId?: string
  readonly operation: string
  readonly timeoutMs?: number
}

function parseTransactionContext(
  context: GraphTransactionContext,
  defaultTimeoutMs: number
): {
  readonly applicationId?: string
  readonly runId?: string
  readonly operation: string
  readonly timeoutMs: number
} {
  const applicationId =
    context.applicationId === undefined
      ? undefined
      : applicationIdSchema.safeParse(context.applicationId)
  const runId =
    context.runId === undefined
      ? undefined
      : runIdSchema.safeParse(context.runId)
  const operation = reasonCodeSchema.safeParse(context.operation)
  const timeoutMs = z
    .number()
    .int()
    .positive()
    .max(120_000)
    .safeParse(context.timeoutMs ?? defaultTimeoutMs)
  const invalidFields = [
    ...(applicationId !== undefined && !applicationId.success
      ? ["applicationId"]
      : []),
    ...(runId !== undefined && !runId.success ? ["runId"] : []),
    ...(!operation.success ? ["operation"] : []),
    ...(!timeoutMs.success ? ["timeoutMs"] : []),
  ]
  if (invalidFields.length > 0) {
    throw new Error(
      `Invalid Neo4j transaction context: ${invalidFields.join(", ")}`
    )
  }
  if (!operation.success || !timeoutMs.success) {
    throw new Error("Invalid Neo4j transaction context")
  }
  return {
    ...(applicationId?.success !== true
      ? {}
      : { applicationId: applicationId.data }),
    ...(runId?.success !== true ? {} : { runId: runId.data }),
    operation: operation.data,
    timeoutMs: timeoutMs.data,
  }
}

export interface GraphDatabase {
  read<T>(
    context: GraphTransactionContext,
    work: (transaction: GraphTransaction) => Promise<T>
  ): Promise<T>
  write<T>(
    context: GraphTransactionContext,
    work: (transaction: GraphTransaction) => Promise<T>
  ): Promise<T>
  health(): Promise<Neo4jHealthResult>
  close(): Promise<void>
}

export type Neo4jHealthResult =
  | {
      readonly status: "ok"
      readonly database: string
      readonly serverAgent: string
      readonly protocolVersion: string
    }
  | {
      readonly status: "error"
      readonly code: "neo4j_unavailable"
      readonly retryable: true
    }

function adaptTransaction(transaction: ManagedTransaction): GraphTransaction {
  return {
    run: async (cypher, parameters = {}) => {
      const result: QueryResult = await transaction.run(cypher, parameters)
      return { records: result.records }
    },
  }
}

export class Neo4jGraphDatabase implements GraphDatabase {
  constructor(
    private readonly driver: Driver,
    private readonly database: string,
    private readonly transactionTimeoutMs = 15_000
  ) {}

  private async execute<T>(
    mode: "read" | "write",
    context: GraphTransactionContext,
    work: (transaction: GraphTransaction) => Promise<T>
  ): Promise<T> {
    const parsedContext = parseTransactionContext(
      context,
      this.transactionTimeoutMs
    )
    const session = this.driver.session({ database: this.database })
    const configuration = {
      timeout: parsedContext.timeoutMs,
      metadata: {
        sentinel_application_id:
          parsedContext.applicationId ?? "not_applicable",
        sentinel_run_id: parsedContext.runId ?? "not_applicable",
        sentinel_operation: parsedContext.operation,
      },
    }
    try {
      const executor =
        mode === "read"
          ? session.executeRead.bind(session)
          : session.executeWrite.bind(session)
      return await executor(
        (transaction) => work(adaptTransaction(transaction)),
        configuration
      )
    } finally {
      await session.close()
    }
  }

  read<T>(
    context: GraphTransactionContext,
    work: (transaction: GraphTransaction) => Promise<T>
  ): Promise<T> {
    return this.execute("read", context, work)
  }

  write<T>(
    context: GraphTransactionContext,
    work: (transaction: GraphTransaction) => Promise<T>
  ): Promise<T> {
    return this.execute("write", context, work)
  }

  async health(): Promise<Neo4jHealthResult> {
    try {
      const info = await this.driver.getServerInfo({ database: this.database })
      return {
        status: "ok",
        database: this.database,
        serverAgent: info.agent ?? "unknown",
        protocolVersion: info.protocolVersion?.toString() ?? "unknown",
      }
    } catch {
      return { status: "error", code: "neo4j_unavailable", retryable: true }
    }
  }

  close(): Promise<void> {
    return this.driver.close()
  }
}

export function createNeo4jGraphDatabase(
  environment: Neo4jEnvironment
): Neo4jGraphDatabase {
  const driver = neo4j.driver(
    environment.NEO4J_URI,
    neo4j.auth.basic(environment.NEO4J_USERNAME, environment.NEO4J_PASSWORD),
    {
      connectionAcquisitionTimeout: 10_000,
      maxTransactionRetryTime: 15_000,
    }
  )
  return new Neo4jGraphDatabase(driver, environment.NEO4J_DATABASE)
}

let sharedDatabase: Neo4jGraphDatabase | undefined
let sharedEnvironment: Neo4jEnvironment | undefined

function isSameEnvironment(
  left: Neo4jEnvironment,
  right: Neo4jEnvironment
): boolean {
  return (
    left.NEO4J_URI === right.NEO4J_URI &&
    left.NEO4J_USERNAME === right.NEO4J_USERNAME &&
    left.NEO4J_PASSWORD === right.NEO4J_PASSWORD &&
    left.NEO4J_DATABASE === right.NEO4J_DATABASE
  )
}

export function getSharedNeo4jGraphDatabase(
  environment: Neo4jEnvironment
): Neo4jGraphDatabase {
  if (sharedDatabase === undefined) {
    sharedEnvironment = environment
    sharedDatabase = createNeo4jGraphDatabase(environment)
    return sharedDatabase
  }
  if (
    sharedEnvironment === undefined ||
    !isSameEnvironment(sharedEnvironment, environment)
  ) {
    throw new Error(
      "Shared Neo4j driver is already initialized with different configuration"
    )
  }
  return sharedDatabase
}

export async function closeSharedNeo4jGraphDatabase(): Promise<void> {
  const database = sharedDatabase
  sharedDatabase = undefined
  sharedEnvironment = undefined
  await database?.close()
}
