import { describe, expect, it } from "vitest"

import {
  browserActionCandidateSchema,
  browserObservationSchema,
  browserPolicyDecisionSchema,
  browserRecoveryRecipeSchema,
  browserTransitionEvidenceSchema,
} from "./browser-runtime.ts"

const ids = {
  action: `action:v1:${"a".repeat(64)}`,
  application: `application:v1:${"b".repeat(64)}`,
  evidence: `evidence:v1:${"c".repeat(64)}`,
  fingerprint: `sha256:${"d".repeat(64)}`,
  run: "run:11111111-1111-4111-8111-111111111111",
} as const

const candidate = {
  actionId: ids.action,
  signature: ids.fingerprint,
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
}

describe("browser runtime contracts", () => {
  it("accepts a bounded selector-free observation", () => {
    const parsed = browserObservationSchema.parse({
      schemaVersion: 1,
      evidenceId: ids.evidence,
      applicationId: ids.application,
      runId: ids.run,
      url: "https://example.test/checkout",
      normalizedRoute: "/checkout",
      title: "Checkout",
      headings: ["Checkout"],
      controls: [{ role: "button", name: "Continue", disabled: false }],
      dialogs: [],
      selectedText: ["Choose tickets"],
      candidates: [candidate],
      stateFingerprint: ids.fingerprint,
      errors: [],
      observedAt: "2026-09-07T10:00:00.000Z",
    })

    expect(parsed.candidates[0]?.name).toBe("Continue")
    expect(JSON.stringify(parsed)).not.toMatch(/selector|cookie|storageState/)
  })

  it.each(["selector", "value", "href", "elementHandle", "storageState"])(
    "rejects the internal or secret-bearing candidate field %s",
    (field) => {
      expect(() =>
        browserActionCandidateSchema.parse({
          ...candidate,
          [field]: "must-not-cross-the-boundary",
        })
      ).toThrow()
    }
  )

  it("rejects contradictory policy decisions", () => {
    expect(() =>
      browserPolicyDecisionSchema.parse({
        category: "destructive",
        allowed: true,
        reason: "safe_read",
        replaySafe: true,
      })
    ).toThrow()
  })

  it("rejects transitions whose action or run is not in the before state", () => {
    const before = browserObservationSchema.parse({
      schemaVersion: 1,
      evidenceId: ids.evidence,
      applicationId: ids.application,
      runId: ids.run,
      url: "https://example.test/checkout",
      normalizedRoute: "/checkout",
      title: "Checkout",
      headings: ["Checkout"],
      controls: [],
      dialogs: [],
      selectedText: [],
      candidates: [candidate],
      stateFingerprint: ids.fingerprint,
      errors: [],
      observedAt: "2026-09-07T10:00:00.000Z",
    })
    expect(() =>
      browserTransitionEvidenceSchema.parse({
        schemaVersion: 1,
        evidenceId: `evidence:v1:${"e".repeat(64)}`,
        runId: "run:22222222-2222-4222-8222-222222222222",
        action: { ...candidate, signature: `sha256:${"f".repeat(64)}` },
        before,
        after: before,
        network: [],
        errors: [],
        observedAt: "2026-09-07T10:00:01.000Z",
      })
    ).toThrow()
    expect(() =>
      browserTransitionEvidenceSchema.parse({
        schemaVersion: 1,
        evidenceId: `evidence:v1:${"e".repeat(64)}`,
        runId: ids.run,
        action: { ...candidate, name: "Different action" },
        before,
        after: before,
        network: [],
        errors: [],
        observedAt: "2026-09-07T10:00:01.000Z",
      })
    ).toThrow()
  })

  it("rejects unbounded observations", () => {
    expect(() =>
      browserObservationSchema.parse({
        schemaVersion: 1,
        evidenceId: ids.evidence,
        applicationId: ids.application,
        runId: ids.run,
        url: "https://example.test/",
        normalizedRoute: "/",
        title: "Example",
        headings: Array.from({ length: 51 }, (_, index) => `Heading ${index}`),
        controls: [],
        dialogs: [],
        selectedText: [],
        candidates: [],
        stateFingerprint: ids.fingerprint,
        errors: [],
        observedAt: "2026-09-07T10:00:00.000Z",
      })
    ).toThrow()
  })

  it("rejects browser URLs beyond the public observation limit", () => {
    expect(() =>
      browserObservationSchema.parse({
        schemaVersion: 1,
        evidenceId: ids.evidence,
        applicationId: ids.application,
        runId: ids.run,
        url: `https://example.test/${"x".repeat(2_100)}`,
        normalizedRoute: "/",
        title: "Example",
        headings: [],
        controls: [],
        dialogs: [],
        selectedText: [],
        candidates: [],
        stateFingerprint: ids.fingerprint,
        errors: [],
        observedAt: "2026-09-07T10:00:00.000Z",
      })
    ).toThrow()
  })

  it("represents replay without action IDs, locators, or raw values", () => {
    const recipe = browserRecoveryRecipeSchema.parse({
      schemaVersion: 1,
      applicationId: ids.application,
      sourceRunId: ids.run,
      entryUrl: "https://example.test/checkout",
      createdAt: "2026-09-07T10:01:00.000Z",
      steps: [
        {
          ordinal: 0,
          signature: ids.fingerprint,
          kind: "click",
          name: "Continue",
          expectedBeforeFingerprint: ids.fingerprint,
          expectedAfterFingerprint: `sha256:${"e".repeat(64)}`,
          replaySafe: true,
        },
      ],
    })

    expect(JSON.stringify(recipe)).not.toMatch(/actionId|selector|value|secret/)
  })
})
