import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  commitShaSchema,
  publicOnboardingApplicationSchema,
  type PublicOnboardingApplication,
} from "@sentinel/contracts"

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}))
const initializeKnowledgeAction = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    runId: "22222222-2222-4222-8222-222222222222",
  })
)

vi.mock("next/navigation", () => ({ useRouter: () => navigation }))

vi.mock("@/app/actions", () => ({
  inspectOnboardingAction: async (state: unknown) => state,
  confirmOnboardingAction: async (state: unknown) => state,
  initializeKnowledgeAction,
}))

import { OnboardingControlPlane } from "@/components/onboarding-control-plane"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

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
      automationConfirmed: true,
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
  completedThrough: "safety",
  updatedAt: "2026-09-08T00:00:00.000Z",
}

const githubAppApplication: PublicOnboardingApplication = {
  ...connectedApplication,
  configuration: {
    ...connectedApplication.configuration,
    repository: {
      ...connectedApplication.configuration.repository,
      accessMode: "github_app",
      installationId: "12345678",
    },
  },
}

const inspectedApplication = publicOnboardingApplicationSchema.parse({
  ...connectedApplication,
  compatibility: {
    schemaVersion: 1,
    inputFingerprint: `sha256:${"e".repeat(64)}`,
    status: "supported",
    resolvedCommitSha: "0497418d5c66d20693751e68be066260eda3f37f",
    selectedAdapters: ["typescript_react"],
    evidence: [
      {
        capability: "repository_resolved",
        status: "detected",
        code: "immutable_commit_resolved",
        summary: "Repository reference resolved to an immutable commit",
        source: "repository",
        references: ["composer.json"],
      },
    ],
    findings: [],
    humanActions: [],
    proposedScope: {
      repositoryPaths: ["frontend"],
      documentationSources: ["repository://README.md"],
      applicationOrigins: ["https://demo.hi.events"],
      allowedActionCategories: ["safe_read"],
      maxActions: 40,
      maxScreens: 20,
      maxDurationSeconds: 300,
    },
    inspectedAt: "2026-09-08T00:00:00.000Z",
  },
})

const confirmedApplication = publicOnboardingApplicationSchema.parse({
  ...inspectedApplication,
  confirmed: true,
  completedThrough: "review",
})

describe("onboarding control plane page", () => {
  it("starts initial knowledge indexing and opens its activity workspace", async () => {
    render(
      <OnboardingControlPlane initialApplications={[confirmedApplication]} />
    )

    fireEvent.click(
      screen.getByRole("button", { name: "Initialize knowledge" })
    )

    await waitFor(() => {
      expect(initializeKnowledgeAction).toHaveBeenCalledWith(
        confirmedApplication.id
      )
      expect(navigation.push).toHaveBeenCalledWith(
        `/applications/${confirmedApplication.id}/activity/22222222-2222-4222-8222-222222222222`
      )
    })
  })

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
    expect(
      screen.getByRole("combobox", { name: "Repository connection" })
    ).toHaveTextContent("Manual URL")
  })

  it("renders generic fields from the selected authentication method", () => {
    render(
      <OnboardingControlPlane initialApplications={[connectedApplication]} />
    )
    fireEvent.click(screen.getByRole("tab", { name: "Access" }))

    fireEvent.click(screen.getByRole("radio", { name: "Credentials" }))
    expect(
      screen.getByLabelText("Email or username").getAttribute("type")
    ).toBe("text")
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe(
      "new-password"
    )
    expect(
      screen.getByLabelText(
        "Automated login works without CAPTCHA or human verification"
      )
    ).toBeDefined()
    fireEvent.click(
      screen.getByRole("button", { name: "Add custom credential" })
    )
    expect(screen.getByLabelText("Credential 3 secret value")).toBeDefined()

    fireEvent.click(screen.getByRole("radio", { name: "Storage state" }))
    expect(screen.getByLabelText("Encrypted storage state")).toBeDefined()
    expect(screen.queryByLabelText("Email or username")).toBeNull()
  })

  it("shows the install link for a GitHub App repository connection", () => {
    render(
      <OnboardingControlPlane initialApplications={[githubAppApplication]} />
    )
    fireEvent.click(screen.getByRole("tab", { name: "Sources" }))

    expect(screen.getByLabelText("GitHub installation ID")).toBeDefined()
    expect(
      screen.getByRole("combobox", { name: "Repository connection" })
    ).toHaveTextContent("GitHub App installation")
    expect(
      screen
        .getByRole("link", { name: /Install Sentinel GitHub App/ })
        .getAttribute("href")
    ).toBe("https://github.com/apps/sentinel-app-demo/installations/new")
    expect(
      document.querySelector<HTMLInputElement>(
        'input[name="repositoryAccessMode"]'
      )?.value
    ).toBe("github_app")
  })

  it("keeps high-risk action classes visibly and immutably denied", () => {
    render(
      <OnboardingControlPlane initialApplications={[connectedApplication]} />
    )
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

  it("requires reinspection before confirming edited form values", () => {
    render(
      <OnboardingControlPlane initialApplications={[inspectedApplication]} />
    )

    expect(screen.getByRole("button", { name: "Confirm scope" })).toBeDefined()
    fireEvent.click(screen.getByRole("tab", { name: "Sources" }))
    fireEvent.change(screen.getByLabelText("Branch or commit"), {
      target: { value: "main" },
    })
    fireEvent.click(screen.getByRole("tab", { name: "Review" }))

    expect(screen.queryByRole("button", { name: "Confirm scope" })).toBeNull()
    expect(
      screen.getByText("Reinspect before confirming changes")
    ).toBeDefined()
  })
})
