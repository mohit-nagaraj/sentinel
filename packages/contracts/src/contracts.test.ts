import { describe, expect, expectTypeOf, it } from "vitest"

import assessmentFindingFixture from "../../../tests/fixtures/contracts/assessment-finding.json" with { type: "json" }
import browserTransitionFixture from "../../../tests/fixtures/contracts/browser-transition.json" with { type: "json" }
import codeSymbolFixture from "../../../tests/fixtures/contracts/code-symbol.json" with { type: "json" }
import discoveryMissionFixture from "../../../tests/fixtures/contracts/discovery-mission.json" with { type: "json" }
import evidenceLinkFixture from "../../../tests/fixtures/contracts/evidence-link.json" with { type: "json" }
import missionResultFixture from "../../../tests/fixtures/contracts/mission-result.json" with { type: "json" }
import requirementCandidateFixture from "../../../tests/fixtures/contracts/requirement-candidate.json" with { type: "json" }
import runEventFixture from "../../../tests/fixtures/contracts/run-event.json" with { type: "json" }
import {
  browserActionSchema,
  claimStatusSchema,
  ContractValidationError,
  evidenceStatusSchema,
  parseApplication,
  parseAssessmentFinding,
  parseBrowserFactEnvelope,
  parseBrowserTransition,
  parseCodeFactEnvelope,
  parseCodeSymbolFact,
  parseDiscoveryMission,
  parseDocumentFactEnvelope,
  parseEvidenceLink,
  parseEvidenceReference,
  parseMissionResult,
  parsePrChange,
  parseRequirementCandidate,
  parseRun,
  parseRunEvent,
  parseSource,
  parseVerificationResult,
  type ApiEndpointId,
  type EvidenceLink,
  type UiElementId,
} from "@sentinel/contracts"

const fixtureParsers = [
  ["discovery mission", discoveryMissionFixture, parseDiscoveryMission],
  ["mission result", missionResultFixture, parseMissionResult],
  ["requirement", requirementCandidateFixture, parseRequirementCandidate],
  ["browser transition", browserTransitionFixture, parseBrowserTransition],
  ["code symbol", codeSymbolFixture, parseCodeSymbolFact],
  ["evidence link", evidenceLinkFixture, parseEvidenceLink],
  ["assessment finding", assessmentFindingFixture, parseAssessmentFinding],
  ["run event", runEventFixture, parseRunEvent],
] as const

describe("versioned wire contracts", () => {
  it.each(fixtureParsers)(
    "parses and snapshots the %s fixture",
    (_, fixture, parse) => {
      expect(parse(fixture)).toMatchSnapshot()
    }
  )

  it("rejects unknown versions with a useful field path", () => {
    expect(() =>
      parseDiscoveryMission({ ...discoveryMissionFixture, schemaVersion: 2 })
    ).toThrowError(ContractValidationError)

    try {
      parseDiscoveryMission({ ...discoveryMissionFixture, schemaVersion: 2 })
    } catch (error) {
      expect(error).toBeInstanceOf(ContractValidationError)
      if (!(error instanceof ContractValidationError)) {
        throw error
      }
      expect(error.issues).toContainEqual(
        expect.objectContaining({ path: "$.schemaVersion" })
      )
    }
  })

  it("rejects secret-shaped fields at persisted boundaries", () => {
    expect(() =>
      parseDiscoveryMission({
        ...discoveryMissionFixture,
        apiKey: "must-not-fit-the-contract",
      })
    ).toThrow("Unrecognized key")

    expect(() =>
      parseRunEvent({ ...runEventFixture, cookie: "session=secret" })
    ).toThrow("Unrecognized key")
  })

  it("does not let an agent claim accepted evidence or a probability", () => {
    const claim = missionResultFixture.claims[0]
    expect(claim).toBeDefined()

    expect(() =>
      parseMissionResult({
        ...missionResultFixture,
        claims: [{ ...claim, accepted: true, probability: 0.99 }],
      })
    ).toThrow("Unrecognized key")
  })

  it("defines claim and evidence lifecycle states and downstream browser actions", () => {
    expect(claimStatusSchema.options).toEqual([
      "proposed",
      "superseded",
      "withdrawn",
    ])
    expect(evidenceStatusSchema.options).toEqual([
      "captured",
      "validated",
      "rejected",
      "expired",
    ])
    expect(
      parseEvidenceReference({
        schemaVersion: 1,
        id: browserTransitionFixture.evidenceId,
        applicationId: discoveryMissionFixture.applicationId,
        runId: discoveryMissionFixture.runId,
        status: "captured",
        kind: "browser_transition",
        sourceEntityId: browserTransitionFixture.toStateId,
        artifactId: browserTransitionFixture.screenshotArtifactId,
        capturedAt: browserTransitionFixture.observedAt,
      })
    ).toMatchObject({ status: "captured" })
    expect(
      browserActionSchema.parse({
        actionId: browserTransitionFixture.action.actionId,
        type: "check",
        elementRole: "checkbox",
        elementName: "Accept terms",
      })
    ).toMatchObject({ type: "check" })
  })

  it("requires claim evidence and enforces agent-specific mission modes", () => {
    const claim = missionResultFixture.claims[0]
    expect(claim).toBeDefined()

    expect(() =>
      parseMissionResult({
        ...missionResultFixture,
        claims: [{ ...claim, evidenceIds: [] }],
      })
    ).toThrow("Too small")

    expect(() =>
      parseDiscoveryMission({
        ...discoveryMissionFixture,
        agent: "documentation",
        mode: "implementation_trace",
      })
    ).toThrow("not allowed for documentation missions")
  })

  it("validates application, source, and run boundaries", () => {
    const applicationId = discoveryMissionFixture.applicationId

    expect(
      parseApplication({
        schemaVersion: 1,
        id: applicationId,
        name: "Hi.Events",
        deploymentUrl: "https://demo.example.com",
        status: "ready",
        indexedCommitSha: codeSymbolFixture.commitSha,
        graphRevision: 1,
        refreshedAt: "2026-09-07T00:00:00.000Z",
      })
    ).toMatchObject({ id: applicationId, status: "ready" })

    expect(
      parseSource({
        schemaVersion: 1,
        id: "document-source:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        applicationId,
        kind: "documentation",
        uri: "repository://README.md",
        status: "ready",
        contentHash: requirementCandidateFixture.source.contentHash,
        secretReference:
          "secret-ref:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      })
    ).toMatchObject({ kind: "documentation", status: "ready" })

    expect(
      parseRun({
        schemaVersion: 1,
        id: discoveryMissionFixture.runId,
        applicationId,
        type: "initialize_knowledge",
        status: "queued",
        idempotencyKey: "initialize:hi-events:0497418",
        budget: discoveryMissionFixture.budget,
        createdAt: "2026-09-07T00:00:00.000Z",
      })
    ).toMatchObject({ status: "queued" })

    expect(() =>
      parseRun({
        schemaVersion: 1,
        id: discoveryMissionFixture.runId,
        applicationId,
        type: "initialize_knowledge",
        status: "queued",
        idempotencyKey: "initialize:missing-budget",
        createdAt: "2026-09-07T00:00:00.000Z",
      })
    ).toThrow("budget")

    expect(() =>
      parseRun({
        schemaVersion: 1,
        id: discoveryMissionFixture.runId,
        applicationId,
        type: "initialize_knowledge",
        status: "queued",
        idempotencyKey: "initialize:hi-events:0497418",
        budget: discoveryMissionFixture.budget,
        createdAt: "2026-09-07T00:00:00.000Z",
        credential: "plaintext-must-not-fit",
      })
    ).toThrow("Unrecognized key")

    expect(() =>
      parseRun({
        schemaVersion: 1,
        id: discoveryMissionFixture.runId,
        applicationId: codeSymbolFixture.id,
        type: "initialize_knowledge",
        status: "queued",
        idempotencyKey: "initialize:wrong-namespace",
        budget: discoveryMissionFixture.budget,
        createdAt: "2026-09-07T00:00:00.000Z",
      })
    ).toThrow("Invalid string")

    expect(() =>
      parseApplication({
        schemaVersion: 1,
        id: applicationId,
        name: "Hi.Events",
        deploymentUrl: "https://operator:password@demo.example.com",
        status: "ready",
        graphRevision: 1,
      })
    ).toThrow("cannot contain credentials")

    expect(() =>
      parseApplication({
        schemaVersion: 1,
        id: applicationId,
        name: "Hi.Events",
        deploymentUrl: "https://demo.example.com?access_token=plaintext",
        status: "ready",
        graphRevision: 1,
      })
    ).toThrow("sensitive query parameter")

    expect(() =>
      parseDiscoveryMission({
        ...discoveryMissionFixture,
        scope: {
          ...discoveryMissionFixture.scope,
          sourceUris: ["https://example.com/callback?sid=abc"],
        },
      })
    ).toThrow("sensitive query parameter")

    expect(() =>
      parseDiscoveryMission({
        ...discoveryMissionFixture,
        goal: "Use Cookie: session=plaintext-secret to inspect checkout.",
      })
    ).toThrow("secret material")

    expect(() =>
      parseRunEvent({
        ...runEventFixture,
        summary: "Authorization: Bearer plaintext-secret",
      })
    ).toThrow("secret material")

    expect(() =>
      parseRunEvent({
        ...runEventFixture,
        summary: "sessionid=plaintext-secret",
      })
    ).toThrow("secret material")

    expect(() =>
      parseRunEvent({
        ...runEventFixture,
        summary: "Cookie: sid=abc",
      })
    ).toThrow("secret material")

    expect(() =>
      parseRunEvent({
        ...runEventFixture,
        summary: "Authorization: Bearer abc",
      })
    ).toThrow("secret material")

    expect(() =>
      parseRunEvent({
        ...runEventFixture,
        summary: "PHPSESSID=abc",
      })
    ).toThrow("secret material")

    expect(() =>
      parseRunEvent({
        ...runEventFixture,
        summary: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature",
      })
    ).toThrow("secret material")

    expect(() =>
      parseDiscoveryMission({
        ...discoveryMissionFixture,
        scope: {
          ...discoveryMissionFixture.scope,
          sourceUris: ["https://example.com/callback?auth=plaintext-secret"],
        },
      })
    ).toThrow("sensitive query parameter")

    expect(() =>
      parseMissionResult({
        ...missionResultFixture,
        exclusions: ["Authorization: Bearer plaintext-secret"],
      })
    ).toThrow("secret material")

    expect(
      parseDiscoveryMission({
        ...discoveryMissionFixture,
        goal: "Determine whether password: must contain a number.",
      })
    ).toMatchObject({ agent: "code" })

    expect(
      parseDiscoveryMission({
        ...discoveryMissionFixture,
        goal: "Confirm that bearer authentication is required and cookies must be secure.",
      })
    ).toMatchObject({ agent: "code" })

    expect(() =>
      parseDiscoveryMission({
        ...discoveryMissionFixture,
        goal: "Use password: hunter for login.",
      })
    ).toThrow("secret material")

    expect(
      parseDiscoveryMission({
        ...discoveryMissionFixture,
        goal: "Verify password: automatically generated by the reset flow.",
      })
    ).toMatchObject({ agent: "code" })

    expect(() =>
      parseRunEvent({
        ...runEventFixture,
        summary: "Provider returned access key AKIAABCDEFGHIJKLMNOP.",
      })
    ).toThrow("secret material")

    expect(
      parseDiscoveryMission({
        ...discoveryMissionFixture,
        scope: {
          ...discoveryMissionFixture.scope,
          sourceUris: [
            "https://example.com/docs?author=alice&session_type=conference",
          ],
        },
      })
    ).toMatchObject({ agent: "code" })

    expect(() =>
      parseSource({
        schemaVersion: 1,
        id: "document-source:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        applicationId,
        kind: "documentation",
        uri: "repository://../private-key.pem",
        status: "ready",
      })
    ).toThrow("cannot traverse")
  })

  it("validates provenance-rich document, code, and browser envelopes", () => {
    const extractor = { name: "fixture_extractor", version: "1.0.0" }
    const applicationId = discoveryMissionFixture.applicationId
    const contentHash = requirementCandidateFixture.source.contentHash

    expect(
      parseDocumentFactEnvelope({
        schemaVersion: 1,
        extractor,
        provenance: {
          sourceKind: "document",
          sourceUri: requirementCandidateFixture.source.uri,
          contentHash,
        },
        factKind: "document_section",
        fact: {
          id: requirementCandidateFixture.source.sectionId,
          applicationId,
          pageId:
            "document-page:v1:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          headingPath: [requirementCandidateFixture.source.heading],
          excerpt: requirementCandidateFixture.source.excerpt,
          contentHash,
        },
      })
    ).toMatchObject({ factKind: "document_section" })

    expect(
      parseCodeFactEnvelope({
        schemaVersion: 1,
        extractor,
        provenance: {
          sourceKind: "repository",
          repository: codeSymbolFixture.repository,
          commitSha: codeSymbolFixture.commitSha,
        },
        factKind: "code_symbol",
        fact: {
          id: codeSymbolFixture.id,
          applicationId,
          repository: codeSymbolFixture.repository,
          commitSha: codeSymbolFixture.commitSha,
          language: codeSymbolFixture.language,
          kind: codeSymbolFixture.kind,
          qualifiedName: codeSymbolFixture.qualifiedName,
          filePath: codeSymbolFixture.filePath,
          range: codeSymbolFixture.range,
        },
      })
    ).toMatchObject({ factKind: "code_symbol" })

    expect(
      parseBrowserFactEnvelope({
        schemaVersion: 1,
        extractor,
        provenance: {
          sourceKind: "browser",
          sourceUri: "https://demo.example.com/checkout",
          observedAt: browserTransitionFixture.observedAt,
        },
        factKind: "transition",
        fact: {
          evidenceId: browserTransitionFixture.evidenceId,
          runId: browserTransitionFixture.runId,
          fromStateId: browserTransitionFixture.fromStateId,
          action: browserTransitionFixture.action,
          toStateId: browserTransitionFixture.toStateId,
          requests: browserTransitionFixture.requests,
          screenshotArtifactId: browserTransitionFixture.screenshotArtifactId,
          observedAt: browserTransitionFixture.observedAt,
        },
      })
    ).toMatchObject({ factKind: "transition" })

    expect(() =>
      parseCodeFactEnvelope({
        schemaVersion: 1,
        extractor,
        provenance: { sourceKind: "repository" },
        factKind: "code_symbol",
        fact: {},
      })
    ).toThrow("repository")
  })

  it("enforces typed graph relationship endpoints", () => {
    type TriggersApiLink = Extract<
      EvidenceLink,
      { relationship: "TRIGGERS_API" }
    >
    expectTypeOf<TriggersApiLink["fromId"]>().toEqualTypeOf<UiElementId>()
    expectTypeOf<TriggersApiLink["toId"]>().toEqualTypeOf<ApiEndpointId>()

    expect(() =>
      parseEvidenceLink({
        ...evidenceLinkFixture,
        relationship: "HAS_PAGE",
        fromId: discoveryMissionFixture.applicationId,
        toId: assessmentFindingFixture.pullRequestId,
      })
    ).toThrow("Invalid string")
  })

  it("models PR operations separately from file classifications", () => {
    const baseChange = {
      schemaVersion: 1,
      pullRequestId: assessmentFindingFixture.pullRequestId,
      operation: "modified",
      classifications: ["configuration", "schema"],
      newPath: "supabase/migrations/001.sql",
      baseRanges: [],
      headRanges: [{ startLine: 1, endLine: 5 }],
      baseSymbolIds: [],
      headSymbolIds: [],
      diffHash: requirementCandidateFixture.source.contentHash,
    }

    expect(parsePrChange(baseChange)).toMatchObject({
      operation: "modified",
      classifications: ["configuration", "schema"],
    })
    expect(() =>
      parsePrChange({ ...baseChange, operation: "added", newPath: undefined })
    ).toThrow("newPath is required")
    expect(() =>
      parsePrChange({
        ...baseChange,
        operation: "renamed",
        oldPath: "old.ts",
        newPath: "old.ts",
      })
    ).toThrow("distinct oldPath and newPath")
    expect(() =>
      parsePrChange({
        ...baseChange,
        operation: "added",
        baseRanges: [{ startLine: 1, endLine: 2 }],
      })
    ).toThrow("cannot contain base-side")
    expect(() =>
      parsePrChange({
        ...baseChange,
        operation: "deleted",
        oldPath: "supabase/migrations/001.sql",
        newPath: undefined,
        headSymbolIds: [codeSymbolFixture.id],
      })
    ).toThrow("cannot contain head-side")
  })

  it("separates unavailable verification from executed deterministic verdicts", () => {
    const unavailable = {
      schemaVersion: 1,
      runId: discoveryMissionFixture.runId,
      pullRequestId: assessmentFindingFixture.pullRequestId,
      headSha: codeSymbolFixture.commitSha,
      status: "verification_unavailable",
      workflowId: assessmentFindingFixture.workflowIds[0],
      requirementIds: assessmentFindingFixture.requirementIds,
      assertions: [],
      requests: [],
      completedAt: "2026-09-07T00:00:00.000Z",
    }

    expect(parseVerificationResult(unavailable)).toMatchObject({
      status: "verification_unavailable",
    })
    expect(() =>
      parseVerificationResult({
        ...unavailable,
        deploymentUrl: "https://baseline.example.com",
      })
    ).toThrow("Unrecognized key")
    expect(() =>
      parseVerificationResult({
        ...unavailable,
        status: "passed",
        deploymentUrl: "https://head.example.com",
      })
    ).toThrow("Too small")
    expect(() =>
      parseVerificationResult({
        ...unavailable,
        status: "passed",
        deploymentUrl: "https://head.example.com",
        assertions: [
          {
            name: "Order confirmation is visible",
            passed: false,
            evidenceIds: [browserTransitionFixture.evidenceId],
          },
        ],
      })
    ).toThrow("cannot contain failed assertions")
  })

  it("requires replayable payloads for budget update events", () => {
    expect(() =>
      parseRunEvent({
        ...runEventFixture,
        kind: "budget_updated",
        budget: undefined,
      })
    ).toThrow("$.budget")

    expect(
      parseRunEvent({
        ...runEventFixture,
        kind: "budget_updated",
        budget: {
          consumed: 12,
          limit: 1000,
          unit: "repository_files",
        },
      })
    ).toMatchObject({ budget: { unit: "repository_files" } })
  })

  it("requires kind-specific run event fields and supports run statuses", () => {
    expect(() =>
      parseRunEvent({
        ...runEventFixture,
        kind: "tool_started",
        status: "started",
        toolName: undefined,
      })
    ).toThrow("toolName")

    expect(() =>
      parseRunEvent({
        ...runEventFixture,
        kind: "error",
        status: "failed",
        error: undefined,
      })
    ).toThrow("error")

    expect(
      parseRunEvent({
        ...runEventFixture,
        kind: "run_status",
        status: "queued",
      })
    ).toMatchObject({ kind: "run_status", status: "queued" })
  })
})
