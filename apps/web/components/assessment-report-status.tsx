import {
  AlertTriangle,
  ArrowRight,
  CircleDashed,
  GitPullRequest,
} from "lucide-react"
import Link from "next/link"

import type { AssessmentReportStatusView } from "@/lib/assessment-report-service"

const pendingStatuses = new Set([
  "queued",
  "running",
  "interrupted",
  "cancelling",
])

function humanize(value: string) {
  return value
    .split("_")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ")
}

export function AssessmentReportStatus({
  assessment,
}: {
  readonly assessment: AssessmentReportStatusView
}) {
  const pending = pendingStatuses.has(assessment.status)
  const Icon = pending ? CircleDashed : AlertTriangle
  return (
    <main className="grid min-h-svh place-items-center bg-background px-4 py-10 text-foreground">
      <section
        aria-labelledby="assessment-status-heading"
        className="w-full max-w-xl border-y border-border py-8 text-center"
      >
        <Icon
          className={
            pending
              ? "mx-auto size-6 text-primary"
              : "mx-auto size-6 text-destructive"
          }
          aria-hidden="true"
        />
        <p className="mt-4 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <GitPullRequest className="size-4" aria-hidden="true" />
          {assessment.repositoryOwner}/{assessment.repositoryName} PR #
          {assessment.pullRequestNumber}
        </p>
        <h1
          id="assessment-status-heading"
          className="mt-2 text-xl font-semibold"
        >
          {pending
            ? "Assessment report is being prepared"
            : "Assessment report is unavailable"}
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
          {pending
            ? `The assessment is ${humanize(assessment.status).toLowerCase()}. Its report will appear here after the analysis is finalized.`
            : assessment.error === null
              ? `The assessment ended with status ${humanize(assessment.status).toLowerCase()} before a report was published.`
              : `The run stopped with error ${assessment.error.code}. ${assessment.error.retryable ? "It can be retried from the Activity page." : "Review the Activity record before starting another assessment."}`}
        </p>
        <Link
          href={`/applications/${assessment.applicationId}/activity/${assessment.runId}`}
          className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-md border border-border px-4 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
        >
          Open run activity
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </section>
    </main>
  )
}
