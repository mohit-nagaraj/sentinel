import { expect, test } from "@playwright/test"

const assessmentId = "00000000-0000-4000-8000-000000000029"
const privilegedCanaries = [
  "supabase-service-canary-snt022",
  "neo4j-password-canary-snt022",
  "azure-model-canary-snt022",
  "github-token-canary-snt022",
  "operator-token-canary-snt022-must-not-leak",
]

test("delivers an accessible operational report and a complete print document", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/assessments/${assessmentId}`)

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Rework UTM attribution tracking and admin attribution report",
    })
  ).toBeVisible()
  await expect(
    page.getByRole("navigation", { name: "Report sections" })
  ).toBeVisible()
  await expect(page.getByText(/high risk/i).first()).toBeVisible()
  await expect(page.getByText(/partially observed/i)).toBeVisible()
  await expect(page.getByText(/does not establish no impact/)).toBeVisible()

  const firstEvidence = page
    .locator("summary")
    .filter({ hasText: "Evidence path" })
    .first()
  await firstEvidence.focus()
  await page.keyboard.press("Enter")
  const artifactButton = page.getByRole("button", {
    name: /View private artifact excerpt/,
  })
  await artifactButton.focus()
  await page.keyboard.press("Enter")
  const dialog = page.getByRole("dialog", { name: "Private evidence excerpt" })
  await expect(dialog).toContainText(
    "OrderService.submit validates attribution",
    { timeout: 20_000 }
  )
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(artifactButton).toBeFocused()

  const delivered = await page.content()
  expect(delivered).not.toContain("The PR is safe")
  expect(delivered).not.toContain("No UI is affected")
  for (const canary of privilegedCanaries)
    expect(delivered).not.toContain(canary)

  await page.screenshot({
    path: testInfo.outputPath("assessment-report-desktop.png"),
    fullPage: true,
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  await page.getByRole("button", { name: "Print" }).focus()
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    )
    .toBe(true)
  await page.screenshot({
    path: testInfo.outputPath("assessment-report-mobile.png"),
    fullPage: true,
  })

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ media: "print", colorScheme: "light" })
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")))
  await expect(page.locator(".report-screen-only").first()).toBeHidden()
  await expect(page.getByText("OrderController.create").first()).toBeVisible()
  await expect(page.getByText(/Evidence caveats/)).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath("assessment-report-print.png"),
    fullPage: true,
  })
  const pdf = await page.pdf({
    path: testInfo.outputPath("assessment-report.pdf"),
    format: "A4",
    printBackground: true,
  })
  expect(pdf.byteLength).toBeGreaterThan(10_000)
})
