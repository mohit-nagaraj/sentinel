import {
  DocumentationExplorerTools,
  DocumentationMapIndex,
  buildDocumentationMap,
  type DocumentSectionRecord,
  type PreparedPage,
} from "@sentinel/adapters"
import {
  applicationIdSchema,
  createDocumentationRequirementId,
  createMissionId,
  createRunScopedEvidenceId,
  documentationExplorerMissionSchema,
  documentationExplorerToolNames,
  runIdSchema,
  submitRequirementClaimInputSchema,
  type DocumentationClaimKind,
  type DocumentationExplorerMission,
  type MissionBudget,
  type SubmitRequirementClaimInput,
} from "@sentinel/contracts"

export const documentationFixtureApplicationId = applicationIdSchema.parse(
  `application:v1:${"5".repeat(64)}`
)
export const documentationFixtureRoot = "https://docs.fixture.test/guide"

export type DocumentationFixtureSectionKey =
  | "architecture"
  | "checkout_confirmation"
  | "checkout_duplicate"
  | "checkout_email"
  | "example"
  | "marketing"
  | "overview"
  | "refund_allowed"
  | "refund_denied"
  | "setup"

export type DocumentationFixtureMode =
  "baseline_discovery" | "targeted_requirement_lookup" | "conflict_resolution"

interface SectionInput {
  readonly key: DocumentationFixtureSectionKey
  readonly heading: string
  readonly text: string
}

function page(
  path: string,
  title: string,
  sections: readonly SectionInput[],
  links: readonly string[] = []
): PreparedPage {
  const uri = `${documentationFixtureRoot}${path}`
  let offset = 0
  const parsedSections = sections.map(({ heading, text }) => {
    const startOffset = offset
    const endOffset = startOffset + text.length
    offset = endOffset + 2
    return {
      headingPath: [title, heading],
      excerpt: text,
      startOffset,
      endOffset,
    }
  })
  return {
    sourceUri: uri,
    canonicalUri: uri,
    mediaType: "text/html",
    document: {
      title,
      sanitizedText: sections.map(({ text }) => text).join("\n\n"),
      sections: parsedSections,
      links: [...links],
    },
  }
}

const checkoutUri = `${documentationFixtureRoot}/checkout`
const duplicateUri = `${documentationFixtureRoot}/checkout-reference`
const refundAllowedUri = `${documentationFixtureRoot}/refunds/current`
const refundDeniedUri = `${documentationFixtureRoot}/refunds/legacy`
const marketingUri = `${documentationFixtureRoot}/why-fixture`
const setupUri = `${documentationFixtureRoot}/setup`
const architectureUri = `${documentationFixtureRoot}/architecture`
const exampleUri = `${documentationFixtureRoot}/examples`

const sectionText: Readonly<Record<DocumentationFixtureSectionKey, string>> = {
  overview:
    "This guide links product behavior, operational notes, and reference material.",
  checkout_email: "The attendee must provide a valid email before checkout.",
  checkout_confirmation:
    "When payment succeeds, the attendee receives an order confirmation.",
  checkout_duplicate:
    "The attendee must provide a valid email before checkout.",
  refund_allowed:
    "An organizer may refund a paid order before the event starts.",
  refund_denied:
    "An organizer cannot refund a paid order before the event starts.",
  marketing:
    "The world's most delightful and seamless ticketing platform delights every team.",
  setup: "Install the package and run the development server.",
  architecture:
    "The checkout service publishes messages through an internal event bus.",
  example:
    "For example, a demo organizer may refund a sample order during training.",
}

const preparedPages: readonly PreparedPage[] = [
  page(
    "",
    "Product guide",
    [{ key: "overview", heading: "Overview", text: sectionText.overview }],
    [
      checkoutUri,
      duplicateUri,
      refundAllowedUri,
      refundDeniedUri,
      marketingUri,
      setupUri,
      architectureUri,
      exampleUri,
    ]
  ),
  page(
    "/checkout",
    "Checkout",
    [
      {
        key: "checkout_email",
        heading: "Required email",
        text: sectionText.checkout_email,
      },
      {
        key: "checkout_confirmation",
        heading: "Successful payment",
        text: sectionText.checkout_confirmation,
      },
    ],
    [refundAllowedUri]
  ),
  page(
    "/checkout-reference",
    "Checkout reference",
    [
      {
        key: "checkout_duplicate",
        heading: "Email requirement",
        text: sectionText.checkout_duplicate,
      },
      {
        key: "overview",
        heading: "Reference note",
        text: "This reference restates one requirement for support teams.",
      },
    ],
    [checkoutUri]
  ),
  page(
    "/refunds/current",
    "Current refunds",
    [
      {
        key: "refund_allowed",
        heading: "Organizer refund",
        text: sectionText.refund_allowed,
      },
    ],
    [refundDeniedUri]
  ),
  page(
    "/refunds/legacy",
    "Legacy refunds",
    [
      {
        key: "refund_denied",
        heading: "Organizer refund",
        text: sectionText.refund_denied,
      },
    ],
    [documentationFixtureRoot]
  ),
  page("/why-fixture", "Why Fixture", [
    {
      key: "marketing",
      heading: "Marketing",
      text: sectionText.marketing,
    },
  ]),
  page("/setup", "Setup", [
    { key: "setup", heading: "Local setup", text: sectionText.setup },
  ]),
  page("/architecture", "Architecture", [
    {
      key: "architecture",
      heading: "Internal eventing",
      text: sectionText.architecture,
    },
  ]),
  page("/examples", "Examples", [
    { key: "example", heading: "Refund demo", text: sectionText.example },
  ]),
]

function runId(ordinal: number) {
  return runIdSchema.parse(
    `run:15000000-0000-4000-8000-${ordinal.toString(16).padStart(12, "0")}`
  )
}

const defaultBudget: MissionBudget = {
  toolCalls: 30,
  contentBytes: 300_000,
  documentBytes: 100_000,
  documentPages: 100,
  documentSections: 200,
  sourceLines: 0,
  repositoryBytes: 0,
  repositoryFiles: 0,
  browserActions: 0,
  modelCalls: 30,
  modelInputTokens: 100_000,
  modelOutputTokens: 10_000,
  reconciliationRounds: 0,
  elapsedMs: 60_000,
}

const questionsByMode = {
  baseline_discovery: [
    "What must an attendee provide before checkout?",
    "What does an attendee receive after successful payment?",
  ],
  targeted_requirement_lookup: [
    "What must an attendee provide before checkout?",
  ],
  conflict_resolution: [
    "May an organizer refund a paid order before the event starts?",
  ],
} as const

function sectionKey(
  record: DocumentSectionRecord
): DocumentationFixtureSectionKey {
  const text = record.sanitizedText
  const matching = Object.entries(sectionText).find(
    ([key, value]) =>
      value === text &&
      !(key === "checkout_email" && record.sourceUri === duplicateUri) &&
      !(key === "checkout_duplicate" && record.sourceUri !== duplicateUri)
  )?.[0]
  if (matching === undefined) {
    throw new Error(`Unknown documentation fixture section: ${text}`)
  }
  return matching as DocumentationFixtureSectionKey
}

export interface DocumentationExplorerFixture {
  readonly map: ReturnType<typeof buildDocumentationMap>
  readonly index: DocumentationMapIndex
  readonly mission: DocumentationExplorerMission
  readonly tools: DocumentationExplorerTools
  readonly sections: Readonly<
    Record<DocumentationFixtureSectionKey, DocumentSectionRecord>
  >
  citation(
    key: DocumentationFixtureSectionKey
  ): ReturnType<typeof submitRequirementClaimInputSchema.parse>["citation"]
  claim(
    key: DocumentationFixtureSectionKey,
    input: {
      readonly kind: DocumentationClaimKind
      readonly actor?: string
      readonly capability: string
      readonly expectedOutcome?: string
    }
  ): SubmitRequirementClaimInput
  requirementId(
    key: DocumentationFixtureSectionKey,
    kind: DocumentationClaimKind
  ): ReturnType<typeof createDocumentationRequirementId>
}

export function createDocumentationExplorerFixture(input: {
  readonly mode: DocumentationFixtureMode
  readonly ordinal?: number
  readonly budget?: Partial<MissionBudget>
  readonly allowedTools?: readonly (typeof documentationExplorerToolNames)[number][]
}): DocumentationExplorerFixture {
  const ordinal = input.ordinal ?? 1
  const selectedRunId = runId(ordinal)
  const map = buildDocumentationMap({
    applicationId: documentationFixtureApplicationId,
    kind: "web",
    rootUri: documentationFixtureRoot,
    pages: preparedPages,
  })
  const mission = documentationExplorerMissionSchema.parse({
    schemaVersion: 1,
    id: createMissionId({
      applicationId: documentationFixtureApplicationId,
      runId: selectedRunId,
      agent: "documentation",
      mode: input.mode,
      ordinal,
    }),
    runId: selectedRunId,
    applicationId: documentationFixtureApplicationId,
    agent: "documentation",
    mode: input.mode,
    goal:
      input.mode === "conflict_resolution"
        ? "Preserve and cite contradictory refund intent."
        : "Discover exact cited checkout intent from the linked guide.",
    seedEvidenceIds: [],
    questions: [...questionsByMode[input.mode]],
    scope: {
      repositoryPaths: [],
      sourceUris: [documentationFixtureRoot],
      allowedHosts: ["docs.fixture.test"],
      allowedTools: [...(input.allowedTools ?? documentationExplorerToolNames)],
    },
    budget: { ...defaultBudget, ...input.budget },
    successCriteria: [
      "Return exact cited requirements or explicit typed unresolved coverage.",
    ],
  })
  const sectionEntries = map.sections
    .filter((record) =>
      Object.values(sectionText).includes(record.sanitizedText)
    )
    .map((record) => [sectionKey(record), record] as const)
  const sections = Object.fromEntries(sectionEntries) as Record<
    DocumentationFixtureSectionKey,
    DocumentSectionRecord
  >
  const index = new DocumentationMapIndex(map)
  const citation = (key: DocumentationFixtureSectionKey) => {
    const section = sections[key]
    if (section === undefined) {
      throw new Error(`Missing documentation fixture section ${key}`)
    }
    const page = map.pages.find(({ fact }) => fact.id === section.fact.pageId)
    if (page === undefined) {
      throw new Error(`Missing documentation fixture page for ${key}`)
    }
    return submitRequirementClaimInputSchema.shape.citation.parse({
      evidenceId: createRunScopedEvidenceId({
        applicationId: mission.applicationId,
        runId: mission.runId,
        sourceId: section.fact.id,
        kind: "documentation_excerpt",
        ordinal: 0,
      }),
      sourceId: map.source.id,
      pageId: page.fact.id,
      sectionId: section.fact.id,
      uri: section.sourceUri,
      headingPath: [...section.fact.headingPath],
      quote: section.sanitizedText,
      startOffset: section.startOffset,
      endOffset: section.endOffset,
      contentHash: section.fact.contentHash,
    })
  }
  const claim = (
    key: DocumentationFixtureSectionKey,
    claimInput: {
      readonly kind: DocumentationClaimKind
      readonly actor?: string
      readonly capability: string
      readonly expectedOutcome?: string
    }
  ) =>
    submitRequirementClaimInputSchema.parse({
      kind: claimInput.kind,
      statement: sections[key].sanitizedText,
      ...(claimInput.actor === undefined ? {} : { actor: claimInput.actor }),
      capability: claimInput.capability,
      ...(claimInput.expectedOutcome === undefined
        ? {}
        : { expectedOutcome: claimInput.expectedOutcome }),
      testable: true,
      citation: citation(key),
    })
  const requirementId = (
    key: DocumentationFixtureSectionKey,
    kind: DocumentationClaimKind
  ) =>
    createDocumentationRequirementId({
      applicationId: mission.applicationId,
      sectionId: sections[key].fact.id,
      kind,
      statement: sections[key].sanitizedText,
    })
  return {
    map,
    index,
    mission,
    tools: new DocumentationExplorerTools(index, mission),
    sections,
    citation,
    claim,
    requirementId,
  }
}
