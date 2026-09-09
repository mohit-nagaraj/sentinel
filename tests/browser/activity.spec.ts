import { expect, test } from "@playwright/test"

const activityFixtureRunId = "00000000-0000-4000-8000-000000000024"
const screenshotId = `artifact:v1:${"a".repeat(64)}`
const privilegedCanaries = [
  "supabase-service-canary-snt022",
  "neo4j-password-canary-snt022",
  "azure-model-canary-snt022",
  "github-token-canary-snt022",
  "operator-token-canary-snt022-must-not-leak",
]

test("streams a parallel run, resumes safely, and reconstructs its storyboard", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000)
  const reset = await page.request.post("/api/control/fixture/activity", {
    data: { action: "reset" },
  })
  await expect(reset).toBeOK()

  await page.setViewportSize({ width: 1180, height: 760 })
  await page.goto("/fixtures/checkout")
  await expect(
    page.getByRole("heading", { name: "Frontend Systems Workshop" })
  ).toBeVisible()
  const captured = await page.locator("main").screenshot()
  const uploaded = await page.request.post(
    `/api/control/fixture/screenshots/${screenshotId}`,
    {
      data: captured,
      headers: { "content-type": "image/png" },
    }
  )
  expect(uploaded.status()).toBe(201)

  await page.goto("/runs")
  await page.getByRole("link", { name: /Assess Pr/ }).click()
  await expect(page).toHaveURL(new RegExp(`/runs/${activityFixtureRunId}$`), {
    timeout: 15_000,
  })
  await expect(
    page.getByRole("heading", { name: "Specialist activity" })
  ).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText("Live", { exact: true })).toBeVisible({
    timeout: 15_000,
  })
  await expect(
    page
      .locator('[data-sequence="1"]:visible')
      .getByText("Mapping the checkout contract")
  ).toBeVisible()
  await expect(
    page
      .locator('[data-sequence="2"]:visible')
      .getByText("Tracing checkout implementation")
  ).toBeVisible()
  await expect(
    page
      .locator('[data-sequence="3"]:visible')
      .getByText("Observing checkout behavior")
  ).toBeVisible()

  await page.getByRole("button", { name: "Pause" }).click()
  await expect(
    page.getByRole("button", { name: "Pause requested" })
  ).toBeDisabled()
  const paused = await page.request.post("/api/control/fixture/activity", {
    data: { action: "advance" },
  })
  await expect(paused).toBeOK()
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible()
  await page.getByRole("button", { name: "Resume" }).focus()
  await page.keyboard.press("Enter")
  await expect(
    page.locator("header").first().getByText("Running", { exact: true })
  ).toBeVisible()

  const completed = await page.request.post("/api/control/fixture/activity", {
    data: { action: "advance" },
  })
  await expect(completed).toBeOK()
  await expect(page.getByText("Run completed.", { exact: false })).toBeVisible()
  await expect(
    page.getByText("Checkout review behavior reconciled", { exact: true })
  ).toBeVisible()
  await expect(
    page
      .locator('[data-sequence="7"]:visible')
      .getByText("Checkout advanced to review")
  ).toBeVisible()
  const storyboard = page.getByAltText(/Application state captured at event/)
  await expect(storyboard).toBeVisible()
  await expect
    .poll(() =>
      storyboard.evaluate((image: HTMLImageElement) => image.naturalWidth)
    )
    .toBeGreaterThan(0)

  const beforeReload = await page
    .locator("[data-sequence]:visible")
    .evaluateAll((items) =>
      items.map((item) => item.getAttribute("data-sequence"))
    )
  await page.reload()
  await expect(page.getByText("Run completed.", { exact: false })).toBeVisible()
  await expect(storyboard).toBeVisible()
  const afterReload = await page
    .locator("[data-sequence]:visible")
    .evaluateAll((items) =>
      items.map((item) => item.getAttribute("data-sequence"))
    )
  expect(afterReload).toEqual(beforeReload)

  const delivered = await page.content()
  for (const canary of privilegedCanaries)
    expect(delivered).not.toContain(canary)
  await page.screenshot({
    path: testInfo.outputPath("activity-parallel-desktop.png"),
    fullPage: true,
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  const documentationTab = page.getByRole("tab", { name: "Documentation" })
  await documentationTab.focus()
  await page.keyboard.press("ArrowRight")
  await expect(page.getByRole("tab", { name: "Code" })).toHaveAttribute(
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
  await page.screenshot({
    path: testInfo.outputPath("activity-parallel-mobile.png"),
    fullPage: true,
  })
})
