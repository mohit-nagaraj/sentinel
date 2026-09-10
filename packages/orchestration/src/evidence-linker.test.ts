import {
  evidenceRelationshipSchema,
  hashCanonical,
  linkEvidenceBindingSchema,
  linkEvidenceRecordSchema,
  submittedEvidenceLinkSchema,
  type EvidenceExtractionMethod,
  type EvidenceAdjudicationRequest,
  type EvidenceRelationship,
  type LinkEvidenceBinding,
  type LinkEvidenceRecord,
} from "@sentinel/contracts"
import { describe, expect, it, vi } from "vitest"

import {
  createEvidenceLinker,
  evidenceMethodSourceKinds,
  evidenceRelationshipPolicies,
  type EvidenceCandidateAdjudicator,
} from "./evidence-linker.ts"

const applicationId = entityId("application", "application")
const otherApplicationId = entityId("application", "other-application")
const runId = "run:00000000-0000-4000-8000-000000000018"
const otherRunId = "run:00000000-0000-4000-8000-000000000118"
const commitSha = "0497418d5c66d20693751e68be066260eda3f37f"
const otherCommitSha = "1497418d5c66d20693751e68be066260eda3f37f"
const repository = {
  host: "github.com",
  owner: "mohit-nagaraj",
  name: "sentinel",
}
const capturedAt = "2026-09-09T10:00:00.000Z"

const ids = {
  documentSource: entityId("document-source", "docs"),
  documentPage: entityId("document-page", "page"),
  documentPageTwo: entityId("document-page", "page-two"),
  documentSection: entityId("document-section", "section"),
  requirement: entityId("requirement", "requirement"),
  requirementTwo: entityId("requirement", "requirement-two"),
  capability: entityId("capability", "capability"),
  workflow: entityId("workflow", "workflow"),
  workflowTwo: entityId("workflow", "workflow-two"),
  flowStep: entityId("flow-step", "flow-step"),
  flowStepTwo: entityId("flow-step", "flow-step-two"),
  screen: entityId("screen", "screen"),
  uiElement: entityId("ui-element", "ui-element"),
  frontendRoute: entityId("frontend-route", "frontend-route"),
  codeSymbol: entityId("code-symbol", "code-symbol"),
  codeSymbolTwo: entityId("code-symbol", "code-symbol-two"),
  apiEndpoint: entityId("api-endpoint", "endpoint"),
  domainEntity: entityId("domain-entity", "domain-entity"),
  coverageAssessment: entityId("coverage-assessment", "coverage"),
  pullRequest: entityId("pull-request", "pull-request"),
} as const

function entityId(kind: string, seed: string): string {
  return `${kind}:v1:${hashCanonical(seed).slice("sha256:".length)}`
}

function evidenceId(seed: string): string {
  return `evidence:v1:${hashCanonical(seed).slice("sha256:".length)}`
}

function claimId(seed: string): string {
  return `claim:v1:${hashCanonical(seed).slice("sha256:".length)}`
}

type SourceKind = LinkEvidenceRecord["provenance"]["sourceKind"]

function provenance(sourceKind: SourceKind, seed: string, sha = commitSha) {
  const contentHash = hashCanonical(`content:${seed}`)
  if (sourceKind === "document") {
    return {
      sourceKind,
      sourceUri: `https://docs.example.com/${seed}`,
      contentHash,
    }
  }
  if (sourceKind === "repository") {
    return { sourceKind, repository, commitSha: sha, contentHash }
  }
  if (sourceKind === "browser") {
    return {
      sourceKind,
      sourceUri: `https://app.example.com/${seed}`,
      observedAt: capturedAt,
    }
  }
  if (sourceKind === "openapi") {
    return {
      sourceKind,
      sourceUri: `https://api.example.com/${seed}`,
      contentHash,
      commitSha: sha,
    }
  }
  return { sourceKind, observedAt: capturedAt }
}

function evidence(
  seed: string,
  extractionMethod: EvidenceExtractionMethod,
  options: {
    readonly application?: string
    readonly commit?: string
    readonly run?: string
    readonly sourceKind?: SourceKind
    readonly status?: "captured" | "validated" | "rejected" | "expired"
    readonly bindings?: readonly LinkEvidenceBinding[]
  } = {}
): LinkEvidenceRecord {
  const sourceKind =
    options.sourceKind ?? evidenceMethodSourceKinds[extractionMethod][0]
  return linkEvidenceRecordSchema.parse({
    reference: {
      schemaVersion: 1,
      id: evidenceId(seed),
      applicationId: options.application ?? applicationId,
      runId: options.run ?? runId,
      status: options.status ?? "captured",
      kind: extractionMethod,
      capturedAt,
    },
    provenance: provenance(sourceKind, seed, options.commit),
    extractionMethod,
    bindings: options.bindings ?? [],
    summary: `${extractionMethod} evidence for ${seed}`,
  })
}

const endpointsByRelationship: Record<
  EvidenceRelationship,
  { readonly fromId: string; readonly toId: string }
> = {
  HAS_PAGE: { fromId: ids.documentSource, toId: ids.documentPage },
  HAS_SECTION: { fromId: ids.documentPage, toId: ids.documentSection },
  LINKS_TO: { fromId: ids.documentPage, toId: ids.documentPageTwo },
  STATES: { fromId: ids.documentSection, toId: ids.requirement },
  REQUIRES: { fromId: ids.requirement, toId: ids.capability },
  COVERED_BY: { fromId: ids.requirement, toId: ids.workflow },
  HAS_STEP: { fromId: ids.workflow, toId: ids.flowStep },
  NEXT: { fromId: ids.flowStep, toId: ids.flowStepTwo },
  ON_SCREEN: { fromId: ids.flowStep, toId: ids.screen },
  ACTS_ON: { fromId: ids.flowStep, toId: ids.uiElement },
  CONTAINS: { fromId: ids.screen, toId: ids.uiElement },
  MATCHES_ROUTE: { fromId: ids.screen, toId: ids.frontendRoute },
  RENDERED_BY: { fromId: ids.screen, toId: ids.codeSymbol },
  BINDS: { fromId: ids.uiElement, toId: ids.codeSymbol },
  TRIGGERS_API: { fromId: ids.uiElement, toId: ids.apiEndpoint },
  CALLS_API: { fromId: ids.codeSymbol, toId: ids.apiEndpoint },
  HANDLED_BY: { fromId: ids.apiEndpoint, toId: ids.codeSymbol },
  CALLS: { fromId: ids.codeSymbol, toId: ids.codeSymbolTwo },
  READS: { fromId: ids.codeSymbol, toId: ids.domainEntity },
  WRITES: { fromId: ids.codeSymbol, toId: ids.domainEntity },
  CHANGES: { fromId: ids.pullRequest, toId: ids.codeSymbol },
  HAS_ASSESSMENT: {
    fromId: ids.requirement,
    toId: ids.coverageAssessment,
  },
}

function evidenceBinding(
  relationship: EvidenceRelationship,
  endpoints = endpointsByRelationship[relationship]
): LinkEvidenceBinding {
  return linkEvidenceBindingSchema.parse({ relationship, ...endpoints })
}

function submittedLink(
  seed: string,
  relationship: EvidenceRelationship,
  evidenceIds: readonly string[],
  assertion: "supports" | "contradicts" = "supports",
  endpoints = endpointsByRelationship[relationship]
) {
  return submittedEvidenceLinkSchema.parse({
    id: claimId(seed),
    applicationId,
    assertion,
    evidenceIds,
    explanation: `${assertion} ${relationship}`,
    relationship,
    ...endpoints,
  })
}

function apiEndpoint() {
  return {
    id: ids.apiEndpoint,
    applicationId,
    method: "POST",
    normalizedPath: "/api/events/{event}/orders",
    operationId: "createOrder",
    sourceHash: hashCanonical("openapi"),
  }
}

function frontendRoute() {
  return {
    id: ids.frontendRoute,
    applicationId,
    repository,
    commitSha,
    pathPattern: "/events/:event/checkout",
    componentSymbolIds: [ids.codeSymbol],
    sourceRange: { startLine: 10, endLine: 20 },
  }
}

function input(
  overrides: Partial<{
    evidence: readonly unknown[]
    submittedLinks: readonly unknown[]
    exactObservations: readonly unknown[]
    apiEndpoints: readonly unknown[]
    frontendRoutes: readonly unknown[]
    semanticEntities: readonly unknown[]
    maxCandidates: number
  }> = {}
) {
  return {
    schemaVersion: 1,
    applicationId,
    runId,
    graphRevision: 4,
    compatibleRunIds: [runId],
    compatibleCommitShas: [commitSha],
    evidence: [],
    submittedLinks: [],
    exactObservations: [],
    apiEndpoints: [],
    frontendRoutes: [],
    semanticEntities: [],
    maxCandidates: 20,
    ...overrides,
  }
}

describe("EvidenceLinker evidence policy", () => {
  const policyEntries = Object.entries(evidenceRelationshipPolicies) as [
    EvidenceRelationship,
    NonNullable<(typeof evidenceRelationshipPolicies)[EvidenceRelationship]>,
  ][]

  it("defines authoritative policies for every relationship except REQUIRES", () => {
    expect(policyEntries.map(([relationship]) => relationship).sort()).toEqual(
      evidenceRelationshipSchema.options
        .filter((relationship) => relationship !== "REQUIRES")
        .sort()
    )
  })

  it.each(policyEntries)(
    "accepts required evidence and rejects an incomplete matrix for %s",
    async (relationship, policy) => {
      const binding = evidenceBinding(relationship)
      const records = policy.requiredMethods.map((alternatives, index) =>
        evidence(`${relationship}:${index}`, alternatives[0]!, {
          bindings: [binding],
        })
      )
      const valid = await createEvidenceLinker().link(
        input({
          evidence: records,
          submittedLinks: [
            submittedLink(
              `${relationship}:valid`,
              relationship,
              records.map(({ reference }) => reference.id)
            ),
          ],
        })
      )

      expect(valid.links).toHaveLength(1)
      expect(valid.links[0]).toMatchObject({
        relationship,
        evidenceTier: policy.tier,
        reviewState: "not_required",
      })

      const incompleteRecords =
        policy.requiredMethods.length > 1
          ? records.slice(0, -1)
          : [
              evidence(
                `${relationship}:wrong`,
                relationship === "HAS_ASSESSMENT"
                  ? "document_parse"
                  : "coverage_evaluator",
                { bindings: [binding] }
              ),
            ]
      const invalid = await createEvidenceLinker().link(
        input({
          evidence: incompleteRecords,
          submittedLinks: [
            submittedLink(
              `${relationship}:invalid`,
              relationship,
              incompleteRecords.map(({ reference }) => reference.id)
            ),
          ],
        })
      )

      expect(invalid.links).toHaveLength(0)
      expect(invalid.rejections[0]?.code).toMatch(
        /required_evidence_missing|unsupported_relationship_evidence/u
      )
    }
  )

  it.each(["REQUIRES"] as const)(
    "keeps %s as review-only semantic work",
    async (relationship) => {
      const record = evidence(
        `${relationship}:semantic`,
        "semantic_capability_match"
      )
      const batch = await createEvidenceLinker().link(
        input({
          evidence: [record],
          submittedLinks: [
            submittedLink(`${relationship}:submitted`, relationship, [
              record.reference.id,
            ]),
          ],
        })
      )

      expect(batch.links).toHaveLength(0)
      expect(batch.rejections).toEqual([
        expect.objectContaining({ code: "unsupported_relationship_evidence" }),
      ])
    }
  )
})

describe("EvidenceLinker exact matching", () => {
  it("links diff, endpoint, route, source, and component evidence in trust order", async () => {
    const records = {
      diff: evidence("diff", "diff_symbol_overlap"),
      runtime: evidence("runtime", "runtime_request_match"),
      frontend: evidence("frontend", "frontend_http_call"),
      handler: evidence("handler", "laravel_route_action"),
      call: evidence("call", "source_call"),
      route: evidence("route", "normalized_route_match"),
      ancestry: evidence("ancestry", "route_component_ancestry"),
      text: evidence("text", "exact_ui_text"),
    }
    const exactObservations = [
      {
        kind: "route_component",
        fromId: ids.screen,
        componentSymbolId: ids.codeSymbol,
        routeId: ids.frontendRoute,
        commitSha,
        runId,
        evidenceIds: [records.ancestry.reference.id, records.text.reference.id],
      },
      {
        kind: "runtime_route",
        screenId: ids.screen,
        normalizedPath: "/events/evt-123/checkout/?step=payment",
        runId,
        evidenceIds: [records.route.reference.id],
      },
      {
        kind: "source_relationship",
        source: {
          relationship: "CALLS",
          fromId: ids.codeSymbol,
          toId: ids.codeSymbolTwo,
        },
        commitSha,
        evidenceIds: [records.call.reference.id],
      },
      {
        kind: "route_handler",
        handlerSymbolId: ids.codeSymbolTwo,
        method: "POST",
        normalizedPath: "/api/events/evt-123/orders",
        commitSha,
        evidenceIds: [records.handler.reference.id],
      },
      {
        kind: "frontend_call",
        symbolId: ids.codeSymbol,
        method: "POST",
        normalizedPath: "/api/events/evt-123/orders",
        commitSha,
        evidenceIds: [records.frontend.reference.id],
      },
      {
        kind: "runtime_request",
        uiElementId: ids.uiElement,
        method: "POST",
        normalizedPath: "/api/events/evt-123/orders?currency=USD",
        runId,
        evidenceIds: [records.runtime.reference.id],
      },
      {
        kind: "diff_symbol",
        pullRequestId: ids.pullRequest,
        symbolId: ids.codeSymbol,
        filePath: "packages/checkout.ts",
        changedRange: { startLine: 15, endLine: 18 },
        symbolRange: { startLine: 10, endLine: 20 },
        commitSha,
        evidenceIds: [records.diff.reference.id],
      },
    ]

    const linker = createEvidenceLinker()
    const request = input({
      evidence: Object.values(records),
      exactObservations,
      apiEndpoints: [apiEndpoint()],
      frontendRoutes: [frontendRoute()],
    })
    const first = await linker.link(request)
    const second = await linker.link(request)

    expect(first).toStrictEqual(second)
    expect(first.rejections).toHaveLength(0)
    expect(first.links.map(({ relationship }) => relationship).sort()).toEqual(
      [
        "CALLS",
        "CALLS_API",
        "CHANGES",
        "HANDLED_BY",
        "MATCHES_ROUTE",
        "RENDERED_BY",
        "TRIGGERS_API",
      ].sort()
    )
    expect(
      first.links.find(({ relationship }) => relationship === "RENDERED_BY")
    ).toMatchObject({ evidenceTier: "B" })
    expect(
      first.links.filter(({ relationship }) => relationship !== "RENDERED_BY")
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ evidenceTier: "A" })])
    )
    expect(
      first.evidence.every(({ reference }) => reference.status === "validated")
    ).toBe(true)
  })

  it("rejects non-overlapping changed ranges and unmatched normalized paths", async () => {
    const diff = evidence("bad-diff", "diff_symbol_overlap")
    const runtime = evidence("bad-runtime", "runtime_request_match")
    const batch = await createEvidenceLinker().link(
      input({
        evidence: [diff, runtime],
        apiEndpoints: [apiEndpoint()],
        exactObservations: [
          {
            kind: "diff_symbol",
            pullRequestId: ids.pullRequest,
            symbolId: ids.codeSymbol,
            filePath: "packages/checkout.ts",
            changedRange: { startLine: 30, endLine: 35 },
            symbolRange: { startLine: 10, endLine: 20 },
            commitSha,
            evidenceIds: [diff.reference.id],
          },
          {
            kind: "runtime_request",
            uiElementId: ids.uiElement,
            method: "GET",
            normalizedPath: "/api/unknown",
            runId,
            evidenceIds: [runtime.reference.id],
          },
        ],
      })
    )

    expect(batch.links).toHaveLength(0)
    expect(batch.rejections.map(({ code }) => code)).toEqual([
      "no_exact_match",
      "no_exact_match",
    ])
  })

  it("prefers a literal route and rejects equally specific dynamic matches", async () => {
    const runtime = evidence("route-specificity", "runtime_request_match")
    const literalEndpoint = {
      ...apiEndpoint(),
      id: entityId("api-endpoint", "literal-me"),
      method: "GET",
      normalizedPath: "/users/me",
    }
    const dynamicEndpoint = {
      ...apiEndpoint(),
      id: entityId("api-endpoint", "dynamic-user"),
      method: "GET",
      normalizedPath: "/users/{id}",
    }
    const equivalentDynamicEndpoint = {
      ...apiEndpoint(),
      id: entityId("api-endpoint", "equivalent-dynamic-user"),
      method: "GET",
      normalizedPath: "/users/{userId}",
    }
    const literal = await createEvidenceLinker().link(
      input({
        evidence: [runtime],
        apiEndpoints: [dynamicEndpoint, literalEndpoint],
        exactObservations: [
          {
            kind: "runtime_request",
            uiElementId: ids.uiElement,
            method: "GET",
            normalizedPath: "/users/me",
            runId,
            evidenceIds: [runtime.reference.id],
          },
        ],
      })
    )

    expect(literal.links).toHaveLength(1)
    expect(literal.links[0]).toMatchObject({ toId: literalEndpoint.id })

    const ambiguous = await createEvidenceLinker().link(
      input({
        evidence: [runtime],
        apiEndpoints: [dynamicEndpoint, equivalentDynamicEndpoint],
        exactObservations: [
          {
            kind: "runtime_request",
            uiElementId: ids.uiElement,
            method: "GET",
            normalizedPath: "/users/123",
            runId,
            evidenceIds: [runtime.reference.id],
          },
        ],
      })
    )

    expect(ambiguous.links).toHaveLength(0)
    expect(ambiguous.rejections).toEqual([
      expect.objectContaining({ code: "ambiguous_exact_match" }),
    ])
  })

  it("rejects stale route facts and route/component commit mismatches", async () => {
    const routeEvidence = evidence("stale-route", "normalized_route_match")
    const ancestry = evidence("stale-ancestry", "route_component_ancestry")
    const text = evidence("stale-text", "exact_ui_text")
    const staleRoute = { ...frontendRoute(), commitSha: otherCommitSha }
    const batch = await createEvidenceLinker().link(
      input({
        evidence: [routeEvidence, ancestry, text],
        frontendRoutes: [staleRoute],
        exactObservations: [
          {
            kind: "runtime_route",
            screenId: ids.screen,
            normalizedPath: "/events/evt-123/checkout",
            runId,
            evidenceIds: [routeEvidence.reference.id],
          },
          {
            kind: "route_component",
            fromId: ids.screen,
            componentSymbolId: ids.codeSymbol,
            routeId: ids.frontendRoute,
            commitSha,
            runId,
            evidenceIds: [ancestry.reference.id, text.reference.id],
          },
        ],
      })
    )

    expect(batch.links).toHaveLength(0)
    expect(new Set(batch.rejections.map(({ code }) => code))).toEqual(
      new Set(["incompatible_commit"])
    )
  })
})

describe("EvidenceLinker semantic candidates", () => {
  function semanticFixture() {
    const requirementEvidence = evidence("requirement", "cited_excerpt")
    const workflowEvidence = evidence("workflow", "crawl_record")
    const secondWorkflowEvidence = evidence("workflow-two", "crawl_record")
    const capabilityEvidence = evidence("capability", "cited_excerpt")
    return {
      records: [
        requirementEvidence,
        workflowEvidence,
        secondWorkflowEvidence,
        capabilityEvidence,
      ],
      entities: [
        {
          kind: "requirement",
          id: ids.requirement,
          applicationId,
          name: "Create an order",
          capabilityTerms: ["order creation"],
          evidenceIds: [requirementEvidence.reference.id],
        },
        {
          kind: "workflow",
          id: ids.workflow,
          applicationId,
          name: "Buyer order checkout",
          capabilityTerms: ["create orders"],
          evidenceIds: [workflowEvidence.reference.id],
        },
        {
          kind: "workflow",
          id: ids.workflowTwo,
          applicationId,
          name: "Organizer order review",
          capabilityTerms: ["orders"],
          evidenceIds: [secondWorkflowEvidence.reference.id],
        },
        {
          kind: "capability",
          id: ids.capability,
          applicationId,
          name: "Order management",
          capabilityTerms: ["order"],
          evidenceIds: [capabilityEvidence.reference.id],
        },
      ],
    }
  }

  it("accepts select, reject, and abstain only for supplied candidate IDs", async () => {
    const fixture = semanticFixture()
    const decisions = ["select", "reject", "abstain"] as const
    const adjudicator: EvidenceCandidateAdjudicator = {
      adjudicate: vi.fn(async (request: EvidenceAdjudicationRequest) => ({
        schemaVersion: 1,
        decisions: request.candidates.map((candidate, index) => ({
          candidateId: candidate.id,
          decision: decisions[index] ?? "abstain",
          reason: `fixture decision ${index}`,
        })),
      })),
    }
    const batch = await createEvidenceLinker({ adjudicator }).link(
      input({
        evidence: fixture.records,
        semanticEntities: fixture.entities,
      })
    )

    expect(adjudicator.adjudicate).toHaveBeenCalledOnce()
    expect(batch.links).toHaveLength(0)
    expect(batch.reviewCandidates).toHaveLength(3)
    expect(
      batch.reviewCandidates
        .map(({ modelDisposition }) => modelDisposition)
        .sort()
    ).toEqual(["abstained", "rejected", "selected"])
    expect(
      batch.reviewCandidates.every(
        ({ confidentPathEligible, evidenceTier, reviewState }) =>
          !confidentPathEligible &&
          evidenceTier === "C" &&
          reviewState === "pending"
      )
    ).toBe(true)
  })

  it("forces abstention when the model introduces an unknown candidate ID", async () => {
    const fixture = semanticFixture()
    const adjudicator: EvidenceCandidateAdjudicator = {
      adjudicate: async () => ({
        schemaVersion: 1,
        decisions: [
          {
            candidateId: `candidate:v1:${"f".repeat(64)}`,
            decision: "select",
            reason: "Invented edge",
          },
        ],
      }),
    }
    const batch = await createEvidenceLinker({ adjudicator }).link(
      input({
        evidence: fixture.records,
        semanticEntities: fixture.entities,
      })
    )

    expect(batch.links).toHaveLength(0)
    expect(
      batch.reviewCandidates.every(
        ({ modelDisposition }) => modelDisposition === "abstained"
      )
    ).toBe(true)
    expect(batch.rejections).toEqual([
      expect.objectContaining({ code: "model_invalid_output" }),
    ])
  })

  it("rejects model-authored edge fields outside the structured decision schema", async () => {
    const fixture = semanticFixture()
    const adjudicator: EvidenceCandidateAdjudicator = {
      adjudicate: async (request) => ({
        schemaVersion: 1,
        decisions: [
          {
            candidateId: request.candidates[0]?.id,
            decision: "select",
            reason: "Attempted arbitrary edge",
            fromId: ids.codeSymbol,
          },
        ],
      }),
    }
    const batch = await createEvidenceLinker({ adjudicator }).link(
      input({
        evidence: fixture.records,
        semanticEntities: fixture.entities,
      })
    )

    expect(batch.links).toHaveLength(0)
    expect(batch.rejections[0]).toMatchObject({ code: "model_invalid_output" })
  })

  it("produces bounded Tier C/D candidates with stable ordering", async () => {
    const requirementEvidence = evidence("tier-c-req", "cited_excerpt")
    const workflowEvidence = evidence("tier-c-flow", "crawl_record")
    const screenEvidence = evidence("tier-d-screen", "accessibility_snapshot")
    const symbolEvidence = evidence("tier-d-symbol", "source_call")
    const request = input({
      evidence: [
        requirementEvidence,
        workflowEvidence,
        screenEvidence,
        symbolEvidence,
      ],
      maxCandidates: 2,
      semanticEntities: [
        {
          kind: "screen",
          id: ids.screen,
          applicationId,
          name: "Checkout panels",
          capabilityTerms: [],
          evidenceIds: [screenEvidence.reference.id],
        },
        {
          kind: "code_symbol",
          id: ids.codeSymbol,
          applicationId,
          name: "Checkout panel",
          capabilityTerms: [],
          evidenceIds: [symbolEvidence.reference.id],
        },
        {
          kind: "requirement",
          id: ids.requirement,
          applicationId,
          name: "Create order",
          capabilityTerms: ["order"],
          evidenceIds: [requirementEvidence.reference.id],
        },
        {
          kind: "workflow",
          id: ids.workflow,
          applicationId,
          name: "Order checkout",
          capabilityTerms: ["orders"],
          evidenceIds: [workflowEvidence.reference.id],
        },
      ],
    })
    const linker = createEvidenceLinker()
    const first = await linker.link(request)
    const second = await linker.link(request)

    expect(first).toStrictEqual(second)
    expect(
      first.reviewCandidates.map(({ evidenceTier }) => evidenceTier).sort()
    ).toEqual(["C", "D"])
    expect(first.reviewCandidates.map(({ id }) => id)).toEqual(
      [...first.reviewCandidates.map(({ id }) => id)].sort()
    )
    expect(
      first.reviewCandidates.every(
        ({ confidentPathEligible }) => !confidentPathEligible
      )
    ).toBe(true)
  })
})

describe("EvidenceLinker provenance, conflicts, and rejection handling", () => {
  it("rejects submitted claims whose evidence is bound to other endpoints", async () => {
    const unrelated = evidence("unrelated-call", "source_call", {
      bindings: [
        evidenceBinding("CALLS", {
          fromId: ids.codeSymbolTwo,
          toId: ids.codeSymbol,
        }),
      ],
    })
    const batch = await createEvidenceLinker().link(
      input({
        evidence: [unrelated],
        submittedLinks: [
          submittedLink("unrelated-call", "CALLS", [unrelated.reference.id]),
        ],
      })
    )

    expect(batch.links).toHaveLength(0)
    expect(batch.rejections).toEqual([
      expect.objectContaining({ code: "evidence_binding_mismatch" }),
    ])
  })

  it("merges duplicate support without losing provenance and withholds conflicts", async () => {
    const callBinding = evidenceBinding("CALLS")
    const readsBinding = evidenceBinding("READS")
    const callOne = evidence("call-one", "source_call", {
      bindings: [callBinding],
    })
    const callTwo = evidence("call-two", "source_call", {
      bindings: [callBinding],
    })
    const readsSupport = evidence("reads-support", "entity_read", {
      bindings: [readsBinding],
    })
    const readsContradiction = evidence("reads-contradiction", "entity_read", {
      bindings: [readsBinding],
    })
    const batch = await createEvidenceLinker().link(
      input({
        evidence: [callOne, callTwo, readsSupport, readsContradiction],
        submittedLinks: [
          submittedLink("call-one", "CALLS", [callOne.reference.id]),
          submittedLink("call-two", "CALLS", [callTwo.reference.id]),
          submittedLink("reads-support", "READS", [readsSupport.reference.id]),
          submittedLink(
            "reads-contradiction",
            "READS",
            [readsContradiction.reference.id],
            "contradicts"
          ),
        ],
      })
    )

    expect(batch.links).toHaveLength(1)
    expect(batch.links[0]).toMatchObject({
      relationship: "CALLS",
      evidenceIds: [callOne.reference.id, callTwo.reference.id].sort(),
    })
    expect(batch.evidence).toHaveLength(4)
    expect(batch.conflicts).toHaveLength(1)
    expect(batch.conflicts[0]).toMatchObject({
      relationship: "READS",
      status: "unresolved",
      reviewState: "pending",
    })
  })

  it("rejects missing, expired, incompatible-run, incompatible-commit, and unsupported-source evidence", async () => {
    const expired = evidence("expired", "entity_write", { status: "expired" })
    const wrongRun = evidence("wrong-run", "diff_symbol_overlap", {
      run: otherRunId,
    })
    const wrongCommit = evidence("wrong-commit", "jsx_ast_binding", {
      commit: otherCommitSha,
    })
    const wrongApplication = evidence("wrong-app", "source_call", {
      application: otherApplicationId,
    })
    const unsupportedSource = evidence("wrong-source", "source_call", {
      sourceKind: "system",
    })
    const missingId = evidenceId("missing")
    const batch = await createEvidenceLinker().link(
      input({
        evidence: [
          expired,
          wrongRun,
          wrongCommit,
          wrongApplication,
          unsupportedSource,
        ],
        submittedLinks: [
          submittedLink("expired", "WRITES", [expired.reference.id]),
          submittedLink("wrong-run", "CHANGES", [wrongRun.reference.id]),
          submittedLink("wrong-commit", "BINDS", [wrongCommit.reference.id]),
          submittedLink("wrong-app", "CALLS", [wrongApplication.reference.id]),
          submittedLink("wrong-source", "CALLS", [
            unsupportedSource.reference.id,
          ]),
          submittedLink("missing", "CALLS_API", [missingId]),
        ],
      })
    )

    expect(batch.links).toHaveLength(0)
    expect(new Set(batch.rejections.map(({ code }) => code))).toEqual(
      new Set([
        "application_mismatch",
        "incompatible_commit",
        "incompatible_run",
        "invalid_evidence_status",
        "missing_evidence",
        "unsupported_source",
      ])
    )
    expect(batch.evidence).toHaveLength(0)
  })

  it("rejects semantic entities from another application namespace", async () => {
    const record = evidence("foreign-semantic", "cited_excerpt")
    const batch = await createEvidenceLinker().link(
      input({
        evidence: [record],
        semanticEntities: [
          {
            kind: "requirement",
            id: ids.requirementTwo,
            applicationId: otherApplicationId,
            name: "Foreign requirement",
            capabilityTerms: ["order"],
            evidenceIds: [record.reference.id],
          },
        ],
      })
    )

    expect(batch.reviewCandidates).toHaveLength(0)
    expect(batch.rejections).toEqual([
      expect.objectContaining({ code: "application_mismatch" }),
    ])
  })
})
