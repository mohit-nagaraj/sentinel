import { redirect } from "next/navigation"

import { listOnboardingApplications } from "@/app/actions"

export const dynamic = "force-dynamic"

export default async function Page() {
  const applications = await listOnboardingApplications().catch(() => [])
  const application = applications[0]
  redirect(
    application
      ? `/applications/${application.id}/onboarding`
      : "/applications/new/onboarding"
  )
}
