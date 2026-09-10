import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import {
  artifactIdSchema,
  createEventId,
  publicRunSchema,
  runEventSchema,
  runIdSchema,
  type PublicRun,
  type PublicRunInterrupt,
  type RunEvent,
} from "@sentinel/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"

const realtimeStart = vi.hoisted(() => vi.fn(async () => undefined))
const realtimeWake = vi.hoisted(() => ({
  current: undefined as (() => void) | undefined,
}))

vi.mock("@/lib/realtime-client", () => ({
  createRunRealtimeSubscription: (options: { readonly onWake: () => void }) => {
    realtimeWake.current = options.onWake
    return {
      start: realtimeStart,
      stop: vi.fn().mockResolvedValue(undefined),
    }
  },
}))

import { RunActivityWorkspace } from "./run-activity-workspace"

const databaseRunId = "33333333-3333-4333-8333-333333333333"
const applicationId = "22222222-2222-4222-8222-222222222222"
const assessmentId = "00000000-0000-4000-8000-000000000029"
const contractRunId = runIdSchema.parse(`run:${databaseRunId}`)
const missionId = `mission:v1:${"b".repeat(64)}`
const screenshotArtifactId = artifactIdSchema.parse(
  `artifact:v1:${"a".repeat(64)}`
)

function run(status: PublicRun["status"] = "running"): PublicRun {
  return publicRunSchema.parse({
    schemaVersion: 1,
    id: databaseRunId,
    applicationId,
    type: "assess_pr",
    status,
    attemptCount: 0,
    createdAt: "2026-09-09T00:00:00.000Z",
    ...(status === "running" ? { startedAt: "2026-09-09T00:00:01.000Z" } : {}),
    ...(new Set(["cancelled", "succeeded", "failed"]).has(status)
      ? { finishedAt: "2026-09-09T00:01:00.000Z" }
      : {}),
    ...(status === "succeeded"
      ? {
          assessmentId,
          assessment: {
            id: assessmentId,
            repository: { host: "github.com", owner: "sentinel", name: "demo" },
            pullRequestNumber: 29,
            baseSha: "1".repeat(40),
            headSha: "2".repeat(40),
            reportAvailable: true,
          },
        }
      : {}),
    ...(status === "failed"
      ? {
          error: {
            category: "provider",
            code: "provider_unavailable",
            message: "Provider unavailable",
            retryable: true,
          },
        }
      : {}),
  })
}

function common(sequence: number) {
  return {
    schemaVersion: 1 as const,
    id: createEventId(contractRunId, sequence),
    runId: contractRunId,
    sequence,
    occurredAt: `2026-09-09T00:00:0${sequence}.000Z`,
    graphName: "synthetic_parallel_run",
    evidenceIds: [],
  }
}

function events(): readonly RunEvent[] {
  return [
    runEventSchema.parse({
      ...common(1),
      agent: "documentation",
      kind: "node_completed",
      nodeName: "read_contracts",
      status: "completed",
      summary: "Documentation contract mapped",
      reasonCode: "documentation_contract_mapped",
      activity: {
        category: "decision",
        detail: "The public contract defines a bounded checkout path.",
      },
    }),
    runEventSchema.parse({
      ...common(2),
      agent: "code",
      missionId,
      kind: "tool_completed",
      toolName: "typescript_index",
      status: "completed",
      summary: "Checkout handler indexed",
      reasonCode: "checkout_handler_indexed",
      activity: { category: "tool" },
    }),
    runEventSchema.parse({
      ...common(3),
      agent: "application",
      missionId,
      kind: "tool_completed",
      toolName: "browser_runtime",
      status: "completed",
      summary: "Checkout advanced to review",
      reasonCode: "checkout_review_reached",
      activity: {
        category: "action",
        action: {
          kind: "advance_checkout",
          label: "Advance checkout",
          status: "completed",
        },
        request: { method: "POST", route: "/api/checkout", status: 200 },
        screenshotArtifactId,
      },
    }),
    runEventSchema.parse({
      ...common(4),
      agent: "curator",
      kind: "node_completed",
      nodeName: "reconcile_evidence",
      status: "completed",
      summary: "Specialist evidence reconciled",
      reasonCode: "specialist_evidence_reconciled",
      activity: { category: "policy", coverageDelta: 3 },
    }),
    runEventSchema.parse({
      ...common(5),
      kind: "budget_updated",
      status: "completed",
      summary: "Browser budget updated",
      reasonCode: "browser_budget_updated",
      budget: { consumed: 4, limit: 20, unit: "browser_actions" },
    }),
  ]
}

function page(items: readonly RunEvent[] = events()) {
  return {
    schemaVersion: 1,
    items: items.map((event) => ({ sequence: event.sequence, event })),
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  realtimeStart.mockReset()
  realtimeStart.mockResolvedValue(undefined)
  realtimeWake.current = undefined
  window.history.replaceState(null, "", "/")
})

describe("run activity workspace", () => {
  it("renders specialist lanes, Curator, budgets, and a signed storyboard", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          schemaVersion: 1,
          runId: databaseRunId,
          artifactId: screenshotArtifactId,
          url: "https://storage.test/private-screenshot.png",
          expiresAt: "2026-09-09T00:05:00.000Z",
        })
      )
    )
    render(
      <RunActivityWorkspace
        initialRun={run()}
        initialEventPage={page()}
        live={false}
      />
    )

    expect(
      screen.getByRole("heading", { level: 2, name: "Specialist activity" })
    ).toBeDefined()
    expect(screen.getByRole("main")).not.toHaveClass("min-h-full")
    expect(
      screen.getAllByText("Documentation contract mapped").length
    ).toBeGreaterThan(0)
    expect(
      screen.getAllByText("Checkout handler indexed").length
    ).toBeGreaterThan(0)
    expect(
      screen.getAllByText("Checkout advanced to review").length
    ).toBeGreaterThan(0)
    expect(screen.getByText("Specialist evidence reconciled")).toBeDefined()
    expect(screen.getByText("4 / 20")).toBeDefined()
    expect(screen.getByText("Offline")).toBeDefined()

    const documentationTab = screen.getByRole("tab", {
      name: "Documentation",
    })
    const codeTab = screen.getByRole("tab", { name: "Code" })
    expect(codeTab.getAttribute("aria-selected")).toBe("false")
    fireEvent.keyDown(documentationTab, { key: "ArrowRight" })
    expect(codeTab.getAttribute("aria-selected")).toBe("true")
    expect(document.activeElement).toBe(codeTab)
    await waitFor(() =>
      expect(
        screen
          .getByAltText("Application state captured at event 3")
          .getAttribute("src")
      ).toBe("https://storage.test/private-screenshot.png")
    )
  })

  it("renders untrusted markup as inert text and reports invalid saved feeds", () => {
    const unsafeText = '<img src=x onerror="globalThis.compromised=true">'
    const unsafeEvent = runEventSchema.parse({
      ...common(1),
      agent: "documentation",
      kind: "node_completed",
      nodeName: "inspect_markup",
      status: "completed",
      summary: unsafeText,
      reasonCode: "markup_inspected",
    })
    const { container, rerender } = render(
      <RunActivityWorkspace
        key="invalid"
        initialRun={run()}
        initialEventPage={page([unsafeEvent])}
        live={false}
      />
    )
    expect(screen.getAllByText(unsafeText).length).toBeGreaterThan(0)
    expect(container.querySelector("img")).toBeNull()

    rerender(
      <RunActivityWorkspace
        initialRun={run()}
        initialEventPage={{
          schemaVersion: 1,
          items: [{ sequence: 2, event: unsafeEvent }],
        }}
        live={false}
      />
    )
    expect(screen.getByRole("alert").textContent).toContain(
      "saved activity could not be reconstructed"
    )
  })

  it("announces newly caught-up activity without replaying saved history", async () => {
    const incoming = events()[0]!
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes("/events?")) {
          const after = new URL(url, "http://sentinel.test").searchParams.get(
            "after"
          )
          return Response.json(after === "0" ? page([incoming]) : page([]))
        }
        if (url.endsWith("/interrupt")) {
          return new Response(null, { status: 404 })
        }
        return Response.json(run())
      })
    )
    render(
      <RunActivityWorkspace
        initialRun={run()}
        initialEventPage={page([])}
        transport="fixture-poll"
      />
    )

    await waitFor(() =>
      expect(
        screen.getByText(
          /1 new activity event\. Latest from Documentation: Decision, Documentation contract mapped\./
        )
      ).toBeDefined()
    )
  })

  it("follows new lane activity only while the user remains at the bottom", async () => {
    const documentationEvent = (sequence: number, summary: string) =>
      runEventSchema.parse({
        ...common(sequence),
        agent: "documentation",
        kind: "node_completed",
        nodeName: `documentation_step_${sequence}`,
        status: "completed",
        summary,
        reasonCode: `documentation_step_${sequence}_completed`,
        activity: { category: "decision" },
      })
    const first = documentationEvent(1, "First documentation event")
    const second = documentationEvent(2, "Second documentation event")
    const third = documentationEvent(3, "Third documentation event")
    let nextEvent: RunEvent | undefined

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes("/events?")) {
          const after = Number(
            new URL(url, "http://sentinel.test").searchParams.get("after")
          )
          if (nextEvent?.sequence === after + 1) {
            const event = nextEvent
            nextEvent = undefined
            return Response.json(page([event]))
          }
          return Response.json(page([]))
        }
        if (url.endsWith("/interrupt")) {
          return new Response(null, { status: 404 })
        }
        return Response.json(run())
      })
    )

    render(
      <RunActivityWorkspace
        initialRun={run()}
        initialEventPage={page([first])}
      />
    )
    const scrollArea = screen.getAllByRole("region", {
      name: "Documentation activity events",
    })[0]!
    let scrollTop = 400
    let scrollHeight = 600
    Object.defineProperties(scrollArea, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value
        },
      },
    })

    expect(scrollArea).toHaveClass("scrollbar-hidden")
    expect(scrollArea).toHaveAttribute("tabindex", "0")
    fireEvent.scroll(scrollArea)

    scrollHeight = 800
    nextEvent = second
    act(() => realtimeWake.current?.())
    await waitFor(() =>
      expect(screen.getAllByText(second.summary).length).toBeGreaterThan(0)
    )
    expect(scrollTop).toBe(800)

    scrollTop = 100
    fireEvent.scroll(scrollArea)
    scrollHeight = 900
    nextEvent = third
    act(() => realtimeWake.current?.())
    await waitFor(() =>
      expect(screen.getAllByText(third.summary).length).toBeGreaterThan(0)
    )
    expect(scrollTop).toBe(100)

    scrollTop = 700
    fireEvent.scroll(scrollArea)
    scrollHeight = 1_100
    nextEvent = documentationEvent(4, "Fourth documentation event")
    act(() => realtimeWake.current?.())
    await waitFor(() =>
      expect(
        screen.getAllByText("Fourth documentation event").length
      ).toBeGreaterThan(0)
    )
    expect(scrollTop).toBe(1_100)
  })

  it("falls back to polling when realtime bootstrap is unavailable", async () => {
    realtimeStart.mockRejectedValueOnce(new Error("realtime unavailable"))
    const incoming = events()[0]!
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes("/events?")) {
          const after = new URL(url, "http://sentinel.test").searchParams.get(
            "after"
          )
          return Response.json(after === "0" ? page([incoming]) : page([]))
        }
        if (url.endsWith("/interrupt")) {
          return new Response(null, { status: 404 })
        }
        return Response.json(run())
      })
    )
    render(
      <RunActivityWorkspace initialRun={run()} initialEventPage={page([])} />
    )

    await waitFor(() =>
      expect(
        screen.getAllByText("Documentation contract mapped").length
      ).toBeGreaterThan(0)
    )
    expect(screen.getByText("Live")).toBeDefined()
  })

  it("shows empty, slow, completed, and failed states", async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(page([])))
    )
    const { rerender } = render(
      <RunActivityWorkspace initialRun={run()} initialEventPage={page([])} />
    )
    expect(
      screen.getAllByText(/No documentation activity yet/).length
    ).toBeGreaterThan(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000)
    })
    expect(screen.getByText("Still connecting")).toBeDefined()

    vi.useRealTimers()
    rerender(
      <RunActivityWorkspace
        key="succeeded"
        initialRun={run("succeeded")}
        initialEventPage={page([])}
        live={false}
      />
    )
    expect(
      screen
        .getAllByRole("status")
        .some((element) => element.textContent?.includes("Run completed"))
    ).toBe(true)
    expect(
      screen.getByRole("link", { name: "Open assessment report" })
    ).toHaveAttribute("href", `/assessments/${assessmentId}`)

    rerender(
      <RunActivityWorkspace
        key="succeeded-without-report"
        initialRun={publicRunSchema.parse({
          ...run("succeeded"),
          assessmentId: undefined,
          assessment: undefined,
        })}
        initialEventPage={page([])}
        live={false}
      />
    )
    expect(
      screen.queryByRole("link", { name: "Open assessment report" })
    ).toBeNull()

    rerender(
      <RunActivityWorkspace
        key="failed"
        initialRun={run("failed")}
        initialEventPage={page([])}
        live={false}
      />
    )
    expect(screen.getByRole("alert").textContent).toContain("Run failed")
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined()
    expect(
      screen.queryByRole("link", { name: "Open assessment report" })
    ).toBeNull()
  })

  it("moves retry to the new run and resets the prior event feed", async () => {
    const retriedRunId = "55555555-5555-4555-8555-555555555555"
    const retried = publicRunSchema.parse({
      ...run("running"),
      id: retriedRunId,
      retryOf: databaseRunId,
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (init?.method === "POST" && url.endsWith("/retry")) {
          return Response.json({ schemaVersion: 1, run: retried })
        }
        if (url.includes(`/${retriedRunId}/events?`)) {
          return Response.json(page([]))
        }
        if (url.endsWith(`/${retriedRunId}/interrupt`)) {
          return new Response(null, { status: 404 })
        }
        return Response.json(retried)
      })
    )
    window.history.replaceState(
      null,
      "",
      `/applications/${applicationId}/activity/${databaseRunId}`
    )
    render(
      <RunActivityWorkspace
        initialRun={run("failed")}
        initialEventPage={page([events()[0]!])}
        live={false}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Retry" }))

    await waitFor(() =>
      expect(window.location.pathname).toBe(
        `/applications/${applicationId}/activity/${retriedRunId}`
      )
    )
    expect(screen.queryByText("Documentation contract mapped")).toBeNull()
    expect(screen.getByRole("button", { name: "Pause" })).toBeDefined()
  })

  it("pauses, confirms stop, and resumes through authenticated control routes", async () => {
    const pendingInterrupt: PublicRunInterrupt = {
      schemaVersion: 1,
      id: "44444444-4444-4444-8444-444444444444",
      runId: databaseRunId,
      decisionId: "resume_run_2",
      prompt: "Resume when the operator is ready" as never,
      status: "pending",
      createdAt: "2026-09-09T00:00:10.000Z",
    }
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith("/pause")) {
          return Response.json({
            schemaVersion: 1,
            run: {
              ...run(),
              pauseRequestedAt: "2026-09-09T00:00:20.000Z",
            },
          })
        }
        if (url.endsWith("/cancel")) {
          return Response.json({ schemaVersion: 1, run: run("cancelled") })
        }
        if (init?.method === "POST" && url.includes("/respond")) {
          return Response.json({
            schemaVersion: 1,
            interrupt: { ...pendingInterrupt, status: "responded" },
            idempotent: false,
          })
        }
        return Response.json(run("running"))
      }
    )
    vi.stubGlobal("fetch", fetcher)

    const { rerender } = render(
      <RunActivityWorkspace
        initialRun={run()}
        initialEventPage={page([])}
        live={false}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Pause" }))
    await waitFor(() => {
      const button = screen.getByRole("button", {
        name: "Pause requested",
      }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
    })
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    expect(screen.getByRole("group", { name: "Confirm stop" })).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: "Confirm stop" }))
    await waitFor(() =>
      expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0)
    )

    rerender(
      <RunActivityWorkspace
        key="interrupted"
        initialRun={run("interrupted")}
        initialEventPage={page([])}
        initialInterrupt={pendingInterrupt}
        live={false}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Resume" }))
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringContaining("/interrupts/resume_run_2/respond"),
        expect.objectContaining({ method: "POST" })
      )
    )
  })
})
