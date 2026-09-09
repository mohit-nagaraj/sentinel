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

vi.mock("server-only", () => ({}))

import {
  createKnowledgeFixtureService,
  KNOWLEDGE_FIXTURE_APPLICATION_ID,
} from "@/lib/knowledge-fixture"

import { KnowledgeWorkspace } from "./knowledge-workspace"

async function fixtureProps() {
  const service = createKnowledgeFixtureService()
  const [initialOverview, initialCoverage, initialWorkflows, initialReviews] =
    await Promise.all([
      service.overview(KNOWLEDGE_FIXTURE_APPLICATION_ID),
      service.coverage(KNOWLEDGE_FIXTURE_APPLICATION_ID, { limit: 20 }),
      service.workflows(KNOWLEDGE_FIXTURE_APPLICATION_ID, { limit: 20 }),
      service.reviews(KNOWLEDGE_FIXTURE_APPLICATION_ID, { limit: 20 }),
    ])
  const initialPath = await service.evidencePath(
    KNOWLEDGE_FIXTURE_APPLICATION_ID,
    initialCoverage.items[0]?.requirementId ?? "missing"
  )
  return {
    service,
    props: {
      initialOverview,
      initialCoverage,
      initialWorkflows,
      initialReviews,
      initialPath,
    },
  }
}

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => cleanup())

describe("knowledge workspace", () => {
  it("shows freshness, every coverage state, and a bounded provenance path", async () => {
    const { props } = await fixtureProps()
    render(<KnowledgeWorkspace {...props} />)

    expect(screen.getByText(/Current knowledge is stale/)).toBeInTheDocument()
    expect(screen.getAllByText("9f8e7d6c5b4a").length).toBeGreaterThan(0)
    for (const label of [
      "Observed",
      "Partially observed",
      "Not observed",
      "Blocked",
      "Not evaluated",
      "Ambiguous",
    ]) {
      expect(
        screen.getAllByText(label, { exact: true }).length
      ).toBeGreaterThan(0)
    }
    expect(
      screen.getByText(/Missing links are unknown until a bounded assessment/)
    ).toBeInTheDocument()
    expect(
      screen.getByRole("combobox", { name: "Coverage status" })
    ).toHaveTextContent("All coverage")
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }))
    fireEvent.click(screen.getByText("Evidence path details"))
    expect(
      screen.getByText("Cross-layer path reaches implementation evidence")
    ).toBeInTheDocument()
    expect(
      screen.getByText("Checkout guide / Completing an order")
    ).toBeInTheDocument()
    expect(screen.getByText("OrderController.create")).toBeInTheDocument()
    expect(screen.getAllByTitle(/Evidence tier/).length).toBeGreaterThan(6)
  })

  it("switches to workflow coverage and exposes stale invalidation", async () => {
    const { props } = await fixtureProps()
    render(<KnowledgeWorkspace {...props} />)

    fireEvent.click(screen.getByRole("button", { name: "Workflows" }))
    expect(
      screen.getAllByText("Buyer completes ticket checkout").length
    ).toBeGreaterThan(0)
    expect(screen.getByText("Buyer opens saved tickets")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("tab", { name: "Reviews" }))
    const candidateButton = screen.getByRole("button", {
      name: /Requirement to checkout workflow/,
    })
    fireEvent.click(candidateButton)
    expect(screen.getByText("Previous decision is stale")).toBeInTheDocument()
    expect(
      screen.getByText(/earlier decision was not reused/)
    ).toBeInTheDocument()
    expect(screen.getByText("Competing evidence (1)")).toBeInTheDocument()
  })

  it("requires a reason and records a link decision", async () => {
    const { props, service } = await fixtureProps()
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as unknown
        const item = props.initialReviews.items.find(
          (candidate) => candidate.kind === "link"
        )
        if (item?.kind !== "link") throw new Error("missing link")
        const result = await service.reviewLink(
          KNOWLEDGE_FIXTURE_APPLICATION_ID,
          item.id,
          body
        )
        return Response.json(result, { status: 201 })
      })
    )
    render(<KnowledgeWorkspace {...props} />)

    fireEvent.click(screen.getByRole("tab", { name: "Reviews" }))
    fireEvent.click(
      screen.getByRole("button", { name: /Requirement to checkout workflow/ })
    )
    const accept = screen.getByRole("button", { name: "Accept" })
    expect(accept).toBeDisabled()
    fireEvent.change(screen.getByLabelText("Decision reason"), {
      target: { value: "Runtime and route evidence corroborate the mapping." },
    })
    expect(accept).not.toBeDisabled()
    fireEvent.click(accept)
    await waitFor(() =>
      expect(screen.getByText("Accepted by reviewer")).toBeInTheDocument()
    )
  })

  it("opens a typed private excerpt without rendering it as HTML", async () => {
    const { props, service } = await fixtureProps()
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const artifactId = props.initialPath?.nodes[0]?.artifactId
        if (artifactId === undefined) throw new Error("missing artifact")
        expect(String(url)).toContain(encodeURIComponent(artifactId))
        return Response.json(
          await service.artifactExcerpt(
            KNOWLEDGE_FIXTURE_APPLICATION_ID,
            artifactId
          )
        )
      })
    )
    render(<KnowledgeWorkspace {...props} />)

    fireEvent.click(screen.getByRole("tab", { name: "Graph" }))
    fireEvent.click(screen.getByText("Evidence path details"))
    const states = screen.getByText("States", { exact: true })
    fireEvent.click(states.closest("summary") ?? states)
    fireEvent.click(
      screen.getByRole("button", { name: "View private excerpt" })
    )
    const dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByText(/Buyers provide attendee details/)
    ).toBeInTheDocument()
    expect(dialog.querySelector("h2")).toBeNull()
  })

  it("loads the next review page without discarding loaded items", async () => {
    const { props } = await fixtureProps()
    const [first, second] = props.initialReviews.items
    if (first === undefined || second === undefined) {
      throw new Error("missing paginated review fixtures")
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        expect(String(url)).toContain(`cursor=${encodeURIComponent(second.id)}`)
        return Response.json({ schemaVersion: 1, items: [second] })
      })
    )
    render(
      <KnowledgeWorkspace
        {...props}
        initialReviews={{
          schemaVersion: 1,
          items: [first],
          nextCursor: second.id,
        }}
      />
    )

    fireEvent.click(screen.getByRole("tab", { name: "Reviews" }))
    fireEvent.click(screen.getByRole("button", { name: "Load more reviews" }))
    expect(
      await screen.findByRole("button", {
        name: /Requirement to checkout workflow/,
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /Operator decision required/ })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Load more reviews" })
    ).not.toBeInTheDocument()
  })

  it("preserves loaded data when a filtered request fails", async () => {
    const { props } = await fixtureProps()
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
    render(<KnowledgeWorkspace {...props} />)

    fireEvent.change(screen.getByPlaceholderText("Search requirements"), {
      target: { value: "refund" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Apply" }))
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Coverage could not be refreshed"
      )
    )
    expect(
      screen.getAllByText("A buyer can select a ticket and complete checkout.")
        .length
    ).toBeGreaterThan(0)
  })
})
