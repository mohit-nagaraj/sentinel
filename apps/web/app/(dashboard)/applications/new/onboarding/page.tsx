import { ApplicationOnboarding } from "@/components/onboarding-control-plane"

export const dynamic = "force-dynamic"

export default function NewApplicationPage() {
  return <ApplicationOnboarding initialApplication={null} />
}
