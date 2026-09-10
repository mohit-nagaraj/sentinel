import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const navigation = vi.hoisted(() => ({ push: vi.fn() }))

vi.mock("next/navigation", () => ({
  useParams: () => ({
    applicationId: "11111111-1111-4111-8111-111111111111",
  }),
  usePathname: () =>
    "/applications/11111111-1111-4111-8111-111111111111/activity/example",
  useRouter: () => navigation,
}))

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn() }),
}))

import { DashboardShell } from "./dashboard-shell"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("dashboard shell", () => {
  it("keeps the desktop sidebar fixed while the document owns scrolling", () => {
    const { container } = render(
      <DashboardShell applications={[]}>
        <div>Dashboard content</div>
      </DashboardShell>
    )

    expect(
      container.querySelector('[data-slot="dashboard-shell"]')
    ).toHaveClass("min-h-svh")
    expect(
      container.querySelector('[data-slot="dashboard-sidebar"]')
    ).toHaveClass("fixed", "inset-y-0", "h-svh")
    const content = container.querySelector('[data-slot="dashboard-content"]')
    expect(content).toHaveClass("lg:ml-[15.5rem]")
    expect(content).not.toHaveClass("lg:overflow-y-auto")
    expect(
      content?.querySelector(
        '[class~="min-h-[calc(100svh-3.5rem)]"], [class~="lg:min-h-svh"]'
      )
    ).toBeNull()
  })
})
