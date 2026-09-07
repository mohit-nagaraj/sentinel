import { expect, test, type Page, type TestInfo } from "@playwright/test"

const targetPassword = "browser-target-password-snt022"
const privilegedCanaries = [
  "supabase-service-canary-snt022",
  "neo4j-password-canary-snt022",
  "azure-model-canary-snt022",
  "github-token-canary-snt022",
]

async function fillSources(
  page: Page,
  input: {
    readonly name: string
    readonly deploymentUrl: string
    readonly repositoryUrl?: string
  }
) {
  await page.getByRole("tab", { name: "Sources" }).click()
  await page.getByLabel("Application name").fill(input.name)
  await page.getByLabel("Application URL").fill(input.deploymentUrl)
  await page
    .getByLabel("GitHub repository")
    .fill(input.repositoryUrl ?? "https://github.com/mohit-nagaraj/Hi.Events")
  await page.getByLabel("Branch or commit").fill("develop")
  await page
    .getByLabel("Documentation sources")
    .fill("https://hi.events/docs\nrepository://README.md")
}

async function configureCredentials(page: Page) {
  await page.getByRole("tab", { name: "Access" }).click()
  await page
    .getByRole("radiogroup", { name: "Authentication method" })
    .getByText("Credentials", { exact: true })
    .click()
  await page.getByLabel("Email secret value").fill("operator@example.com")
  await page.getByLabel("Password secret value").fill(targetPassword)
}

async function configureSafety(page: Page, deploymentUrl: string) {
  await page.getByRole("tab", { name: "Safety" }).click()
  await page.getByLabel("Allowed hosts").fill(new URL(deploymentUrl).hostname)
  await page.getByLabel("Allow non-destructive form submission").check()
  await page
    .getByLabel("Capability or workflow hints")
    .fill("Attendee checkout\nOrganizer order visibility")
  await page
    .getByLabel("Target setup reference")
    .fill("Use target fixture checkout_demo")
}

async function review(page: Page) {
  await page.getByRole("tab", { name: "Review" }).click()
}

async function saveScreenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({
    path: testInfo.outputPath(name),
    fullPage: true,
  })
}

test("completes onboarding, inspects compatibility, confirms scope, and isolates secrets", async ({
  page,
  request,
}, testInfo) => {
  const actionResponses: Promise<string>[] = []
  page.on("response", (response) => {
    if (response.request().method() === "POST") {
      actionResponses.push(response.text().catch(() => ""))
    }
  })

  await page.goto("/")
  await expect(
    page.getByRole("heading", { level: 1, name: "Sentinel" })
  ).toBeVisible()

  const deploymentUrl = "https://demo.hi.events"
  await fillSources(page, {
    name: "Hi.Events browser fixture",
    deploymentUrl,
  })
  await configureCredentials(page)
  await configureSafety(page, deploymentUrl)
  await review(page)

  await expect(page.getByText(deploymentUrl)).toBeVisible()
  await page.getByRole("button", { name: "Inspect compatibility" }).click()

  await expect(page.getByText("supported", { exact: true })).toBeVisible()
  await expect(
    page.getByText("TypeScript React frontend evidence was detected")
  ).toBeVisible()
  await expect(
    page.getByText("PHP Laravel backend evidence was detected")
  ).toBeVisible()
  await expect(
    page.getByText("OpenAPI Scramble evidence was detected")
  ).toBeVisible()
  await expect(page.getByText("Playwright assets were detected")).toBeVisible()
  await expect(page.getByText(targetPassword)).toHaveCount(0)

  await page.getByRole("button", { name: "Confirm scope" }).click()
  await expect(page.getByText("Scope confirmed", { exact: true })).toBeVisible()
  await expect(
    page.getByText(
      "Scope confirmed; the application is ready for initialization"
    )
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Confirm scope" })).toHaveCount(
    0
  )

  const pageHtml = await page.content()
  expect(pageHtml).not.toContain(targetPassword)
  for (const canary of privilegedCanaries)
    expect(pageHtml).not.toContain(canary)

  const scriptSources = await page
    .locator("script[src]")
    .evaluateAll((scripts) =>
      scripts
        .map((script) => script.getAttribute("src"))
        .filter((source): source is string => source !== null)
    )
  for (const source of scriptSources) {
    const response = await request.get(new URL(source, page.url()).toString())
    const body = await response.text()
    expect(body).not.toContain(targetPassword)
    for (const canary of privilegedCanaries) expect(body).not.toContain(canary)
  }

  const healthBody = await (await request.get("/api/health")).text()
  for (const canary of privilegedCanaries)
    expect(healthBody).not.toContain(canary)
  const responseBodies = await Promise.all(actionResponses)
  for (const body of responseBodies) {
    expect(body).not.toContain(targetPassword)
    for (const canary of privilegedCanaries) expect(body).not.toContain(canary)
  }

  await saveScreenshot(page, testInfo, "onboarding-confirmed-desktop.png")
})

test("preserves non-secret state through validation and reports compatibility blockers", async ({
  page,
}, testInfo) => {
  await page.goto("/")
  await page.getByRole("button", { name: "New application" }).click()

  await fillSources(page, {
    name: "Validation recovery fixture",
    deploymentUrl: "https://blocked.example.test",
    repositoryUrl: "https://example.com/not-github",
  })
  await configureSafety(page, "https://blocked.example.test")
  await review(page)
  await page.getByRole("button", { name: "Inspect compatibility" }).click()

  await expect(
    page.getByText("Review the highlighted fields and run inspection again")
  ).toBeVisible()
  await page.getByRole("tab", { name: "Sources" }).click()
  await expect(page.getByLabel("Application name")).toHaveValue(
    "Validation recovery fixture"
  )
  await expect(
    page.getByText(/Repository URL must identify one GitHub/)
  ).toBeVisible()

  await page
    .getByLabel("GitHub repository")
    .fill("https://github.com/mohit-nagaraj/Hi.Events")
  await review(page)
  await page.getByRole("button", { name: "Inspect compatibility" }).click()

  await expect(page.getByText("blocked", { exact: true })).toBeVisible()
  await expect(
    page.getByText("The fixture application is intentionally unavailable")
  ).toBeVisible()
  await expect(
    page.getByText("Use a reachable fixture application host and inspect again")
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Confirm scope" })).toHaveCount(
    0
  )

  await saveScreenshot(page, testInfo, "onboarding-blocked-desktop.png")
})

test("keeps the control plane coherent on a narrow keyboard-driven viewport", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  await expect(page.getByText("Control plane", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "New application" }).focus()
  await page.keyboard.press("Enter")
  await page.getByRole("tab", { name: "Access" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("tab", { name: "Access" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    )
    .toBe(true)

  await saveScreenshot(page, testInfo, "onboarding-mobile.png")
})
