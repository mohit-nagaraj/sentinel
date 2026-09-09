import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env["SENTINEL_BROWSER_PORT"] ?? 3100)
const baseURL = `http://127.0.0.1:${port}`
const isCI = Boolean(process.env["CI"])

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: "./output/playwright/test-results",
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  ...(isCI ? { workers: 1 } : {}),
  reporter: [
    ["list"],
    ["html", { outputFolder: "./output/playwright/report", open: "never" }],
  ],
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `cross-env SENTINEL_CONTROL_PLANE_FIXTURE=1 SENTINEL_OPERATOR_ID=00000000-0000-4000-8000-000000000022 SENTINEL_OPERATOR_TOKEN=operator-token-canary-snt022-must-not-leak SUPABASE_SERVICE_ROLE_KEY=supabase-service-canary-snt022 NEO4J_PASSWORD=neo4j-password-canary-snt022 AZURE_OPENAI_API_KEY=azure-model-canary-snt022 GITHUB_TOKEN=github-token-canary-snt022 pnpm --filter @sentinel/web dev --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
