import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  canonicalSerialize,
  createActionId,
  createArtifactId,
  createClaimId,
  createEventId,
  createFindingId,
  createMissionId,
  createRunScopedEvidenceId,
  createStableKey,
  hashCanonical,
  repositoryPathSchema,
  runIdSchema,
  stableKeyInputSchema,
} from "@sentinel/contracts"

const appId =
  "application:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const sourceId =
  "document-source:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const pageId =
  "document-page:v1:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
const sectionId =
  "document-section:v1:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
const workflowId =
  "workflow:v1:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
const screenId =
  "screen:v1:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
const requirementId =
  "requirement:v1:1111111111111111111111111111111111111111111111111111111111111111"
const hash =
  "sha256:2222222222222222222222222222222222222222222222222222222222222222"
const commitSha = "0497418d5c66d20693751e68be066260eda3f37f"
const repository = {
  host: "github.com",
  owner: "mohit-nagaraj",
  name: "Hi.Events",
}

const stableKeyInputs: readonly unknown[] = [
  {
    kind: "application",
    deploymentUrl: "https://demo.example.com",
    repository,
  },
  {
    kind: "document-source",
    applicationId: appId,
    rootUri: "https://hi.events/docs",
  },
  {
    kind: "document-page",
    applicationId: appId,
    sourceId,
    canonicalUri: "https://hi.events/docs/tickets",
    contentHash: hash,
  },
  {
    kind: "document-section",
    applicationId: appId,
    pageId,
    headingPath: ["Tickets"],
    contentHash: hash,
  },
  {
    kind: "requirement",
    applicationId: appId,
    sectionId,
    statementFingerprint: hash,
  },
  { kind: "capability", applicationId: appId, normalizedName: "create order" },
  {
    kind: "workflow",
    applicationId: appId,
    actor: "buyer",
    normalizedName: "complete checkout",
  },
  {
    kind: "flow-step",
    applicationId: appId,
    workflowId,
    ordinal: 1,
    actionType: "click",
  },
  {
    kind: "screen",
    applicationId: appId,
    normalizedRoute: "/checkout",
    stateFingerprint: hash,
  },
  {
    kind: "ui-element",
    applicationId: appId,
    screenId,
    role: "button",
    accessibleName: "Continue",
    contextFingerprint: hash,
  },
  {
    kind: "frontend-route",
    applicationId: appId,
    repository,
    commitSha,
    pathPattern: "/checkout/{eventId}",
  },
  {
    kind: "code-file",
    applicationId: appId,
    repository,
    commitSha,
    path: "frontend/src/Checkout.tsx",
  },
  {
    kind: "code-symbol",
    applicationId: appId,
    repository,
    commitSha,
    filePath: "backend/app/CreateOrderHandler.php",
    qualifiedName: "CreateOrderHandler::handle",
    symbolKind: "handler",
  },
  {
    kind: "api-endpoint",
    applicationId: appId,
    method: "POST",
    normalizedPath: "/api/events/{eventId}/orders",
  },
  { kind: "domain-entity", applicationId: appId, normalizedName: "Order" },
  {
    kind: "coverage-assessment",
    applicationId: appId,
    requirementId,
    scopeFingerprint: hash,
    runId: "run:11111111-1111-4111-8111-111111111111",
  },
  {
    kind: "pull-request",
    applicationId: appId,
    repository,
    number: 1338,
    baseSha: "2064f88ff7590e93c738efb8becaa7d732063619",
    headSha: "f68df0dabd18d04df5e6c7e873aac2b5e5201584",
  },
]

describe("canonical identity", () => {
  it("canonicalizes object keys recursively", () => {
    expect(canonicalSerialize({ z: [{ b: 2, a: 1 }], a: true, n: null })).toBe(
      '{"a":true,"n":null,"z":[{"a":1,"b":2}]}'
    )
  })

  it("is stable across arbitrary object-key ordering", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (record) => {
        const reversed = Object.fromEntries(Object.entries(record).reverse())
        expect(hashCanonical(record)).toBe(hashCanonical(reversed))
      })
    )
  })

  it.each(stableKeyInputs)("builds a deterministic key for %#", (input) => {
    const parsed = stableKeyInputSchema.parse(input)
    const first = createStableKey(parsed)
    const second = createStableKey(stableKeyInputSchema.parse(input))

    expect(first).toBe(second)
    expect(first).toMatch(new RegExp(`^${parsed.kind}:v1:[a-f0-9]{64}$`))
  })

  it("normalizes public URLs before building stable keys", () => {
    const lower = stableKeyInputSchema.parse({
      kind: "application",
      deploymentUrl: "https://demo.example.com",
      repository,
    })
    const mixedCase = stableKeyInputSchema.parse({
      kind: "application",
      deploymentUrl: "https://DEMO.EXAMPLE.COM/",
      repository,
    })

    expect(createStableKey(lower)).toBe(createStableKey(mixedCase))
  })

  it("normalizes GitHub repository casing and distinguishes repeated controls", () => {
    const lowerRepositoryKey = createStableKey(
      stableKeyInputSchema.parse({
        kind: "code-file",
        applicationId: appId,
        repository,
        commitSha,
        path: "frontend/src/Checkout.tsx",
      })
    )
    const mixedRepositoryKey = createStableKey(
      stableKeyInputSchema.parse({
        kind: "code-file",
        applicationId: appId,
        repository: {
          host: "GitHub.com",
          owner: "Mohit-Nagaraj",
          name: "HI.EVENTS",
        },
        commitSha,
        path: "frontend/src/Checkout.tsx",
      })
    )
    expect(mixedRepositoryKey).toBe(lowerRepositoryKey)

    const firstControl = createStableKey(
      stableKeyInputSchema.parse({
        kind: "ui-element",
        applicationId: appId,
        screenId,
        role: "button",
        accessibleName: "Remove",
        contextFingerprint: hash,
      })
    )
    const secondControl = createStableKey(
      stableKeyInputSchema.parse({
        kind: "ui-element",
        applicationId: appId,
        screenId,
        role: "button",
        accessibleName: "Remove",
        contextFingerprint:
          "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      })
    )
    expect(secondControl).not.toBe(firstControl)
  })

  it.each([
    "C:\\Windows\\win.ini",
    "\\\\server\\share\\secret",
    "folder\\file.ts",
    "../secret",
    "/absolute/path",
  ])("rejects unsafe repository path %s", (path) => {
    expect(repositoryPathSchema.safeParse(path).success).toBe(false)
  })

  it("rejects values outside canonical JSON", () => {
    expect(() => hashCanonical({ invalid: undefined })).toThrow(
      "undefined at $.invalid is not canonical JSON"
    )
    expect(() => hashCanonical(Number.NaN)).toThrow("Non-finite number")
    expect(() => hashCanonical(new Date())).toThrow("Non-plain object")

    const circular: Record<string, unknown> = {}
    circular["self"] = circular
    expect(() => hashCanonical(circular)).toThrow("Circular reference")

    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => "must-not-run",
    })
    expect(() => hashCanonical(accessor)).toThrow("Accessor")
  })

  it("creates distinct branded evidence and workflow identifiers", () => {
    const runId = runIdSchema.parse("run:11111111-1111-4111-8111-111111111111")
    const missionId = createMissionId({
      applicationId: appId,
      runId,
      agent: "code",
      mode: "implementation_trace",
      ordinal: 1,
    })
    const claimId = createClaimId({
      applicationId: appId,
      missionId,
      subjectId:
        "api-endpoint:v1:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      predicate: "handled_by",
      objectId:
        "code-symbol:v1:1111111111111111111111111111111111111111111111111111111111111111",
      ordinal: 1,
    })
    const evidenceId = createRunScopedEvidenceId({
      applicationId: appId,
      runId,
      sourceId:
        "code-symbol:v1:1111111111111111111111111111111111111111111111111111111111111111",
      kind: "source_range",
      ordinal: 1,
    })
    const artifactId = createArtifactId({
      applicationId: appId,
      contentHash: hash,
      kind: "screenshot",
    })
    const actionId = createActionId({
      applicationId: appId,
      runId,
      stateFingerprint: hash,
      actionType: "click",
      ordinal: 1,
    })
    const findingId = createFindingId({
      applicationId: appId,
      pullRequestId:
        "pull-request:v1:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      titleFingerprint: hash,
    })

    expect(missionId).toMatch(/^mission:v1:[a-f0-9]{64}$/)
    expect(claimId).toMatch(/^claim:v1:[a-f0-9]{64}$/)
    expect(evidenceId).toMatch(/^evidence:v1:[a-f0-9]{64}$/)
    expect(artifactId).toMatch(/^artifact:v1:[a-f0-9]{64}$/)
    expect(actionId).toMatch(/^action:v1:[a-f0-9]{64}$/)
    expect(createEventId(runId, 1)).toMatch(/^event:v1:[a-f0-9]{64}$/)
    expect(findingId).toMatch(/^finding:v1:[a-f0-9]{64}$/)

    expect(() => createMissionId({ ordinal: 1 })).toThrow()
    expect(
      createMissionId({
        applicationId:
          "application:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        runId,
        agent: "code",
        mode: "implementation_trace",
        ordinal: 1,
      })
    ).not.toBe(missionId)
  })
})
