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

export default async function ApplicationRunPage({
  params,
}: {
  readonly params: Promise<{
    readonly applicationId: string
    readonly runId: string
  }>
}) {
  const { applicationId, runId: rawRunId } = await params
  const runId = databaseRunIdSchema.safeParse(rawRunId)
  if (!runId.success) notFound()
  if (isControlPlaneFixture(process.env)) {
    const snapshot = getActivityFixtureSnapshot()
    if (
      runId.data !== ACTIVITY_FIXTURE_RUN_ID ||
      snapshot.run.applicationId !== applicationId
    )
      notFound()
    return (
      <RunActivityWorkspace
        initialRun={snapshot.run}
        initialEventPage={snapshot.eventPage}
        initialInterrupt={snapshot.interrupt}
        transport="fixture-poll"
      />
    )
  }
  const service = getRunControlService()
  const run = await service.get(runId.data)
  if (run === null || run.applicationId !== applicationId) notFound()
  const [eventPage, initialInterrupt] = await Promise.all([
    service.events({ runId: run.id, after: 0, limit: 100 }),
    service.pendingInterrupt(run.id),
  ])
  if (eventPage === null) notFound()
  return (
    <RunActivityWorkspace
      initialRun={run}
      initialEventPage={{ schemaVersion: 1, ...eventPage }}
      initialInterrupt={initialInterrupt}
    />
  )
}
