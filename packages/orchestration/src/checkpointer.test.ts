import { describe, expect, it } from "vitest"

import {
  CheckpointConfigurationError,
  LANGGRAPH_CHECKPOINT_SCHEMA,
  createPostgresCheckpointSaver,
} from "./checkpointer.ts"

describe("Postgres checkpoint configuration", () => {
  it("uses the fixed non-user-controlled checkpoint schema", async () => {
    const saver = createPostgresCheckpointSaver(
      "postgresql://postgres:example@127.0.0.1:5432/postgres"
    )
    expect(LANGGRAPH_CHECKPOINT_SCHEMA).toBe("langgraph_checkpoint")
    await saver.end()
  })

  it("rejects invalid connection strings without echoing them", () => {
    const value = "https://user:secret@example.com"
    let captured: unknown
    try {
      createPostgresCheckpointSaver(value)
    } catch (error) {
      captured = error
    }
    expect(captured).toBeInstanceOf(CheckpointConfigurationError)
    expect(String(captured)).not.toContain(value)
    expect(String(captured)).not.toContain("secret")
  })
})
