import {
  GITHUB_API_VERSION,
  createGithubAppJwt,
  loadAzureOpenAIEnvironment,
  loadGithubAppConfiguration,
} from "@sentinel/adapters"
import { chromium, type Browser } from "playwright"

export type WorkerDependencyName = "model" | "browser" | "github"

export type WorkerDependencyProbe = (
  signal: AbortSignal
) => boolean | Promise<boolean>

export type WorkerDependencyProbes = Readonly<
  Record<WorkerDependencyName, WorkerDependencyProbe>
>

interface DependencyHealthRuntime {
  readonly fetcher?: typeof fetch
  readonly launchBrowser?: () => Promise<Pick<Browser, "close">>
}

function authorizationHeader(apiKey: string): string {
  return `Bearer ${apiKey}`
}

export function createWorkerDependencyProbes(
  environment: Readonly<Record<string, string | undefined>>,
  runtime: DependencyHealthRuntime = {}
): WorkerDependencyProbes {
  const fetcher = runtime.fetcher ?? fetch
  const launchBrowser =
    runtime.launchBrowser ??
    (() =>
      chromium.launch({
        headless: true,
        timeout: 3_000,
        args: ["--disable-webrtc", "--disable-background-networking"],
      }))

  return {
    model: async (signal) => {
      const configuration = loadAzureOpenAIEnvironment(environment)
      const url = new URL("models", configuration.AZURE_OPENAI_ENDPOINT)
      const response = await fetcher(url, {
        cache: "no-store",
        headers: {
          accept: "application/json",
          authorization: authorizationHeader(
            configuration.AZURE_OPENAI_API_KEY
          ),
        },
        signal,
      })
      if (!response.ok) return false
      const payload = (await response.json()) as unknown
      if (
        payload === null ||
        typeof payload !== "object" ||
        !("data" in payload) ||
        !Array.isArray(payload.data)
      ) {
        return false
      }
      return payload.data.some(
        (model) =>
          model !== null &&
          typeof model === "object" &&
          "id" in model &&
          model.id === configuration.AZURE_OPENAI_DEPLOYMENT
      )
    },
    browser: async (signal) => {
      if (signal.aborted) return false
      const browser = await launchBrowser()
      const abort = () => void browser.close().catch(() => undefined)
      signal.addEventListener("abort", abort, { once: true })
      try {
        return !signal.aborted
      } finally {
        signal.removeEventListener("abort", abort)
        await browser.close()
      }
    },
    github: async (signal) => {
      const configuration = await loadGithubAppConfiguration(environment)
      const jwt = createGithubAppJwt(configuration)
      const response = await fetcher("https://api.github.com/app", {
        cache: "no-store",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "user-agent": "sentinel-worker/0.0.1",
          "x-github-api-version": GITHUB_API_VERSION,
        },
        signal,
      })
      if (!response.ok) return false
      const payload = (await response.json()) as unknown
      return (
        payload !== null &&
        typeof payload === "object" &&
        "id" in payload &&
        String(payload.id) === configuration.appId
      )
    },
  }
}
