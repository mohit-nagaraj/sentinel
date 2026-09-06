import { randomUUID } from "node:crypto"

import {
  createStableKey,
  stableKeyInputSchema,
  type MissionBudget,
} from "@sentinel/contracts"

export const operationalTestBudget: MissionBudget = {
  toolCalls: 10,
  contentBytes: 10_000,
  documentBytes: 10_000,
  documentPages: 10,
  documentSections: 100,
  sourceLines: 1_000,
  repositoryBytes: 1_000_000,
  repositoryFiles: 1_000,
  browserActions: 10,
  modelCalls: 10,
  modelInputTokens: 10_000,
  modelOutputTokens: 2_000,
  reconciliationRounds: 2,
  elapsedMs: 60_000,
}

export function createOperationalTestApplication(repositoryName: string) {
  const deploymentUrl = `https://${randomUUID()}.fixture.example.com`
  return {
    stableKey: createStableKey(
      stableKeyInputSchema.parse({
        kind: "application",
        deploymentUrl,
        repository: {
          host: "github.com",
          owner: "sentinel-integration",
          name: repositoryName,
        },
      })
    ),
    name: "Sentinel integration fixture",
    deploymentUrl,
    status: "ready" as const,
  }
}
