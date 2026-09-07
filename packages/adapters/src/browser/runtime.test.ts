import {
  browserObservationSchema,
  browserTransitionEvidenceSchema,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import { FakeBrowserEvidenceRuntime } from "./fake.ts"

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
