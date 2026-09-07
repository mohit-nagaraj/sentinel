import type {
  Driver,
  ManagedTransaction,
  QueryResult,
  Session,
} from "neo4j-driver"
import { describe, expect, it, vi } from "vitest"

import { Neo4jGraphDatabase } from "./database.ts"

function createDriver(options?: { readonly healthError?: Error }) {
  const run = vi.fn(async (): Promise<QueryResult> => {
    return { records: [] } as unknown as QueryResult
  })
  const transaction = { run } as unknown as ManagedTransaction
  const executeRead = vi.fn(
    async <T>(
      work: (transaction: ManagedTransaction) => Promise<T>,
      configuration?: unknown
    ): Promise<T> => {
      void configuration
      return work(transaction)
    }
  )
  const executeWrite = vi.fn(
    async <T>(
      work: (transaction: ManagedTransaction) => Promise<T>,
      configuration?: unknown
    ): Promise<T> => {
      void configuration
      return work(transaction)
    }
  )
  const closeSession = vi.fn(async () => undefined)
  const session = {
    executeRead,
    executeWrite,
    close: closeSession,
  } as unknown as Session
  const closeDriver = vi.fn(async () => undefined)
  const driver = {
    session: vi.fn(() => session),
    getServerInfo: options?.healthError
      ? vi.fn(async () => Promise.reject(options.healthError))
      : vi.fn(async () => ({
          agent: "Neo4j/2026.01",
          protocolVersion: { toString: () => "5.8" },
        })),
    close: closeDriver,
  } as unknown as Driver

  return {
    driver,
    run,
    executeRead,
    executeWrite,
    closeSession,
    closeDriver,
  }
}

describe("Neo4j database boundary", () => {
  it("uses managed transactions with operation metadata", async () => {
    const fake = createDriver()
    const database = new Neo4jGraphDatabase(fake.driver, "neo4j", 12_000)

    await database.write(
      {
        applicationId: "application:v1:abc",
        runId: "run:123",
        operation: "merge_node",
      },
      async (transaction) => transaction.run("RETURN $value", { value: 7 })
    )

    expect(fake.executeWrite).toHaveBeenCalledOnce()
    expect(fake.executeRead).not.toHaveBeenCalled()
    expect(fake.executeWrite.mock.calls[0]?.[1]).toEqual({
      timeout: 12_000,
      metadata: {
        sentinel_application_id: "application:v1:abc",
        sentinel_run_id: "run:123",
        sentinel_operation: "merge_node",
      },
    })
    expect(fake.run).toHaveBeenCalledWith("RETURN $value", { value: 7 })
    expect(fake.closeSession).toHaveBeenCalledOnce()
  })

  it("closes sessions after transaction failures", async () => {
    const fake = createDriver()
    fake.executeRead.mockRejectedValueOnce(new Error("read failed"))
    const database = new Neo4jGraphDatabase(fake.driver, "neo4j")

    await expect(
      database.read({ operation: "read_node" }, async () => undefined)
    ).rejects.toThrow("read failed")
    expect(fake.closeSession).toHaveBeenCalledOnce()
  })

  it("returns sanitized health failures and closes the driver", async () => {
    const secret = "credential-must-not-escape"
    const fake = createDriver({ healthError: new Error(secret) })
    const database = new Neo4jGraphDatabase(fake.driver, "neo4j")

    const health = await database.health()
    expect(health).toEqual({
      status: "error",
      code: "neo4j_unavailable",
      retryable: true,
    })
    expect(JSON.stringify(health)).not.toContain(secret)
    await database.close()
    expect(fake.closeDriver).toHaveBeenCalledOnce()
  })
})
