import { expect, test } from "@playwright/test"

const applicationId = "25252525-2525-4525-8525-252525252525"
const privilegedCanaries = [
  "supabase-service-canary-snt022",
  "neo4j-password-canary-snt022",
  "azure-model-canary-snt022",
  "github-token-canary-snt022",
  "operator-token-canary-snt022-must-not-leak",
]

test("drills through a cited path and resumes a review interrupt once", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/knowledge/${applicationId}`)

  await expect(
    page.getByRole("heading", { name: "Hi.Events checkout" })
  ).toBeVisible()
  await expect(page.getByText(/Current knowledge is stale/)).toBeVisible()
  await expect(
    page.getByText("9f8e7d6c5b4a", { exact: true }).first()
  ).toBeVisible()
  await expect(
    page.getByText("Cross-layer path reaches implementation evidence")
  ).toBeVisible()
  await expect(page.getByText("OrderController.create")).toBeVisible()

  await page
    .locator("summary")
    .filter({ hasText: /^StatesA$/ })
    .click()
  await page.getByRole("button", { name: "View private excerpt" }).click()
  const excerpt = page.getByRole("dialog", { name: "Private source excerpt" })
  await expect(excerpt).toContainText("Buyers provide attendee details")
  await page.getByRole("button", { name: "Close excerpt" }).click()

  const linkReview = page.getByRole("button", {
    name: /Requirement to checkout workflow/,
  })
  await linkReview.click()
  await expect(page.getByText("Previous decision is stale")).toBeVisible()
  await expect(page.getByText("Competing evidence (1)")).toBeVisible()

  await page.getByRole("button", { name: /Operator decision required/ }).click()
  const reason =
    "The observed state matches the documented checkout checkpoint."
  await page.getByLabel("Decision reason").fill(reason)
  const mutation = page.waitForResponse(
    (response) =>
      response.url().includes("/reviews/interrupts/") &&
      response.request().method() === "POST"
  )
  await page.getByRole("button", { name: "Accept" }).click()
  expect((await mutation).status()).toBe(202)
  await expect(
    page.getByText("This interrupt has been answered.")
  ).toBeVisible()

  const decisionId = "confirm_checkout_mapping"
  const runId = "25252525-2525-4525-8525-252525252526"
  const duplicate = await page.request.post(
    `/api/knowledge/applications/${applicationId}/reviews/interrupts/${runId}/${decisionId}`,
    {
      data: { schemaVersion: 1, decision: "accepted", reason },
    }
  )
  expect(duplicate.status()).toBe(200)
  expect((await duplicate.json()).idempotent).toBe(true)

  const content = await page.content()
  expect(content).not.toContain("The feature does not exist")
  expect(content).not.toContain("No UI is affected")
  for (const canary of privilegedCanaries) expect(content).not.toContain(canary)
  await page.screenshot({
    path: testInfo.outputPath("knowledge-review-desktop.png"),
    fullPage: true,
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(
    page.getByRole("heading", { name: "Hi.Events checkout" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Workflows" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Buyer opens saved tickets")).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    )
    .toBe(true)
  await page.screenshot({
    path: testInfo.outputPath("knowledge-review-mobile.png"),
    fullPage: true,
  })
})
