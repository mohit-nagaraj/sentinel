import {
  coverageItemSchema,
  evidencePathSchema,
  hashCanonical,
  linkReviewItemSchema,
  privateArtifactExcerptSchema,
  publicRunInterruptSchema,
  publicRunSchema,
  workflowCoverageItemSchema,
  type CoverageItem,
  type LinkReviewItem,
  type PublicRun,
  type PublicRunInterrupt,
  type WorkflowCoverageItem,
} from "@sentinel/contracts"
import type {
  KnowledgeGraphPage,
  KnowledgeInterruptRecord,
  KnowledgeSourceRecord,
  OwnedKnowledgeApplication,
  StoredLinkReview,
} from "@sentinel/storage"

import {
  KnowledgeReviewConflictError,
  KnowledgeService,
  type KnowledgeArtifactReader,
  type KnowledgeGraphStore,
  type KnowledgeInterruptService,
  type KnowledgeSummaryStore,
} from "./knowledge-service"

export const KNOWLEDGE_FIXTURE_APPLICATION_ID =
  "25252525-2525-4525-8525-252525252525"
const KNOWLEDGE_FIXTURE_STABLE_ID = `application:v1:${"2".repeat(64)}`
const RUN_ID = "25252525-2525-4525-8525-252525252526"
const INTERRUPT_ID = "25252525-2525-4525-8525-252525252527"
const REVIEW_ID = "25252525-2525-4525-8525-252525252528"
const OPERATOR_ID = "00000000-0000-4000-8000-000000000022"
const COMMIT_SHA = "9f8e7d6c5b4a32100123456789abcdef01234567"
const ARTIFACT_ID = `artifact:v1:${"9".repeat(64)}`
const CURRENT_SOURCE_HASH = `sha256:${"8".repeat(64)}`
const PREVIOUS_SOURCE_HASH = `sha256:${"7".repeat(64)}`

function stable(kind: string, character: string): string {
  return `${kind}:v1:${character.repeat(64)}`
}

const ids = {
  section: stable("document-section", "1"),
  observed: stable("requirement", "2"),
  partial: stable("requirement", "3"),
  notObserved: stable("requirement", "4"),
  blocked: stable("requirement", "5"),
  notEvaluated: stable("requirement", "6"),
  ambiguous: stable("requirement", "7"),
  workflow: stable("workflow", "a"),
  workflowPartial: stable("workflow", "b"),
  workflowUnlinked: stable("workflow", "c"),
  step: stable("flow-step", "d"),
  screen: stable("screen", "e"),
  element: stable("ui-element", "f"),
  endpoint: stable("api-endpoint", "0"),
  symbol: stable("code-symbol", "a"),
} as const

const linkIds = Array.from({ length: 7 }, (_, index) =>
  stable("evidence", (index + 1).toString())
)

const coverage: readonly CoverageItem[] = [
  {
    requirementId: ids.observed,
    statement: "A buyer can select a ticket and complete checkout.",
    actor: "Buyer",
    capability: "Complete ticket checkout",
    status: "observed",
    summary:
      "The checkout behavior was observed through the confirmation request.",
    scope: "Public event, ticket selection, attendee details, and confirmation",
    possibleCauses: [],
    reviewerActions: [],
    workflowCount: 1,
    evidenceTiers: ["A", "B"],
    stale: false,
  },
  {
    requirementId: ids.partial,
    statement: "A buyer can apply a promotion code.",
    actor: "Buyer",
    capability: "Apply promotion",
    status: "partially_observed",
    summary:
      "A promotion entry point was observed, but submission was not completed.",
    scope: "Ticket selection and first checkout state",
    possibleCauses: ["The fixture has no active promotion."],
    reviewerActions: ["Provide promotion test data and refresh knowledge."],
    workflowCount: 1,
    evidenceTiers: ["B"],
    stale: false,
  },
  {
    requirementId: ids.notObserved,
    statement: "A buyer can transfer a ticket after purchase.",
    actor: "Buyer",
    capability: "Transfer ticket",
    status: "not_observed",
    summary:
      "The transfer behavior was not observed within the completed account crawl.",
    scope: "Orders list and order detail states",
    possibleCauses: [
      "The selected order may not be eligible.",
      "The completed crawl may not include the required state.",
    ],
    reviewerActions: ["Inspect an eligible paid order."],
    workflowCount: 0,
    evidenceTiers: [],
    stale: false,
  },
  {
    requirementId: ids.blocked,
    statement: "An organizer can issue a refund.",
    actor: "Organizer",
    capability: "Issue refund",
    status: "blocked",
    summary: "Refund coverage was blocked at a destructive-action boundary.",
    scope: "Organizer order detail",
    possibleCauses: ["The action changes payment state."],
    reviewerActions: [
      "Approve a reversible test refund in an isolated account.",
    ],
    workflowCount: 0,
    evidenceTiers: ["C"],
    stale: false,
  },
  {
    requirementId: ids.notEvaluated,
    statement: "An organizer can export attendee records.",
    actor: "Organizer",
    capability: "Export attendees",
    status: "not_evaluated",
    summary:
      "This requirement has not been evaluated within a completed exploration scope.",
    possibleCauses: ["No organizer export mission has run."],
    reviewerActions: ["Run a scoped organizer workflow inspection."],
    workflowCount: 0,
    evidenceTiers: [],
    stale: false,
  },
  {
    requirementId: ids.ambiguous,
    statement: "A buyer receives an order confirmation.",
    actor: "Buyer",
    capability: "Receive confirmation",
    status: "ambiguous",
    summary:
      "The mapping is plausible but depends on an unreviewed semantic match.",
    scope: "Checkout confirmation and email notification paths",
    possibleCauses: ["Two confirmation workflows share the same concept."],
    reviewerActions: ["Review the competing workflow evidence."],
    workflowCount: 2,
    evidenceTiers: ["C", "D"],
    stale: true,
  },
].map((item) => coverageItemSchema.parse(item))

const workflows: readonly WorkflowCoverageItem[] = [
  {
    workflowId: ids.workflow,
    name: "Buyer completes ticket checkout",
    actor: "Buyer",
    requirementCount: 2,
    screenCount: 3,
    stepCount: 4,
    status: "observed",
    stale: false,
  },
  {
    workflowId: ids.workflowPartial,
    name: "Organizer reviews an order",
    actor: "Organizer",
    requirementCount: 1,
    screenCount: 1,
    stepCount: 2,
    status: "partial",
    stale: false,
  },
  {
    workflowId: ids.workflowUnlinked,
    name: "Buyer opens saved tickets",
    actor: "Buyer",
    requirementCount: 0,
    screenCount: 1,
    stepCount: 1,
    status: "unlinked",
    stale: true,
  },
].map((item) => workflowCoverageItemSchema.parse(item))

const pathNodes = [
  {
    id: ids.section,
    kind: "document-section",
    label: "Checkout guide / Completing an order",
    detail: "Buyers provide attendee details before confirming an order.",
    sourceUri: "https://docs.example.test/checkout#complete-order",
    artifactId: ARTIFACT_ID,
  },
  {
    id: ids.observed,
    kind: "requirement",
    label: "Complete ticket checkout",
    detail: "A buyer can select a ticket and complete checkout.",
  },
  {
    id: ids.workflow,
    kind: "workflow",
    label: "Buyer completes ticket checkout",
  },
  {
    id: ids.step,
    kind: "flow-step",
    label: "Submit attendee details",
  },
  {
    id: ids.screen,
    kind: "screen",
    label: "Attendee details",
    detail: "/checkout/details",
  },
  {
    id: ids.element,
    kind: "ui-element",
    label: "Confirm order",
    detail: "button",
  },
  {
    id: ids.endpoint,
    kind: "api-endpoint",
    label: "POST /api/orders",
  },
  {
    id: ids.symbol,
    kind: "code-symbol",
    label: "OrderController.create",
    detail: "backend/app/Http/Controllers/OrderController.php:42-87",
  },
] as const

const relationshipNames = [
  "states",
  "covered_by",
  "has_step",
  "on_screen",
  "acts_on",
  "triggers_api",
  "handled_by",
] as const

const pathLinks = relationshipNames.map((relationship, index) => ({
  id: linkIds[index],
  relationship,
  tier:
    index === 1
      ? ("C" as const)
      : index === 5
        ? ("B" as const)
        : ("A" as const),
  reviewState: index === 1 ? ("pending" as const) : ("not_required" as const),
  extractionMethod:
    index === 1
      ? "semantic_requirement_match"
      : index === 5
        ? "runtime_request_observation"
        : "deterministic_extractor",
  sourceIdentityHash:
    index === 1
      ? CURRENT_SOURCE_HASH
      : `sha256:${(index + 1).toString().repeat(64)}`,
  sourceCommitSha: COMMIT_SHA,
  sourceRunId: `run:25252525-2525-4525-8525-25252525252${index}`,
  capturedAt: "2026-09-09T02:10:00.000Z",
  explanation:
    index === 1
      ? "Requirement language and observed workflow share the checkout capability."
      : "The normalized source and target identities match deterministic evidence.",
  ...(index === 0
    ? {
        sourceUri: "https://docs.example.test/checkout#complete-order",
        artifactId: ARTIFACT_ID,
      }
    : {}),
  stale: false,
}))

const selectedPath = evidencePathSchema.parse({
  schemaVersion: 1,
  id: "fixture-checkout-path",
  requirementId: ids.observed,
  complete: true,
  nodes: pathNodes,
  links: pathLinks,
})

const candidate = linkReviewItemSchema.parse({
  kind: "link",
  id: linkIds[1],
  relationship: "covered_by",
  title: "Requirement to checkout workflow",
  summary: "The semantic mapping has one corroborating capability match.",
  tier: "C",
  sourceIdentityHash: CURRENT_SOURCE_HASH,
  from: pathNodes[1],
  to: pathNodes[2],
  competingEvidence: [
    {
      id: stable("evidence", "f"),
      relationship: "covered_by",
      tier: "D",
      reviewState: "pending",
      extractionMethod: "name_similarity",
      sourceIdentityHash: `sha256:${"6".repeat(64)}`,
      explanation:
        "A second workflow has a similar name but no runtime corroboration.",
      stale: false,
    },
  ],
  previousReviews: [],
})

class FixtureSummaryStore implements KnowledgeSummaryStore {
  private readonly reviews: StoredLinkReview[] = [
    {
      id: REVIEW_ID,
      linkStableKey: candidate.id,
      sourceIdentityHash: PREVIOUS_SOURCE_HASH,
      decision: "accepted",
      reason: "The prior documentation and runtime source agreed.",
      decidedAt: new Date("2026-09-08T20:00:00.000Z"),
    },
  ]
  interruptPending = true

  getOwnedApplication(
    operatorId: string,
    applicationId: string
  ): Promise<OwnedKnowledgeApplication | null> {
    if (
      operatorId !== OPERATOR_ID ||
      applicationId !== KNOWLEDGE_FIXTURE_APPLICATION_ID
    ) {
      return Promise.resolve(null)
    }
    return Promise.resolve({
      id: KNOWLEDGE_FIXTURE_APPLICATION_ID,
      stableKey: KNOWLEDGE_FIXTURE_STABLE_ID,
      name: "Hi.Events checkout",
      deploymentUrl: "https://events.example.test/",
      status: "stale",
      indexedCommitSha: COMMIT_SHA,
      graphRevision: 4,
      refreshedAt: new Date("2026-09-09T02:12:00.000Z"),
      knowledgeStale: true,
    })
  }

  listOwnedSources(): Promise<readonly KnowledgeSourceRecord[]> {
    return Promise.resolve([
      {
        stableKey: KNOWLEDGE_FIXTURE_STABLE_ID,
        kind: "application",
        uri: "https://events.example.test/",
        status: "ready",
        checkedAt: new Date("2026-09-09T02:12:00.000Z"),
      },
      {
        stableKey: stable("document-source", "3"),
        kind: "documentation",
        uri: "https://docs.example.test/",
        status: "warning",
        checkedAt: new Date("2026-09-08T22:00:00.000Z"),
      },
      {
        stableKey: stable("document-source", "4"),
        kind: "repository",
        uri: "https://github.com/example/events",
        status: "ready",
        checkedAt: new Date("2026-09-09T02:12:00.000Z"),
      },
    ])
  }

  lastSuccessfulRunAt(): Promise<Date> {
    return Promise.resolve(new Date("2026-09-09T02:12:00.000Z"))
  }

  listOwnedPendingInterrupts(): Promise<readonly KnowledgeInterruptRecord[]> {
    return Promise.resolve(
      this.interruptPending
        ? [
            {
              id: INTERRUPT_ID,
              runId: RUN_ID,
              decisionId: "confirm_checkout_mapping",
              prompt:
                "Choose whether the observed confirmation step represents the documented checkout completion.",
              status: "pending",
              createdAt: new Date("2026-09-09T02:14:00.000Z"),
            },
          ]
        : []
    )
  }

  listOwnedLinkReviews(
    _operatorId: string,
    _applicationId: string,
    linkIds: readonly string[]
  ): Promise<readonly StoredLinkReview[]> {
    return Promise.resolve(
      this.reviews.filter((review) => linkIds.includes(review.linkStableKey))
    )
  }

  recordOwnedLinkReview(
    input: Parameters<KnowledgeSummaryStore["recordOwnedLinkReview"]>[0]
  ): Promise<{
    readonly review: StoredLinkReview
    readonly idempotent: boolean
  }> {
    const existing = this.reviews.find(
      (review) =>
        review.linkStableKey === input.linkStableKey &&
        review.sourceIdentityHash === input.sourceIdentityHash
    )
    if (existing !== undefined) {
      if (
        existing.decision !== input.decision ||
        existing.reason !== input.reason
      ) {
        throw new KnowledgeReviewConflictError()
      }
      return Promise.resolve({ review: existing, idempotent: true })
    }
    const review = {
      id: "25252525-2525-4525-8525-252525252529",
      linkStableKey: input.linkStableKey,
      sourceIdentityHash: input.sourceIdentityHash,
      decision: input.decision,
      reason: input.reason,
      decidedAt: new Date(),
    }
    this.reviews.push(review)
    return Promise.resolve({ review, idempotent: false })
  }
}

class FixtureGraphStore implements KnowledgeGraphStore {
  counts() {
    return Promise.resolve({
      requirements: coverage.length,
      workflows: workflows.length,
      screens: 5,
      uiElements: 18,
      apiEndpoints: 7,
      codeSymbols: 34,
      ambiguousLinks: 1,
    })
  }

  coverage(input: {
    readonly status?: unknown
    readonly query?: unknown
    readonly cursor?: unknown
    readonly limit?: unknown
  }): Promise<KnowledgeGraphPage<CoverageItem>> {
    const status = typeof input.status === "string" ? input.status : "all"
    const query =
      typeof input.query === "string" ? input.query.toLowerCase() : ""
    const cursor = typeof input.cursor === "string" ? input.cursor : undefined
    const limit = typeof input.limit === "number" ? input.limit : 20
    const filtered = coverage.filter(
      (item) =>
        (status === "all" || item.status === status) &&
        (query.length === 0 ||
          `${item.statement} ${item.capability}`
            .toLowerCase()
            .includes(query)) &&
        (cursor === undefined || item.requirementId > cursor)
    )
    const items = filtered.slice(0, limit)
    const nextCursor =
      filtered.length > limit ? items.at(-1)?.requirementId : undefined
    return Promise.resolve({
      items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    })
  }

  workflows(input: {
    readonly cursor?: unknown
    readonly limit?: unknown
  }): Promise<KnowledgeGraphPage<WorkflowCoverageItem>> {
    const cursor = typeof input.cursor === "string" ? input.cursor : undefined
    const limit = typeof input.limit === "number" ? input.limit : 20
    const filtered = workflows.filter(
      (item) => cursor === undefined || item.workflowId > cursor
    )
    return Promise.resolve({ items: filtered.slice(0, limit) })
  }

  evidencePath(input: { readonly requirementId: string }) {
    return Promise.resolve(
      input.requirementId === ids.observed ? selectedPath : null
    )
  }

  reviewCandidates(): Promise<KnowledgeGraphPage<LinkReviewItem>> {
    return Promise.resolve({ items: [candidate] })
  }

  reviewCandidate(input: { readonly linkId: string }) {
    return Promise.resolve(input.linkId === candidate.id ? candidate : null)
  }
}

class FixtureInterruptService implements KnowledgeInterruptService {
  private responseHash: string | undefined
  constructor(private readonly summary: FixtureSummaryStore) {}

  get(runId: string): Promise<PublicRun | null> {
    return Promise.resolve(
      runId === RUN_ID
        ? publicRunSchema.parse({
            schemaVersion: 1,
            id: RUN_ID,
            applicationId: KNOWLEDGE_FIXTURE_APPLICATION_ID,
            type: "initialize_knowledge",
            status: this.summary.interruptPending ? "interrupted" : "queued",
            attemptCount: 0,
            createdAt: "2026-09-09T02:00:00.000Z",
            startedAt: "2026-09-09T02:01:00.000Z",
          })
        : null
    )
  }

  respond(
    runId: string,
    decisionId: string,
    input: unknown
  ): Promise<{
    readonly interrupt: PublicRunInterrupt
    readonly idempotent: boolean
  }> {
    if (runId !== RUN_ID || decisionId !== "confirm_checkout_mapping") {
      throw new Error("Interrupt not found")
    }
    const responseHash = hashCanonical(input)
    if (this.responseHash !== undefined && this.responseHash !== responseHash) {
      throw new KnowledgeReviewConflictError()
    }
    const idempotent = this.responseHash === responseHash
    this.responseHash = responseHash
    this.summary.interruptPending = false
    return Promise.resolve({
      interrupt: publicRunInterruptSchema.parse({
        schemaVersion: 1,
        id: INTERRUPT_ID,
        runId: RUN_ID,
        decisionId,
        prompt:
          "Choose whether the observed confirmation step represents the documented checkout completion.",
        status: "responded",
        createdAt: "2026-09-09T02:14:00.000Z",
        respondedAt: new Date().toISOString(),
      }),
      idempotent,
    })
  }
}

const fixtureArtifacts: KnowledgeArtifactReader = {
  readTextExcerpt: (_applicationId, artifactId) =>
    Promise.resolve(
      artifactId === ARTIFACT_ID
        ? privateArtifactExcerptSchema.parse({
            schemaVersion: 1,
            artifactId,
            mimeType: "text/markdown",
            excerpt:
              "## Completing an order\nBuyers provide attendee details before confirming an order. The confirmation creates the order and displays its reference.",
            truncated: false,
          })
        : null
    ),
}

let fixtureService: KnowledgeService | undefined

export function createKnowledgeFixtureService(): KnowledgeService {
  const summary = new FixtureSummaryStore()
  return new KnowledgeService(
    OPERATOR_ID,
    summary,
    new FixtureGraphStore(),
    new FixtureInterruptService(summary),
    fixtureArtifacts
  )
}

export function getKnowledgeFixtureService(): KnowledgeService {
  return (fixtureService ??= createKnowledgeFixtureService())
}
