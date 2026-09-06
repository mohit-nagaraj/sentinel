import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import Page from "./page"

describe("home page", () => {
  it("renders the Sentinel control application", () => {
    render(<Page />)

    expect(
      screen.getByRole("heading", { level: 1, name: "Sentinel" })
    ).toBeDefined()
    expect(screen.getByText("Foundation ready")).toBeDefined()
  })
})
