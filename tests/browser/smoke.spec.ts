import { expect, test } from "@playwright/test"

test("renders the control application and health route", async ({ page }) => {
  await page.goto("/")

  await expect(
    page.getByRole("heading", { level: 1, name: "Sentinel" })
  ).toBeVisible()

  const healthResponse = await page.request.get("/api/health")
  await expect(healthResponse).toBeOK()
  await expect(healthResponse.json()).resolves.toEqual({
    service: "web",
    status: "ok",
  })
})
