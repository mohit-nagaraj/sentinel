import {
  BrowserRuntimeError,
  createPlaywrightBrowserEvidenceRuntime,
  type BrowserArtifactSink,
  type BrowserClock,
  type BrowserLauncher,
  type BrowserRunOptions,
} from "@sentinel/adapters"
import {
  artifactIdSchema,
  contentHashSchema,
  type ApplicationId,
  type ArtifactId,
  type RunId,
} from "@sentinel/contracts"
import { chromium, type Browser } from "@playwright/test"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  startBrowserFixtureApplication,
  type BrowserFixtureApplication,
} from "../fixtures/browser-application.ts"

const applicationId = `application:v1:${"a".repeat(64)}`
const runIds = {
  primary: "run:11111111-1111-4111-8111-111111111111",
  secondary: "run:22222222-2222-4222-8222-222222222222",
  stale: "run:33333333-3333-4333-8333-333333333333",
  expired: "run:44444444-4444-4444-8444-444444444444",
  failure: "run:55555555-5555-4555-8555-555555555555",
  recovery: "run:66666666-6666-4666-8666-666666666666",
  cleanup: "run:77777777-7777-4777-8777-777777777777",
  callback: "run:88888888-8888-4888-8888-888888888888",
  redirect: "run:99999999-9999-4999-8999-999999999999",
  mediaLimits: "run:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  mismatch: "run:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  abort: "run:dddddddd-dddd-4ddd-8ddd-dddddddddddd",
} as const

class MemoryArtifacts implements BrowserArtifactSink {
  readonly records: Array<{
    artifactType: "screenshot" | "trace"
    retention: "report" | "failure"
    body: Uint8Array
  }> = []
  failNext = false

  async persist(input: {
    readonly applicationId: ApplicationId
    readonly runId: RunId
    readonly artifactType: "screenshot" | "trace"
    readonly mimeType: "image/png" | "application/json"
    readonly body: Uint8Array
    readonly retention: "report" | "failure"
  }): Promise<ArtifactId> {
    if (this.failNext) {
      this.failNext = false
      throw new Error("artifact persistence failed with token=private")
    }
    this.records.push({
      artifactType: input.artifactType,
      retention: input.retention,
      body: input.body,
    })
    return artifactIdSchema.parse(
      `artifact:v1:${this.records.length.toString(16).padStart(64, "0")}`
    )
  }
}

class TrackingLauncher implements BrowserLauncher {
  readonly browsers: Browser[] = []
  disconnected = 0

  async launch(): Promise<Browser> {
    const browser = await chromium.launch({ headless: true })
    browser.on("disconnected", () => {
      this.disconnected += 1
    })
    this.browsers.push(browser)
    return browser
  }
}

class MutableClock implements BrowserClock {
  private current = new Date("2026-09-07T10:00:00.000Z")

  now(): Date {
    return new Date(this.current)
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds)
  }
}

function failureCode(error: unknown): string | undefined {
  return error instanceof BrowserRuntimeError ? error.failure.code : undefined
}

describe("Playwright browser evidence runtime", () => {
  let fixture: BrowserFixtureApplication

  beforeAll(async () => {
    fixture = await startBrowserFixtureApplication()
  }, 30_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  function options(
    runId: string,
    path = "/",
    overrides: Partial<BrowserRunOptions> = {}
  ): BrowserRunOptions {
    return {
      applicationId,
      runId,
      entryUrl: `${fixture.origin}${path}`,
      inputSlots: [
        { slot: "account_email", kind: "fill", accessibleName: "Email" },
        {
          slot: "account_password",
          kind: "fill",
          accessibleName: "Password",
        },
        {
          slot: "ticket_type",
          kind: "select",
          accessibleName: "Ticket type",
        },
      ],
      policy: {
        allowedOrigins: [fixture.origin],
        allowInsecureLocalhost: true,
      },
      ...overrides,
    }
  }

  it("injects auth by reference, enumerates safe slots, and emits redacted transition evidence", async () => {
    const artifacts = new MemoryArtifacts()
    const storageReferences: string[] = []
    const runtime = createPlaywrightBrowserEvidenceRuntime({
      artifacts,
      inputResolver: {
        async resolve(_runId, slot) {
          return (
            {
              account_email: "buyer@example.test",
              account_password: "correct horse battery staple",
              ticket_type: "vip",
            }[slot] ?? ""
          )
        },
      },
      storageStateProvider: {
        async resolve(reference) {
          storageReferences.push(reference)
          return {
            cookies: [
              {
                name: "fixture_auth",
                value: "browser-storage-secret-value",
                domain: "127.0.0.1",
                path: "/",
                expires: -1,
                httpOnly: true,
                secure: false,
                sameSite: "Lax",
              },
            ],
            origins: [],
          }
        },
      },
    })
    const secretReference = `secret-ref:v1:${"b".repeat(64)}`
    let observation = await runtime.startRun({
      ...options(runIds.primary),
      storageStateReference: secretReference,
    })
    expect(storageReferences).toStrictEqual([secretReference])
    expect(observation.selectedText).toContain(
      "Authenticated session [REDACTED]"
    )
    expect(observation.selectedText).toContain("Peer connection blocked")
    expect(JSON.stringify(observation)).not.toContain("raw-private-note")
    expect(observation.screenshotArtifactId).toMatch(/^artifact:v1:/)

    for (const [name, slot] of [
      ["Email", "account_email"],
      ["Password", "account_password"],
      ["Ticket type", "ticket_type"],
    ] as const) {
      const candidate = observation.candidates.find(
        (value) => value.name === name && value.inputSlot === slot
      )
      expect(candidate?.policy.allowed).toBe(true)
      const transition = await runtime.performAction(
        runIds.primary,
        candidate?.actionId ?? "missing"
      )
      observation = transition.after
    }

    expect(
      observation.candidates.find((value) => value.name === "Continue")?.policy
    ).toMatchObject({ category: "unknown_submission", allowed: false })
    const continueAction = observation.candidates.find(
      (value) => value.name === "Load attendee details"
    )
    const transition = await runtime.performAction(
      runIds.primary,
      continueAction?.actionId ?? "missing"
    )
    const serialized = JSON.stringify(transition)
    expect(transition.after.normalizedRoute).toBe("/details/redacted")
    expect(transition.network).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "GET",
          normalizedPath: "/api/step",
          status: 201,
          outcome: "response",
        }),
      ])
    )
    expect(serialized).not.toMatch(
      /buyer@example\.test|correct horse|vip|selector|locator|cookie|storageState/
    )
    expect(
      runtime
        .createRecoveryRecipe(runIds.primary)
        .steps.some((step) => step.name === "Load attendee details")
    ).toBe(true)
    expect(
      artifacts.records.every((record) => record.body.byteLength > 0)
    ).toBe(true)
    await runtime.completeRun(runIds.primary)

    const volatileFirst = await runtime.startRun(
      options(runIds.primary, "/volatile")
    )
    await runtime.completeRun(runIds.primary)
    const volatileSecond = await runtime.startRun(
      options(runIds.secondary, "/volatile")
    )
    expect(volatileSecond.stateFingerprint).toBe(volatileFirst.stateFingerprint)
    await runtime.completeRun(runIds.secondary)
  }, 30_000)

  it("keeps duplicate semantic states stable and distinguishes modal state", async () => {
    const runtime = createPlaywrightBrowserEvidenceRuntime({
      artifacts: new MemoryArtifacts(),
      inputResolver: {
        async resolve() {
          return "unused"
        },
      },
    })
    let observation = await runtime.startRun(options(runIds.primary))
    const sameState = await runtime.startRun(options(runIds.secondary))
    expect(
      sameState.candidates.map(({ signature, kind, name }) => ({
        signature,
        kind,
        name,
      }))
    ).toStrictEqual(
      observation.candidates.map(({ signature, kind, name }) => ({
        signature,
        kind,
        name,
      }))
    )
    await runtime.completeRun(runIds.secondary)
    const refresh = observation.candidates.find(
      (value) => value.name === "Refresh state"
    )
    const duplicate = await runtime.performAction(
      runIds.primary,
      refresh?.actionId ?? "missing"
    )
    expect(duplicate.after.stateFingerprint).toBe(
      duplicate.before.stateFingerprint
    )
    observation = duplicate.after
    const modal = observation.candidates.find(
      (value) => value.name === "Open modal"
    )
    const changed = await runtime.performAction(
      runIds.primary,
      modal?.actionId ?? "missing"
    )
    expect(changed.after.stateFingerprint).not.toBe(
      changed.before.stateFingerprint
    )
    expect(changed.after.dialogs[0]).toMatchObject({
      role: "dialog",
      name: "Confirmation",
      text: "Confirm [EMAIL_REDACTED]",
    })
    await runtime.completeRun(runIds.primary)
  }, 30_000)

  it("fails closed for forged, cross-run, reused, stale, expired, and concurrent actions", async () => {
    const artifacts = new MemoryArtifacts()
    const runtime = createPlaywrightBrowserEvidenceRuntime({
      artifacts,
      inputResolver: {
        async resolve() {
          return "unused"
        },
      },
    })
    const first = await runtime.startRun(options(runIds.primary))
    const second = await runtime.startRun(options(runIds.secondary))
    const refresh = first.candidates.find(
      (value) => value.name === "Refresh state"
    )
    const forged = `action:v1:${"f".repeat(64)}`
    await expect(
      runtime.performAction(runIds.primary, forged)
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "action_not_found"
    )
    await expect(
      runtime.performAction(runIds.secondary, refresh?.actionId ?? "missing")
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "action_cross_run"
    )
    await runtime.performAction(runIds.primary, refresh?.actionId ?? "missing")
    await expect(
      runtime.performAction(runIds.primary, refresh?.actionId ?? "missing")
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "action_reused"
    )

    const slow = second.candidates.find(
      (value) => value.name === "Load slow response"
    )
    const inFlight = runtime.performAction(
      runIds.secondary,
      slow?.actionId ?? "missing"
    )
    await expect(
      runtime.performAction(runIds.secondary, slow?.actionId ?? "missing")
    ).rejects.toSatisfy((error: unknown) => failureCode(error) === "run_busy")
    await expect(runtime.observe(runIds.secondary)).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "run_busy"
    )
    await inFlight
    await runtime.completeRun(runIds.primary)
    await runtime.completeRun(runIds.secondary)

    const stale = await runtime.startRun(options(runIds.stale, "/stale"))
    const staleAction = stale.candidates.find(
      (value) => value.name === "Continue"
    )
    await new Promise((resolve) => setTimeout(resolve, 600))
    await expect(
      runtime.performAction(runIds.stale, staleAction?.actionId ?? "missing")
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "action_stale"
    )
    await runtime.completeRun(runIds.stale)

    const expired = await runtime.startRun(
      options(runIds.expired, "/", {
        policy: {
          allowedOrigins: [fixture.origin],
          allowInsecureLocalhost: true,
          budgets: { actionExpiryMs: 100 },
        },
      })
    )
    const expiredAction = expired.candidates.find(
      (value) => value.name === "Refresh state"
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    await expect(
      runtime.performAction(
        runIds.expired,
        expiredAction?.actionId ?? "missing"
      )
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "action_expired"
    )
    await runtime.completeRun(runIds.expired)

    const positionObservation = await runtime.startRun(
      options(runIds.expired, "/stale-position")
    )
    const positioned = positionObservation.candidates.find(
      (value) => value.name === "Show position state"
    )
    await new Promise((resolve) => setTimeout(resolve, 600))
    const positionedTransition = await runtime.performAction(
      runIds.expired,
      positioned?.actionId ?? "missing"
    )
    expect(positionedTransition.after.selectedText).toContain(
      "Position target selected"
    )
    await runtime.completeRun(runIds.expired)

    const piiObservation = await runtime.startRun(
      options(runIds.expired, "/stale-pii")
    )
    const piiAction = piiObservation.candidates.find(
      (value) => value.name === "View [EMAIL_REDACTED]"
    )
    await new Promise((resolve) => setTimeout(resolve, 600))
    await expect(
      runtime.performAction(runIds.expired, piiAction?.actionId ?? "missing")
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "action_stale"
    )
    await runtime.completeRun(runIds.expired)

    const attributeObservation = await runtime.startRun(
      options(runIds.expired, "/stale-attributes")
    )
    const mutable = attributeObservation.candidates.find(
      (value) => value.name === "Load mutable state"
    )
    await new Promise((resolve) => setTimeout(resolve, 600))
    await expect(
      runtime.performAction(runIds.expired, mutable?.actionId ?? "missing")
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "action_stale"
    )
    await runtime.completeRun(runIds.expired)
  }, 30_000)

  it("denies unsafe categories, downloads, popups, and off-origin redirects", async () => {
    const artifacts = new MemoryArtifacts()
    const runtime = createPlaywrightBrowserEvidenceRuntime({
      artifacts,
      inputResolver: {
        async resolve() {
          return "unused"
        },
      },
    })
    const observation = await runtime.startRun({
      ...options(runIds.failure),
      traceOnFailure: true,
    })
    const expectedCategories = new Map([
      ["Delete account", "destructive"],
      ["Place order", "payment"],
      ["Send message", "external_message"],
      ["Make administrator", "account_privilege"],
      ["Submit mystery", "unknown_submission"],
      ["Download invoice", "download"],
      ["Open popup", "popup"],
    ])
    for (const [name, category] of expectedCategories) {
      expect(
        observation.candidates.find((value) => value.name === name)?.policy
      ).toMatchObject({ allowed: false, category })
    }
    expect(
      observation.candidates.find((value) => value.name === "Close account")
        ?.policy
    ).toMatchObject({ allowed: false, category: "destructive" })
    const denied = observation.candidates.find(
      (value) => value.name === "Delete account"
    )
    await expect(
      runtime.performAction(runIds.failure, denied?.actionId ?? "missing")
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "policy_denied"
    )
    for (const name of ["Download invoice", "Open popup"]) {
      const action = observation.candidates.find((value) => value.name === name)
      await expect(
        runtime.performAction(runIds.failure, action?.actionId ?? "missing")
      ).rejects.toSatisfy(
        (error: unknown) => failureCode(error) === "policy_denied"
      )
    }
    const externalSocket = observation.candidates.find(
      (value) => value.name === "Show external socket"
    )
    artifacts.failNext = true
    await expect(
      runtime.performAction(
        runIds.failure,
        externalSocket?.actionId ?? "missing"
      )
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof BrowserRuntimeError &&
        error.failure.code === "host_denied" &&
        !error.failure.message.includes("private")
      )
    })

    const redirect = observation.candidates.find(
      (value) => value.name === "Redirect outside"
    )
    let failure: BrowserRuntimeError | undefined
    try {
      await runtime.performAction(
        runIds.failure,
        redirect?.actionId ?? "missing"
      )
    } catch (error) {
      if (error instanceof BrowserRuntimeError) failure = error
    }
    expect({
      failure: failure?.failure,
      records: artifacts.records.map(({ artifactType, retention }) => ({
        artifactType,
        retention,
      })),
    }).toMatchObject({
      failure: {
        code: "host_denied",
        screenshotArtifactId: expect.stringMatching(/^artifact:v1:/),
        traceArtifactId: expect.stringMatching(/^artifact:v1:/),
      },
      records: expect.arrayContaining([
        { artifactType: "screenshot", retention: "failure" },
        { artifactType: "trace", retention: "failure" },
      ]),
    })
    expect(artifacts.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactType: "screenshot",
          retention: "failure",
        }),
        expect.objectContaining({
          artifactType: "trace",
          retention: "failure",
        }),
      ])
    )
    const trace = artifacts.records.find(
      (record) => record.artifactType === "trace"
    )
    const traceText = new TextDecoder().decode(trace?.body)
    expect(JSON.parse(traceText)).toMatchObject({
      kind: "sanitized_browser_failure_trace",
      runId: runIds.failure,
    })
    expect(traceText).not.toMatch(
      /must-not-appear|buyer@example|correct horse|authorization|cookie|locator|selector/
    )
    await runtime.cancelRun(runIds.failure)

    const redirectObservation = await runtime.startRun(
      options(runIds.redirect, "/", {
        policy: {
          allowedOrigins: [fixture.origin],
          allowInsecureLocalhost: true,
          budgets: { maxRedirects: 1 },
        },
      })
    )
    const redirectChain = redirectObservation.candidates.find(
      (value) => value.name === "Redirect chain"
    )
    await expect(
      runtime.performAction(
        runIds.redirect,
        redirectChain?.actionId ?? "missing"
      )
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "redirect_limit_reached"
    )
    await runtime.cancelRun(runIds.redirect)

    const mediaObservation = await runtime.startRun(
      options(runIds.mediaLimits, "/", {
        policy: {
          allowedOrigins: [fixture.origin],
          allowedCategories: [
            "safe_read",
            "safe_navigation",
            "safe_form_progress",
            "credential_entry",
            "download",
          ],
          allowInsecureLocalhost: true,
          budgets: { maxDownloads: 0, maxTabs: 1 },
        },
      })
    )
    const unexpectedPopup = mediaObservation.candidates.find(
      (value) => value.name === "Open window"
    )
    await expect(
      runtime.performAction(
        runIds.mediaLimits,
        unexpectedPopup?.actionId ?? "missing"
      )
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "tab_limit_reached"
    )
    await runtime.cancelRun(runIds.mediaLimits)

    const delayed = await runtime.startRun(
      options(runIds.secondary, "/", {
        policy: {
          allowedOrigins: [fixture.origin],
          allowInsecureLocalhost: true,
          budgets: { observationSettleMs: 0 },
        },
      })
    )
    const delayedSocket = delayed.candidates.find(
      (value) => value.name === "Show delayed connection"
    )
    await runtime.performAction(
      runIds.secondary,
      delayedSocket?.actionId ?? "missing"
    )
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    await expect(runtime.completeRun(runIds.secondary)).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "host_denied"
    )
    expect(runtime.isActive(runIds.secondary)).toBe(false)
    const downloadObservation = await runtime.startRun(
      options(runIds.mediaLimits, "/", {
        policy: {
          allowedOrigins: [fixture.origin],
          allowedCategories: [
            "safe_read",
            "safe_navigation",
            "safe_form_progress",
            "credential_entry",
            "download",
          ],
          allowInsecureLocalhost: true,
          budgets: { maxDownloads: 0, maxTabs: 1 },
        },
      })
    )
    const allowedDownload = downloadObservation.candidates.find(
      (value) => value.name === "Download invoice"
    )
    expect(allowedDownload?.policy.allowed).toBe(true)
    await expect(
      runtime.performAction(
        runIds.mediaLimits,
        allowedDownload?.actionId ?? "missing"
      )
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "download_denied"
    )
    await runtime.completeRun(runIds.mediaLimits)
  }, 30_000)

  it("correlates only action-window network and redacts console errors", async () => {
    const runtime = createPlaywrightBrowserEvidenceRuntime({
      artifacts: new MemoryArtifacts(),
      inputResolver: {
        async resolve() {
          return "unused"
        },
      },
    })
    const observation = await runtime.startRun(options(runIds.primary))
    const action = observation.candidates.find(
      (value) => value.name === "Load summary"
    )
    const transition = await runtime.performAction(
      runIds.primary,
      action?.actionId ?? "missing"
    )
    expect(transition.network).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          normalizedPath: "/api/users/redacted",
          status: 200,
        }),
      ])
    )
    expect(transition.network).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ normalizedPath: "/" })])
    )
    expect(JSON.stringify(transition)).not.toContain("must-not-appear")
    expect(transition.errors.at(-1)?.message).toBe(
      "Summary failed for [EMAIL_REDACTED]"
    )
    const pageErrorAction = transition.after.candidates.find(
      (value) => value.name === "Show page error"
    )
    const pageErrorTransition = await runtime.performAction(
      runIds.primary,
      pageErrorAction?.actionId ?? "missing"
    )
    expect(pageErrorTransition.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "page",
          message: "Page crashed for [EMAIL_REDACTED]",
        }),
      ])
    )
    await runtime.completeRun(runIds.primary)
  }, 30_000)

  it("enforces action, screen, and time budgets", async () => {
    const clock = new MutableClock()
    const runtime = createPlaywrightBrowserEvidenceRuntime({
      artifacts: new MemoryArtifacts(),
      inputResolver: {
        async resolve() {
          return "unused"
        },
      },
      clock,
    })
    const observation = await runtime.startRun(
      options(runIds.primary, "/", {
        policy: {
          allowedOrigins: [fixture.origin],
          allowInsecureLocalhost: true,
          budgets: { maxActions: 1, maxScreens: 2, maxDurationMs: 5_000 },
        },
      })
    )
    const refresh = observation.candidates.find(
      (value) => value.name === "Refresh state"
    )
    const firstTransition = await runtime.performAction(
      runIds.primary,
      refresh?.actionId ?? "missing"
    )
    const overActionBudget = firstTransition.after.candidates.find(
      (value) => value.name === "Open modal"
    )
    await expect(
      runtime.performAction(
        runIds.primary,
        overActionBudget?.actionId ?? "missing"
      )
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "action_limit_reached"
    )
    const latest = await runtime.observe(runIds.primary).catch((error) => error)
    expect(failureCode(latest)).toBe("screen_limit_reached")
    clock.advance(6_000)
    await expect(
      runtime.performAction(
        runIds.primary,
        overActionBudget?.actionId ?? "missing"
      )
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "run_expired"
    )
    await runtime.completeRun(runIds.primary)

    const screenOnlyRuntime = createPlaywrightBrowserEvidenceRuntime({
      artifacts: new MemoryArtifacts(),
      inputResolver: {
        async resolve() {
          return "unused"
        },
      },
    })
    const screenOnly = await screenOnlyRuntime.startRun(
      options(runIds.secondary, "/", {
        policy: {
          allowedOrigins: [fixture.origin],
          allowInsecureLocalhost: true,
          budgets: { maxScreens: 1 },
        },
      })
    )
    const blockedRefresh = screenOnly.candidates.find(
      (value) => value.name === "Refresh state"
    )
    await expect(
      screenOnlyRuntime.performAction(
        runIds.secondary,
        blockedRefresh?.actionId ?? "missing"
      )
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "screen_limit_reached"
    )
    await screenOnlyRuntime.completeRun(runIds.secondary)

    const advancingClock = new MutableClock()
    const midActionRuntime = createPlaywrightBrowserEvidenceRuntime({
      artifacts: new MemoryArtifacts(),
      inputResolver: {
        async resolve() {
          advancingClock.advance(5_001)
          return "buyer@example.test"
        },
      },
      clock: advancingClock,
    })
    const midAction = await midActionRuntime.startRun(
      options(runIds.expired, "/", {
        policy: {
          allowedOrigins: [fixture.origin],
          allowInsecureLocalhost: true,
          budgets: { maxDurationMs: 5_000 },
        },
      })
    )
    const email = midAction.candidates.find((value) => value.name === "Email")
    await expect(
      midActionRuntime.performAction(
        runIds.expired,
        email?.actionId ?? "missing"
      )
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "run_expired"
    )
    await midActionRuntime.completeRun(runIds.expired)
  }, 30_000)

  it("replays only safe history with fingerprint checks", async () => {
    const runtime = createPlaywrightBrowserEvidenceRuntime({
      artifacts: new MemoryArtifacts(),
      inputResolver: {
        async resolve() {
          return "unused"
        },
      },
    })
    const initial = await runtime.startRun(options(runIds.primary))
    const modal = initial.candidates.find(
      (value) => value.name === "Open modal"
    )
    const original = await runtime.performAction(
      runIds.primary,
      modal?.actionId ?? "missing"
    )
    const recipe = runtime.createRecoveryRecipe(runIds.primary)
    expect(recipe.steps).toHaveLength(1)
    await runtime.completeRun(runIds.primary)

    const replay = await runtime.replay(options(runIds.recovery), recipe)
    expect(replay.transitions).toHaveLength(1)
    expect(replay.finalObservation.stateFingerprint).toBe(
      original.after.stateFingerprint
    )
    await runtime.completeRun(runIds.recovery)

    await expect(
      runtime.replay(options(runIds.mismatch), {
        ...recipe,
        steps: recipe.steps.map((step) => ({
          ...step,
          expectedBeforeFingerprint: contentHashSchema.parse(
            `sha256:${"0".repeat(64)}`
          ),
        })),
      })
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "recovery_mismatch"
    )
    expect(runtime.isActive(runIds.mismatch)).toBe(false)
  }, 30_000)

  it("closes contexts on completion, cancellation, and callback exceptions", async () => {
    const launcher = new TrackingLauncher()
    const artifacts = new MemoryArtifacts()
    const runtime = createPlaywrightBrowserEvidenceRuntime({
      artifacts,
      inputResolver: {
        async resolve() {
          return "unused"
        },
      },
      launcher,
    })
    artifacts.failNext = true
    await expect(
      runtime.startRun(options(runIds.cleanup))
    ).rejects.toMatchObject({
      failure: { code: "browser_error" },
    })
    expect(
      (Reflect.get(runtime, "actionOwners") as Map<unknown, unknown>).size
    ).toBe(0)
    expect(runtime.isActive(runIds.cleanup)).toBe(false)
    const first = await runtime.startRun(options(runIds.cleanup))
    const ownerCount = (
      Reflect.get(runtime, "actionOwners") as Map<unknown, unknown>
    ).size
    artifacts.failNext = true
    await expect(runtime.observe(runIds.cleanup)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof BrowserRuntimeError &&
        error.failure.code === "browser_error" &&
        !error.failure.message.includes("private")
    )
    expect(
      (Reflect.get(runtime, "actionOwners") as Map<unknown, unknown>).size
    ).toBe(ownerCount)
    const oldAction = first.candidates.find(
      (value) => value.name === "Refresh state"
    )
    const completion = runtime.completeRun(runIds.cleanup)
    await expect(runtime.observe(runIds.cleanup)).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "run_busy"
    )
    await completion
    await runtime.startRun(options(runIds.cleanup))
    await expect(
      runtime.performAction(runIds.cleanup, oldAction?.actionId ?? "missing")
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "action_not_found"
    )
    await runtime.cancelRun(runIds.cleanup)
    const abortController = new AbortController()
    await expect(
      runtime.executeRun(
        options(runIds.abort),
        async (activeRuntime, observation) => {
          const slow = observation.candidates.find(
            (value) => value.name === "Load slow response"
          )
          setTimeout(() => abortController.abort(), 10)
          return activeRuntime.performAction(
            runIds.abort,
            slow?.actionId ?? "missing"
          )
        },
        abortController.signal
      )
    ).rejects.toBeDefined()
    expect(runtime.isActive(runIds.abort)).toBe(false)
    await expect(
      runtime.executeRun(options(runIds.callback), async () => {
        throw new Error("fixture callback failure")
      })
    ).rejects.toThrow("fixture callback failure")
    expect(runtime.isActive(runIds.callback)).toBe(false)
    const neverCompletes = new Promise<never>(() => undefined)
    await expect(
      runtime.executeRun(
        options(runIds.expired, "/", {
          policy: {
            allowedOrigins: [fixture.origin],
            allowInsecureLocalhost: true,
            budgets: { maxDurationMs: 2_000 },
          },
        }),
        async () => neverCompletes
      )
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "run_expired"
    )
    expect(runtime.isActive(runIds.expired)).toBe(false)
    expect(launcher.disconnected).toBe(6)
  }, 30_000)

  it("settles hanging artifact and input providers at the run deadline", async () => {
    const artifactRuntime = createPlaywrightBrowserEvidenceRuntime({
      artifacts: {
        async persist() {
          return new Promise<never>(() => undefined)
        },
      },
      inputResolver: {
        async resolve() {
          return "unused"
        },
      },
    })
    await expect(
      artifactRuntime.startRun(
        options(runIds.primary, "/", {
          policy: {
            allowedOrigins: [fixture.origin],
            allowInsecureLocalhost: true,
            budgets: { maxDurationMs: 2_000 },
          },
        })
      )
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "run_expired"
    )
    expect(artifactRuntime.isActive(runIds.primary)).toBe(false)

    const inputRuntime = createPlaywrightBrowserEvidenceRuntime({
      artifacts: new MemoryArtifacts(),
      inputResolver: {
        async resolve() {
          return new Promise<never>(() => undefined)
        },
      },
    })
    const inputObservation = await inputRuntime.startRun(
      options(runIds.secondary, "/", {
        policy: {
          allowedOrigins: [fixture.origin],
          allowInsecureLocalhost: true,
          budgets: { maxDurationMs: 3_000 },
        },
      })
    )
    const email = inputObservation.candidates.find(
      (value) => value.name === "Email"
    )
    await expect(
      inputRuntime.performAction(runIds.secondary, email?.actionId ?? "missing")
    ).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "run_expired"
    )
    expect(inputRuntime.isActive(runIds.secondary)).toBe(false)
  }, 30_000)
})
