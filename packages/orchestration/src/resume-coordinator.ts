import { reasonCodeSchema, runIdSchema } from "@sentinel/contracts"
import { Pool } from "pg"

import { parseCheckpointConnectionString } from "./checkpointer.ts"
import type { ResumeCoordinator } from "./runtime.ts"

export class ResumeCoordinationError extends Error {
  constructor() {
    super("Resume coordination failed")
    this.name = "ResumeCoordinationError"
  }
}

function lockKey(input: {
  readonly runId: string
  readonly decisionId: string
}) {
  return `${runIdSchema.parse(input.runId)}:${reasonCodeSchema.parse(input.decisionId)}`
}

export class InMemoryResumeCoordinator implements ResumeCoordinator {
  private readonly tails = new Map<string, Promise<void>>()

  async runExclusive<Output>(
    input: { readonly runId: string; readonly decisionId: string },
    work: () => Promise<Output>
  ): Promise<Output> {
    const key = lockKey(input)
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => gate)
    this.tails.set(key, tail)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

export class PostgresResumeCoordinator implements ResumeCoordinator {
  private readonly pool: Pool

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString: parseCheckpointConnectionString(connectionString),
      max: 2,
    })
  }

  async runExclusive<Output>(
    input: { readonly runId: string; readonly decisionId: string },
    work: () => Promise<Output>
  ): Promise<Output> {
    let client
    try {
      client = await this.pool.connect()
      await client.query("begin")
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [lockKey(input)]
      )
    } catch {
      if (client !== undefined) {
        await client.query("rollback").catch(() => undefined)
        client.release()
      }
      throw new ResumeCoordinationError()
    }
    try {
      const result = await work()
      try {
        await client.query("commit")
      } catch {
        throw new ResumeCoordinationError()
      }
      return result
    } catch (error) {
      await client.query("rollback").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  close(): Promise<void> {
    return this.pool.end()
  }
}
