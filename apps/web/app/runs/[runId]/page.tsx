import { notFound } from "next/navigation"

import { databaseRunIdSchema } from "@sentinel/contracts"

import { RunActivityWorkspace } from "@/components/run-activity-workspace"
import { isControlPlaneFixture } from "@/lib/operator-auth"
import {
  ACTIVITY_FIXTURE_RUN_ID,
  getActivityFixtureSnapshot,
} from "@/lib/run-activity-fixture"
import { getRunControlService } from "@/lib/run-control"

export const dynamic = "force-dynamic"

type Props = { readonly params: Promise<{ readonly runId: string }> }

function UnavailableRunActivity() {
  return (
    <main className="grid min-h-svh place-items-center bg-background px-6 text-foreground">
      <div
        role="alert"
        className="w-full max-w-xl border-l-2 border-destructive bg-destructive/5 px-5 py-4"
      >
        <h1 className="text-sm font-semibold">Run activity unavailable</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The server could not load this run. Check control-plane storage and
          realtime configuration, then reload.
        </p>
      </div>
    </main>
  )
}

export default async function RunActivityPage({ params }: Props) {
  const parsedRunId = databaseRunIdSchema.safeParse((await params).runId)
  if (!parsedRunId.success) notFound()

  if (isControlPlaneFixture(process.env)) {
    if (parsedRunId.data !== ACTIVITY_FIXTURE_RUN_ID) notFound()
    const snapshot = getActivityFixtureSnapshot()
    return (
      <RunActivityWorkspace
        initialRun={snapshot.run}
        initialEventPage={snapshot.eventPage}
        initialInterrupt={snapshot.interrupt}
        transport="fixture-poll"
      />
    )
  }

  let service: ReturnType<typeof getRunControlService>
  try {
    service = getRunControlService()
  } catch {
    return <UnavailableRunActivity />
  }
  let run
  try {
    run = await service.get(parsedRunId.data)
  } catch {
    return <UnavailableRunActivity />
  }
  if (run === null) notFound()
  const activity = await Promise.all([
    service.events({ runId: run.id, after: 0, limit: 100 }),
    service.pendingInterrupt(run.id),
  ]).catch(() => null)
  if (activity === null) return <UnavailableRunActivity />
  const [eventPage, interrupt] = activity
  if (eventPage === null) notFound()
  return (
    <RunActivityWorkspace
      initialRun={run}
      initialEventPage={{ schemaVersion: 1, ...eventPage }}
      initialInterrupt={interrupt}
    />
  )
}
