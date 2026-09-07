import type { PublicOnboardingApplication } from "@sentinel/contracts"

import { listOnboardingApplications } from "@/app/actions"
import { OnboardingControlPlane } from "@/components/onboarding-control-plane"

export const dynamic = "force-dynamic"

export default async function Page() {
  let applications: readonly PublicOnboardingApplication[] = []
  let configurationUnavailable = false
  try {
    applications = await listOnboardingApplications()
  } catch {
    configurationUnavailable = true
  }
  return (
    <OnboardingControlPlane
      initialApplications={applications}
      configurationUnavailable={configurationUnavailable}
    />
  )
}
