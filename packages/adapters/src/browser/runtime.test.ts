import {
  browserObservationSchema,
  browserTransitionEvidenceSchema,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"
import type { Browser, BrowserContextOptions } from "playwright"

import { FakeBrowserEvidenceRuntime } from "./fake.ts"
import { createPlaywrightBrowserEvidenceRuntime } from "./runtime.ts"

const ids = {
  action: `action:v1:${"a".repeat(64)}`,
  application: `application:v1:${"b".repeat(64)}`,
  beforeEvidence: `evidence:v1:${"c".repeat(64)}`,
  beforeFingerprint: `sha256:${"d".repeat(64)}`,
  afterEvidence: `evidence:v1:${"e".repeat(64)}`,
  afterFingerprint: `sha256:${"f".repeat(64)}`,
  transitionEvidence: `evidence:v1:${"1".repeat(64)}`,
  run: "run:11111111-1111-4111-8111-111111111111",
} as const

const candidate = {
  actionId: ids.action,
  signature: ids.beforeFingerprint,
  kind: "click",
  role: "button",
  name: "Continue",
  disabled: false,
  policy: {
    category: "safe_form_progress",
    allowed: true,
    reason: "safe_form_progress",
    replaySafe: true,
  },
  expiresAt: "2026-09-07T10:00:30.000Z",
} as const

function observation(
  evidenceId: string,
  fingerprint: string,
  candidates: readonly (typeof candidate)[]
) {
  return browserObservationSchema.parse({
    schemaVersion: 1,
    evidenceId,
    applicationId: ids.application,
    runId: ids.run,
    url: "https://example.test/flow",
    normalizedRoute: "/flow",
    title: "Fixture",
    headings: ["Fixture"],
    controls: [{ role: "button", name: "Continue", disabled: false }],
    dialogs: [],
    selectedText: ["Fixture state"],
    candidates,
    stateFingerprint: fingerprint,
    errors: [],
    observedAt: "2026-09-07T10:00:00.000Z",
  })
}

describe("fake browser evidence runtime", () => {
  it("follows the production observation and transition contract", async () => {
    const runtime = new FakeBrowserEvidenceRuntime()
    const before = observation(ids.beforeEvidence, ids.beforeFingerprint, [
      candidate,
    ])
    const after = observation(ids.afterEvidence, ids.afterFingerprint, [])
    const transition = browserTransitionEvidenceSchema.parse({
      schemaVersion: 1,
      evidenceId: ids.transitionEvidence,
      runId: ids.run,
      action: candidate,
      before,
      after,
      network: [],
      errors: [],
      observedAt: "2026-09-07T10:00:01.000Z",
    })
    runtime.enqueue(ids.run, { initial: before, transitions: [transition] })

    await expect(
      runtime.startRun({
        applicationId: ids.application,
        runId: ids.run,
        entryUrl: before.url,
        policy: { allowedOrigins: ["https://example.test"] },
      })
    ).resolves.toStrictEqual(before)
    await expect(
      runtime.performAction(ids.run, ids.action)
    ).resolves.toStrictEqual(transition)
    expect((await runtime.observe(ids.run)).stateFingerprint).toBe(
      ids.afterFingerprint
    )
    await runtime.completeRun(ids.run)
    expect(runtime.isActive(ids.run)).toBe(false)
    expect(runtime.completedRuns).toStrictEqual([ids.run])
  })

  it("records cancellation and rejects unknown scripts", async () => {
    const runtime = new FakeBrowserEvidenceRuntime()
    await expect(
      runtime.startRun({
        applicationId: ids.application,
        runId: ids.run,
        entryUrl: "https://example.test/",
        policy: { allowedOrigins: ["https://example.test"] },
      })
    ).rejects.toThrow(/No fake browser script/)

    const initial = observation(ids.beforeEvidence, ids.beforeFingerprint, [])
    runtime.enqueue(ids.run, { initial, transitions: [] })
    await runtime.startRun({
      applicationId: ids.application,
      runId: ids.run,
      entryUrl: initial.url,
      policy: { allowedOrigins: ["https://example.test"] },
    })
    await runtime.cancelRun(ids.run)
    expect(runtime.cancelledRuns).toStrictEqual([ids.run])
  })

  it("rejects scripted transitions from a different active state", async () => {
    const runtime = new FakeBrowserEvidenceRuntime()
    const initial = observation(ids.beforeEvidence, ids.beforeFingerprint, [
      candidate,
    ])
    const wrongBefore = observation(ids.afterEvidence, ids.afterFingerprint, [
      candidate,
    ])
    const transition = browserTransitionEvidenceSchema.parse({
      schemaVersion: 1,
      evidenceId: ids.transitionEvidence,
      runId: ids.run,
      action: candidate,
      before: wrongBefore,
      after: wrongBefore,
      network: [],
      errors: [],
      observedAt: "2026-09-07T10:00:01.000Z",
    })
    runtime.enqueue(ids.run, { initial, transitions: [transition] })
    await runtime.startRun({
      applicationId: ids.application,
      runId: ids.run,
      entryUrl: initial.url,
      policy: { allowedOrigins: ["https://example.test"] },
    })
    await expect(runtime.performAction(ids.run, ids.action)).rejects.toThrow(
      /stale/
    )
  })
})

describe("Playwright browser setup cleanup", () => {
  it("closes a launched browser when context creation fails", async () => {
    let closed = 0
    let contextOptions: BrowserContextOptions | undefined
    const browser = {
      async newContext(options?: BrowserContextOptions) {
        contextOptions = options
        throw new Error("context setup failed")
      },
      async close() {
        closed += 1
      },
    } as unknown as Browser
    const runtime = createPlaywrightBrowserEvidenceRuntime({
      artifacts: {
        async persist() {
          throw new Error("not reached")
        },
      },
      inputResolver: {
        async resolve() {
          return "not reached"
        },
      },
      launcher: {
        async launch() {
          return browser
        },
      },
    })

    await expect(
      runtime.startRun({
        applicationId: ids.application,
        runId: ids.run,
        entryUrl: "https://example.test/",
        policy: { allowedOrigins: ["https://example.test"] },
      })
    ).rejects.toMatchObject({
      failure: {
        code: "browser_error",
        message: "Browser setup failed during context_creation: browser_error",
      },
    })
    expect(closed).toBe(1)
    expect(contextOptions).toMatchObject({
      acceptDownloads: false,
      serviceWorkers: "block",
    })
    expect(runtime.isActive(ids.run)).toBe(false)
  })

  it("reserves a run ID before asynchronous browser setup", async () => {
    let resolveLaunch: ((browser: Browser) => void) | undefined
    const launchGate = new Promise<Browser>((resolve) => {
      resolveLaunch = resolve
    })
    let launches = 0
    const runtime = createPlaywrightBrowserEvidenceRuntime({
      artifacts: {
        async persist() {
          throw new Error("not reached")
        },
      },
      inputResolver: {
        async resolve() {
          return "not reached"
        },
      },
      launcher: {
        async launch() {
          launches += 1
          return launchGate
        },
      },
    })
    const options = {
      applicationId: ids.application,
      runId: ids.run,
      entryUrl: "https://example.test/",
      policy: { allowedOrigins: ["https://example.test"] },
    }

    const firstStart = runtime.startRun(options)
    await expect(runtime.startRun(options)).rejects.toMatchObject({
      failure: { code: "run_already_exists" },
    })
    if (resolveLaunch === undefined)
      throw new Error("Launch gate was not ready")
    resolveLaunch({
      async newContext() {
        throw new Error("context setup failed")
      },
      async close() {},
    } as unknown as Browser)
    await expect(firstStart).rejects.toMatchObject({
      failure: { code: "browser_error" },
    })
    expect(launches).toBe(1)
  })
})
