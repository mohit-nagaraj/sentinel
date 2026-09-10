import { render, screen } from "@testing-library/react"
import { cleanup } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import SignInPage from "./page"

afterEach(cleanup)

describe("operator sign-in page", () => {
  it("renders the operator token form and preserves the return path", async () => {
    render(
      await SignInPage({
        searchParams: Promise.resolve({ next: "/applications/example" }),
      })
    )

    expect(screen.getByRole("heading", { name: "Sign in" })).toBeDefined()
    expect(screen.getByLabelText("Operator token")).toHaveAttribute(
      "type",
      "password"
    )
    expect(screen.getByDisplayValue("/applications/example")).toHaveAttribute(
      "name",
      "next"
    )
  })

  it("shows invalid credentials as an inline error", async () => {
    render(
      await SignInPage({
        searchParams: Promise.resolve({ error: "invalid" }),
      })
    )

    expect(screen.getByRole("alert").textContent).toContain("not valid")
  })
})
