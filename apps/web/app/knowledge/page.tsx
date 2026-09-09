import { BookOpenCheck, ChevronRight } from "lucide-react"
import Link from "next/link"

import { listOnboardingApplications } from "@/app/actions"
import { KNOWLEDGE_FIXTURE_APPLICATION_ID } from "@/lib/knowledge-fixture"
import { isControlPlaneFixture } from "@/lib/operator-auth"

export const dynamic = "force-dynamic"

export default async function KnowledgePage() {
  const applications = isControlPlaneFixture(process.env)
    ? [
        {
          id: KNOWLEDGE_FIXTURE_APPLICATION_ID,
          name: "Hi.Events checkout",
          status: "stale",
        },
      ]
    : await listOnboardingApplications()
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
              Knowledge control
            </p>
          </div>
        </div>
        <nav
          aria-label="Control plane"
          className="flex items-center gap-1 text-xs"
        >
          <Link
            href="/"
            className="min-h-11 rounded-md px-3 leading-[2.75rem] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Applications
          </Link>
          <Link
            href="/knowledge"
            aria-current="page"
            className="min-h-11 rounded-md bg-muted px-3 leading-[2.75rem] font-medium"
          >
            Knowledge
          </Link>
          <Link
            href="/runs"
            className="min-h-11 rounded-md px-3 leading-[2.75rem] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Activity
          </Link>
        </nav>
      </header>
      <section
        aria-labelledby="knowledge-applications-heading"
        className="mx-auto grid w-full max-w-4xl gap-6 px-4 py-8 sm:px-6"
      >
        <div className="flex items-start gap-3">
          <span className="grid size-9 place-items-center rounded-md bg-muted text-primary">
            <BookOpenCheck className="size-4" aria-hidden="true" />
          </span>
          <div>
            <h2
              id="knowledge-applications-heading"
              className="text-lg font-semibold"
            >
              Application knowledge
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Inspect current evidence, coverage, and reviewer decisions.
            </p>
          </div>
        </div>
        {applications.length === 0 ? (
          <div className="grid min-h-48 place-items-center border border-dashed border-border p-6 text-center">
            <div>
              <p className="text-sm font-medium">
                No application knowledge yet
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Connect and initialize an application first.
              </p>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-border border-y border-border">
            {applications.map((application) => (
              <li key={application.id}>
                <Link
                  href={`/knowledge/${application.id}`}
                  className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
                >
                  <div>
                    <p className="text-sm font-semibold">{application.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {humanizeStatus(application.status)}
                    </p>
                  </div>
                  <ChevronRight
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

function humanizeStatus(value: string): string {
  return value
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ")
}
