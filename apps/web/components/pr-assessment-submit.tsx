"use client"

import { GitPullRequest, LoaderCircle } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useState, type FormEvent } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function PrAssessmentSubmit({
  applicationId,
}: {
  readonly applicationId: string
}) {
  const router = useRouter()
  const [pullRequestUrl, setPullRequestUrl] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh()
    }
    const interval = window.setInterval(refresh, 5_000)
    return () => window.clearInterval(interval)
  }, [router])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setMessage(null)
    try {
      const response = await fetch("/api/github/assessments", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          applicationId,
          pullRequestUrl: pullRequestUrl.trim(),
        }),
      })
      const payload = (await response.json()) as {
        readonly status?: string
        readonly runId?: string
        readonly reason?: string
        readonly error?: { readonly message?: string }
      }
      if (!response.ok) {
        throw new Error(
          payload.error?.message ?? "The pull request could not be queued."
        )
      }
      if (payload.status === "ignored") {
        setMessage(
          payload.reason === "draft_pull_request"
            ? "Draft pull requests are assessed after they are marked ready."
            : "This pull request event does not require an assessment."
        )
        return
      }
      if (payload.runId === undefined) {
        throw new Error("The assessment was accepted without a run identity.")
      }
      setPullRequestUrl("")
      router.push(
        `/applications/${applicationId}/activity/${encodeURIComponent(payload.runId)}`
      )
      router.refresh()
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The pull request could not be queued."
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section
      aria-labelledby="assess-pr-heading"
      className="border-b border-border bg-muted/20 px-4 py-4 sm:px-6 lg:px-8"
    >
      <form
        onSubmit={handleSubmit}
        className="mx-auto grid max-w-6xl gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end"
      >
        <div className="grid gap-1.5">
          <label
            id="assess-pr-heading"
            htmlFor="pull-request-url"
            className="flex items-center gap-2 text-sm font-semibold"
          >
            <GitPullRequest className="size-4 text-primary" aria-hidden="true" />
            Assess a pull request
          </label>
          <Input
            id="pull-request-url"
            type="url"
            required
            autoComplete="url"
            value={pullRequestUrl}
            onChange={(event) => setPullRequestUrl(event.target.value)}
            placeholder="https://github.com/owner/repository/pull/123"
            aria-describedby={message === null ? undefined : "assessment-message"}
            disabled={submitting}
          />
        </div>
        <Button type="submit" className="min-h-11" disabled={submitting}>
          {submitting ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <GitPullRequest aria-hidden="true" />
          )}
          {submitting ? "Queuing..." : "Analyze PR"}
        </Button>
        {message === null ? null : (
          <p
            id="assessment-message"
            role="status"
            className="text-sm text-muted-foreground lg:col-span-2"
          >
            {message}
          </p>
        )}
      </form>
    </section>
  )
}
