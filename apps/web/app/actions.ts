"use server"

import {
  databaseApplicationIdSchema,
  runControlBudgetSchema,
  type OnboardingActionState,
} from "@sentinel/contracts"
import { headers } from "next/headers"

import { getControlPlane } from "@/lib/control-plane"
import { isOperatorRequestAuthorized } from "@/lib/operator-auth"
import { getRunControlService } from "@/lib/run-control"

const initializationBudget = runControlBudgetSchema.parse({
  toolCalls: 200,
  contentBytes: 5_000_000,
  documentBytes: 25_000_000,
  documentPages: 1_000,
  documentSections: 5_000,
  sourceLines: 1_000_000,
  repositoryBytes: 1_000_000_000,
  repositoryFiles: 100_000,
  browserActions: 100,
  modelCalls: 100,
  modelInputTokens: 1_000_000,
  modelOutputTokens: 200_000,
  reconciliationRounds: 10,
  elapsedMs: 3_600_000,
})

async function authorizedControlPlane() {
  const requestHeaders = await headers()
  if (
    !isOperatorRequestAuthorized(
      requestHeaders.get("authorization"),
      process.env
    )
  ) {
    throw new Error("Control-plane request is unauthorized")
  }
  return getControlPlane()
}

export async function inspectOnboardingAction(
  _previousState: OnboardingActionState,
  formData: FormData
): Promise<OnboardingActionState> {
  return (await authorizedControlPlane()).inspect(formData)
}

export async function confirmOnboardingAction(
  _previousState: OnboardingActionState,
  formData: FormData
): Promise<OnboardingActionState> {
  return (await authorizedControlPlane()).confirm(formData)
}

export async function listOnboardingApplications() {
  return (await authorizedControlPlane()).listApplications()
}

export async function initializeKnowledgeAction(applicationIdInput: string) {
  const requestHeaders = await headers()
  if (
    !isOperatorRequestAuthorized(
      requestHeaders.get("authorization"),
      process.env
    )
  ) {
    throw new Error("Control-plane request is unauthorized")
  }
  const applicationId = databaseApplicationIdSchema.parse(applicationIdInput)
  const result = await getRunControlService().command({
    schemaVersion: 1,
    applicationId,
    type: "initialize_knowledge",
    idempotencyKey: `initialize_knowledge:${applicationId}`,
    budget: initializationBudget,
    payload: {},
  })
  return { runId: result.run.id }
}
