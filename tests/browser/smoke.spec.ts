import { expect, test } from "@playwright/test"

test("renders the control application and health route", async ({ page }) => {
  await page.goto("/")

  await expect(
    page.getByText("Sentinel", { exact: true }).first()
  ).toBeVisible()
  await expect(page).toHaveTitle("Sentinel")

  const healthResponse = await page.request.get("/api/health")
  await expect(healthResponse).toBeOK()
  await expect(healthResponse.json()).resolves.toEqual({
    service: "web",
    status: "ok",
  })
})
