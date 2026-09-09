import {
  publicOnboardingApplicationSchema,
  type PublicOnboardingApplication,
} from "@sentinel/contracts"

import { listOnboardingApplications } from "@/app/actions"
import { DashboardShell } from "@/components/dashboard-shell"
import { KNOWLEDGE_FIXTURE_APPLICATION_ID } from "@/lib/knowledge-fixture"
import { isControlPlaneFixture } from "@/lib/operator-auth"
import { ACTIVITY_FIXTURE_APPLICATION_ID } from "@/lib/run-activity-fixture"

function fixtureApplication(
  id: string,
  name: string,
  status: "ready" | "stale"
): PublicOnboardingApplication {
  return publicOnboardingApplicationSchema.parse({
    id,
    name,
    deploymentUrl: "https://events.example.test/",
    status,
    graphRevision: 4,
    knowledgeStale: status === "stale",
    configuration: {
      repository: {
        url: "https://github.com/example/events",
        ref: "main",
        accessMode: "manual",
      },
      documentationSources: ["https://docs.example.test/"],
      authentication: {
        method: "none",
        configuredFields: [],
        revision: 0,
        automationConfirmed: true,
      },
      crawl: {
        allowedHosts: ["events.example.test"],
        maxActions: 40,
        maxScreens: 20,
        maxDurationSeconds: 300,
        allowFormSubmission: false,
        denyDestructiveActions: true,
        denyRealPayments: true,
        denyExternalMessaging: true,
        denyPrivilegeChanges: true,
      },
      capabilityHints: [],
    },
    confirmed: true,
    completedThrough: "review",
    updatedAt: "2026-09-09T02:12:00.000Z",
  })
}

export default async function DashboardLayout({
  children,
}: {
  readonly children: React.ReactNode
}) {
  let applications: readonly PublicOnboardingApplication[] = []
  try {
    applications = [...(await listOnboardingApplications())]
  } catch {
    // Individual pages render their own configuration errors.
  }
  if (isControlPlaneFixture(process.env)) {
    const fixtures = [
      fixtureApplication(
        KNOWLEDGE_FIXTURE_APPLICATION_ID,
        "Hi.Events checkout",
        "stale"
      ),
      fixtureApplication(
        ACTIVITY_FIXTURE_APPLICATION_ID,
        "Frontend Systems Workshop",
        "ready"
      ),
    ]
    applications = [
      ...fixtures,
      ...applications.filter(
        (application) =>
          !fixtures.some((fixture) => fixture.id === application.id)
      ),
    ]
  }
  return <DashboardShell applications={applications}>{children}</DashboardShell>
}
