import { z } from "zod"

import { requirementCandidateSchema } from "./facts.ts"
import {
  createClaimId,
  createRunScopedEvidenceId,
  hashCanonical,
} from "./identity.ts"
import {
  discoveryMissionSchema,
  missionBudgetSchema,
  missionResultSchema,
} from "./operations.ts"
import {
  applicationIdSchema,
  capabilityIdSchema,
  claimIdSchema,
  contentHashSchema,
  documentPageIdSchema,
  documentSectionIdSchema,
  documentSourceIdSchema,
  evidenceIdSchema,
  missionIdSchema,
  persistedTextSchema,
  reasonCodeSchema,
  requirementIdSchema,
  runIdSchema,
  schemaVersionSchema,
  shortTextSchema,
  sourceUriSchema,
  terminalStatusSchema,
} from "./primitives.ts"
import { createStableKey } from "./stable-keys.ts"

export const DOCUMENTATION_EXPLORER_SCHEMA_VERSION = 1 as const

export const documentationExplorerToolNames = [
  "list_document_tree",
  "search_documentation",
  "read_document_section",
  "inspect_linked_sections",
  "submit_requirement_claim",
  "finish_document_mission",
] as const

export const documentationExplorerToolNameSchema = z.enum(
  documentationExplorerToolNames
)

const resultLimitSchema = z.number().int().positive().max(100).optional()
const cursorSchema = z.number().int().nonnegative().max(1_000_000).optional()

export const listDocumentTreeInputSchema = z.strictObject({
  pageId: documentPageIdSchema.optional(),
  cursor: cursorSchema,
  limit: resultLimitSchema,
})

export const searchDocumentationInputSchema = z.strictObject({
  query: z.string().trim().min(2).max(256),
  cursor: cursorSchema,
  limit: resultLimitSchema,
})

export const readDocumentSectionInputSchema = z.strictObject({
  sectionId: documentSectionIdSchema,
})

export const inspectLinkedSectionsInputSchema = z.strictObject({
  sectionId: documentSectionIdSchema,
  cursor: cursorSchema,
  limit: resultLimitSchema,
})

export const documentationExcerptCitationSchema = z
  .strictObject({
    evidenceId: evidenceIdSchema,
    sourceId: documentSourceIdSchema,
    pageId: documentPageIdSchema,
    sectionId: documentSectionIdSchema,
    uri: sourceUriSchema,
    headingPath: z.array(shortTextSchema).min(1).max(20),
    quote: z.string().min(1).max(32_768),
    startOffset: z.number().int().nonnegative().max(1_000_000),
    endOffset: z.number().int().positive().max(1_000_000),
    contentHash: contentHashSchema,
  })
  .superRefine((citation, context) => {
    if (citation.endOffset - citation.startOffset !== citation.quote.length) {
      context.addIssue({
        code: "custom",
        message: "Citation offsets must span the exact quoted text",
        path: ["endOffset"],
      })
    }
  })

export const documentationClaimKindSchema = z.enum([
  "requirement",
  "acceptance_criterion",
])

export const documentationClaimCitationInputSchema = z
  .strictObject({
    evidenceId: evidenceIdSchema,
    sectionId: documentSectionIdSchema,
    startOffset: z.number().int().nonnegative().max(1_000_000),
    endOffset: z.number().int().positive().max(1_000_000),
    contentHash: contentHashSchema,
  })
  .refine(({ endOffset, startOffset }) => endOffset > startOffset, {
    message: "Claim citation end offset must follow its start offset",
    path: ["endOffset"],
  })

export const submitRequirementClaimInputSchema = z.strictObject({
  kind: documentationClaimKindSchema,
  statement: persistedTextSchema,
  actor: shortTextSchema.optional(),
  capability: shortTextSchema,
  expectedOutcome: persistedTextSchema.optional(),
  testable: z.literal(true),
  citation: documentationClaimCitationInputSchema,
})

export const documentationQuestionDispositionSchema = z
  .strictObject({
    questionIndex: z.number().int().nonnegative().max(19),
    question: persistedTextSchema,
    status: z.enum(["covered", "unresolved", "conflict"]),
    requirementIds: z.array(requirementIdSchema).max(100),
    evidenceIds: z.array(evidenceIdSchema).max(100),
    reasonCode: reasonCodeSchema,
    summary: persistedTextSchema,
  })
  .superRefine((disposition, context) => {
    if (
      new Set(disposition.requirementIds).size !==
        disposition.requirementIds.length ||
      new Set(disposition.evidenceIds).size !== disposition.evidenceIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Question disposition references must be unique",
      })
    }
    if (
      disposition.status === "covered" &&
      (disposition.requirementIds.length === 0 ||
        disposition.evidenceIds.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Covered questions require a cited requirement",
      })
    }
    if (
      disposition.status === "unresolved" &&
      disposition.requirementIds.length > 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Unresolved questions cannot claim requirement coverage",
        path: ["requirementIds"],
      })
    }
    if (
      disposition.status === "conflict" &&
      (disposition.requirementIds.length < 2 ||
        disposition.evidenceIds.length < 2)
    ) {
      context.addIssue({
        code: "custom",
        message: "Conflicts require at least two cited requirements",
      })
    }
  })

export const documentationExclusionCategorySchema = z.enum([
  "architecture",
  "example",
  "marketing",
  "setup",
  "unsupported",
  "vague",
])

export const documentationExclusionSchema = z.strictObject({
  category: documentationExclusionCategorySchema,
  summary: persistedTextSchema,
  sectionId: documentSectionIdSchema.optional(),
  evidenceId: evidenceIdSchema.optional(),
})

export const finishDocumentMissionInputSchema = z.strictObject({
  status: terminalStatusSchema,
  selectedRequirementIds: z.array(requirementIdSchema).max(500),
  questionDispositions: z
    .array(documentationQuestionDispositionSchema)
    .min(1)
    .max(20),
  exclusions: z.array(documentationExclusionSchema).max(100),
  suggestedFollowups: z.array(discoveryMissionSchema).max(20),
  stopReason: z.strictObject({
    code: reasonCodeSchema,
    summary: persistedTextSchema,
  }),
})

export const documentationExplorerToolInputSchema = z.discriminatedUnion(
  "toolName",
  [
    z.strictObject({
      toolName: z.literal("list_document_tree"),
      arguments: listDocumentTreeInputSchema,
    }),
    z.strictObject({
      toolName: z.literal("search_documentation"),
      arguments: searchDocumentationInputSchema,
    }),
    z.strictObject({
      toolName: z.literal("read_document_section"),
      arguments: readDocumentSectionInputSchema,
    }),
    z.strictObject({
      toolName: z.literal("inspect_linked_sections"),
      arguments: inspectLinkedSectionsInputSchema,
    }),
    z.strictObject({
      toolName: z.literal("submit_requirement_claim"),
      arguments: submitRequirementClaimInputSchema,
    }),
    z.strictObject({
      toolName: z.literal("finish_document_mission"),
      arguments: finishDocumentMissionInputSchema,
    }),
  ]
)

export const documentationPageSummarySchema = z.strictObject({
  sourceId: documentSourceIdSchema,
  pageId: documentPageIdSchema,
  uri: sourceUriSchema,
  title: shortTextSchema,
  contentHash: contentHashSchema,
  sectionCount: z.number().int().nonnegative().max(10_000),
  linkedPageCount: z.number().int().nonnegative().max(10_000),
})

export const documentationSectionSummarySchema = z.strictObject({
  pageId: documentPageIdSchema,
  sectionId: documentSectionIdSchema,
  headingPath: z.array(shortTextSchema).min(1).max(20),
  contentHash: contentHashSchema,
  contentBytes: z.number().int().nonnegative().max(1_000_000),
})

export const documentationSearchHitSchema = z.strictObject({
  page: documentationPageSummarySchema,
  section: documentationSectionSummarySchema,
  matchedTerms: z.array(shortTextSchema).min(1).max(50),
  score: z.number().int().nonnegative().max(1_000_000),
})

export const documentationLinkedSectionSchema = z.strictObject({
  fromPageId: documentPageIdSchema,
  page: documentationPageSummarySchema,
  sections: z.array(documentationSectionSummarySchema).max(100),
})

export const documentationToolMetricsSchema = z.strictObject({
  contentBytes: z.number().int().nonnegative(),
  documentBytes: z.number().int().nonnegative(),
  documentPages: z.number().int().nonnegative(),
  documentSections: z.number().int().nonnegative(),
  resultItems: z.number().int().nonnegative(),
})

const observationBase = {
  schemaVersion: schemaVersionSchema,
  summary: persistedTextSchema,
  nextCursor: z.number().int().nonnegative().max(1_000_000).optional(),
  metrics: documentationToolMetricsSchema,
}

export const documentTreeObservationSchema = z.strictObject({
  ...observationBase,
  toolName: z.literal("list_document_tree"),
  pages: z.array(documentationPageSummarySchema).max(100),
  sections: z.array(documentationSectionSummarySchema).max(1_000),
})

export const documentationSearchObservationSchema = z.strictObject({
  ...observationBase,
  toolName: z.literal("search_documentation"),
  hits: z.array(documentationSearchHitSchema).max(100),
})

export const documentSectionObservationSchema = z.strictObject({
  ...observationBase,
  toolName: z.literal("read_document_section"),
  fullSection: z.literal(true),
  citation: documentationExcerptCitationSchema,
})

export const linkedSectionsObservationSchema = z.strictObject({
  ...observationBase,
  toolName: z.literal("inspect_linked_sections"),
  links: z.array(documentationLinkedSectionSchema).max(100),
})

export const documentationToolObservationSchema = z.discriminatedUnion(
  "toolName",
  [
    documentTreeObservationSchema,
    documentationSearchObservationSchema,
    documentSectionObservationSchema,
    linkedSectionsObservationSchema,
  ]
)

export const documentationRequirementClaimSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    claimId: claimIdSchema,
    missionId: missionIdSchema,
    runId: runIdSchema,
    status: z.literal("proposed"),
    kind: documentationClaimKindSchema,
    requirement: requirementCandidateSchema.extend({
      testable: z.literal(true),
    }),
    citation: documentationExcerptCitationSchema,
    evidenceIds: z.array(evidenceIdSchema).length(1),
    statementFingerprint: contentHashSchema,
  })
  .superRefine((claim, context) => {
    const source = claim.requirement.source
    const citation = claim.citation
    const lastHeading = citation.headingPath.at(-1)
    if (
      source.sectionId !== citation.sectionId ||
      source.uri !== citation.uri ||
      source.heading !== lastHeading ||
      source.excerpt !== citation.quote ||
      source.contentHash !== citation.contentHash
    ) {
      context.addIssue({
        code: "custom",
        message: "Requirement source must exactly match its citation",
        path: ["requirement", "source"],
      })
    }
    const expectedRequirementId = createDocumentationRequirementId({
      applicationId: claim.requirement.applicationId,
      sectionId: citation.sectionId,
      kind: claim.kind,
      statement: claim.requirement.statement,
    })
    if (claim.requirement.id !== expectedRequirementId) {
      context.addIssue({
        code: "custom",
        message: "Requirement ID must match its canonical cited statement",
        path: ["requirement", "id"],
      })
    }
    const expectedClaimId = createClaimId({
      applicationId: claim.requirement.applicationId,
      missionId: claim.missionId,
      subjectId: claim.requirement.id,
      predicate: "supported_by",
      objectId: citation.sectionId,
      ordinal: 0,
    })
    if (claim.claimId !== expectedClaimId) {
      context.addIssue({
        code: "custom",
        message: "Claim ID must match its canonical requirement relation",
        path: ["claimId"],
      })
    }
    const expectedEvidenceId = createRunScopedEvidenceId({
      applicationId: claim.requirement.applicationId,
      runId: claim.runId,
      sourceId: citation.sectionId,
      kind: "documentation_excerpt",
      ordinal: 0,
    })
    if (citation.evidenceId !== expectedEvidenceId) {
      context.addIssue({
        code: "custom",
        message:
          "Citation evidence ID must match its run-scoped section identity",
        path: ["citation", "evidenceId"],
      })
    }
    if (
      claim.evidenceIds.length !== 1 ||
      claim.evidenceIds[0] !== citation.evidenceId
    ) {
      context.addIssue({
        code: "custom",
        message: "Requirement evidence must be its cited excerpt",
        path: ["evidenceIds"],
      })
    }
    if (
      hashCanonical(
        normalizeRequirementStatement(claim.requirement.statement)
      ) !== claim.statementFingerprint
    ) {
      context.addIssue({
        code: "custom",
        message: "Statement fingerprint must match the normalized requirement",
        path: ["statementFingerprint"],
      })
    }
  })

export const documentationDuplicateGroupSchema = z
  .strictObject({
    key: contentHashSchema,
    status: z.literal("grouped"),
    canonicalRequirementId: requirementIdSchema,
    duplicateRequirementIds: z.array(requirementIdSchema).min(1).max(100),
    evidenceIds: z.array(evidenceIdSchema).min(2).max(100),
  })
  .superRefine((group, context) => {
    if (group.duplicateRequirementIds.includes(group.canonicalRequirementId)) {
      context.addIssue({
        code: "custom",
        message: "Canonical requirement cannot also be a duplicate",
        path: ["duplicateRequirementIds"],
      })
    }
    if (
      new Set(group.duplicateRequirementIds).size !==
        group.duplicateRequirementIds.length ||
      new Set(group.evidenceIds).size !== group.evidenceIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Duplicate group references must be unique",
      })
    }
  })

export const documentationConflictSchema = z
  .strictObject({
    key: contentHashSchema,
    status: z.literal("unresolved"),
    kind: z.literal("contradictory_requirement"),
    requirementIds: z.array(requirementIdSchema).min(2).max(100),
    evidenceIds: z.array(evidenceIdSchema).min(2).max(100),
    summary: persistedTextSchema,
  })
  .superRefine((conflict, context) => {
    if (
      new Set(conflict.requirementIds).size !==
        conflict.requirementIds.length ||
      new Set(conflict.evidenceIds).size !== conflict.evidenceIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Conflict references must be distinct",
      })
    }
  })

export const documentationCapabilityTermSchema = z
  .strictObject({
    id: capabilityIdSchema,
    applicationId: applicationIdSchema,
    normalizedName: shortTextSchema,
    requirementIds: z.array(requirementIdSchema).min(1).max(500),
    status: z.literal("proposed"),
    authoritative: z.literal(false),
  })
  .refine(
    ({ requirementIds }) =>
      new Set(requirementIds).size === requirementIds.length,
    {
      message: "Capability requirement references must be unique",
      path: ["requirementIds"],
    }
  )

export const documentationMissionMetricsSchema = z.strictObject({
  treePagesVisited: z.number().int().nonnegative(),
  searchesPerformed: z.number().int().nonnegative(),
  sectionsRead: z.number().int().nonnegative(),
  linksInspected: z.number().int().nonnegative(),
  requirementsAccepted: z.number().int().nonnegative(),
  duplicateRequirements: z.number().int().nonnegative(),
  conflictsFound: z.number().int().nonnegative(),
})

const documentationBudgetStopReasons = new Set([
  "budget_exhausted",
  "elapsed_budget_exhausted",
  "model_budget_exhausted",
  "model_usage_exceeded_preflight",
  "recursion_limit",
  "tool_budget_exhausted",
  "tool_usage_exceeded_preflight",
])

export const documentationMissionResultSchema = missionResultSchema
  .extend({
    applicationId: applicationIdSchema,
    runId: runIdSchema,
    sourceId: documentSourceIdSchema,
    mapContentHash: contentHashSchema,
    requirements: z.array(documentationRequirementClaimSchema).max(500),
    questionDispositions: z
      .array(documentationQuestionDispositionSchema)
      .min(1)
      .max(20),
    duplicateGroups: z.array(documentationDuplicateGroupSchema).max(100),
    conflicts: z.array(documentationConflictSchema).max(100),
    capabilityTerms: z.array(documentationCapabilityTermSchema).max(500),
    typedExclusions: z.array(documentationExclusionSchema).max(100),
    metrics: documentationMissionMetricsSchema,
  })
  .superRefine((result, context) => {
    assertUnique(
      result.requirements,
      ({ requirement }) => requirement.id,
      context,
      ["requirements"]
    )
    assertUnique(result.requirements, ({ claimId }) => claimId, context, [
      "requirements",
    ])
    assertUnique(
      result.questionDispositions,
      ({ questionIndex }) => String(questionIndex),
      context,
      ["questionDispositions"]
    )
    assertUnique(result.duplicateGroups, ({ key }) => key, context, [
      "duplicateGroups",
    ])
    assertUnique(result.conflicts, ({ key }) => key, context, ["conflicts"])
    assertUnique(result.capabilityTerms, ({ id }) => id, context, [
      "capabilityTerms",
    ])

    const requirementById = new Map<
      string,
      (typeof result.requirements)[number]
    >(result.requirements.map((claim) => [claim.requirement.id, claim]))
    const genericClaimById = new Map(
      result.claims.map((claim) => [claim.id, claim])
    )
    for (const [index, requirementClaim] of result.requirements.entries()) {
      const genericClaim = genericClaimById.get(requirementClaim.claimId)
      if (
        genericClaim === undefined ||
        String(genericClaim.subjectId) !==
          String(requirementClaim.requirement.id) ||
        genericClaim.predicate !== "supported_by" ||
        String(genericClaim.objectId) !==
          String(requirementClaim.citation.sectionId) ||
        genericClaim.evidenceIds.length !== 1 ||
        genericClaim.evidenceIds[0] !== requirementClaim.citation.evidenceId
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Each requirement must have one matching generic mission claim",
          path: ["requirements", index, "claimId"],
        })
      }
    }
    if (result.claims.length !== result.requirements.length) {
      context.addIssue({
        code: "custom",
        message: "Generic claims and cited requirements must be one-to-one",
        path: ["claims"],
      })
    }

    const validateReferences = (
      ids: readonly string[],
      path: (string | number)[]
    ) => {
      ids.forEach((id, index) => {
        if (!requirementById.has(id)) {
          context.addIssue({
            code: "custom",
            message: "Referenced requirement must be present in the result",
            path: [...path, index],
          })
        }
      })
    }
    result.questionDispositions.forEach((item, index) =>
      validateReferences(item.requirementIds, [
        "questionDispositions",
        index,
        "requirementIds",
      ])
    )
    result.duplicateGroups.forEach((group, index) => {
      validateReferences(
        [group.canonicalRequirementId, ...group.duplicateRequirementIds],
        ["duplicateGroups", index, "requirementIds"]
      )
    })
    result.conflicts.forEach((conflict, index) =>
      validateReferences(conflict.requirementIds, [
        "conflicts",
        index,
        "requirementIds",
      ])
    )
    result.capabilityTerms.forEach((term, index) => {
      if (term.applicationId !== result.applicationId) {
        context.addIssue({
          code: "custom",
          message: "Capability term must belong to the mission application",
          path: ["capabilityTerms", index, "applicationId"],
        })
      }
      if (
        term.id !==
        createDocumentationCapabilityId({
          applicationId: term.applicationId,
          normalizedName: term.normalizedName,
        })
      ) {
        context.addIssue({
          code: "custom",
          message: "Capability ID must match its canonical normalized name",
          path: ["capabilityTerms", index, "id"],
        })
      }
      validateReferences(term.requirementIds, [
        "capabilityTerms",
        index,
        "requirementIds",
      ])
    })
    result.requirements.forEach((claim, index) => {
      if (
        claim.missionId !== result.missionId ||
        claim.runId !== result.runId ||
        claim.requirement.applicationId !== result.applicationId ||
        claim.citation.sourceId !== result.sourceId
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Requirement must belong to the mission application and documentation source",
          path: ["requirements", index],
        })
      }
    })
    result.duplicateGroups.forEach((group, index) => {
      const groupedClaims = [
        group.canonicalRequirementId,
        ...group.duplicateRequirementIds,
      ].map((id) => requirementById.get(id))
      const fingerprints = new Set(
        groupedClaims.map((claim) =>
          claim === undefined
            ? "missing"
            : `${claim.kind}:${claim.statementFingerprint}`
        )
      )
      const expectedEvidence = [
        ...new Set(
          groupedClaims.flatMap((claim) =>
            claim === undefined ? [] : [claim.citation.evidenceId]
          )
        ),
      ].sort()
      const suppliedEvidence = [...group.evidenceIds].sort()
      const firstClaim = groupedClaims[0]
      const expectedKey =
        firstClaim === undefined
          ? undefined
          : hashCanonical({
              kind: "documentation_duplicate_group",
              normalizedKey: `${firstClaim.kind}\u0000${firstClaim.statementFingerprint}`,
            })
      if (
        fingerprints.size !== 1 ||
        group.key !== expectedKey ||
        expectedEvidence.length !== suppliedEvidence.length ||
        expectedEvidence.some(
          (evidenceId, evidenceIndex) =>
            evidenceId !== suppliedEvidence[evidenceIndex]
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Duplicate groups must contain the same normalized claim and exact evidence union",
          path: ["duplicateGroups", index],
        })
      }
    })
    result.conflicts.forEach((conflict, index) => {
      const conflictClaims = conflict.requirementIds.map((id) =>
        requirementById.get(id)
      )
      const subjects = new Set(
        conflictClaims.map((claim) =>
          claim === undefined
            ? "missing"
            : `${normalizeRequirementStatement(claim.requirement.actor ?? "system")}\u0000${normalizeRequirementStatement(claim.requirement.capability)}`
        )
      )
      const subject = [...subjects][0]
      const expectedKey =
        subjects.size === 1 && subject !== undefined
          ? hashCanonical({ kind: "documentation_conflict", subject })
          : undefined
      const expectedEvidence = [
        ...new Set(
          conflictClaims.flatMap((claim) =>
            claim === undefined ? [] : [claim.citation.evidenceId]
          )
        ),
      ].sort()
      const suppliedEvidence = [...conflict.evidenceIds].sort()
      if (
        conflict.key !== expectedKey ||
        expectedEvidence.length !== suppliedEvidence.length ||
        expectedEvidence.some(
          (evidenceId, evidenceIndex) =>
            evidenceId !== suppliedEvidence[evidenceIndex]
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Conflicts must share one actor/capability and the exact evidence union",
          path: ["conflicts", index],
        })
      }
    })
    result.suggestedFollowups.forEach((mission, index) => {
      if (
        mission.applicationId !== result.applicationId ||
        mission.runId !== result.runId ||
        (mission.agent !== "code" && mission.agent !== "application")
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Documentation follow-ups must target Code or Application in the same run",
          path: ["suggestedFollowups", index],
        })
      }
    })

    const indexes = result.questionDispositions.map(
      ({ questionIndex }) => questionIndex
    )
    if (!isStrictlyAscending(indexes)) {
      context.addIssue({
        code: "custom",
        message:
          "Question dispositions must be unique and ordered by question index",
        path: ["questionDispositions"],
      })
    }
    if (
      result.status === "complete" &&
      (result.requirements.length === 0 ||
        result.unresolved.length > 0 ||
        result.questionDispositions.some(({ status }) => status !== "covered"))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Complete documentation results require cited coverage for every question",
        path: ["status"],
      })
    }
    if (
      result.status === "budget_exhausted" &&
      !documentationBudgetStopReasons.has(result.stopReason.code)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Budget-exhausted results require a deterministic budget or recursion stop reason",
        path: ["stopReason", "code"],
      })
    }
  })

const documentationToolSet = new Set<string>(documentationExplorerToolNames)

export const documentationExplorerMissionSchema =
  discoveryMissionSchema.superRefine((mission, context) => {
    if (mission.agent !== "documentation") {
      context.addIssue({
        code: "custom",
        message: "Documentation Explorer requires a documentation mission",
        path: ["agent"],
      })
    }
    if (mission.scope.sourceUris.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Documentation missions require an approved source URI",
        path: ["scope", "sourceUris"],
      })
    }
    if (mission.scope.repositoryPaths.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Documentation Explorer cannot receive repository code paths",
        path: ["scope", "repositoryPaths"],
      })
    }
    const seen = new Set<string>()
    mission.scope.allowedTools.forEach((tool, index) => {
      if (!documentationToolSet.has(tool)) {
        context.addIssue({
          code: "custom",
          message: `Tool ${tool} is not available to the Documentation Explorer`,
          path: ["scope", "allowedTools", index],
        })
      }
      if (seen.has(tool)) {
        context.addIssue({
          code: "custom",
          message: "Documentation tool permissions must be unique",
          path: ["scope", "allowedTools", index],
        })
      }
      seen.add(tool)
    })
    if (!seen.has("finish_document_mission")) {
      context.addIssue({
        code: "custom",
        message: "Documentation missions must be able to finish explicitly",
        path: ["scope", "allowedTools"],
      })
    }
  })

export function normalizeRequirementStatement(statement: string): string {
  return statement.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US")
}

export function createDocumentationRequirementId(input: {
  applicationId: z.infer<typeof applicationIdSchema>
  sectionId: z.infer<typeof documentSectionIdSchema>
  kind: z.infer<typeof documentationClaimKindSchema>
  statement: string
}): z.infer<typeof requirementIdSchema> {
  const key = createStableKey({
    kind: "requirement",
    applicationId: input.applicationId,
    sectionId: input.sectionId,
    statementFingerprint: hashCanonical({
      kind: input.kind,
      statement: normalizeRequirementStatement(input.statement),
    }),
  })
  return requirementIdSchema.parse(key)
}

export function createDocumentationCapabilityId(input: {
  applicationId: z.infer<typeof applicationIdSchema>
  normalizedName: string
}): z.infer<typeof capabilityIdSchema> {
  const key = createStableKey({
    kind: "capability",
    applicationId: input.applicationId,
    normalizedName: shortTextSchema.parse(
      input.normalizedName
        .trim()
        .replace(/\s+/g, " ")
        .toLocaleLowerCase("en-US")
    ),
  })
  return capabilityIdSchema.parse(key)
}

function assertUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  context: z.RefinementCtx,
  path: (string | number)[]
) {
  const seen = new Set<string>()
  values.forEach((value, index) => {
    const itemKey = key(value)
    if (seen.has(itemKey)) {
      context.addIssue({
        code: "custom",
        message: "Values must be unique",
        path: [...path, index],
      })
    }
    seen.add(itemKey)
  })
}

function isStrictlyAscending(values: readonly number[]): boolean {
  return values.every(
    (value, index) => index === 0 || values[index - 1]! < value
  )
}

export type DocumentationExplorerToolName = z.infer<
  typeof documentationExplorerToolNameSchema
>
export type DocumentationClaimKind = z.infer<
  typeof documentationClaimKindSchema
>
export type ListDocumentTreeInput = z.infer<typeof listDocumentTreeInputSchema>
export type SearchDocumentationInput = z.infer<
  typeof searchDocumentationInputSchema
>
export type ReadDocumentSectionInput = z.infer<
  typeof readDocumentSectionInputSchema
>
export type InspectLinkedSectionsInput = z.infer<
  typeof inspectLinkedSectionsInputSchema
>
export type DocumentationExcerptCitation = z.infer<
  typeof documentationExcerptCitationSchema
>
export type DocumentationClaimCitationInput = z.infer<
  typeof documentationClaimCitationInputSchema
>
export type SubmitRequirementClaimInput = z.infer<
  typeof submitRequirementClaimInputSchema
>
export type FinishDocumentMissionInput = z.infer<
  typeof finishDocumentMissionInputSchema
>
export type DocumentationExplorerToolInput = z.infer<
  typeof documentationExplorerToolInputSchema
>
export type DocumentationPageSummary = z.infer<
  typeof documentationPageSummarySchema
>
export type DocumentationSectionSummary = z.infer<
  typeof documentationSectionSummarySchema
>
export type DocumentationSearchHit = z.infer<
  typeof documentationSearchHitSchema
>
export type DocumentationToolObservation = z.infer<
  typeof documentationToolObservationSchema
>
export type DocumentationRequirementClaim = z.infer<
  typeof documentationRequirementClaimSchema
>
export type DocumentationQuestionDisposition = z.infer<
  typeof documentationQuestionDispositionSchema
>
export type DocumentationDuplicateGroup = z.infer<
  typeof documentationDuplicateGroupSchema
>
export type DocumentationConflict = z.infer<typeof documentationConflictSchema>
export type DocumentationCapabilityTerm = z.infer<
  typeof documentationCapabilityTermSchema
>
export type DocumentationExclusion = z.infer<
  typeof documentationExclusionSchema
>
export type DocumentationExplorerMission = z.infer<
  typeof documentationExplorerMissionSchema
>
export type DocumentationMissionResult = z.infer<
  typeof documentationMissionResultSchema
>
export type DocumentationMissionBudget = z.infer<typeof missionBudgetSchema>
export type DocumentationRunId = z.infer<typeof runIdSchema>
