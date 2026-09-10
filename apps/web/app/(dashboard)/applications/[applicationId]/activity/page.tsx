import { Activity, ArrowRight, Boxes, CircleDot } from "lucide-react"
import Link from "next/link"
import type { PublicRun } from "@sentinel/contracts"

import { isControlPlaneFixture } from "@/lib/operator-auth"
import { getActivityFixtureSnapshot } from "@/lib/run-activity-fixture"
import { getRunControlService } from "@/lib/run-control"
import { PrAssessmentSubmit } from "@/components/pr-assessment-submit"

export const dynamic = "force-dynamic"

function humanize(value: string) {
  return value
    .split("_")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ")
}

export default async function ApplicationActivityPage({
  params,
}: {
  readonly params: Promise<{ readonly applicationId: string }>
}) {
  const { applicationId } = await params
  let unavailable = false
  let runs: readonly PublicRun[] = []
  try {
    const page = isControlPlaneFixture(process.env)
      ? { items: [getActivityFixtureSnapshot().run] }
      : await getRunControlService().list({ applicationId, limit: 100 })
    runs = page.items.filter((run) => run.applicationId === applicationId)
  } catch {
    unavailable = true
  }
  const active = runs.filter((run) =>
    ["queued", "running", "interrupted", "cancelling"].includes(run.status)
  ).length
  return (
    <main className="min-h-full bg-background">
      <header className="border-b border-border px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              Operations
            </p>
            <h1 className="mt-1 text-xl font-semibold">Activity</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Runs, decisions, and specialist work for this application.
            </p>
          </div>
          <div className="flex gap-5 text-sm">
            <div>
              <p className="font-mono text-lg font-semibold">{runs.length}</p>
              <p className="text-xs text-muted-foreground">Recent runs</p>
            </div>
            <div>
              <p className="font-mono text-lg font-semibold">{active}</p>
              <p className="text-xs text-muted-foreground">Active</p>
            </div>
          </div>
        </div>
      </header>
      {unavailable ? (
        <div
          role="alert"
          className="border-b border-destructive/25 bg-destructive/5 px-6 py-3 text-sm text-destructive"
        >
          Run activity is currently unavailable.
        </div>
      ) : null}
      <PrAssessmentSubmit applicationId={applicationId} />
      <section
        aria-labelledby="runs-heading"
        className="mx-auto grid max-w-6xl gap-5 px-4 py-6 sm:px-6 lg:px-8"
      >
        <div className="flex items-center gap-2">
          <Activity className="size-4 text-primary" />
          <h2 id="runs-heading" className="text-sm font-semibold">
            Recent runs
          </h2>
        </div>
        {runs.length === 0 ? (
          <div className="grid min-h-52 place-items-center rounded-lg border border-dashed border-border bg-background p-6 text-center">
            <div>
              <Boxes className="mx-auto size-5 text-muted-foreground" />
              <p className="mt-2 text-sm font-medium">No runs yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Started runs will appear here.
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-background">
            <ul className="divide-y divide-border">
              {runs.map((run) => (
                <li key={run.id}>
                  <Link
                    href={`/applications/${applicationId}/activity/${run.id}`}
                    className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <CircleDot className="size-4 text-primary" />
                        <span className="truncate text-sm font-semibold">
                          {humanize(run.type)}
                        </span>
                      </div>
                      <p className="mt-1 font-mono text-[0.6875rem] text-muted-foreground">
                        {humanize(run.status)} / Attempt {run.attemptCount + 1}{" "}
                        / {run.createdAt.slice(0, 19).replace("T", " ")} UTC
                      </p>
                      {run.assessment === undefined ? null : (
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {run.assessment.repository.owner}/
                          {run.assessment.repository.name} PR #
                          {run.assessment.pullRequestNumber} / head{" "}
                          <span className="font-mono">
                            {run.assessment.headSha.slice(0, 12)}
                          </span>
                          {run.assessment.reportAvailable
                            ? " / report ready"
                            : " / report pending"}
                        </p>
                      )}
                    </div>
                    <ArrowRight className="size-4 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </main>
  )
}
