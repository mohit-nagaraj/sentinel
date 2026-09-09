import { Activity, ArrowRight, Boxes, CircleDot } from "lucide-react"
import Link from "next/link"

import type { PublicRun } from "@sentinel/contracts"

import { isControlPlaneFixture } from "@/lib/operator-auth"
import { getActivityFixtureSnapshot } from "@/lib/run-activity-fixture"
import { getRunControlService } from "@/lib/run-control"

export const dynamic = "force-dynamic"

function humanize(value: string): string {
  return value
    .split("_")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ")
}

async function loadRuns(): Promise<{
  readonly runs: readonly PublicRun[]
  readonly unavailable: boolean
}> {
  if (isControlPlaneFixture(process.env)) {
    return { runs: [getActivityFixtureSnapshot().run], unavailable: false }
  }
  try {
    const page = await getRunControlService().list({ limit: 100 })
    return { runs: page.items, unavailable: false }
  } catch {
    return { runs: [], unavailable: true }
  }
}

export default async function RunsPage() {
  const { runs, unavailable } = await loadRuns()
  return (
    <main className="min-h-svh bg-background text-foreground">
      <header className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2 sm:px-6">
        <div className="flex items-center gap-3">
          <span className="grid size-7 place-items-center rounded-md bg-foreground font-mono text-xs font-semibold text-background">
            S
          </span>
          <div>
            <h1 className="text-sm font-semibold">Sentinel</h1>
            <p className="font-mono text-[0.6875rem] text-muted-foreground">
              Control plane
            </p>
          </div>
        </div>
        <nav
          aria-label="Control plane"
          className="flex items-center gap-1 text-xs"
        >
          <Link
            href="/"
            className="min-h-11 rounded-md px-3 leading-[2.75rem] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
          >
            Applications
          </Link>
          <Link
            href="/knowledge"
            className="min-h-11 rounded-md px-3 leading-[2.75rem] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
          >
            Knowledge
          </Link>
          <Link
            href="/runs"
            aria-current="page"
            className="min-h-11 rounded-md bg-muted px-3 leading-[2.75rem] font-medium"
          >
            Activity
          </Link>
        </nav>
      </header>

      {unavailable ? (
        <div
          role="alert"
          className="border-b border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive sm:px-6"
        >
          Run activity is unavailable because server configuration could not be
          loaded.
        </div>
      ) : null}

      <section
        aria-labelledby="runs-heading"
        className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-8 sm:px-6"
      >
        <div className="flex items-start gap-3">
          <span className="grid size-9 place-items-center rounded-md bg-muted text-primary">
            <Activity className="size-4" aria-hidden="true" />
          </span>
          <div>
            <h2 id="runs-heading" className="text-lg font-semibold">
              Run activity
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Inspect ordered specialist work and reconciliation.
            </p>
          </div>
        </div>

        {runs.length === 0 ? (
          <div className="grid min-h-48 place-items-center border border-dashed border-border px-6 text-center">
            <div className="grid justify-items-center gap-2">
              <Boxes
                className="size-5 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="text-sm font-medium">No runs yet</p>
              <p className="text-xs text-muted-foreground">
                Started control-plane runs will appear here.
              </p>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-border border-y border-border">
            {runs.map((run) => (
              <li key={run.id}>
                <Link
                  href={`/runs/${run.id}`}
                  className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3 py-4 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary sm:px-4"
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <CircleDot
                        className="size-4 shrink-0 text-primary"
                        aria-hidden="true"
                      />
                      <span className="truncate text-sm font-semibold">
                        {humanize(run.type)}
                      </span>
                    </div>
                    <p className="mt-1 font-mono text-[0.6875rem] text-muted-foreground">
                      {humanize(run.status)} / Attempt {run.attemptCount + 1} /{" "}
                      {run.createdAt.slice(0, 19).replace("T", " ")} UTC
                    </p>
                  </div>
                  <ArrowRight
                    className="size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
