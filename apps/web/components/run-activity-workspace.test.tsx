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

vi.mock("@/lib/realtime-client", () => ({
  createRunRealtimeSubscription: () => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}))

import { RunActivityWorkspace } from "./run-activity-workspace"

const databaseRunId = "33333333-3333-4333-8333-333333333333"
const applicationId = "22222222-2222-4222-8222-222222222222"
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
      screen.getByRole("heading", { level: 1, name: "Sentinel" })
    ).toBeDefined()
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
