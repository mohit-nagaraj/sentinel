import "@testing-library/jest-dom/vitest"

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  REPORT_FIXTURE_ASSESSMENT_ID,
  REPORT_FIXTURE_EVIDENCE_ARTIFACT_ID,
  FixtureAssessmentReportService,
} from "@/lib/assessment-report-service"

import { AssessmentReportWorkspace } from "./assessment-report-workspace"

vi.mock("server-only", () => ({}))

async function fixtureReport() {
  const report = await new FixtureAssessmentReportService().get(
    REPORT_FIXTURE_ASSESSMENT_ID
  )
  if (report === null) throw new Error("missing report fixture")
  return report
}

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => cleanup())

describe("assessment report workspace", () => {
  it("renders every mandatory report section and keeps uncertainty explicit", async () => {
    render(<AssessmentReportWorkspace report={await fixtureReport()} />)

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Rework UTM attribution tracking and admin attribution report",
      })
    ).toBeInTheDocument()
    for (const heading of [
      "Executive summary",
      "Affected product areas",
      "User interface",
      "Workflows",
      "Requirements at risk",
      "Why items were flagged",
      "Recommended QA",
      "Verification",
      "Unknowns and exclusions",
      "Report generation",
    ]) {
      expect(
        screen.getByRole("heading", { level: 2, name: heading })
      ).toBeInTheDocument()
    }
    expect(screen.getAllByText(/high risk/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/partially observed/i)).toBeInTheDocument()
    expect(
      screen.getByText(
        /Unknown or unobserved scope means evidence is incomplete/
      )
    ).toBeInTheDocument()
    expect(document.body.textContent).not.toContain("The PR is safe")
    expect(document.body.textContent).not.toContain("No UI is affected")
  })

  it("exposes the canonical download, sources, and print command", async () => {
    const print = vi.fn()
    vi.stubGlobal("print", print)
    render(<AssessmentReportWorkspace report={await fixtureReport()} />)

    expect(screen.getByRole("link", { name: "Markdown" })).toHaveAttribute(
      "href",
      `/api/assessments/${REPORT_FIXTURE_ASSESSMENT_ID}/download`
    )
    fireEvent.click(screen.getByRole("button", { name: "Print" }))
    expect(print).toHaveBeenCalledOnce()

    fireEvent.click(
      screen.getAllByText(/Evidence path/)[0]?.closest("summary") ??
        document.body
    )
    expect(
      screen.getByRole("link", {
        name: /github.com\/HiEventsDev\/Hi.Events\/blob\/.+\/frontend\/src\/components\/routes\/admin\/Attribution\/index\.tsx/,
      })
    ).toHaveAttribute("rel", "noreferrer")
  })

  it("loads a report-scoped private excerpt as inert text and restores focus", async () => {
    const service = new FixtureAssessmentReportService()
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        expect(String(url)).toContain(
          encodeURIComponent(REPORT_FIXTURE_EVIDENCE_ARTIFACT_ID)
        )
        return Response.json(
          await service.artifactExcerpt(
            REPORT_FIXTURE_ASSESSMENT_ID,
            REPORT_FIXTURE_EVIDENCE_ARTIFACT_ID
          )
        )
      })
    )
    render(<AssessmentReportWorkspace report={await fixtureReport()} />)

    fireEvent.click(
      screen.getAllByText(/Evidence path/)[0]?.closest("summary") ??
        document.body
    )
    const trigger = screen.getByRole("button", {
      name: /View private artifact excerpt/,
    })
    fireEvent.click(trigger)
    const dialog = await screen.findByRole("dialog", {
      name: "Private evidence excerpt",
    })
    expect(
      within(dialog).getByText(/OrderService.submit validates attribution/)
    ).toBeInTheDocument()
    expect(dialog.querySelector("script")).toBeNull()

    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(trigger).toHaveFocus()
  })

  it("keeps the report visible when a private excerpt cannot be loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    )
    render(<AssessmentReportWorkspace report={await fixtureReport()} />)

    fireEvent.click(
      screen.getAllByText(/Evidence path/)[0]?.closest("summary") ??
        document.body
    )
    fireEvent.click(
      screen.getByRole("button", { name: /View private artifact excerpt/ })
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "private excerpt could not be loaded"
    )
    expect(
      screen.getByRole("heading", { name: "Executive summary" })
    ).toBeInTheDocument()
  })
})
