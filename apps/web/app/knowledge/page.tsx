import { redirect } from "next/navigation"

import { listOnboardingApplications } from "@/app/actions"

export const dynamic = "force-dynamic"

export default async function KnowledgePage() {
  const application = (await listOnboardingApplications())[0]
  redirect(
    application
      ? `/applications/${application.id}/knowledge`
      : "/applications/new/onboarding"
  )
}
