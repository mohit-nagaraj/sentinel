"use server"

import type { OnboardingActionState } from "@sentinel/contracts"

import {
  getControlPlane,
  initialOnboardingActionState,
} from "@/lib/control-plane"

export async function inspectOnboardingAction(
  _previousState: OnboardingActionState,
  formData: FormData
): Promise<OnboardingActionState> {
  return getControlPlane().inspect(formData)
}

export async function confirmOnboardingAction(
  _previousState: OnboardingActionState,
  formData: FormData
): Promise<OnboardingActionState> {
  return getControlPlane().confirm(formData)
}

export async function listOnboardingApplications() {
  return getControlPlane().listApplications()
}

export async function initialOnboardingState() {
  return initialOnboardingActionState
}
