"use client"

import {
  AlertTriangle,
  ArrowRight,
  BookOpenCheck,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  ExternalLink,
  FileSearch,
  GitCommitHorizontal,
  LoaderCircle,
  Network,
  RefreshCw,
  Search,
  ShieldAlert,
  XCircle,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import {
  coveragePageSchema,
  evidencePathSchema,
  knowledgeReviewDecisionResultSchema,
  knowledgeReviewPageSchema,
  privateArtifactExcerptSchema,
  workflowCoveragePageSchema,
  type CoverageItem,
  type CoveragePage,
  type EvidencePath,
  type EvidencePathLink,
  type KnowledgeOverview,
  type KnowledgeReviewPage,
  type PrivateArtifactExcerpt,
  type WorkflowCoveragePage,
} from "@sentinel/contracts"

import { Button } from "@/components/ui/button"
import { KnowledgeGraphExplorer } from "@/components/knowledge-graph-explorer"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

type View = "requirements" | "workflows"
type WorkspaceView = "coverage" | "graph" | "reviews"
type Busy = "coverage" | "path" | "reviews" | "decision" | "excerpt" | null

const coverageLabels: Record<CoverageItem["status"], string> = {
  observed: "Observed",
  partially_observed: "Partially observed",
  not_observed: "Not observed",
  blocked: "Blocked",
  not_evaluated: "Not evaluated",
  ambiguous: "Ambiguous",
}

function statusTone(status: CoverageItem["status"] | string): string {
  switch (status) {
    case "observed":
    case "accepted":
    case "current":
    case "ready":
      return "border-emerald-600/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    case "blocked":
    case "rejected":
    case "failed":
      return "border-destructive/25 bg-destructive/10 text-destructive"
    case "not_observed":
    case "ambiguous":
    case "warning":
    case "stale":
      return "border-amber-600/25 bg-amber-500/10 text-amber-800 dark:text-amber-300"
    default:
      return "border-border bg-muted text-muted-foreground"
  }
}

function humanize(value: string): string {
  return value
    .split(/[_-]/)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ")
}

function shortId(value: string): string {
  const suffix = value.split(":").at(-1) ?? value
  return suffix.slice(0, 8)
}

function formatTime(value?: string): string {
  if (value === undefined) return "Unknown"
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value))
}

function SummaryBand({ overview }: { readonly overview: KnowledgeOverview }) {
  const counts = [
    ["Requirements", overview.counts.requirements],
    ["Workflows", overview.counts.workflows],
    ["Screens", overview.counts.screens],
    ["UI elements", overview.counts.uiElements],
    ["Endpoints", overview.counts.apiEndpoints],
    ["Code symbols", overview.counts.codeSymbols],
  ] as const
  return (
    <>
      {overview.application.stale ? (
        <div
          role="status"
          className="flex items-start gap-2 border-b border-amber-600/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 sm:px-6 dark:text-amber-200"
        >
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <span>
            Current knowledge is stale. Source or configuration identity changed
            after the last successful refresh.
          </span>
        </div>
      ) : null}
      <section
        aria-labelledby="knowledge-summary-heading"
        className="border-b border-border px-4 py-5 sm:px-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            <p className="font-mono text-[0.6875rem] text-muted-foreground uppercase">
              Application knowledge
            </p>
            <h2
              id="knowledge-summary-heading"
              className="mt-1 text-lg font-semibold"
            >
              {overview.application.name}
            </h2>
            <a
              href={overview.application.deploymentUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex max-w-full items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-primary"
            >
              <span className="truncate">
                {overview.application.deploymentUrl}
              </span>
              <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
            </a>
          </div>
          <dl className="grid min-w-0 gap-3 text-xs sm:grid-cols-2">
            <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
              <GitCommitHorizontal
                className="size-4 text-primary"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <dt className="text-muted-foreground">Indexed commit</dt>
                <dd
                  className="truncate font-mono font-medium"
                  title={overview.application.indexedCommitSha}
                >
                  {overview.application.indexedCommitSha?.slice(0, 12) ??
                    "Not indexed"}
                </dd>
              </div>
            </div>
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
              <Clock3 className="size-4 text-primary" aria-hidden="true" />
              <div>
                <dt className="text-muted-foreground">
                  Current knowledge updated
                </dt>
                <dd className="font-medium">
                  {formatTime(overview.application.refreshedAt)} UTC
                </dd>
              </div>
            </div>
          </dl>
        </div>
        <dl className="mt-5 grid grid-cols-2 border border-border sm:grid-cols-3 lg:grid-cols-6">
          {counts.map(([label, value]) => (
            <div
              key={label}
              className="border-r border-b border-border p-3 last:border-r-0 lg:border-b-0 sm:[&:nth-child(3n)]:border-r-0 lg:[&:nth-child(3n)]:border-r lg:[&:nth-child(6n)]:border-r-0 sm:[&:nth-child(n+4)]:border-b-0"
            >
              <dt className="text-[0.6875rem] text-muted-foreground">
                {label}
              </dt>
              <dd className="mt-1 font-mono text-lg font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {overview.sources.map((source) => (
            <div
              key={source.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-l-2 border-border px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-xs font-medium">{humanize(source.kind)}</p>
                <p
                  className="truncate text-[0.6875rem] text-muted-foreground"
                  title={source.uri}
                >
                  {source.uri}
                </p>
              </div>
              <span
                className={cn(
                  "rounded-sm border px-1.5 py-0.5 text-[0.6875rem]",
                  statusTone(source.freshness)
                )}
              >
                {humanize(source.freshness)}
              </span>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}

function CoverageTable({
  page,
  onTrace,
  onLoadMore,
  busy,
}: {
  readonly page: CoveragePage
  readonly onTrace: (requirementId: string) => void
  readonly onLoadMore: () => void
  readonly busy: Busy
}) {
  if (page.items.length === 0) {
    return (
      <div className="grid min-h-44 place-items-center border border-dashed border-border p-6 text-center">
        <div>
          <FileSearch
            className="mx-auto size-5 text-muted-foreground"
            aria-hidden="true"
          />
          <p className="mt-2 text-sm font-medium">No matching requirements</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Change the filters or wait for knowledge initialization.
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="grid gap-3">
      <div className="border-y border-border">
        <Table className="min-w-[46rem] border-collapse text-left text-xs">
          <TableHeader className="bg-muted/40 text-muted-foreground">
            <TableRow>
              <TableHead scope="col" className="h-auto px-3 py-2 font-medium">
                Requirement
              </TableHead>
              <TableHead scope="col" className="h-auto px-3 py-2 font-medium">
                Coverage
              </TableHead>
              <TableHead scope="col" className="h-auto px-3 py-2 font-medium">
                Evidence
              </TableHead>
              <TableHead scope="col" className="h-auto px-3 py-2 font-medium">
                Path
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="divide-y divide-border">
            {page.items.map((item) => (
              <TableRow
                key={item.requirementId}
                className={
                  item.stale
                    ? "bg-amber-500/5 hover:bg-amber-500/5"
                    : "hover:bg-transparent"
                }
              >
                <TableHead
                  scope="row"
                  className="h-auto max-w-md px-3 py-3 align-top font-normal whitespace-normal"
                >
                  <p className="text-sm font-medium">{item.statement}</p>
                  <p className="mt-1 text-muted-foreground">
                    {item.actor ?? "Unknown actor"} / {item.capability}
                  </p>
                  <p className="mt-2 leading-relaxed text-muted-foreground">
                    {item.summary}
                  </p>
                  {item.scope === undefined ? null : (
                    <p className="mt-1 font-mono text-[0.6875rem] text-muted-foreground">
                      Scope: {item.scope}
                    </p>
                  )}
                </TableHead>
                <TableCell className="px-3 py-3 align-top whitespace-normal">
                  <span
                    className={cn(
                      "inline-flex rounded-sm border px-2 py-1 font-medium",
                      statusTone(item.status)
                    )}
                  >
                    {coverageLabels[item.status]}
                  </span>
                  {item.stale ? (
                    <p className="mt-2 text-amber-700 dark:text-amber-300">
                      Stale assessment
                    </p>
                  ) : null}
                </TableCell>
                <TableCell className="px-3 py-3 align-top whitespace-normal">
                  <div className="flex flex-wrap gap-1">
                    {item.evidenceTiers.length === 0 ? (
                      <span className="text-muted-foreground">
                        None recorded
                      </span>
                    ) : (
                      item.evidenceTiers.map((tier) => (
                        <span
                          key={tier}
                          className="grid size-7 place-items-center rounded-sm border border-border font-mono font-semibold"
                          title={`Evidence tier ${tier}`}
                        >
                          {tier}
                        </span>
                      ))
                    )}
                  </div>
                  <p className="mt-2 text-muted-foreground">
                    {item.workflowCount} linked workflow
                    {item.workflowCount === 1 ? "" : "s"}
                  </p>
                </TableCell>
                <TableCell className="px-3 py-3 align-top whitespace-normal">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11 rounded-md"
                    disabled={busy === "path"}
                    onClick={() => onTrace(item.requirementId)}
                  >
                    {busy === "path" ? (
                      <LoaderCircle
                        className="animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : (
                      <Network aria-hidden="true" />
                    )}
                    Trace
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {page.nextCursor === undefined ? null : (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 justify-self-start rounded-md"
          disabled={busy === "coverage"}
          onClick={onLoadMore}
        >
          {busy === "coverage" ? (
            <LoaderCircle
              className="animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <ChevronDown aria-hidden="true" />
          )}
          Load more requirements
        </Button>
      )}
    </div>
  )
}

function WorkflowTable({ page }: { readonly page: WorkflowCoveragePage }) {
  if (page.items.length === 0) {
    return (
      <p className="border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No workflows have been discovered.
      </p>
    )
  }
  return (
    <div className="border-y border-border">
      <Table className="min-w-[38rem] border-collapse text-left text-xs">
        <TableHeader className="bg-muted/40 text-muted-foreground">
          <TableRow>
            <TableHead scope="col" className="h-auto px-3 py-2 font-medium">
              Workflow
            </TableHead>
            <TableHead scope="col" className="h-auto px-3 py-2 font-medium">
              Status
            </TableHead>
            <TableHead scope="col" className="h-auto px-3 py-2 font-medium">
              Requirements
            </TableHead>
            <TableHead scope="col" className="h-auto px-3 py-2 font-medium">
              Observed surface
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="divide-y divide-border">
          {page.items.map((item) => (
            <TableRow
              key={item.workflowId}
              className={
                item.stale
                  ? "bg-amber-500/5 hover:bg-amber-500/5"
                  : "hover:bg-transparent"
              }
            >
              <TableHead
                scope="row"
                className="h-auto px-3 py-3 font-normal whitespace-normal"
              >
                <p className="text-sm font-medium">{item.name}</p>
                <p className="mt-1 text-muted-foreground">{item.actor}</p>
              </TableHead>
              <TableCell className="px-3 py-3 whitespace-normal">
                <span
                  className={cn(
                    "rounded-sm border px-2 py-1 font-medium",
                    statusTone(item.stale ? "stale" : item.status)
                  )}
                >
                  {item.stale ? "Stale" : humanize(item.status)}
                </span>
              </TableCell>
              <TableCell className="px-3 py-3 font-mono whitespace-normal">
                {item.requirementCount}
              </TableCell>
              <TableCell className="px-3 py-3 whitespace-normal text-muted-foreground">
                {item.stepCount} steps / {item.screenCount} screens
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function Provenance({
  link,
  onExcerpt,
  busy,
}: {
  readonly link: EvidencePathLink
  readonly onExcerpt: (artifactId: string) => void
  readonly busy: Busy
}) {
  return (
    <details className="group border-l-2 border-border pl-4">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-primary">
        <ArrowRight
          className="size-3 text-muted-foreground"
          aria-hidden="true"
        />
        {humanize(link.relationship)}
        <span
          className="grid size-6 place-items-center rounded-sm border border-border font-mono"
          title={`Evidence tier ${link.tier}`}
        >
          {link.tier}
        </span>
        {link.stale ? (
          <span className="text-amber-700 dark:text-amber-300">Stale</span>
        ) : null}
      </summary>
      <dl className="grid gap-2 pb-3 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Evidence</dt>
          <dd className="mt-0.5 leading-relaxed">{link.explanation}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Extraction</dt>
          <dd className="mt-0.5 font-mono break-all">
            {link.extractionMethod}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Review</dt>
          <dd className="mt-0.5">{humanize(link.reviewState)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Source identity</dt>
          <dd className="mt-0.5 font-mono break-all">
            {shortId(link.sourceIdentityHash)}
          </dd>
        </div>
        {link.sourceCommitSha === undefined ? null : (
          <div>
            <dt className="text-muted-foreground">Commit</dt>
            <dd className="mt-0.5 font-mono break-all">
              {link.sourceCommitSha.slice(0, 12)}
            </dd>
          </div>
        )}
        {link.sourceRunId === undefined ? null : (
          <div>
            <dt className="text-muted-foreground">Run</dt>
            <dd className="mt-0.5 font-mono break-all">{link.sourceRunId}</dd>
          </div>
        )}
        {link.capturedAt === undefined ? null : (
          <div>
            <dt className="text-muted-foreground">Confirmed</dt>
            <dd className="mt-0.5">{formatTime(link.capturedAt)} UTC</dd>
          </div>
        )}
        {link.sourceUri === undefined ? null : (
          <div>
            <dt className="text-muted-foreground">Source</dt>
            <dd className="mt-0.5 break-all">
              <a
                href={link.sourceUri}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4 hover:text-primary"
              >
                Open source
              </a>
            </dd>
          </div>
        )}
      </dl>
      {link.artifactId === undefined ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mb-3 min-h-11 rounded-md"
          disabled={busy === "excerpt"}
          onClick={() => onExcerpt(link.artifactId ?? "")}
        >
          {busy === "excerpt" ? (
            <LoaderCircle
              className="animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <FileSearch aria-hidden="true" />
          )}
          View private excerpt
        </Button>
      )}
    </details>
  )
}

function EvidencePathPanel({
  path,
  onExcerpt,
  busy,
}: {
  readonly path: EvidencePath | null
  readonly onExcerpt: (artifactId: string) => void
  readonly busy: Busy
}) {
  return (
    <section
      aria-labelledby="evidence-path-heading"
      className="border-t border-border p-4 sm:p-5"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-primary">
          <Network className="size-4" aria-hidden="true" />
        </span>
        <div>
          <h3 id="evidence-path-heading" className="text-sm font-semibold">
            Selected evidence path
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            A bounded cited trace, not the complete application graph.
          </p>
        </div>
      </div>
      {path === null ? (
        <div className="mt-4 border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No complete evidence path was found for the selected requirement.
        </div>
      ) : (
        <div className="mt-4">
          <div
            className={cn(
              "mb-3 flex items-center gap-2 text-xs",
              path.complete
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-amber-700 dark:text-amber-300"
            )}
          >
            {path.complete ? (
              <CheckCircle2 className="size-4" aria-hidden="true" />
            ) : (
              <CircleHelp className="size-4" aria-hidden="true" />
            )}
            {path.complete
              ? "Cross-layer path reaches implementation evidence"
              : "Path is partial or contains unresolved evidence"}
          </div>
          <ol className="grid gap-0">
            {path.nodes.map((node, index) => (
              <li key={node.id} className="grid gap-1">
                <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 border border-border p-3">
                  <span className="grid size-7 place-items-center rounded-sm bg-muted font-mono text-[0.6875rem] text-primary">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-[0.6875rem] text-muted-foreground uppercase">
                      {humanize(node.kind)}
                    </p>
                    <p className="mt-0.5 text-sm font-medium break-words">
                      {node.label}
                    </p>
                    {node.detail === undefined ? null : (
                      <p className="mt-1 text-xs break-words text-muted-foreground">
                        {node.detail}
                      </p>
                    )}
                  </div>
                </div>
                {path.links[index] === undefined ? null : (
                  <Provenance
                    link={path.links[index]}
                    onExcerpt={onExcerpt}
                    busy={busy}
                  />
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}

function ReviewPanel({
  page,
  applicationId,
  onPage,
  busy,
  setBusy,
  setMessage,
  onLoadMore,
}: {
  readonly page: KnowledgeReviewPage
  readonly applicationId: string
  readonly onPage: (page: KnowledgeReviewPage) => void
  readonly busy: Busy
  readonly setBusy: (busy: Busy) => void
  readonly setMessage: (message: string) => void
  readonly onLoadMore: () => void
}) {
  const [selectedId, setSelectedId] = useState(page.items[0]?.id)
  const [reason, setReason] = useState("")
  const selected =
    page.items.find((item) => item.id === selectedId) ?? page.items[0]

  async function decide(decision: "accepted" | "rejected") {
    if (selected === undefined || reason.trim().length < 3) {
      setMessage("Add a reason before recording a decision.")
      return
    }
    setBusy("decision")
    setMessage("")
    try {
      const base = `/api/knowledge/applications/${encodeURIComponent(applicationId)}/reviews`
      const url =
        selected.kind === "link"
          ? `${base}/links/${encodeURIComponent(selected.id)}`
          : `${base}/interrupts/${encodeURIComponent(selected.runId)}/${encodeURIComponent(selected.decisionId)}`
      const response = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 1,
          decision,
          reason: reason.trim(),
          ...(selected.kind === "link"
            ? { sourceIdentityHash: selected.sourceIdentityHash }
            : {}),
        }),
      })
      if (!response.ok) throw new Error("review_failed")
      const result = knowledgeReviewDecisionResultSchema.parse(
        await response.json()
      )
      onPage({
        ...page,
        items: page.items.map((item) =>
          item.id === selected.id ? result.item : item
        ),
      })
      setReason("")
      setMessage(
        result.idempotent
          ? "This exact decision was already recorded."
          : selected.kind === "interrupt"
            ? "Decision recorded; the intended run was resumed once."
            : "Evidence link review recorded."
      )
    } catch {
      setMessage(
        "The review could not be recorded. Reload before trying again."
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <aside
      aria-labelledby="review-heading"
      className="border-t border-border xl:border-t-0 xl:border-l"
    >
      <header className="flex min-h-16 items-center gap-3 border-b border-border px-4 py-3">
        <span className="grid size-8 place-items-center rounded-md bg-muted text-primary">
          <ShieldAlert className="size-4" aria-hidden="true" />
        </span>
        <div>
          <h3 id="review-heading" className="text-sm font-semibold">
            Review queue
          </h3>
          <p className="text-xs text-muted-foreground">
            Ambiguous links and run interrupts
          </p>
        </div>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {page.items.length}
        </span>
      </header>
      {page.items.length === 0 || selected === undefined ? (
        <div className="p-6 text-center text-sm text-muted-foreground">
          <CheckCircle2 className="mx-auto mb-2 size-5" aria-hidden="true" />
          No review items are pending.
        </div>
      ) : (
        <div className="grid divide-y divide-border">
          <div className="grid max-h-64 overflow-y-auto">
            {page.items.map((item) => (
              <Button
                key={item.id}
                type="button"
                variant="ghost"
                aria-pressed={item.id === selected.id}
                className={cn(
                  "h-auto min-h-14 justify-start rounded-none border-b border-border px-4 py-3 text-left text-xs whitespace-normal last:border-b-0 focus-visible:ring-inset",
                  item.id === selected.id ? "bg-muted" : "hover:bg-muted/50"
                )}
                onClick={() => {
                  setSelectedId(item.id)
                  setReason("")
                }}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">{item.title}</span>
                  <span
                    className={cn(
                      "rounded-sm border px-1.5 py-0.5 text-[0.6875rem]",
                      statusTone(
                        item.kind === "link"
                          ? (item.currentReview?.decision ?? "pending")
                          : item.status
                      )
                    )}
                  >
                    {item.kind === "link"
                      ? humanize(item.currentReview?.decision ?? "pending")
                      : humanize(item.status)}
                  </span>
                </span>
                <span className="mt-1 block text-muted-foreground">
                  {item.kind === "link"
                    ? `Tier ${item.tier} / ${humanize(item.relationship)}`
                    : `Run ${shortId(item.runId)}`}
                </span>
              </Button>
            ))}
          </div>
          <div className="grid gap-4 p-4">
            <div>
              <p className="text-sm font-semibold">{selected.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {selected.summary}
              </p>
            </div>
            {selected.kind === "link" ? (
              <>
                <dl className="grid gap-2 text-xs">
                  <div>
                    <dt className="text-muted-foreground">Candidate</dt>
                    <dd className="mt-0.5">
                      {selected.from.label}{" "}
                      <ArrowRight
                        className="mx-1 inline size-3"
                        aria-hidden="true"
                      />{" "}
                      {selected.to.label}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Source identity</dt>
                    <dd className="mt-0.5 font-mono">
                      {shortId(selected.sourceIdentityHash)}
                    </dd>
                  </div>
                </dl>
                {selected.previousReviews.length === 0 ? null : (
                  <div className="border-l-2 border-amber-500 px-3 py-2 text-xs">
                    <p className="font-medium text-amber-800 dark:text-amber-300">
                      Previous decision is stale
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      The source identity changed, so the earlier decision was
                      not reused.
                    </p>
                  </div>
                )}
                {selected.competingEvidence.length === 0 ? null : (
                  <details>
                    <summary className="min-h-11 cursor-pointer py-3 text-xs font-medium focus-visible:outline-2 focus-visible:outline-primary">
                      Competing evidence ({selected.competingEvidence.length})
                    </summary>
                    <ul className="grid gap-2">
                      {selected.competingEvidence.map((evidence) => (
                        <li
                          key={evidence.id}
                          className="border-l-2 border-border pl-3 text-xs"
                        >
                          <span className="font-mono">
                            Tier {evidence.tier}
                          </span>
                          <p className="mt-1 text-muted-foreground">
                            {evidence.explanation}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            ) : (
              <p className="font-mono text-[0.6875rem] text-muted-foreground">
                Decision {selected.decisionId} / run {shortId(selected.runId)}
              </p>
            )}
            {selected.kind === "link" &&
            selected.currentReview !== undefined ? (
              <div className="border-l-2 border-emerald-500 px-3 py-2 text-xs">
                <p className="font-medium">
                  {humanize(selected.currentReview.decision)} by reviewer
                </p>
                <p className="mt-1 text-muted-foreground">
                  {selected.currentReview.reason}
                </p>
              </div>
            ) : selected.kind === "interrupt" &&
              selected.status === "responded" ? (
              <p className="text-xs text-emerald-700 dark:text-emerald-300">
                This interrupt has been answered.
              </p>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <Label
                    htmlFor="review-reason"
                    className="text-xs leading-normal font-medium"
                  >
                    Decision reason
                  </Label>
                  <Textarea
                    id="review-reason"
                    rows={4}
                    maxLength={4096}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    className="min-h-24 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    placeholder="Record the evidence behind this decision"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    className="min-h-11 rounded-md"
                    disabled={busy === "decision" || reason.trim().length < 3}
                    onClick={() => void decide("accepted")}
                  >
                    {busy === "decision" ? (
                      <LoaderCircle
                        className="animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : (
                      <CheckCircle2 aria-hidden="true" />
                    )}
                    Accept
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 rounded-md"
                    disabled={busy === "decision" || reason.trim().length < 3}
                    onClick={() => void decide("rejected")}
                  >
                    <XCircle aria-hidden="true" />
                    Reject
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {page.nextCursor === undefined ? null : (
        <div className="border-t border-border p-3">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full rounded-md"
            disabled={busy === "reviews"}
            onClick={onLoadMore}
          >
            {busy === "reviews" ? (
              <LoaderCircle
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <ChevronDown aria-hidden="true" />
            )}
            Load more reviews
          </Button>
        </div>
      )}
    </aside>
  )
}

export function KnowledgeWorkspace({
  initialOverview,
  initialCoverage,
  initialWorkflows,
  initialReviews,
  initialPath,
}: {
  readonly initialOverview: KnowledgeOverview
  readonly initialCoverage: CoveragePage
  readonly initialWorkflows: WorkflowCoveragePage
  readonly initialReviews: KnowledgeReviewPage
  readonly initialPath: EvidencePath | null
}) {
  const [view, setView] = useState<View>("requirements")
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("coverage")
  const [coverage, setCoverage] = useState(initialCoverage)
  const [workflows, setWorkflows] = useState(initialWorkflows)
  const [reviews, setReviews] = useState(initialReviews)
  const [path, setPath] = useState(initialPath)
  const [status, setStatus] = useState("all")
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState<Busy>(null)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [excerpt, setExcerpt] = useState<PrivateArtifactExcerpt | null>(null)
  const excerptCloseRef = useRef<HTMLButtonElement>(null)
  const applicationId = initialOverview.application.id

  useEffect(() => {
    if (excerpt === null) return
    excerptCloseRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExcerpt(null)
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [excerpt])

  const unresolvedCount = useMemo(
    () =>
      coverage.items.filter((item) =>
        ["blocked", "not_observed", "not_evaluated", "ambiguous"].includes(
          item.status
        )
      ).length,
    [coverage.items]
  )

  async function loadCoverage(cursor?: string) {
    setBusy("coverage")
    setError("")
    try {
      const params = new URLSearchParams({ status, query, limit: "20" })
      if (cursor !== undefined) params.set("cursor", cursor)
      const response = await fetch(
        `/api/knowledge/applications/${encodeURIComponent(applicationId)}/coverage?${params}`,
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        }
      )
      if (!response.ok) throw new Error("coverage_failed")
      const next = coveragePageSchema.parse(await response.json())
      setCoverage(
        cursor === undefined
          ? next
          : { ...next, items: [...coverage.items, ...next.items] }
      )
    } catch {
      setError(
        "Coverage could not be refreshed. The last loaded results remain visible."
      )
    } finally {
      setBusy(null)
    }
  }

  async function loadWorkflows(cursor?: string) {
    setBusy("coverage")
    setError("")
    try {
      const params = new URLSearchParams({ limit: "20" })
      if (cursor !== undefined) params.set("cursor", cursor)
      const response = await fetch(
        `/api/knowledge/applications/${encodeURIComponent(applicationId)}/workflows?${params}`,
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        }
      )
      if (!response.ok) throw new Error("workflows_failed")
      const next = workflowCoveragePageSchema.parse(await response.json())
      setWorkflows(
        cursor === undefined
          ? next
          : { ...next, items: [...workflows.items, ...next.items] }
      )
    } catch {
      setError("Workflow coverage could not be refreshed.")
    } finally {
      setBusy(null)
    }
  }

  async function loadPath(requirementId: string) {
    setBusy("path")
    setError("")
    try {
      const response = await fetch(
        `/api/knowledge/applications/${encodeURIComponent(applicationId)}/paths/${encodeURIComponent(requirementId)}`,
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        }
      )
      if (response.status === 404) {
        setPath(null)
        return
      }
      if (!response.ok) throw new Error("path_failed")
      setPath(evidencePathSchema.parse(await response.json()))
      document
        .getElementById("evidence-path-heading")
        ?.scrollIntoView({ behavior: "smooth", block: "start" })
    } catch {
      setError("The selected evidence path could not be loaded.")
    } finally {
      setBusy(null)
    }
  }

  async function loadReviews(cursor?: string) {
    setBusy("reviews")
    setError("")
    try {
      const params = new URLSearchParams({ limit: "20" })
      if (cursor !== undefined) params.set("cursor", cursor)
      const response = await fetch(
        `/api/knowledge/applications/${encodeURIComponent(applicationId)}/reviews?${params}`,
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        }
      )
      if (!response.ok) throw new Error("reviews_failed")
      const next = knowledgeReviewPageSchema.parse(await response.json())
      setReviews(
        cursor === undefined
          ? next
          : { ...next, items: [...reviews.items, ...next.items] }
      )
    } catch {
      setError("The review queue could not be refreshed.")
    } finally {
      setBusy(null)
    }
  }

  async function loadExcerpt(artifactId: string) {
    setBusy("excerpt")
    setError("")
    try {
      const response = await fetch(
        `/api/knowledge/applications/${encodeURIComponent(applicationId)}/artifacts/${encodeURIComponent(artifactId)}/excerpt`,
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        }
      )
      if (!response.ok) throw new Error("excerpt_failed")
      setExcerpt(privateArtifactExcerptSchema.parse(await response.json()))
    } catch {
      setError("The private source excerpt is unavailable.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <main className="min-h-full bg-background text-foreground">
      <SummaryBand overview={initialOverview} />
      {error.length === 0 ? null : (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive sm:px-6"
        >
          <AlertTriangle className="size-4" aria-hidden="true" />
          {error}
        </div>
      )}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {message}
      </p>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <Tabs
          value={workspaceView}
          onValueChange={(value) => setWorkspaceView(value as WorkspaceView)}
        >
          <TabsList aria-label="Knowledge views">
            <TabsTrigger value="coverage">Coverage</TabsTrigger>
            <TabsTrigger value="graph">Graph</TabsTrigger>
            <TabsTrigger value="reviews">Reviews</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {workspaceView === "coverage" ? (
        <div className="min-w-0">
          <div className="min-w-0">
            <section aria-labelledby="coverage-heading" className="p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <BookOpenCheck
                      className="size-4 text-primary"
                      aria-hidden="true"
                    />
                    <h3 id="coverage-heading" className="text-sm font-semibold">
                      Coverage
                    </h3>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Missing links are unknown until a bounded assessment records
                    otherwise. {unresolvedCount} loaded requirements need
                    attention.
                  </p>
                </div>
                <div
                  className="flex rounded-md border border-border p-0.5"
                  role="group"
                  aria-label="Coverage view"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    aria-pressed={view === "requirements"}
                    className={cn(
                      "h-auto min-h-10 rounded-sm px-3 text-xs",
                      view === "requirements"
                        ? "bg-muted"
                        : "text-muted-foreground hover:bg-transparent hover:text-foreground"
                    )}
                    onClick={() => setView("requirements")}
                  >
                    Requirements
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-pressed={view === "workflows"}
                    className={cn(
                      "h-auto min-h-10 rounded-sm px-3 text-xs",
                      view === "workflows"
                        ? "bg-muted"
                        : "text-muted-foreground hover:bg-transparent hover:text-foreground"
                    )}
                    onClick={() => setView("workflows")}
                  >
                    Workflows
                  </Button>
                </div>
              </div>
              {view === "requirements" ? (
                <>
                  <form
                    className="mt-4 grid gap-2 sm:grid-cols-[minmax(12rem,1fr)_12rem_auto]"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void loadCoverage()
                    }}
                  >
                    <Label className="relative block">
                      <span className="sr-only">Search requirements</span>
                      <Search
                        className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <Input
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search requirements"
                        className="min-h-11 w-full rounded-md border border-input bg-background pr-3 pl-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    </Label>
                    <Label className="block">
                      <span className="sr-only">Coverage status</span>
                      <NativeSelect
                        value={status}
                        onChange={(event) => setStatus(event.target.value)}
                        className="w-full [&>select]:min-h-11 [&>select]:rounded-md [&>select]:bg-background"
                      >
                        <NativeSelectOption value="all">
                          All coverage
                        </NativeSelectOption>
                        {Object.entries(coverageLabels).map(
                          ([value, label]) => (
                            <NativeSelectOption key={value} value={value}>
                              {label}
                            </NativeSelectOption>
                          )
                        )}
                      </NativeSelect>
                    </Label>
                    <Button
                      type="submit"
                      variant="outline"
                      className="min-h-11 rounded-md"
                      disabled={busy === "coverage"}
                    >
                      {busy === "coverage" ? (
                        <LoaderCircle
                          className="animate-spin motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                      ) : (
                        <Search aria-hidden="true" />
                      )}
                      Apply
                    </Button>
                  </form>
                  <div className="mt-4">
                    <CoverageTable
                      page={coverage}
                      onTrace={(id) => {
                        void loadPath(id)
                        setWorkspaceView("graph")
                      }}
                      onLoadMore={() => void loadCoverage(coverage.nextCursor)}
                      busy={busy}
                    />
                  </div>
                </>
              ) : (
                <div className="mt-4">
                  <WorkflowTable page={workflows} />
                  {workflows.nextCursor === undefined ? null : (
                    <Button
                      type="button"
                      variant="outline"
                      className="mt-3 min-h-11 rounded-md"
                      onClick={() => void loadWorkflows(workflows.nextCursor)}
                      disabled={busy === "coverage"}
                    >
                      <ChevronDown aria-hidden="true" />
                      Load more workflows
                    </Button>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>
      ) : workspaceView === "graph" ? (
        <div>
          <KnowledgeGraphExplorer
            applicationId={applicationId}
            initialSeedId={path?.requirementId}
          />
          <details className="border-t border-border bg-muted/10">
            <summary className="min-h-11 cursor-pointer px-4 py-3 text-xs font-medium sm:px-6">
              Evidence path details
            </summary>
            <EvidencePathPanel
              path={path}
              onExcerpt={(id) => void loadExcerpt(id)}
              busy={busy}
            />
          </details>
        </div>
      ) : (
        <div className="mx-auto max-w-5xl border-x border-border bg-background">
          <ReviewPanel
            page={reviews}
            applicationId={applicationId}
            onPage={setReviews}
            busy={busy}
            setBusy={setBusy}
            setMessage={setMessage}
            onLoadMore={() => void loadReviews(reviews.nextCursor)}
          />
        </div>
      )}
      <div className="fixed right-4 bottom-4 flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="rounded-md bg-background"
          title="Refresh review queue"
          aria-label="Refresh review queue"
          disabled={busy === "reviews"}
          onClick={() => void loadReviews()}
        >
          {busy === "reviews" ? (
            <LoaderCircle
              className="animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <RefreshCw aria-hidden="true" />
          )}
        </Button>
      </div>
      {excerpt === null ? null : (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Private source excerpt"
          className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setExcerpt(null)
          }}
        >
          <div className="grid max-h-[80svh] w-full max-w-2xl grid-rows-[auto_minmax(0,1fr)] border border-border bg-background">
            <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <h3 id="excerpt-heading" className="text-sm font-semibold">
                  Private source excerpt
                </h3>
                <p className="font-mono text-[0.6875rem] text-muted-foreground">
                  {shortId(excerpt.artifactId)} / {excerpt.mimeType}
                  {excerpt.truncated ? " / truncated" : ""}
                </p>
              </div>
              <Button
                ref={excerptCloseRef}
                type="button"
                variant="ghost"
                size="icon"
                className="rounded-md"
                aria-label="Close excerpt"
                title="Close excerpt"
                onClick={() => setExcerpt(null)}
              >
                <XCircle aria-hidden="true" />
              </Button>
            </header>
            <pre className="overflow-auto p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
              {excerpt.excerpt}
            </pre>
          </div>
        </div>
      )}
    </main>
  )
}
