"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  Braces,
  CheckCircle2,
  CirclePause,
  CircleStop,
  ClipboardCheck,
  Code2,
  FileSearch,
  Gauge,
  Globe2,
  ImageOff,
  LoaderCircle,
  Network,
  Play,
  RefreshCw,
  Scale,
  ShieldCheck,
  TerminalSquare,
  Wrench,
  XCircle,
} from "lucide-react"

import {
  publicRunSchema,
  runEventPageSchema,
  signedRunArtifactSchema,
  type PublicRun,
  type PublicRunInterrupt,
} from "@sentinel/contracts"

import { Button } from "@/components/ui/button"
import {
  ActivityCatchUpController,
  activityFeedReducer,
  createActivityFeedState,
  mergeActivityPage,
  type ActivityConnectionState,
  type ActivityFeedState,
} from "@/lib/activity-feed"
import {
  projectActivityFeed,
  type ActivityCategory,
  type ActivityLane,
  type ActivityViewModel,
} from "@/lib/activity-projector"
import { createRunRealtimeSubscription } from "@/lib/realtime-client"
import { cn } from "@/lib/utils"

const laneDefinitions = [
  {
    id: "documentation" as const,
    label: "Documentation",
    description: "Guides, contracts, and stated behavior",
    icon: FileSearch,
  },
  {
    id: "code" as const,
    label: "Code",
    description: "Implementation and repository evidence",
    icon: Code2,
  },
  {
    id: "application" as const,
    label: "Application",
    description: "Observed runtime behavior",
    icon: Globe2,
  },
] as const

const categoryIcons = {
  decision: Scale,
  policy: ShieldCheck,
  tool: Wrench,
  action: Play,
  transition: RefreshCw,
  request: Network,
  coverage: ClipboardCheck,
  status: TerminalSquare,
} satisfies Readonly<Record<ActivityCategory, typeof Scale>>

const terminalStatuses = new Set(["cancelled", "succeeded", "failed"])
const activeStatuses = new Set(["queued", "running"])

function humanize(value: string): string {
  return value
    .split("_")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ")
}

function eventTime(value: string): string {
  const date = new Date(value)
  return `${date.toISOString().slice(11, 19)} UTC`
}

function statusTone(status: string): string {
  if (new Set(["failed", "blocked", "cancelled"]).has(status)) {
    return "border-destructive/25 bg-destructive/5 text-destructive"
  }
  if (new Set(["warning", "cancelling", "interrupted"]).has(status)) {
    return "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300"
  }
  if (new Set(["completed", "succeeded", "live"]).has(status)) {
    return "border-primary/25 bg-primary/5 text-primary"
  }
  return "border-border bg-muted/40 text-muted-foreground"
}

function ActivityCard({ item }: { readonly item: ActivityViewModel }) {
  const Icon = categoryIcons[item.category]
  return (
    <article
      className="grid min-w-0 gap-3 rounded-md border border-border bg-background p-3"
      data-sequence={item.sequence}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            <Icon className="size-3.5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-[0.6875rem] font-semibold text-muted-foreground uppercase">
              {item.categoryLabel}
            </p>
            <h4 className="text-sm leading-5 font-medium break-words">
              {item.summary}
            </h4>
          </div>
        </div>
        <time
          dateTime={item.occurredAt}
          className="shrink-0 font-mono text-[0.625rem] text-muted-foreground"
        >
          {eventTime(item.occurredAt)}
        </time>
      </div>

      {item.detail === undefined ? null : (
        <p className="text-xs leading-5 break-words whitespace-pre-wrap text-muted-foreground">
          {item.detail}
        </p>
      )}

      {item.action === undefined ? null : (
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-l-2 border-primary/40 pl-3 text-xs">
          <div className="min-w-0">
            <dt className="sr-only">Action</dt>
            <dd className="font-medium break-words">{item.action.label}</dd>
          </div>
          <div>
            <dt className="sr-only">Action status</dt>
            <dd className="font-mono text-[0.6875rem] text-muted-foreground">
              {humanize(item.action.status)}
            </dd>
          </div>
        </dl>
      )}

      {item.request === undefined ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-2 bg-muted/50 px-2.5 py-2 font-mono text-[0.6875rem]">
          <span className="font-semibold">{item.request.method}</span>
          <span className="min-w-0 flex-1 break-all text-muted-foreground">
            {item.request.route}
          </span>
          {item.request.status === undefined ? null : (
            <span>{item.request.status}</span>
          )}
        </div>
      )}

      <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-border pt-2 text-[0.6875rem] text-muted-foreground">
        <span
          className={cn(
            "rounded-sm border px-1.5 py-0.5 font-medium",
            statusTone(item.status)
          )}
        >
          {humanize(item.status)}
        </span>
        <code className="min-w-0 break-all">{item.reasonCode}</code>
        {item.evidenceGain > 0 ? (
          <span>{item.evidenceGain} evidence gained</span>
        ) : null}
        {item.coverageDelta === undefined ? null : (
          <span>
            Coverage {item.coverageDelta >= 0 ? "+" : ""}
            {item.coverageDelta}
          </span>
        )}
      </div>
    </article>
  )
}

function EmptyLane({ label }: { readonly label: string }) {
  return (
    <div className="grid min-h-28 place-items-center border border-dashed border-border px-4 text-center">
      <p className="text-xs text-muted-foreground">
        No {label.toLowerCase()} activity yet
      </p>
    </div>
  )
}

function SpecialistLane({
  lane,
  items,
  headingId,
  className,
}: {
  readonly lane: (typeof laneDefinitions)[number]
  readonly items: readonly ActivityViewModel[]
  readonly headingId: string
  readonly className?: string
}) {
  const Icon = lane.icon
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "min-w-0 border-r border-border last:border-r-0",
        className
      )}
    >
      <header className="grid min-h-20 content-center gap-1 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-primary" aria-hidden="true" />
          <h3 id={headingId} className="text-sm font-semibold">
            {lane.label}
          </h3>
          <span className="ml-auto font-mono text-[0.6875rem] text-muted-foreground">
            {items.length}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{lane.description}</p>
      </header>
      <div className="grid max-h-[34rem] gap-3 overflow-y-auto p-3">
        {items.length === 0 ? (
          <EmptyLane label={lane.label} />
        ) : (
          items.map((item) => <ActivityCard key={item.sequence} item={item} />)
        )}
      </div>
    </section>
  )
}

function BudgetPanel({
  budgets,
}: {
  readonly budgets: ReturnType<typeof projectActivityFeed>["budgets"]
}) {
  if (budgets.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No budget usage reported</p>
    )
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
      {budgets.map((budget) => {
        const maximum = Math.max(1, budget.limit)
        const value = Math.min(budget.consumed, maximum)
        return (
          <label key={budget.unit} className="grid gap-1.5 text-xs">
            <span className="flex items-center justify-between gap-3">
              <span>{humanize(budget.unit)}</span>
              <span className="font-mono text-[0.6875rem] text-muted-foreground">
                {budget.consumed.toLocaleString()} /{" "}
                {budget.limit.toLocaleString()}
              </span>
            </span>
            <progress
              className="h-1.5 w-full accent-primary"
              max={maximum}
              value={value}
            >
              {Math.round((value / maximum) * 100)}%
            </progress>
          </label>
        )
      })}
    </div>
  )
}

function ScreenshotFrame({
  runId,
  item,
}: {
  readonly runId: string
  readonly item: ActivityViewModel
}) {
  const artifactId = item.screenshotArtifactId
  const [state, setState] = useState<
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly url: string }
    | { readonly status: "unavailable" }
  >({ status: "loading" })

  useEffect(() => {
    if (artifactId === undefined) return
    const controller = new AbortController()
    void fetch(
      `/api/control/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
      {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        signal: controller.signal,
      }
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("unavailable")
        const parsed = signedRunArtifactSchema.parse(await response.json())
        if (parsed.runId !== runId || parsed.artifactId !== artifactId) {
          throw new Error("unavailable")
        }
        setState({ status: "ready", url: parsed.url })
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setState({ status: "unavailable" })
        }
      })
    return () => controller.abort()
  }, [artifactId, runId])

  return (
    <figure className="grid gap-2 border-b border-border pb-4 last:border-b-0 last:pb-0">
      <div className="aspect-[16/10] overflow-hidden rounded-md border border-border bg-muted/40">
        {state.status === "loading" ? (
          <div className="grid size-full place-items-center text-muted-foreground">
            <LoaderCircle
              className="size-5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            <span className="sr-only">Loading screenshot</span>
          </div>
        ) : state.status === "ready" ? (
          // Dynamic, short-lived S3 hosts cannot be enumerated in Next image config.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={state.url}
            alt={`Application state captured at event ${item.sequence}`}
            className="size-full object-contain"
            onError={() => setState({ status: "unavailable" })}
          />
        ) : (
          <div className="grid size-full place-items-center gap-2 px-4 text-center text-muted-foreground">
            <ImageOff className="size-5" aria-hidden="true" />
            <p className="text-xs">Screenshot expired or unavailable</p>
          </div>
        )}
      </div>
      <figcaption className="grid gap-1">
        <span className="text-xs font-medium break-words">{item.summary}</span>
        <span className="font-mono text-[0.6875rem] text-muted-foreground">
          Event {item.sequence} · {eventTime(item.occurredAt)}
        </span>
      </figcaption>
    </figure>
  )
}

function ConnectionStatus({
  connection,
  slow,
}: {
  readonly connection: ActivityConnectionState
  readonly slow: boolean
}) {
  const label =
    slow && (connection === "connecting" || connection === "reconnecting")
      ? "Still connecting"
      : humanize(connection)
  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground"
      aria-live="polite"
      aria-atomic="true"
    >
      <span
        className={cn(
          "size-2 rounded-full",
          connection === "live"
            ? "bg-primary"
            : connection === "error"
              ? "bg-destructive"
              : "bg-amber-500"
        )}
        aria-hidden="true"
      />
      <span>{label}</span>
    </div>
  )
}

type ControlAction = "pause" | "cancel" | "retry" | "approve" | "reject"

export interface RunActivityWorkspaceProps {
  readonly initialRun: PublicRun
  readonly initialEventPage: unknown
  readonly initialInterrupt?: PublicRunInterrupt | null
  readonly live?: boolean
}

export function RunActivityWorkspace({
  initialRun,
  initialEventPage,
  initialInterrupt = null,
  live = true,
}: RunActivityWorkspaceProps) {
  const [run, setRun] = useState(() => publicRunSchema.parse(initialRun))
  const [interrupt, setInterrupt] = useState(initialInterrupt)
  const [activeLane, setActiveLane] = useState<ActivityLane>("documentation")
  const [busy, setBusy] = useState<ControlAction | null>(null)
  const [confirmStop, setConfirmStop] = useState(false)
  const [controlMessage, setControlMessage] = useState("")
  const [slow, setSlow] = useState(false)
  const [feed, setFeed] = useState<ActivityFeedState>(() => {
    try {
      const merged = mergeActivityPage(
        createActivityFeedState(initialRun.id),
        initialEventPage
      )
      return {
        ...merged,
        connection: live ? "connecting" : "offline",
      }
    } catch {
      return {
        ...createActivityFeedState(initialRun.id),
        connection: "error",
        errorMessage: "The saved activity could not be reconstructed.",
      }
    }
  })
  const feedRef = useRef(feed)

  const writeFeed = useCallback((next: ActivityFeedState) => {
    feedRef.current = next
    setFeed(next)
  }, [])

  useEffect(() => {
    if (!live) return
    let disposed = false
    const controller = new ActivityCatchUpController({
      read: () => feedRef.current,
      write: writeFeed,
      fetchPage: async (after) => {
        const response = await fetch(
          `/api/control/runs/${encodeURIComponent(run.id)}/events?after=${after}&limit=100`,
          {
            cache: "no-store",
            credentials: "same-origin",
            headers: { accept: "application/json" },
          }
        )
        if (!response.ok) throw new Error("activity_fetch_failed")
        return runEventPageSchema.parse(await response.json())
      },
      onError: () => {
        if (!disposed) {
          setSlow(false)
          writeFeed(
            activityFeedReducer(feedRef.current, {
              type: "connection",
              connection: "error",
              errorMessage: "Activity catch-up failed. Reconnect to try again.",
            })
          )
        }
      },
    })
    const realtime = createRunRealtimeSubscription({
      runId: run.id,
      onWake: () => void controller.wake(),
      onStatus: (connection) => {
        if (disposed) return
        setSlow(false)
        writeFeed(
          activityFeedReducer(feedRef.current, {
            type: "connection",
            connection,
          })
        )
        if (connection === "live") void controller.wake()
      },
    })
    void realtime.start().catch(() => undefined)
    void controller.wake().catch(() => undefined)
    return () => {
      disposed = true
      controller.stop()
      void realtime.stop()
    }
  }, [live, run.id, writeFeed])

  useEffect(() => {
    if (
      feed.connection !== "connecting" &&
      feed.connection !== "reconnecting"
    ) {
      return
    }
    const timer = window.setTimeout(() => setSlow(true), 8_000)
    return () => window.clearTimeout(timer)
  }, [feed.connection])

  const projection = useMemo(
    () => projectActivityFeed(feed.items),
    [feed.items]
  )

  const handleLaneKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      const last = laneDefinitions.length - 1
      const nextIndex =
        event.key === "ArrowRight"
          ? index === last
            ? 0
            : index + 1
          : event.key === "ArrowLeft"
            ? index === 0
              ? last
              : index - 1
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? last
                : undefined
      if (nextIndex === undefined) return
      event.preventDefault()
      const nextLane = laneDefinitions[nextIndex]
      if (nextLane === undefined) return
      setActiveLane(nextLane.id)
      document.getElementById(`${nextLane.id}-tab`)?.focus()
    },
    []
  )

  const refreshRun = useCallback(async () => {
    const response = await fetch(
      `/api/control/runs/${encodeURIComponent(run.id)}`,
      {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      }
    )
    if (!response.ok) throw new Error("run_refresh_failed")
    setRun(publicRunSchema.parse(await response.json()))
  }, [run.id])

  const handleControl = useCallback(
    async (action: ControlAction) => {
      setBusy(action)
      setControlMessage("")
      try {
        const base = `/api/control/runs/${encodeURIComponent(run.id)}`
        const request = (() => {
          if (action === "pause" || action === "cancel") {
            return { url: `${base}/${action}`, body: undefined }
          }
          if (action === "retry") {
            return {
              url: `${base}/retry`,
              body: {
                schemaVersion: 1,
                idempotencyKey: `retry:${run.id}:${Date.now()}`,
              },
            }
          }
          if (interrupt === null) throw new Error("interrupt_missing")
          return {
            url: `${base}/interrupts/${encodeURIComponent(interrupt.decisionId)}/respond`,
            body: {
              schemaVersion: 1,
              response: { approved: action === "approve" },
            },
          }
        })()
        const response = await fetch(request.url, {
          method: "POST",
          credentials: "same-origin",
          headers:
            request.body === undefined
              ? { accept: "application/json" }
              : {
                  accept: "application/json",
                  "content-type": "application/json",
                },
          ...(request.body === undefined
            ? {}
            : { body: JSON.stringify(request.body) }),
        })
        if (!response.ok) throw new Error("control_failed")
        const payload = (await response.json()) as unknown
        if (action === "approve" || action === "reject") {
          setInterrupt(null)
          await refreshRun()
        } else {
          const parsed = publicRunSchema.parse(
            (payload as { readonly run?: unknown }).run
          )
          setRun(parsed)
        }
        setConfirmStop(false)
        setControlMessage(
          action === "approve" && interrupt?.decisionId === "resume_run"
            ? "Run resumed."
            : `${humanize(action)} request accepted.`
        )
      } catch {
        setControlMessage("The control request failed. Try again.")
      } finally {
        setBusy(null)
      }
    },
    [interrupt, refreshRun, run.id]
  )

  const terminal = terminalStatuses.has(run.status)
  const canPause =
    activeStatuses.has(run.status) && run.pauseRequestedAt === undefined
  const canStop = activeStatuses.has(run.status) || run.status === "interrupted"

  return (
    <main className="min-h-svh bg-background text-foreground">
      <header className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-foreground font-mono text-xs font-semibold text-background">
            S
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">Sentinel</h1>
            <p className="font-mono text-[0.6875rem] text-muted-foreground">
              Live agent activity
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <ConnectionStatus connection={feed.connection} slow={slow} />
          <span
            className={cn(
              "rounded-sm border px-2 py-1 text-xs font-medium",
              statusTone(run.status)
            )}
          >
            {humanize(run.status)}
          </span>
        </div>
      </header>

      <section className="border-b border-border px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="font-mono text-[0.6875rem] text-muted-foreground uppercase">
              {humanize(run.type)} · Attempt {run.attemptCount + 1}
            </p>
            <h2 className="mt-1 text-lg font-semibold">Specialist activity</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Ordered decisions, actions, and evidence for this run.
            </p>
          </div>
          <div className="flex min-h-11 flex-wrap items-center justify-end gap-2">
            {canPause || run.pauseRequestedAt !== undefined ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 rounded-md"
                disabled={!canPause || busy !== null}
                onClick={() => void handleControl("pause")}
              >
                {busy === "pause" ? (
                  <LoaderCircle
                    className="animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <CirclePause aria-hidden="true" />
                )}
                {run.pauseRequestedAt === undefined
                  ? "Pause"
                  : "Pause requested"}
              </Button>
            ) : null}
            {canStop && !confirmStop ? (
              <Button
                type="button"
                variant="destructive"
                className="min-h-11 rounded-md"
                disabled={busy !== null}
                onClick={() => setConfirmStop(true)}
              >
                <CircleStop aria-hidden="true" />
                Stop
              </Button>
            ) : null}
            {canStop && confirmStop ? (
              <div
                className="flex min-h-11 items-center gap-2"
                role="group"
                aria-label="Confirm stop"
              >
                <Button
                  type="button"
                  variant="destructive"
                  className="min-h-11 rounded-md"
                  disabled={busy !== null}
                  onClick={() => void handleControl("cancel")}
                >
                  {busy === "cancel" ? (
                    <LoaderCircle
                      className="animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <CircleStop aria-hidden="true" />
                  )}
                  Confirm stop
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 rounded-md"
                  disabled={busy !== null}
                  onClick={() => setConfirmStop(false)}
                >
                  Keep running
                </Button>
              </div>
            ) : null}
            {run.status === "failed" ? (
              <Button
                type="button"
                className="min-h-11 rounded-md"
                disabled={busy !== null}
                onClick={() => void handleControl("retry")}
              >
                <RefreshCw aria-hidden="true" />
                Retry
              </Button>
            ) : null}
          </div>
        </div>

        {interrupt === null ? null : (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-l-2 border-amber-500 bg-amber-500/5 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold">
                {interrupt.decisionId === "resume_run"
                  ? "Paused at a safe boundary"
                  : "Operator decision required"}
              </p>
              <p className="text-xs break-words text-muted-foreground">
                {interrupt.prompt}
              </p>
            </div>
            <div className="flex min-h-11 items-center gap-2">
              <Button
                type="button"
                className="min-h-11 rounded-md"
                disabled={busy !== null}
                onClick={() => void handleControl("approve")}
              >
                <CheckCircle2 aria-hidden="true" />
                {interrupt.decisionId === "resume_run" ? "Resume" : "Approve"}
              </Button>
              {interrupt.decisionId === "resume_run" ? null : (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 rounded-md"
                  disabled={busy !== null}
                  onClick={() => void handleControl("reject")}
                >
                  <XCircle aria-hidden="true" />
                  Reject
                </Button>
              )}
            </div>
          </div>
        )}

        <p className="sr-only" aria-live="assertive" aria-atomic="true">
          {controlMessage}
        </p>
      </section>

      {feed.connection === "error" ? (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive sm:px-6"
        >
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          {feed.errorMessage ?? "Live activity is temporarily unavailable."}
        </div>
      ) : null}

      {terminal ? (
        <div
          className={cn(
            "flex items-center gap-2 border-b px-4 py-3 text-sm sm:px-6",
            statusTone(run.status)
          )}
          role={run.status === "failed" ? "alert" : "status"}
        >
          {run.status === "succeeded" ? (
            <CheckCircle2 className="size-4" aria-hidden="true" />
          ) : (
            <XCircle className="size-4" aria-hidden="true" />
          )}
          {run.status === "succeeded"
            ? "Run completed. The full activity record is available below."
            : run.status === "cancelled"
              ? "Run stopped. Completed activity remains available."
              : "Run failed. Review the Curator record before retrying."}
        </div>
      ) : null}

      <div className="grid min-w-0 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 border-b border-border xl:border-r xl:border-b-0">
          <div
            role="tablist"
            aria-label="Specialist lanes"
            className="grid grid-cols-3 border-b border-border md:hidden"
          >
            {laneDefinitions.map((lane, index) => (
              <button
                key={lane.id}
                id={`${lane.id}-tab`}
                type="button"
                role="tab"
                aria-selected={activeLane === lane.id}
                aria-controls={`${lane.id}-mobile-panel`}
                tabIndex={activeLane === lane.id ? 0 : -1}
                className={cn(
                  "min-h-11 border-r border-border px-2 text-xs font-medium last:border-r-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary",
                  activeLane === lane.id
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground"
                )}
                onClick={() => setActiveLane(lane.id)}
                onKeyDown={(event) => handleLaneKeyDown(event, index)}
              >
                {lane.label}
              </button>
            ))}
          </div>

          <div className="hidden grid-cols-3 md:grid">
            {laneDefinitions.map((lane) => (
              <SpecialistLane
                key={lane.id}
                lane={lane}
                items={projection.lanes[lane.id]}
                headingId={`${lane.id}-desktop-heading`}
              />
            ))}
          </div>

          <div className="md:hidden">
            {laneDefinitions.map((lane) => (
              <div
                key={lane.id}
                id={`${lane.id}-mobile-panel`}
                role="tabpanel"
                aria-labelledby={`${lane.id}-tab`}
                hidden={activeLane !== lane.id}
              >
                <SpecialistLane
                  lane={lane}
                  items={projection.lanes[lane.id]}
                  headingId={`${lane.id}-mobile-heading`}
                  className="border-r-0"
                />
              </div>
            ))}
          </div>

          <section
            aria-labelledby="curator-heading"
            className="border-t border-border"
          >
            <header className="flex min-h-16 items-center gap-3 border-b border-border bg-muted/20 px-4 py-3">
              <span className="grid size-8 place-items-center rounded-md bg-foreground text-background">
                <Braces className="size-4" aria-hidden="true" />
              </span>
              <div>
                <h3 id="curator-heading" className="text-sm font-semibold">
                  Curator reconciliation
                </h3>
                <p className="text-xs text-muted-foreground">
                  Cross-specialist decisions, blockers, and terminal state
                </p>
              </div>
              <span className="ml-auto font-mono text-[0.6875rem] text-muted-foreground">
                {projection.lanes.curator.length}
              </span>
            </header>
            <div className="grid gap-3 p-3 sm:grid-cols-2">
              {projection.lanes.curator.length === 0 ? (
                <div className="sm:col-span-2">
                  <EmptyLane label="Curator" />
                </div>
              ) : (
                projection.lanes.curator.map((item) => (
                  <ActivityCard key={item.sequence} item={item} />
                ))
              )}
            </div>
          </section>
        </div>

        <aside
          aria-label="Run evidence"
          className="grid content-start divide-y divide-border"
        >
          <section aria-labelledby="budget-heading" className="grid gap-4 p-4">
            <div className="flex items-center gap-2">
              <Gauge className="size-4 text-primary" aria-hidden="true" />
              <h3 id="budget-heading" className="text-sm font-semibold">
                Budget
              </h3>
            </div>
            <BudgetPanel budgets={projection.budgets} />
          </section>
          <section
            aria-labelledby="storyboard-heading"
            className="grid gap-4 p-4"
          >
            <div className="flex items-center gap-2">
              <Globe2 className="size-4 text-primary" aria-hidden="true" />
              <div>
                <h3 id="storyboard-heading" className="text-sm font-semibold">
                  Application storyboard
                </h3>
                <p className="text-xs text-muted-foreground">
                  Private action-aligned captures
                </p>
              </div>
            </div>
            {projection.storyboard.length === 0 ? (
              <div className="grid aspect-[16/10] place-items-center border border-dashed border-border px-4 text-center">
                <p className="text-xs text-muted-foreground">
                  No screenshots captured yet
                </p>
              </div>
            ) : (
              <div className="grid gap-4">
                {projection.storyboard.map((item) => (
                  <ScreenshotFrame
                    key={item.sequence}
                    runId={run.id}
                    item={item}
                  />
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>
    </main>
  )
}
