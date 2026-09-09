"use client"

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Download,
  ExternalLink,
  FileText,
  GitCommitHorizontal,
  LoaderCircle,
  Network,
  Printer,
  ShieldAlert,
  X,
} from "lucide-react"
import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  privateArtifactExcerptSchema,
  type AssessmentReportView,
  type PrivateArtifactExcerpt,
} from "@sentinel/contracts"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type Finding = AssessmentReportView["findings"][number]
type EvidencePath = Finding["evidencePaths"][number]

const sectionLinks = [
  ["identity", "Identity"],
  ["executive-summary", "Executive summary"],
  ["product-areas", "Product areas"],
  ["user-interface", "User interface"],
  ["workflows", "Workflows"],
  ["requirements", "Requirements"],
  ["evidence", "Evidence"],
  ["recommended-qa", "Recommended QA"],
  ["verification", "Verification"],
  ["unknowns-exclusions", "Unknowns & exclusions"],
  ["generation", "Generation"],
] as const

function humanize(value: string) {
  return value
    .split("_")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ")
}

function shortIdentity(value: string) {
  const final = value.split(":").at(-1) ?? value
  return final.length > 12 ? final.slice(0, 12) : final
}

function riskTone(risk: AssessmentReportView["overallRisk"]) {
  if (risk === "high")
    return "border-destructive/35 bg-destructive/8 text-destructive"
  if (risk === "medium")
    return "border-amber-500/40 bg-amber-500/8 text-amber-800 dark:text-amber-300"
  if (risk === "low")
    return "border-emerald-600/30 bg-emerald-600/8 text-emerald-800 dark:text-emerald-300"
  return "border-border bg-muted text-foreground"
}

function verificationTone(
  status: AssessmentReportView["verification"]["status"]
) {
  if (status === "failed" || status === "behavior_changed")
    return "border-destructive/35 bg-destructive/8 text-destructive"
  if (status === "passed")
    return "border-emerald-600/30 bg-emerald-600/8 text-emerald-800 dark:text-emerald-300"
  if (status === "blocked")
    return "border-amber-500/40 bg-amber-500/8 text-amber-800 dark:text-amber-300"
  return "border-border bg-muted text-muted-foreground"
}

function sourceLink(uri: string) {
  return uri.startsWith("https://") || uri.startsWith("http://")
}

function StatusMark({
  kind,
}: {
  readonly kind: "risk" | "evidence" | "verification"
}) {
  if (kind === "verification")
    return <CheckCircle2 className="size-4" aria-hidden="true" />
  if (kind === "risk")
    return <ShieldAlert className="size-4" aria-hidden="true" />
  return <Network className="size-4" aria-hidden="true" />
}

function ReportSection({
  id,
  eyebrow,
  title,
  children,
  className,
}: {
  readonly id: string
  readonly eyebrow: string
  readonly title: string
  readonly children: React.ReactNode
  readonly className?: string
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className={cn(
        "report-section scroll-mt-20 border-t border-border py-8",
        className
      )}
    >
      <div className="grid gap-5 lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8">
        <div>
          <p className="font-mono text-[0.6875rem] text-muted-foreground uppercase">
            {eyebrow}
          </p>
          <h2 id={`${id}-heading`} className="mt-1 text-base font-semibold">
            {title}
          </h2>
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  )
}

function EmptyScope({ children }: { readonly children: React.ReactNode }) {
  return (
    <p className="border-l-2 border-border px-4 py-2 text-sm text-muted-foreground">
      {children}
    </p>
  )
}

function FindingSummary({ finding }: { readonly finding: Finding }) {
  return (
    <article className="report-finding border-t border-border py-5 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex rounded-sm border px-2 py-1 text-[0.6875rem] font-semibold uppercase",
            riskTone(finding.risk)
          )}
        >
          {finding.risk} risk
        </span>
        <span className="inline-flex rounded-sm border border-border px-2 py-1 font-mono text-[0.6875rem] text-muted-foreground">
          Evidence {finding.evidenceStrength}
        </span>
        <span className="text-xs text-muted-foreground">
          {humanize(finding.targetKind)}
        </span>
      </div>
      <h3 className="mt-3 text-sm font-semibold">{finding.title}</h3>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
        {finding.summary}
      </p>
      <p className="mt-3 font-mono text-[0.6875rem] break-all text-muted-foreground">
        Finding {shortIdentity(finding.id)}
        {finding.targetId === undefined
          ? " / unresolved target"
          : ` / target ${shortIdentity(finding.targetId)}`}
      </p>
    </article>
  )
}

function FindingList({
  findings,
  empty,
}: {
  readonly findings: readonly Finding[]
  readonly empty: string
}) {
  if (findings.length === 0) return <EmptyScope>{empty}</EmptyScope>
  return (
    <div>
      {findings.map((finding) => (
        <FindingSummary key={finding.id} finding={finding} />
      ))}
    </div>
  )
}

function EvidenceReference({
  assessmentId,
  reference,
  onArtifact,
}: {
  readonly assessmentId: string
  readonly reference: EvidencePath["references"][number]
  readonly onArtifact: (artifactId: string, trigger: HTMLButtonElement) => void
}) {
  return (
    <li className="grid gap-2 border-t border-border py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono text-foreground">
          {shortIdentity(reference.id)}
        </span>
        <span className="text-muted-foreground">
          {humanize(reference.extractionMethod)}
        </span>
      </div>
      {reference.sourceUris.length > 0 ? (
        <ul aria-label="Evidence sources" className="grid gap-1.5">
          {reference.sourceUris.map((uri) => (
            <li key={uri} className="min-w-0 text-xs">
              {sourceLink(uri) ? (
                <a
                  href={uri}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex max-w-full items-center gap-1 text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <span className="truncate">{uri}</span>
                  <ExternalLink
                    className="size-3 shrink-0"
                    aria-hidden="true"
                  />
                </a>
              ) : (
                <span className="font-mono break-all text-muted-foreground">
                  {uri}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {reference.artifactIds.length > 0 ? (
        <div className="report-screen-only flex flex-wrap gap-2">
          {reference.artifactIds.map((artifactId) => (
            <Button
              key={artifactId}
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 rounded-md"
              onClick={(event) =>
                onArtifact(artifactId, event.currentTarget as HTMLButtonElement)
              }
              aria-label={`View private artifact excerpt ${shortIdentity(artifactId)}`}
            >
              <FileText aria-hidden="true" />
              Private excerpt
            </Button>
          ))}
        </div>
      ) : null}
      <span className="sr-only">Assessment {assessmentId}</span>
    </li>
  )
}

function EvidencePathDetail({
  assessmentId,
  path,
  onArtifact,
}: {
  readonly assessmentId: string
  readonly path: EvidencePath
  readonly onArtifact: (artifactId: string, trigger: HTMLButtonElement) => void
}) {
  return (
    <details className="report-details report-evidence-path border-t border-border first:border-t-0">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 py-3 text-sm focus-visible:outline-2 focus-visible:outline-primary">
        <span className="min-w-0">
          <span className="font-medium">Evidence path</span>{" "}
          <span className="font-mono text-xs text-muted-foreground">
            {shortIdentity(path.id)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          Strength {path.evidenceStrength}
          <ChevronDown
            className="details-open:rotate-180 size-4"
            aria-hidden="true"
          />
        </span>
      </summary>
      <div className="grid gap-4 pb-5">
        <ol aria-label="Evidence path nodes" className="grid gap-0">
          {path.nodes.map((node, index) => (
            <li
              key={`${path.id}-${node.id}`}
              className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3"
            >
              <div className="grid justify-items-center">
                <span className="grid size-7 place-items-center rounded-sm border border-border bg-muted font-mono text-[0.6875rem]">
                  {index + 1}
                </span>
                {index === path.nodes.length - 1 ? null : (
                  <span className="h-full w-px bg-border" aria-hidden="true" />
                )}
              </div>
              <div className="min-w-0 pb-4">
                <p className="text-sm font-medium">{node.title}</p>
                <p className="mt-0.5 font-mono text-[0.6875rem] break-all text-muted-foreground">
                  {humanize(node.kind)} / {shortIdentity(node.id)}
                </p>
              </div>
            </li>
          ))}
        </ol>
        <div>
          <p className="text-xs font-medium">Citations</p>
          {path.references.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Evidence IDs are recorded, but no source or artifact reference was
              attached.
            </p>
          ) : (
            <ul className="mt-2 border-y border-border">
              {path.references.map((reference) => (
                <EvidenceReference
                  key={reference.id}
                  assessmentId={assessmentId}
                  reference={reference}
                  onArtifact={onArtifact}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </details>
  )
}

function FindingEvidence({
  assessmentId,
  finding,
  onArtifact,
}: {
  readonly assessmentId: string
  readonly finding: Finding
  readonly onArtifact: (artifactId: string, trigger: HTMLButtonElement) => void
}) {
  return (
    <article className="report-finding border-t border-border py-5 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{finding.title}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {finding.evidencePaths.length} inspectable path
            {finding.evidencePaths.length === 1 ? "" : "s"} /{" "}
            {finding.changedSymbolIds.length} changed symbol
            {finding.changedSymbolIds.length === 1 ? "" : "s"}
          </p>
        </div>
        <span className="rounded-sm border border-border px-2 py-1 font-mono text-[0.6875rem]">
          {shortIdentity(finding.id)}
        </span>
      </div>
      {finding.evidencePaths.length === 0 ? (
        <p className="mt-4 border-l-2 border-border px-4 py-2 text-sm text-muted-foreground">
          No inspectable evidence path was established for this unknown finding.
        </p>
      ) : (
        <div className="mt-4 border-y border-border">
          {finding.evidencePaths.map((path) => (
            <EvidencePathDetail
              key={path.id}
              assessmentId={assessmentId}
              path={path}
              onArtifact={onArtifact}
            />
          ))}
        </div>
      )}
      {finding.changedSymbolIds.length > 0 ? (
        <details className="report-details mt-4 border-l-2 border-border pl-4">
          <summary className="min-h-11 cursor-pointer py-3 text-xs font-medium focus-visible:outline-2 focus-visible:outline-primary">
            Changed symbols ({finding.changedSymbolIds.length})
          </summary>
          <ul className="grid gap-1 pb-3 font-mono text-[0.6875rem] text-muted-foreground">
            {finding.changedSymbolIds.map((symbolId) => (
              <li key={symbolId} className="break-all">
                {symbolId}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {finding.caveats.length > 0 ? (
        <div className="mt-4 border-l-2 border-amber-500/60 px-4 py-2">
          <p className="text-xs font-medium">Evidence caveats</p>
          <ul className="mt-2 grid gap-1 text-xs leading-5 text-muted-foreground">
            {finding.caveats.map((caveat) => (
              <li key={caveat.id}>{caveat.summary}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  )
}

function ExcerptDialog({
  excerpt,
  artifactId,
  loading,
  error,
  closeRef,
  onClose,
}: {
  readonly excerpt: PrivateArtifactExcerpt | null
  readonly artifactId: string
  readonly loading: boolean
  readonly error: string
  readonly closeRef: React.RefObject<HTMLButtonElement | null>
  readonly onClose: () => void
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-excerpt-heading"
      className="report-screen-only fixed inset-0 z-50 grid place-items-center bg-foreground/35 p-4"
    >
      <div className="w-full max-w-2xl border border-border bg-background text-foreground">
        <header className="flex min-h-14 items-center justify-between gap-4 border-b border-border px-4 py-2">
          <div className="min-w-0">
            <h2 id="report-excerpt-heading" className="text-sm font-semibold">
              Private evidence excerpt
            </h2>
            <p className="mt-0.5 truncate font-mono text-[0.6875rem] text-muted-foreground">
              {artifactId}
            </p>
          </div>
          <Button
            ref={closeRef}
            type="button"
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 rounded-md"
            onClick={onClose}
            aria-label="Close private evidence excerpt"
            title="Close"
          >
            <X aria-hidden="true" />
          </Button>
        </header>
        <div className="max-h-[70svh] overflow-auto p-4">
          {loading ? (
            <div
              role="status"
              className="flex min-h-36 items-center justify-center gap-2 text-sm text-muted-foreground"
            >
              <LoaderCircle
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              Loading private excerpt
            </div>
          ) : error.length > 0 ? (
            <div
              role="alert"
              className="border-l-2 border-destructive bg-destructive/5 px-4 py-3 text-sm text-destructive"
            >
              {error}
            </div>
          ) : excerpt === null ? null : (
            <div>
              <p className="mb-3 text-xs text-muted-foreground">
                {excerpt.mimeType}
                {excerpt.truncated
                  ? " / bounded excerpt"
                  : " / complete excerpt"}
              </p>
              <pre className="overflow-auto border-y border-border bg-muted/35 p-4 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
                {excerpt.excerpt}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function AssessmentReportWorkspace({
  report,
}: {
  readonly report: AssessmentReportView
}) {
  const [artifactId, setArtifactId] = useState("")
  const [excerpt, setExcerpt] = useState<PrivateArtifactExcerpt | null>(null)
  const [excerptLoading, setExcerptLoading] = useState(false)
  const [excerptError, setExcerptError] = useState("")
  const closeRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const uiFindings = useMemo(
    () =>
      report.findings.filter(
        ({ targetKind }) =>
          targetKind === "ui-element" || targetKind === "screen"
      ),
    [report.findings]
  )
  const workflowFindings = useMemo(
    () => report.findings.filter(({ targetKind }) => targetKind === "workflow"),
    [report.findings]
  )
  const requirementFindings = useMemo(
    () =>
      report.findings.filter(({ targetKind }) => targetKind === "requirement"),
    [report.findings]
  )
  const scenarios = useMemo(
    () =>
      report.findings.flatMap((finding) =>
        finding.scenarios.map((scenario) => ({ finding, scenario }))
      ),
    [report.findings]
  )

  const handleCloseExcerpt = useCallback(() => {
    setArtifactId("")
    setExcerpt(null)
    setExcerptError("")
  }, [])

  useEffect(() => {
    if (artifactId.length === 0) return
    closeRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleCloseExcerpt()
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [artifactId, handleCloseExcerpt])

  useEffect(() => {
    if (artifactId.length === 0) triggerRef.current?.focus()
  }, [artifactId])

  useEffect(() => {
    let closedDetails: HTMLDetailsElement[] = []
    const handleBeforePrint = () => {
      closedDetails = Array.from(
        document.querySelectorAll<HTMLDetailsElement>(
          ".report-document details:not([open])"
        )
      )
      for (const detail of closedDetails) detail.open = true
    }
    const handleAfterPrint = () => {
      for (const detail of closedDetails) detail.open = false
      closedDetails = []
    }
    window.addEventListener("beforeprint", handleBeforePrint)
    window.addEventListener("afterprint", handleAfterPrint)
    return () => {
      window.removeEventListener("beforeprint", handleBeforePrint)
      window.removeEventListener("afterprint", handleAfterPrint)
    }
  }, [])

  async function handleArtifact(
    nextArtifactId: string,
    trigger: HTMLButtonElement
  ) {
    triggerRef.current = trigger
    setArtifactId(nextArtifactId)
    setExcerpt(null)
    setExcerptError("")
    setExcerptLoading(true)
    try {
      const response = await fetch(
        `/api/assessments/${encodeURIComponent(report.assessmentId)}/artifacts/${encodeURIComponent(nextArtifactId)}/excerpt`,
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        }
      )
      if (!response.ok) throw new Error("excerpt_failed")
      setExcerpt(privateArtifactExcerptSchema.parse(await response.json()))
    } catch {
      setExcerptError(
        "This private excerpt could not be loaded. The report remains available."
      )
    } finally {
      setExcerptLoading(false)
    }
  }

  return (
    <main className="min-h-svh bg-background text-foreground">
      <header className="report-screen-only flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2 sm:px-6">
        <div className="flex items-center gap-3">
          <span className="grid size-7 place-items-center rounded-md bg-foreground font-mono text-xs font-semibold text-background">
            S
          </span>
          <div>
            <p className="text-sm font-semibold">Sentinel</p>
            <p className="font-mono text-[0.6875rem] text-muted-foreground">
              Assessment report
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
            className="min-h-11 rounded-md px-3 leading-[2.75rem] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
          >
            Activity
          </Link>
        </nav>
      </header>

      <div className="report-screen-only border-b border-border bg-muted/30 px-4 py-2 sm:px-6">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-2">
          <Link
            href="/runs"
            className="inline-flex min-h-11 items-center gap-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
          >
            <ArrowRight className="size-3 rotate-180" aria-hidden="true" />
            Back to activity
          </Link>
          <div className="flex flex-wrap gap-2">
            <a
              href={`/api/assessments/${encodeURIComponent(report.assessmentId)}/download`}
              className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-input/30 px-3 text-sm font-medium hover:bg-input/50 focus-visible:outline-2 focus-visible:outline-primary"
            >
              <Download className="size-4" aria-hidden="true" />
              Markdown
            </a>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 rounded-md"
              onClick={() => window.print()}
            >
              <Printer aria-hidden="true" />
              Print
            </Button>
          </div>
        </div>
      </div>

      <div className="report-layout mx-auto grid w-full max-w-7xl gap-8 px-4 py-6 sm:px-6 lg:grid-cols-[12rem_minmax(0,1fr)] lg:py-8">
        <aside className="report-screen-only hidden lg:block">
          <nav
            aria-label="Report sections"
            className="sticky top-4 border-l border-border pl-3"
          >
            <p className="mb-2 px-2 font-mono text-[0.6875rem] text-muted-foreground uppercase">
              Report contents
            </p>
            <ul className="grid gap-0.5">
              {sectionLinks.map(([id, label]) => (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    className="block rounded-sm px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </aside>

        <article className="report-document min-w-0">
          <section
            id="identity"
            aria-labelledby="report-title"
            className="scroll-mt-20 pb-8"
          >
            <div className="flex flex-wrap items-center gap-2 font-mono text-[0.6875rem] text-muted-foreground">
              <span>{report.repository.host}</span>
              <span aria-hidden="true">/</span>
              <span>
                {report.repository.owner}/{report.repository.name}
              </span>
              <span aria-hidden="true">/</span>
              <span>PR #{report.pullRequestNumber}</span>
            </div>
            <h1
              id="report-title"
              className="mt-3 max-w-4xl text-2xl font-semibold sm:text-3xl"
            >
              {report.pullRequestTitle}
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
              Evidence-grounded blast-radius assessment for product and QA
              review. Predicted risk is not a safety guarantee or a substitute
              for verification.
            </p>

            <dl className="mt-6 grid grid-cols-2 border-y border-border sm:grid-cols-4">
              <div className="border-r border-b border-border p-3 sm:border-b-0">
                <dt className="flex items-center gap-2 text-[0.6875rem] text-muted-foreground uppercase">
                  <StatusMark kind="risk" />
                  Predicted risk
                </dt>
                <dd
                  className={cn(
                    "mt-2 inline-flex rounded-sm border px-2 py-1 text-xs font-semibold uppercase",
                    riskTone(report.overallRisk)
                  )}
                >
                  {report.overallRisk}
                </dd>
              </div>
              <div className="border-b border-border p-3 sm:border-r sm:border-b-0">
                <dt className="flex items-center gap-2 text-[0.6875rem] text-muted-foreground uppercase">
                  <StatusMark kind="evidence" />
                  Evidence
                </dt>
                <dd className="mt-2 font-mono text-sm font-semibold">
                  Strength {report.overallEvidenceStrength}
                </dd>
              </div>
              <div className="border-r border-border p-3">
                <dt className="flex items-center gap-2 text-[0.6875rem] text-muted-foreground uppercase">
                  <StatusMark kind="verification" />
                  Verification
                </dt>
                <dd
                  className={cn(
                    "mt-2 inline-flex rounded-sm border px-2 py-1 text-xs font-semibold",
                    verificationTone(report.verification.status)
                  )}
                >
                  {humanize(report.verification.status)}
                </dd>
              </div>
              <div className="p-3">
                <dt className="flex items-center gap-2 text-[0.6875rem] text-muted-foreground uppercase">
                  <GitCommitHorizontal className="size-4" aria-hidden="true" />
                  Head
                </dt>
                <dd className="mt-2 font-mono text-xs" title={report.headSha}>
                  {report.headSha.slice(0, 12)}
                </dd>
              </div>
            </dl>
          </section>

          <ReportSection
            id="executive-summary"
            eyebrow="01 / Decision context"
            title="Executive summary"
          >
            <p className="max-w-3xl text-base leading-7">
              {report.executiveSummary}
            </p>
            <div className="mt-5 flex gap-3 border-l-2 border-amber-500/60 bg-amber-500/5 px-4 py-3 text-sm leading-6">
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300"
                aria-hidden="true"
              />
              <p>
                Use this report to prioritize QA. Unknown or unobserved scope
                means evidence is incomplete; it does not establish no impact.
              </p>
            </div>
          </ReportSection>

          <ReportSection
            id="product-areas"
            eyebrow="02 / Blast radius"
            title="Affected product areas"
          >
            <dl className="grid grid-cols-2 border border-border sm:grid-cols-4">
              {[
                ["UI & screens", uiFindings.length],
                ["Workflows", workflowFindings.length],
                ["Requirements", requirementFindings.length],
                ["Unknown", report.unknowns.length],
              ].map(([label, value], index) => (
                <div
                  key={String(label)}
                  className={cn(
                    "p-3",
                    index < 3 && "border-r border-border",
                    index < 2 && "max-sm:border-b"
                  )}
                >
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-1 font-mono text-xl font-semibold">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </ReportSection>

          <ReportSection
            id="user-interface"
            eyebrow="03 / Product surface"
            title="User interface"
          >
            <FindingList
              findings={uiFindings}
              empty="No UI impact path was established within the assessed scope."
            />
          </ReportSection>

          <ReportSection
            id="workflows"
            eyebrow="04 / Product flow"
            title="Workflows"
          >
            <FindingList
              findings={workflowFindings}
              empty="No workflow impact path was established within the assessed scope."
            />
          </ReportSection>

          <ReportSection
            id="requirements"
            eyebrow="05 / Coverage"
            title="Requirements at risk"
          >
            <FindingList
              findings={requirementFindings}
              empty="No requirement impact path was established within the assessed scope."
            />
            {report.coverage.length > 0 ? (
              <div className="mt-6 overflow-x-auto border-y border-border">
                <table className="w-full min-w-[38rem] border-collapse text-left text-xs">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Requirement
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Status
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Assessed scope
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {report.coverage.map((item) => (
                      <tr key={item.requirementId}>
                        <th
                          scope="row"
                          className="max-w-md px-3 py-3 align-top font-normal"
                        >
                          <p className="text-sm font-medium">{item.wording}</p>
                          <p className="mt-1 font-mono text-[0.6875rem] text-muted-foreground">
                            {shortIdentity(item.requirementId)}
                          </p>
                        </th>
                        <td className="px-3 py-3 align-top">
                          <span className="inline-flex rounded-sm border border-border px-2 py-1 font-medium">
                            {humanize(item.status)}
                          </span>
                        </td>
                        <td className="max-w-sm px-3 py-3 align-top leading-5 text-muted-foreground">
                          {item.scope}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </ReportSection>

          <ReportSection
            id="evidence"
            eyebrow="06 / Provenance"
            title="Why items were flagged"
          >
            <div>
              {report.findings.map((finding) => (
                <FindingEvidence
                  key={finding.id}
                  assessmentId={report.assessmentId}
                  finding={finding}
                  onArtifact={handleArtifact}
                />
              ))}
            </div>
          </ReportSection>

          <ReportSection
            id="recommended-qa"
            eyebrow="07 / Action"
            title="Recommended QA"
          >
            {scenarios.length === 0 ? (
              <EmptyScope>
                No evidence-backed QA scenario could be generated for the
                assessed scope.
              </EmptyScope>
            ) : (
              <ol className="grid gap-0">
                {scenarios.map(({ finding, scenario }, index) => (
                  <li
                    key={scenario.id}
                    className="report-finding grid grid-cols-[2rem_minmax(0,1fr)] gap-3 border-t border-border py-4 first:border-t-0 first:pt-0"
                  >
                    <span className="grid size-8 place-items-center rounded-sm border border-border bg-muted font-mono text-xs">
                      {index + 1}
                    </span>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold">{finding.title}</p>
                        <span
                          className={cn(
                            "rounded-sm border px-2 py-0.5 text-[0.6875rem] uppercase",
                            riskTone(scenario.priority)
                          )}
                        >
                          {scenario.priority} priority
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {humanize(scenario.kind)} across{" "}
                        {scenario.checkpointEntityIds.length} evidence-backed
                        checkpoint
                        {scenario.checkpointEntityIds.length === 1 ? "" : "s"}.
                      </p>
                      <details className="report-details mt-2">
                        <summary className="min-h-11 cursor-pointer py-3 text-xs font-medium focus-visible:outline-2 focus-visible:outline-primary">
                          Checkpoint identities
                        </summary>
                        <ul className="grid gap-1 pb-2 font-mono text-[0.6875rem] text-muted-foreground">
                          {scenario.checkpointEntityIds.map((id) => (
                            <li key={id} className="break-all">
                              {id}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </ReportSection>

          <ReportSection
            id="verification"
            eyebrow="08 / Runtime evidence"
            title="Verification"
          >
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={cn(
                  "inline-flex rounded-sm border px-2 py-1 text-xs font-semibold",
                  verificationTone(report.verification.status)
                )}
              >
                {humanize(report.verification.status)}
              </span>
              <span className="font-mono text-[0.6875rem] text-muted-foreground">
                Enrichment version {report.verification.version}
              </span>
            </div>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
              {report.verification.reason}
            </p>
            {report.verification.results.length > 0 ? (
              <div className="mt-5 border-y border-border">
                {report.verification.results.map((result) => (
                  <details
                    key={`${result.workflowId}-${result.completedAt}`}
                    className="report-details border-t border-border first:border-t-0"
                  >
                    <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 py-3 text-sm focus-visible:outline-2 focus-visible:outline-primary">
                      <span>
                        <span className="font-medium">
                          {humanize(result.status)}
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {shortIdentity(result.workflowId)}
                        </span>
                      </span>
                      <ChevronDown
                        className="size-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </summary>
                    <div className="grid gap-4 pb-5 text-xs">
                      {"deploymentUrl" in result ? (
                        <a
                          href={result.deploymentUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex w-fit items-center gap-1 text-primary underline-offset-4 hover:underline"
                        >
                          Verified deployment
                          <ExternalLink className="size-3" aria-hidden="true" />
                        </a>
                      ) : null}
                      {result.assertions.length > 0 ? (
                        <ul className="grid gap-2">
                          {result.assertions.map((assertion) => (
                            <li
                              key={assertion.name}
                              className="flex items-start gap-2"
                            >
                              <span
                                className={
                                  assertion.passed
                                    ? "text-emerald-700 dark:text-emerald-300"
                                    : "text-destructive"
                                }
                              >
                                {assertion.passed ? "Passed" : "Failed"}
                              </span>
                              <span>{assertion.name}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <p className="font-mono text-[0.6875rem] text-muted-foreground">
                        Completed{" "}
                        {new Date(result.completedAt).toLocaleString("en-US", {
                          timeZone: "UTC",
                        })}{" "}
                        UTC
                      </p>
                    </div>
                  </details>
                ))}
              </div>
            ) : null}
          </ReportSection>

          <ReportSection
            id="unknowns-exclusions"
            eyebrow="09 / Boundaries"
            title="Unknowns and exclusions"
          >
            {report.unknowns.length === 0 && report.exclusions.length === 0 ? (
              <EmptyScope>
                No additional unknown or excluded scope was recorded.
              </EmptyScope>
            ) : (
              <div className="grid gap-5">
                {report.unknowns.length > 0 ? (
                  <div>
                    <h3 className="flex items-center gap-2 text-sm font-semibold">
                      <CircleHelp
                        className="size-4 text-amber-700 dark:text-amber-300"
                        aria-hidden="true"
                      />
                      Unknown impact
                    </h3>
                    <ul className="mt-3 grid gap-2">
                      {report.unknowns.map((finding) => (
                        <li
                          key={finding.id}
                          className="border-l-2 border-amber-500/60 px-4 py-2 text-sm leading-6"
                        >
                          <span className="font-medium">{finding.title}.</span>{" "}
                          <span className="text-muted-foreground">
                            {finding.summary}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {report.exclusions.length > 0 ? (
                  <div>
                    <h3 className="text-sm font-semibold">Excluded scope</h3>
                    <ul className="mt-3 grid gap-2 text-sm text-muted-foreground">
                      {report.exclusions.map((exclusion) => (
                        <li key={exclusion} className="flex items-start gap-2">
                          <span aria-hidden="true">-</span>
                          <span>{exclusion}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            )}
          </ReportSection>

          <ReportSection
            id="generation"
            eyebrow="10 / Reproducibility"
            title="Report generation"
            className="report-generation"
          >
            <dl className="grid gap-x-8 gap-y-4 text-xs sm:grid-cols-2">
              {[
                [
                  "Generated",
                  new Date(report.generatedAt).toLocaleString("en-US", {
                    timeZone: "UTC",
                  }) + " UTC",
                ],
                ["Report ID", report.id],
                ["Assessment ID", report.assessmentId],
                ["Graph revision", String(report.graphRevision)],
                ["Graph commit", report.graphCommitSha],
                ["Base commit", report.baseSha],
                ["Head commit", report.headSha],
                ["Policy", report.policyVersion],
                ["Template", report.templateVersion],
                ["Wording prompt", report.wordingPromptVersion],
                ["Wording mode", humanize(report.model.mode)],
                ...(report.model.mode === "validated_model_wording"
                  ? [["Model", report.model.modelId]]
                  : []),
              ].map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="mt-1 font-mono break-all">{value}</dd>
                </div>
              ))}
            </dl>
          </ReportSection>
        </article>
      </div>

      {artifactId.length > 0 ? (
        <ExcerptDialog
          excerpt={excerpt}
          artifactId={artifactId}
          loading={excerptLoading}
          error={excerptError}
          closeRef={closeRef}
          onClose={handleCloseExcerpt}
        />
      ) : null}
    </main>
  )
}
