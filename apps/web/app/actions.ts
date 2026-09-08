"use server"

import type { OnboardingActionState } from "@sentinel/contracts"
import { headers } from "next/headers"

import { getControlPlane } from "@/lib/control-plane"
import { isOperatorRequestAuthorized } from "@/lib/operator-auth"

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
