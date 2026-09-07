import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import { z } from "zod"

export const LANGGRAPH_CHECKPOINT_SCHEMA = "langgraph_checkpoint" as const

export class CheckpointConfigurationError extends Error {
  constructor() {
    super("Invalid LangGraph checkpoint configuration: connectionString")
    this.name = "CheckpointConfigurationError"
  }
}

export function createPostgresCheckpointSaver(
  connectionStringInput: string
): PostgresSaver {
  const parsed = z.string().min(1).max(4_096).safeParse(connectionStringInput)
  if (!parsed.success) throw new CheckpointConfigurationError()
  let url: URL
  try {
    url = new URL(parsed.data)
  } catch {
    throw new CheckpointConfigurationError()
  }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) {
    throw new CheckpointConfigurationError()
  }
  return PostgresSaver.fromConnString(parsed.data, {
    schema: LANGGRAPH_CHECKPOINT_SCHEMA,
  })
}

export async function initializePostgresCheckpointSaver(
  connectionString: string
): Promise<PostgresSaver> {
  const saver = createPostgresCheckpointSaver(connectionString)
  try {
    await saver.setup()
    return saver
  } catch (error) {
    await saver.end()
    throw error
  }
}
