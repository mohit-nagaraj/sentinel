import {
  graphPublicationInputSchema,
  hashCanonical,
  type GraphPublicationInput,
} from "@sentinel/contracts"

const timestamp = "2026-09-09T00:00:00.000Z"
const commitSha = "b".repeat(40)

function stableId(kind: string, applicationId: string, seed: string): string {
  return `${kind}:v1:${hashCanonical({ applicationId, kind, seed }).slice(
    "sha256:".length
  )}`
}

export function createGraphPublicationFixture(input: {
  readonly applicationId: string
  readonly graphRevision: number
  readonly replacement?: unknown
  readonly retainedEvidenceIds?: readonly string[]
  readonly omitRelationship?: string
  readonly omitCapability?: boolean
}): {
  readonly publication: GraphPublicationInput
  readonly ids: Readonly<Record<string, string>>
} {
  const { applicationId, graphRevision } = input
  const runId = "run:11111111-1111-4111-8111-111111111111"
  const ids = {
    source: stableId("document-source", applicationId, "source"),
    page: stableId("document-page", applicationId, "page"),
    section: stableId("document-section", applicationId, "section"),
    requirement: stableId("requirement", applicationId, "requirement"),
    capability: stableId("capability", applicationId, "capability"),
    workflow: stableId("workflow", applicationId, "workflow"),
    step: stableId("flow-step", applicationId, "step"),
    element: stableId("ui-element", applicationId, "element"),
    endpoint: stableId("api-endpoint", applicationId, "endpoint"),
    symbol: stableId("code-symbol", applicationId, "symbol"),
    coverage: stableId("coverage-assessment", applicationId, "coverage"),
  }
  const provenance = { sourceKind: "system", observedAt: timestamp }
  const wrap = (kind: string, fact: Readonly<Record<string, unknown>>) => ({
    kind,
    fact,
    extractionMethod: "source_reference",
    evidenceTier: "A",
    evidenceIds: [],
    provenance,
    reviewState: "not_required",
  })
  const nodes = [
    wrap("application", {
      id: applicationId,
      applicationId,
      name: "Graph publication fixture",
      indexedCommitSha: commitSha,
    }),
    wrap("document-source", {
      id: ids.source,
      applicationId,
      kind: "web",
      rootUri: "https://example.test/docs",
      contentHash: `sha256:${"1".repeat(64)}`,
    }),
    wrap("document-page", {
      id: ids.page,
      applicationId,
      sourceId: ids.source,
      canonicalUri: "https://example.test/docs/checkout",
      title: "Checkout",
      contentHash: `sha256:${"2".repeat(64)}`,
      linkedPageIds: [],
    }),
    wrap("document-section", {
      id: ids.section,
      applicationId,
      pageId: ids.page,
      headingPath: ["Checkout"],
      excerpt: "Buyers can submit an order.",
      contentHash: `sha256:${"3".repeat(64)}`,
    }),
    wrap("requirement", {
      schemaVersion: 1,
      id: ids.requirement,
      applicationId,
      statement: `Buyers can submit an order at revision ${graphRevision}.`,
      capability: "submit order",
      testable: true,
      source: {
        sectionId: ids.section,
        uri: "https://example.test/docs/checkout",
        heading: "Checkout",
        excerpt: "Buyers can submit an order.",
        contentHash: `sha256:${"3".repeat(64)}`,
      },
    }),
    wrap("capability", {
      id: ids.capability,
      applicationId,
      normalizedName: "submit order",
    }),
    wrap("workflow", {
      id: ids.workflow,
      applicationId,
      name: "Submit checkout",
      actor: "buyer",
      sourceRunId: runId,
    }),
    wrap("flow-step", {
      id: ids.step,
      applicationId,
      workflowId: ids.workflow,
      ordinal: 0,
      actionType: "click",
      sourceRunId: runId,
    }),
    wrap("ui-element", {
      id: ids.element,
      applicationId,
      screenId: stableId("screen", applicationId, "screen"),
      role: "button",
      accessibleName: "Submit order",
      contextFingerprint: `sha256:${"4".repeat(64)}`,
      observedAt: timestamp,
      sourceRunId: runId,
    }),
    wrap("api-endpoint", {
      id: ids.endpoint,
      applicationId,
      method: "POST",
      normalizedPath: "/orders",
      sourceHash: `sha256:${"5".repeat(64)}`,
    }),
    wrap("code-symbol", {
      schemaVersion: 1,
      id: ids.symbol,
      applicationId,
      repository: { host: "github.com", owner: "acme", name: "shop" },
      commitSha,
      language: "typescript",
      kind: "handler",
      qualifiedName: "createOrder",
      filePath: "src/orders.ts",
      range: { startLine: 1, endLine: 10 },
    }),
    wrap("coverage-assessment", {
      schemaVersion: 1,
      id: ids.coverage,
      applicationId,
      requirementId: ids.requirement,
      status: "not_observed",
      scopeFingerprint: `sha256:${"6".repeat(64)}`,
      scopeSummary: "Checkout submit step",
      reasonCode: "bounded_attempt_no_observation",
      wording:
        "The behavior was not observed within the checkout states explored during this run.",
      attemptSummary: "The submit control and request were checked.",
      runId,
      graphRevision,
      evidenceIds: [],
      attemptEvidenceIds: [stableId("evidence", applicationId, "attempt")],
      blockerKinds: [],
      requirementSourceHash: `sha256:${"3".repeat(64)}`,
      crawlConfigurationHash: `sha256:${"7".repeat(64)}`,
      authenticationRevision: 0,
      evaluatedAt: timestamp,
    }),
  ].filter(
    (node) => !(input.omitCapability === true && node.kind === "capability")
  )

  const relationships = [
    ["HAS_PAGE", ids.source, ids.page],
    ["HAS_SECTION", ids.page, ids.section],
    ["STATES", ids.section, ids.requirement],
    ["COVERED_BY", ids.requirement, ids.workflow],
    ["HAS_STEP", ids.workflow, ids.step],
    ["ACTS_ON", ids.step, ids.element],
    ["TRIGGERS_API", ids.element, ids.endpoint],
    ["HANDLED_BY", ids.endpoint, ids.symbol],
    ["HAS_ASSESSMENT", ids.requirement, ids.coverage],
  ].filter(([relationship]) => relationship !== input.omitRelationship)
  const linked = relationships.map(([relationship, fromId, toId]) => {
    const evidenceId = stableId("evidence", applicationId, String(relationship))
    return {
      link: {
        schemaVersion: 1,
        id: evidenceId,
        applicationId,
        fromId,
        relationship,
        toId,
        extractionMethod: "source_reference",
        evidenceTier: "A",
        explanation: `${relationship} fixture evidence`,
        evidenceIds: [evidenceId],
        reviewState: "not_required",
        graphRevision,
        lastConfirmedAt: timestamp,
      },
      evidence: {
        reference: {
          schemaVersion: 1,
          id: evidenceId,
          applicationId,
          runId,
          status: "validated",
          kind: "graph_fixture",
          capturedAt: timestamp,
        },
        provenance,
        extractionMethod: "source_reference",
        bindings: [{ fromId, relationship, toId }],
        summary: `${relationship} fixture evidence`,
      },
    }
  })

  return {
    publication: graphPublicationInputSchema.parse({
      schemaVersion: 1,
      applicationId,
      runId,
      inputFingerprint: `sha256:${"a".repeat(64)}`,
      indexedCommitSha: commitSha,
      expectedGraphRevision: graphRevision - 1,
      graphRevision,
      replacement: input.replacement ?? { kind: "full" },
      nodes: nodes.sort((left, right) =>
        String(left.fact["id"]).localeCompare(String(right.fact["id"]))
      ),
      links: linked
        .map(({ link }) => link)
        .sort((left, right) => String(left.id).localeCompare(String(right.id))),
      evidence: linked
        .map(({ evidence }) => evidence)
        .sort((left, right) =>
          String(left.reference.id).localeCompare(String(right.reference.id))
        ),
      retainedEvidenceIds: [...(input.retainedEvidenceIds ?? [])].sort(),
      batchSize: 4,
    }),
    ids,
  }
}
