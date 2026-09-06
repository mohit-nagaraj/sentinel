import postgres, { type Sql, type TransactionSql } from "postgres"

export type SqlParameter = null | boolean | number | string | Date | Uint8Array

export interface DatabaseExecutor {
  query<Row extends Record<string, unknown>>(
    statement: string,
    parameters?: readonly SqlParameter[]
  ): Promise<readonly Row[]>
}

export interface DatabaseClient extends DatabaseExecutor {
  transaction<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T>
  close(): Promise<void>
}

function createExecutor(sql: Sql | TransactionSql): DatabaseExecutor {
  return {
    query: async <Row extends Record<string, unknown>>(
      statement: string,
      parameters: readonly SqlParameter[] = []
    ) => {
      const rows = await sql.unsafe<Row[]>(statement, [...parameters])
      return rows
    },
  }
}

export interface PostgresDatabaseOptions {
  readonly maxConnections?: number
  readonly idleTimeoutSeconds?: number
  readonly connectTimeoutSeconds?: number
}

export function createPostgresDatabase(
  connectionString: string,
  options: PostgresDatabaseOptions = {}
): DatabaseClient {
  const sql = postgres(connectionString, {
    max: options.maxConnections ?? 5,
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    prepare: false,
  })
  const executor = createExecutor(sql)

  return {
    ...executor,
    transaction: async <T>(
      work: (transaction: DatabaseExecutor) => Promise<T>
    ) => {
      const result = await sql.begin(async (transactionSql) => ({
        value: await work(createExecutor(transactionSql)),
      }))
      return result.value
    },
    close: async () => sql.end({ timeout: 5 }),
  }
}
