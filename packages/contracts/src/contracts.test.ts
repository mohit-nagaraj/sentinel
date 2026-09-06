import { describe, expect, it } from "vitest"

import assessmentFindingFixture from "../../../tests/fixtures/contracts/assessment-finding.json" with { type: "json" }
import browserTransitionFixture from "../../../tests/fixtures/contracts/browser-transition.json" with { type: "json" }
import codeSymbolFixture from "../../../tests/fixtures/contracts/code-symbol.json" with { type: "json" }
import discoveryMissionFixture from "../../../tests/fixtures/contracts/discovery-mission.json" with { type: "json" }
import evidenceLinkFixture from "../../../tests/fixtures/contracts/evidence-link.json" with { type: "json" }
import missionResultFixture from "../../../tests/fixtures/contracts/mission-result.json" with { type: "json" }
import requirementCandidateFixture from "../../../tests/fixtures/contracts/requirement-candidate.json" with { type: "json" }
import runEventFixture from "../../../tests/fixtures/contracts/run-event.json" with { type: "json" }
import {
  ContractValidationError,
  parseApplication,
  parseAssessmentFinding,
  parseBrowserFactEnvelope,
  parseBrowserTransition,
  parseCodeFactEnvelope,
  parseCodeSymbolFact,
  parseDiscoveryMission,
  parseDocumentFactEnvelope,
  parseEvidenceLink,
  parseMissionResult,
  parseRequirementCandidate,
  parseRun,
  parseRunEvent,
  parseSource,
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
        idempotencyKey: "initialize:hi-events:0497418",
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
        createdAt: "2026-09-07T00:00:00.000Z",
      })
    ).toThrow("Invalid string")

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
})
