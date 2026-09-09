import { FileQuestion } from "lucide-react"
import Link from "next/link"

export default function AssessmentReportNotFound() {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-6 text-foreground">
      <div className="grid max-w-md justify-items-center gap-4 text-center">
        <FileQuestion
          className="size-6 text-muted-foreground"
          aria-hidden="true"
        />
        <div>
          <h1 className="text-base font-semibold">
            Assessment report not found
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This assessment ID is invalid, unavailable, or not owned by the
            current operator.
          </p>
        </div>
        <Link
          href="/runs"
          className="inline-flex min-h-11 items-center rounded-md border border-border bg-input/30 px-3 text-sm font-medium hover:bg-input/50 focus-visible:outline-2 focus-visible:outline-primary"
        >
          Return to activity
        </Link>
      </div>
    </main>
  )
}
