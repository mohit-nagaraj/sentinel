import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  commitShaSchema,
  type PublicOnboardingApplication,
} from "@sentinel/contracts"

vi.mock("@/app/actions", () => ({
  inspectOnboardingAction: async (state: unknown) => state,
  confirmOnboardingAction: async (state: unknown) => state,
}))

import { OnboardingControlPlane } from "@/components/onboarding-control-plane"

afterEach(cleanup)

const connectedApplication: PublicOnboardingApplication = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Hi.Events",
  deploymentUrl: "https://demo.hi.events/",
  status: "awaiting_confirmation",
  graphRevision: 0,
  knowledgeStale: false,
  configuration: {
    repository: {
      url: "https://github.com/mohit-nagaraj/Hi.Events",
      ref: "develop",
      accessMode: "manual",
      resolvedCommitSha: commitShaSchema.parse(
        "0497418d5c66d20693751e68be066260eda3f37f"
      ),
    },
    documentationSources: ["https://hi.events/docs", "repository://README.md"],
    authentication: {
      method: "credentials",
      configuredFields: [
        { key: "email", label: "Email" },
        { key: "password", label: "Password" },
      ],
      revision: 1,
    },
    crawl: {
      allowedHosts: ["demo.hi.events"],
      maxActions: 40,
      maxScreens: 20,
      maxDurationSeconds: 300,
      allowFormSubmission: true,
      denyDestructiveActions: true,
      denyRealPayments: true,
      denyExternalMessaging: true,
      denyPrivilegeChanges: true,
    },
    capabilityHints: ["Attendee checkout"],
  },
  confirmed: false,
  updatedAt: "2026-09-08T00:00:00.000Z",
}

describe("onboarding control plane page", () => {
  it("renders the application shell and a server-backed onboarding workspace", () => {
    render(<OnboardingControlPlane initialApplications={[]} />)

    expect(
      screen.getByRole("heading", { level: 1, name: "Sentinel" })
    ).toBeDefined()
    expect(
      screen.getByRole("navigation", { name: "Connected applications" })
    ).toBeDefined()
    expect(
      screen.getByRole("heading", { level: 2, name: "Connect application" })
    ).toBeDefined()
    expect(
      screen.getByRole("tab", { name: "Sources" }).getAttribute("aria-selected")
    ).toBe("true")
    expect(screen.getByLabelText("Application name")).toBeDefined()
  })

  it("renders generic fields from the selected authentication method", () => {
    render(<OnboardingControlPlane initialApplications={[]} />)
    fireEvent.click(screen.getByRole("tab", { name: "Access" }))

    fireEvent.click(screen.getByRole("radio", { name: "Credentials" }))
    expect(
      screen.getByLabelText("Email secret value").getAttribute("type")
    ).toBe("password")
    expect(
      screen
        .getByLabelText("Password secret value")
        .getAttribute("autocomplete")
    ).toBe("new-password")
    fireEvent.click(screen.getByRole("button", { name: "Add field" }))
    expect(screen.getByLabelText("Credential 3 secret value")).toBeDefined()

    fireEvent.click(screen.getByRole("radio", { name: "Storage state" }))
    expect(screen.getByLabelText("Encrypted storage state")).toBeDefined()
    expect(screen.queryByLabelText("Email secret value")).toBeNull()
  })

  it("keeps high-risk action classes visibly and immutably denied", () => {
    render(<OnboardingControlPlane initialApplications={[]} />)
    fireEvent.click(screen.getByRole("tab", { name: "Safety" }))

    const mandatoryDenials = screen.getByLabelText("Mandatory action denials")
    const checkboxes = mandatoryDenials.querySelectorAll(
      'input[type="checkbox"]'
    )
    expect(checkboxes).toHaveLength(4)
    for (const checkbox of checkboxes) {
      expect((checkbox as HTMLInputElement).checked).toBe(true)
      expect((checkbox as HTMLInputElement).disabled).toBe(true)
    }
    expect(screen.getByText("Block real payments")).toBeDefined()
    expect(screen.getByText("Block external messages")).toBeDefined()
  })

  it("shows connected application context and allows a fresh draft", () => {
    render(
      <OnboardingControlPlane initialApplications={[connectedApplication]} />
    )

    expect(
      screen
        .getByRole("button", { name: /Hi\.Events/ })
        .getAttribute("aria-current")
    ).toBe("page")
    expect(screen.getByText("Awaiting confirmation")).toBeDefined()
    expect(screen.getByDisplayValue("Hi.Events")).toBeDefined()

    fireEvent.click(screen.getByRole("button", { name: "New application" }))
    expect(
      screen.getByRole("heading", { level: 2, name: "Connect application" })
    ).toBeDefined()
    expect(
      (screen.getByLabelText("Application name") as HTMLInputElement).value
    ).toBe("")
  })
})
