import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createWorkerDependencyProbes } from "./dependency-health.ts"

describe("worker dependency probes", () => {
  let temporaryDirectory: string | undefined

  afterEach(async () => {
    if (temporaryDirectory !== undefined) {
      await rm(temporaryDirectory, { recursive: true, force: true })
      temporaryDirectory = undefined
    }
  })

  it("verifies the configured model, browser executable, and GitHub App", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "sentinel-health-"))
    const privateKeyPath = join(temporaryDirectory, "github-app.pem")
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    await writeFile(
      privateKeyPath,
      privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 }
    )
    const environment = {
      AZURE_OPENAI_ENDPOINT: "https://sentinel.openai.azure.com/openai/v1/",
      AZURE_OPENAI_API_KEY: "azure-key-long-enough-for-validation",
      AZURE_OPENAI_DEPLOYMENT: "sentinel-model",
      GITHUB_APP_ID: "123",
      GITHUB_APP_CLIENT_ID: "Iv23sentinelclient",
      GITHUB_APP_PRIVATE_KEY_PATH: privateKeyPath,
      GITHUB_APP_WEBHOOK_SECRET: "w".repeat(32),
      SENTINEL_PUBLIC_BASE_URL: "https://sentinel.example",
    }
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      if (url.endsWith("/models")) {
        expect(headers.get("authorization")).toBe(
          `Bearer ${environment.AZURE_OPENAI_API_KEY}`
        )
        return Response.json({ data: [{ id: "sentinel-model" }] })
      }
      expect(url).toBe("https://api.github.com/app")
      expect(headers.get("authorization")).toMatch(
        /^Bearer [^.]+(?:\.[^.]+){2}$/
      )
      expect(headers.get("x-github-api-version")).toBe("2026-03-10")
      return Response.json({ id: 123 })
    })
    const close = vi.fn().mockResolvedValue(undefined)
    const launchBrowser = vi.fn().mockResolvedValue({ close })
    const probes = createWorkerDependencyProbes(environment, {
      fetcher,
      launchBrowser,
    })
    const signal = new AbortController().signal

    await expect(probes.model(signal)).resolves.toBe(true)
    await expect(probes.browser(signal)).resolves.toBe(true)
    await expect(probes.github(signal)).resolves.toBe(true)
    expect(launchBrowser).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it("rejects malformed or mismatched provider responses", async () => {
    const environment = {
      AZURE_OPENAI_ENDPOINT: "https://sentinel.openai.azure.com/openai/v1/",
      AZURE_OPENAI_API_KEY: "azure-key-long-enough-for-validation",
      AZURE_OPENAI_DEPLOYMENT: "expected-deployment",
    }
    const probes = createWorkerDependencyProbes(environment, {
      fetcher: vi
        .fn()
        .mockResolvedValue(
          Response.json({ data: [{ id: "different-deployment" }] })
        ),
      launchBrowser: vi.fn(),
    })
    await expect(probes.model(new AbortController().signal)).resolves.toBe(
      false
    )
    await expect(
      probes.github(new AbortController().signal)
    ).rejects.toMatchObject({ code: "configuration_invalid" })
  })
})
