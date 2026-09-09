import { notFound } from "next/navigation"

import { listOnboardingApplications } from "@/app/actions"
import { ApplicationOnboarding } from "@/components/onboarding-control-plane"

export const dynamic = "force-dynamic"

export default async function ApplicationOnboardingPage({
  params,
}: {
  readonly params: Promise<{ readonly applicationId: string }>
}) {
  const { applicationId } = await params
  const application = (await listOnboardingApplications()).find(
    (item) => item.id === applicationId
  )
  if (application === undefined) notFound()
  return <ApplicationOnboarding initialApplication={application} />
}
