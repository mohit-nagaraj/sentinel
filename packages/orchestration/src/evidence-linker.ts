import {
  EVIDENCE_LINKING_SCHEMA_VERSION,
  evidenceAdjudicationRequestSchema,
  evidenceAdjudicationResultSchema,
  evidenceCandidateIdSchema,
  evidenceLinkConflictSchema,
  evidenceLinkingInputSchema,
  evidenceLinkRejectionSchema,
  evidenceReviewCandidateSchema,
  hashCanonical,
  pendingEvidenceLinkBatchSchema,
  submittedEvidenceLinkSchema,
  type EvidenceAdjudicationRequest,
  type EvidenceExtractionMethod,
  type EvidenceLinkConflict,
  type EvidenceLinkRejection,
  type EvidenceLinkingInput,
  type EvidenceReviewCandidate,
  type ExactLinkObservation,
  type LinkEvidenceRecord,
  type PendingEvidenceLinkBatch,
  type SemanticEntity,
  type SubmittedEvidenceLink,
  type EvidenceLink,
  type EvidenceRelationship,
} from "@sentinel/contracts"

const MAX_SEMANTIC_COMPARISONS = 5_000

type EvidenceSourceKind = LinkEvidenceRecord["provenance"]["sourceKind"]

export const evidenceMethodSourceKinds = Object.freeze({
  document_parse: ["document"],
  sanitized_link_map: ["document"],
  cited_excerpt: ["document"],
  validated_requirement_extraction: ["document"],
  crawl_record: ["browser"],
  browser_transition: ["browser"],
  locator_action: ["browser"],
  accessibility_snapshot: ["browser"],
  normalized_route_match: ["browser"],
  route_component_ancestry: ["repository"],
  exact_ui_text: ["browser"],
  jsx_ast_binding: ["repository"],
  runtime_request_match: ["browser"],
  frontend_http_call: ["repository"],
  laravel_route_action: ["repository", "openapi"],
  source_call: ["repository"],
  source_reference: ["repository"],
  entity_read: ["repository"],
  entity_write: ["repository"],
  diff_symbol_overlap: ["repository"],
  coverage_evaluator: ["system"],
  semantic_capability_match: ["system"],
  name_similarity: ["system"],
} as const satisfies Record<
  EvidenceExtractionMethod,
  readonly EvidenceSourceKind[]
>)

type AuthoritativeTier = "A" | "B"

interface RelationshipPolicy {
  readonly tier: AuthoritativeTier
  readonly requiredMethods: readonly (readonly EvidenceExtractionMethod[])[]
}

const relationshipPolicies: Partial<
  Record<EvidenceRelationship, RelationshipPolicy>
> = {
  HAS_PAGE: { tier: "A", requiredMethods: [["document_parse"]] },
  HAS_SECTION: { tier: "A", requiredMethods: [["document_parse"]] },
  LINKS_TO: { tier: "A", requiredMethods: [["sanitized_link_map"]] },
  STATES: {
    tier: "B",
    requiredMethods: [["cited_excerpt"], ["validated_requirement_extraction"]],
  },
  COVERED_BY: {
    tier: "B",
    requiredMethods: [
      ["validated_requirement_extraction"],
      ["browser_transition"],
    ],
  },
  HAS_STEP: { tier: "A", requiredMethods: [["crawl_record"]] },
  NEXT: { tier: "A", requiredMethods: [["browser_transition"]] },
  ON_SCREEN: { tier: "A", requiredMethods: [["browser_transition"]] },
  ACTS_ON: { tier: "A", requiredMethods: [["locator_action"]] },
  CONTAINS: { tier: "A", requiredMethods: [["accessibility_snapshot"]] },
  MATCHES_ROUTE: {
    tier: "A",
    requiredMethods: [["normalized_route_match"]],
  },
  RENDERED_BY: {
    tier: "B",
    requiredMethods: [["route_component_ancestry"], ["exact_ui_text"]],
  },
  BINDS: { tier: "A", requiredMethods: [["jsx_ast_binding"]] },
  TRIGGERS_API: {
    tier: "A",
    requiredMethods: [["runtime_request_match"]],
  },
  CALLS_API: {
    tier: "A",
    requiredMethods: [["frontend_http_call"]],
  },
  HANDLED_BY: {
    tier: "A",
    requiredMethods: [["laravel_route_action"]],
  },
  CALLS: {
    tier: "A",
    requiredMethods: [["source_call", "source_reference"]],
  },
  READS: { tier: "A", requiredMethods: [["entity_read"]] },
  WRITES: { tier: "A", requiredMethods: [["entity_write"]] },
  CHANGES: { tier: "A", requiredMethods: [["diff_symbol_overlap"]] },
  HAS_ASSESSMENT: {
    tier: "A",
    requiredMethods: [["coverage_evaluator"]],
  },
}

export const evidenceRelationshipPolicies = Object.freeze(relationshipPolicies)

export interface EvidenceCandidateAdjudicator {
  adjudicate(
    request: EvidenceAdjudicationRequest,
    signal?: AbortSignal
  ): Promise<unknown>
}

export interface EvidenceLinkerOptions {
  readonly adjudicator?: EvidenceCandidateAdjudicator
}

interface ValidatedClaim {
  readonly claim: SubmittedEvidenceLink
  readonly evidence: readonly LinkEvidenceRecord[]
  readonly tier: AuthoritativeTier
}

interface CandidateWithScore {
  readonly candidate: EvidenceReviewCandidate
  readonly score: number
}

type SemanticRelationship = "REQUIRES" | "COVERED_BY" | "RENDERED_BY"

function stringHash(value: unknown): string {
  return hashCanonical(value).slice("sha256:".length)
}

function createGeneratedClaimId(value: unknown) {
  return `claim:v1:${stringHash({ kind: "generated-link-claim", value, version: 1 })}`
}

function createLinkId(
  applicationId: string,
  fromId: string,
  relationship: string,
  toId: string
) {
  return `evidence:v1:${stringHash({
    applicationId,
    fromId,
    kind: "validated-evidence-link",
    relationship,
    toId,
    version: 1,
  })}`
}

function createCandidateId(
  applicationId: string,
  fromId: string,
  relationship: SemanticRelationship,
  toId: string
) {
  return evidenceCandidateIdSchema.parse(
    `candidate:v1:${stringHash({
      applicationId,
      fromId,
      kind: "evidence-review-candidate",
      relationship,
      toId,
      version: 1,
    })}`
  )
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[]
}

function relationshipKey(link: {
  readonly fromId: string
  readonly relationship: string
  readonly toId: string
}): string {
  return `${link.fromId}\u0000${link.relationship}\u0000${link.toId}`
}

function rangesOverlap(
  left: { readonly startLine: number; readonly endLine: number },
  right: { readonly startLine: number; readonly endLine: number }
): boolean {
  return left.startLine <= right.endLine && right.startLine <= left.endLine
}

function normalizeObservedPath(path: string): string {
  const withoutQuery = path.split(/[?#]/u, 1)[0] ?? "/"
  const collapsed = withoutQuery.replace(/\/{2,}/gu, "/")
  return collapsed.length > 1 && collapsed.endsWith("/")
    ? collapsed.slice(0, -1)
    : collapsed
}

function isDynamicRouteSegment(segment: string): boolean {
  return (
    (segment.startsWith("{") && segment.endsWith("}")) ||
    (segment.startsWith(":") && segment.length > 1) ||
    (segment.startsWith("[") && segment.endsWith("]"))
  )
}

function routeMatches(patternInput: string, pathInput: string): boolean {
  const pattern = normalizeObservedPath(patternInput)
  const path = normalizeObservedPath(pathInput)
  if (pattern === path) return true

  const patternSegments = pattern.split("/").filter(Boolean)
  const pathSegments = path.split("/").filter(Boolean)
  const catchAllIndex = patternSegments.findIndex(
    (segment) => segment === "*" || segment.startsWith("[...")
  )
  if (catchAllIndex === -1 && patternSegments.length !== pathSegments.length) {
    return false
  }
  if (catchAllIndex !== -1 && pathSegments.length < catchAllIndex) return false

  return patternSegments.every((segment, index) => {
    if (segment === "*" || segment.startsWith("[...")) return true
    const observed = pathSegments[index]
    return (
      observed !== undefined &&
      (isDynamicRouteSegment(segment) || segment === observed)
    )
  })
}

function routeSpecificity(patternInput: string): number {
  return normalizeObservedPath(patternInput)
    .split("/")
    .filter(Boolean)
    .reduce((score, segment) => {
      if (segment === "*" || segment.startsWith("[...")) return score - 100
      return score + (isDynamicRouteSegment(segment) ? 1 : 100)
    }, 0)
}

function bestPathMatches<T>(
  candidates: readonly T[],
  path: string,
  patternOf: (candidate: T) => string
): T[] {
  const matches = candidates.filter((candidate) =>
    routeMatches(patternOf(candidate), path)
  )
  const literalMatches = matches.filter(
    (candidate) =>
      normalizeObservedPath(patternOf(candidate)) ===
      normalizeObservedPath(path)
  )
  const pool = literalMatches.length > 0 ? literalMatches : matches
  if (pool.length === 0) return []
  const bestSpecificity = Math.max(
    ...pool.map((candidate) => routeSpecificity(patternOf(candidate)))
  )
  return pool.filter(
    (candidate) => routeSpecificity(patternOf(candidate)) === bestSpecificity
  )
}

function evidenceCommitSha(record: LinkEvidenceRecord): string | undefined {
  return "commitSha" in record.provenance
    ? record.provenance.commitSha
    : undefined
}

function evidenceCompatibilityCode(
  record: LinkEvidenceRecord,
  input: EvidenceLinkingInput
): EvidenceLinkRejection["code"] | undefined {
  if (record.reference.applicationId !== input.applicationId) {
    return "application_mismatch"
  }
  if (
    record.reference.status !== "captured" &&
    record.reference.status !== "validated"
  ) {
    return "invalid_evidence_status"
  }
  if (
    !evidenceMethodSourceKinds[record.extractionMethod].some(
      (sourceKind) => sourceKind === record.provenance.sourceKind
    )
  ) {
    return "unsupported_source"
  }
  if (!input.compatibleRunIds.includes(record.reference.runId)) {
    return "incompatible_run"
  }
  const commitSha = evidenceCommitSha(record)
  if (
    commitSha !== undefined &&
    !input.compatibleCommitShas.some(
      (compatibleCommitSha) => compatibleCommitSha === commitSha
    )
  ) {
    return "incompatible_commit"
  }
  return undefined
}

function rejection(
  code: EvidenceLinkRejection["code"],
  summary: string,
  details: {
    readonly claimId?: SubmittedEvidenceLink["id"]
    readonly observationKey?: ReturnType<typeof hashCanonical>
    readonly evidenceIds?: readonly LinkEvidenceRecord["reference"]["id"][]
  } = {}
): EvidenceLinkRejection {
  const evidenceIds = sortedUnique(details.evidenceIds ?? [])
  const identity = {
    code,
    evidenceIds,
    summary,
    ...(details.claimId === undefined ? {} : { claimId: details.claimId }),
    ...(details.observationKey === undefined
      ? {}
      : { observationKey: details.observationKey }),
  }
  return evidenceLinkRejectionSchema.parse({
    id: hashCanonical(identity),
    code,
    ...(details.claimId === undefined ? {} : { claimId: details.claimId }),
    ...(details.observationKey === undefined
      ? {}
      : { observationKey: details.observationKey }),
    evidenceIds,
    summary,
  })
}

function observationIdentity(observation: ExactLinkObservation) {
  return hashCanonical({ kind: observation.kind, observation })
}

function observationCompatibilityRejection(
  observation: ExactLinkObservation,
  input: EvidenceLinkingInput
): EvidenceLinkRejection | undefined {
  const observationKey = observationIdentity(observation)
  if (
    "runId" in observation &&
    !input.compatibleRunIds.includes(observation.runId)
  ) {
    return rejection(
      "incompatible_run",
      "Exact observation belongs to an incompatible run",
      { observationKey, evidenceIds: observation.evidenceIds }
    )
  }
  if (
    "commitSha" in observation &&
    !input.compatibleCommitShas.includes(observation.commitSha)
  ) {
    return rejection(
      "incompatible_commit",
      "Exact observation belongs to an incompatible source commit",
      { observationKey, evidenceIds: observation.evidenceIds }
    )
  }
  return undefined
}

function generatedClaim(
  input: EvidenceLinkingInput,
  observation: ExactLinkObservation,
  relation: {
    readonly fromId: string
    readonly relationship: EvidenceRelationship
    readonly toId: string
  },
  explanation: string
): SubmittedEvidenceLink {
  return submittedEvidenceLinkSchema.parse({
    id: createGeneratedClaimId({
      observation: observationIdentity(observation),
      relation,
    }),
    applicationId: input.applicationId,
    assertion: "supports",
    evidenceIds: observation.evidenceIds,
    explanation,
    ...relation,
  })
}

function exactClaimsForObservation(
  input: EvidenceLinkingInput,
  observation: ExactLinkObservation
): {
  readonly claims: readonly SubmittedEvidenceLink[]
  readonly rejection?: EvidenceLinkRejection
} {
  const incompatible = observationCompatibilityRejection(observation, input)
  if (incompatible !== undefined) return { claims: [], rejection: incompatible }

  const observationKey = observationIdentity(observation)
  const noMatch = (summary: string) => ({
    claims: [],
    rejection: rejection("no_exact_match", summary, {
      observationKey,
      evidenceIds: observation.evidenceIds,
    }),
  })
  const ambiguousMatch = (summary: string) => ({
    claims: [],
    rejection: rejection("ambiguous_exact_match", summary, {
      observationKey,
      evidenceIds: observation.evidenceIds,
    }),
  })

  if (observation.kind === "diff_symbol") {
    if (!rangesOverlap(observation.changedRange, observation.symbolRange)) {
      return noMatch("Changed lines do not overlap the supplied AST symbol")
    }
    return {
      claims: [
        generatedClaim(
          input,
          observation,
          {
            fromId: observation.pullRequestId,
            relationship: "CHANGES",
            toId: observation.symbolId,
          },
          `Changed lines in ${observation.filePath} overlap the indexed symbol range`
        ),
      ],
    }
  }

  if (observation.kind === "runtime_request") {
    const endpoints = bestPathMatches(
      input.apiEndpoints.filter(
        (endpoint) =>
          endpoint.applicationId === input.applicationId &&
          endpoint.method === observation.method
      ),
      observation.normalizedPath,
      (endpoint) => endpoint.normalizedPath
    )
    if (endpoints.length === 0) {
      return noMatch("Runtime request did not match a normalized API endpoint")
    }
    if (endpoints.length > 1) {
      return ambiguousMatch(
        "Runtime request matched multiple equally specific API endpoints"
      )
    }
    return {
      claims: endpoints.map((endpoint) =>
        generatedClaim(
          input,
          observation,
          {
            fromId: observation.uiElementId,
            relationship: "TRIGGERS_API",
            toId: endpoint.id,
          },
          `Observed ${observation.method} ${normalizeObservedPath(observation.normalizedPath)} matched the endpoint exactly`
        )
      ),
    }
  }

  if (observation.kind === "frontend_call") {
    const endpoints = bestPathMatches(
      input.apiEndpoints.filter(
        (endpoint) =>
          endpoint.applicationId === input.applicationId &&
          endpoint.method === observation.method
      ),
      observation.normalizedPath,
      (endpoint) => endpoint.normalizedPath
    )
    if (endpoints.length === 0) {
      return noMatch("Frontend call did not match a normalized API endpoint")
    }
    if (endpoints.length > 1) {
      return ambiguousMatch(
        "Frontend call matched multiple equally specific API endpoints"
      )
    }
    return {
      claims: endpoints.map((endpoint) =>
        generatedClaim(
          input,
          observation,
          {
            fromId: observation.symbolId,
            relationship: "CALLS_API",
            toId: endpoint.id,
          },
          `Indexed frontend call ${observation.method} ${normalizeObservedPath(observation.normalizedPath)} matched the endpoint exactly`
        )
      ),
    }
  }

  if (observation.kind === "route_handler") {
    const endpoints = bestPathMatches(
      input.apiEndpoints.filter(
        (endpoint) =>
          endpoint.applicationId === input.applicationId &&
          endpoint.method === observation.method
      ),
      observation.normalizedPath,
      (endpoint) => endpoint.normalizedPath
    )
    if (endpoints.length === 0) {
      return noMatch("Backend route did not match a normalized API endpoint")
    }
    if (endpoints.length > 1) {
      return ambiguousMatch(
        "Backend route matched multiple equally specific API endpoints"
      )
    }
    return {
      claims: endpoints.map((endpoint) =>
        generatedClaim(
          input,
          observation,
          {
            fromId: endpoint.id,
            relationship: "HANDLED_BY",
            toId: observation.handlerSymbolId,
          },
          `Laravel route ${observation.method} ${normalizeObservedPath(observation.normalizedPath)} resolved to the indexed handler`
        )
      ),
    }
  }

  if (observation.kind === "source_relationship") {
    return {
      claims: [
        generatedClaim(
          input,
          observation,
          observation.source,
          `Indexed source structure established ${observation.source.relationship}`
        ),
      ],
    }
  }

  if (observation.kind === "runtime_route") {
    const matchingRoutes = input.frontendRoutes.filter(
      (route) =>
        route.applicationId === input.applicationId &&
        routeMatches(route.pathPattern, observation.normalizedPath)
    )
    if (matchingRoutes.length === 0) {
      return noMatch("Runtime path did not match an indexed frontend route")
    }
    const compatibleRoutes = matchingRoutes.filter((route) =>
      input.compatibleCommitShas.includes(route.commitSha)
    )
    if (compatibleRoutes.length === 0) {
      return {
        claims: [],
        rejection: rejection(
          "incompatible_commit",
          "Runtime path matched only frontend routes from incompatible commits",
          { observationKey, evidenceIds: observation.evidenceIds }
        ),
      }
    }
    const routes = bestPathMatches(
      compatibleRoutes,
      observation.normalizedPath,
      (route) => route.pathPattern
    )
    if (routes.length > 1) {
      return ambiguousMatch(
        "Runtime path matched multiple equally specific frontend routes"
      )
    }
    return {
      claims: routes.map((route) =>
        generatedClaim(
          input,
          observation,
          {
            fromId: observation.screenId,
            relationship: "MATCHES_ROUTE",
            toId: route.id,
          },
          `Runtime path ${normalizeObservedPath(observation.normalizedPath)} matched frontend route ${route.pathPattern}`
        )
      ),
    }
  }

  const route = input.frontendRoutes.find(
    ({ id }) => id === observation.routeId
  )
  if (
    route !== undefined &&
    (!input.compatibleCommitShas.includes(route.commitSha) ||
      route.commitSha !== observation.commitSha)
  ) {
    return {
      claims: [],
      rejection: rejection(
        "incompatible_commit",
        "Route/component observation does not match the frontend route commit",
        { observationKey, evidenceIds: observation.evidenceIds }
      ),
    }
  }
  if (
    route === undefined ||
    route.applicationId !== input.applicationId ||
    !route.componentSymbolIds.includes(observation.componentSymbolId)
  ) {
    return noMatch(
      "Route/component observation did not match indexed route ancestry"
    )
  }
  return {
    claims: [
      generatedClaim(
        input,
        observation,
        {
          fromId: observation.fromId,
          relationship: "RENDERED_BY",
          toId: observation.componentSymbolId,
        },
        "Indexed route ancestry and exact UI evidence identify the rendering component"
      ),
    ],
  }
}

function validateClaim(
  claim: SubmittedEvidenceLink,
  input: EvidenceLinkingInput,
  evidenceById: ReadonlyMap<string, LinkEvidenceRecord>,
  requiresEvidenceBinding: boolean
): ValidatedClaim | EvidenceLinkRejection {
  if (claim.applicationId !== input.applicationId) {
    return rejection(
      "application_mismatch",
      "Submitted link crosses the active application namespace",
      { claimId: claim.id, evidenceIds: claim.evidenceIds }
    )
  }

  const records: LinkEvidenceRecord[] = []
  for (const evidenceId of claim.evidenceIds) {
    const record = evidenceById.get(evidenceId)
    if (record === undefined) {
      return rejection(
        "missing_evidence",
        "Submitted link references missing evidence",
        {
          claimId: claim.id,
          evidenceIds: claim.evidenceIds,
        }
      )
    }
    const incompatibility = evidenceCompatibilityCode(record, input)
    if (incompatibility !== undefined) {
      return rejection(
        incompatibility,
        `Submitted link uses ${incompatibility.replaceAll("_", " ")} evidence`,
        { claimId: claim.id, evidenceIds: claim.evidenceIds }
      )
    }
    records.push(record)
  }

  const policy = relationshipPolicies[claim.relationship]
  if (policy === undefined) {
    return rejection(
      "unsupported_relationship_evidence",
      `${claim.relationship} is review-only and cannot be authorized from a submitted claim`,
      { claimId: claim.id, evidenceIds: claim.evidenceIds }
    )
  }

  const allowedMethods = new Set(policy.requiredMethods.flat())
  if (
    records.some(
      ({ extractionMethod }) => !allowedMethods.has(extractionMethod)
    )
  ) {
    return rejection(
      "unsupported_relationship_evidence",
      `Submitted evidence method is not allowed for ${claim.relationship}`,
      { claimId: claim.id, evidenceIds: claim.evidenceIds }
    )
  }

  const methods = new Set(
    records.map(({ extractionMethod }) => extractionMethod)
  )
  if (
    policy.requiredMethods.some(
      (alternatives) => !alternatives.some((method) => methods.has(method))
    )
  ) {
    return rejection(
      "required_evidence_missing",
      `Submitted link lacks required evidence for ${claim.relationship}`,
      { claimId: claim.id, evidenceIds: claim.evidenceIds }
    )
  }

  if (
    requiresEvidenceBinding &&
    records.some(
      ({ bindings }) =>
        !bindings.some(
          (binding) =>
            String(binding.fromId) === String(claim.fromId) &&
            binding.relationship === claim.relationship &&
            String(binding.toId) === String(claim.toId)
        )
    )
  ) {
    return rejection(
      "evidence_binding_mismatch",
      "Submitted link evidence is not bound to the claimed relationship endpoints",
      { claimId: claim.id, evidenceIds: claim.evidenceIds }
    )
  }

  return { claim, evidence: records, tier: policy.tier }
}

function linkFromClaims(
  applicationId: EvidenceLinkingInput["applicationId"],
  graphRevision: number,
  claims: readonly ValidatedClaim[]
): EvidenceLink {
  const first = claims[0]
  if (first === undefined)
    throw new Error("Validated link group cannot be empty")
  const evidence = [
    ...new Map(
      claims
        .flatMap(({ evidence }) => evidence)
        .map((record) => [record.reference.id, record])
    ).values(),
  ].sort((left, right) => left.reference.id.localeCompare(right.reference.id))
  const evidenceIds = evidence.map(({ reference }) => reference.id)
  const methods = sortedUnique(
    evidence.map(({ extractionMethod }) => extractionMethod)
  )
  const commits = sortedUnique(
    evidence.flatMap((record) => {
      const commitSha = evidenceCommitSha(record)
      return commitSha === undefined ? [] : [commitSha]
    })
  )
  const runs = sortedUnique(evidence.map(({ reference }) => reference.runId))
  const artifacts = sortedUnique(
    evidence.flatMap(({ reference }) =>
      reference.artifactId === undefined ? [] : [reference.artifactId]
    )
  )
  const explanations = sortedUnique(
    claims.map(({ claim }) => claim.explanation)
  )
  const lastConfirmedAt = [...evidence]
    .map(({ reference }) => reference.capturedAt)
    .sort()
    .at(-1)
  const tier = claims.some(({ tier }) => tier === "A") ? "A" : "B"
  const extractionMethod =
    methods.length === 1 ? methods[0] : `corroborated:${methods.join("+")}`

  return {
    schemaVersion: EVIDENCE_LINKING_SCHEMA_VERSION,
    id: createLinkId(
      applicationId,
      first.claim.fromId,
      first.claim.relationship,
      first.claim.toId
    ) as EvidenceLink["id"],
    applicationId,
    fromId: first.claim.fromId,
    relationship: first.claim.relationship,
    toId: first.claim.toId,
    extractionMethod,
    evidenceTier: tier,
    explanation: explanations.join(" | ").slice(0, 4_096),
    evidenceIds,
    ...(commits.length === 1 ? { sourceCommitSha: commits[0] } : {}),
    ...(runs.length === 1 ? { crawlRunId: runs[0] } : {}),
    ...(artifacts.length === 1 ? { artifactId: artifacts[0] } : {}),
    reviewState: "not_required",
    graphRevision,
    lastConfirmedAt,
  } as EvidenceLink
}

const TERM_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "be",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
])

function normalizeTerm(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
  if (normalized.length > 3 && normalized.endsWith("s")) {
    return normalized.slice(0, -1)
  }
  return normalized
}

function normalizedTerms(entity: SemanticEntity): string[] {
  return sortedUnique(
    entity.capabilityTerms
      .flatMap((term) => normalizeTerm(term).split(" "))
      .filter((term) => term.length > 1 && !TERM_STOP_WORDS.has(term))
  )
}

function trigrams(value: string): Set<string> {
  const padded = `  ${value}  `
  const result = new Set<string>()
  for (let index = 0; index <= padded.length - 3; index += 1) {
    result.add(padded.slice(index, index + 3))
  }
  return result
}

function nameSimilarity(leftInput: string, rightInput: string): number {
  const left = trigrams(normalizeTerm(leftInput))
  const right = trigrams(normalizeTerm(rightInput))
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const value of left) if (right.has(value)) intersection += 1
  return (2 * intersection) / (left.size + right.size)
}

function semanticPairRelationship(
  source: SemanticEntity,
  target: SemanticEntity
): SemanticRelationship | undefined {
  if (source.kind === "requirement" && target.kind === "workflow") {
    return "COVERED_BY"
  }
  if (source.kind === "requirement" && target.kind === "capability") {
    return "REQUIRES"
  }
  if (
    (source.kind === "screen" || source.kind === "ui_element") &&
    target.kind === "code_symbol"
  ) {
    return "RENDERED_BY"
  }
  return undefined
}

function compatibleSemanticEntities(
  input: EvidenceLinkingInput,
  evidenceById: ReadonlyMap<string, LinkEvidenceRecord>,
  rejections: EvidenceLinkRejection[]
): SemanticEntity[] {
  const compatible: SemanticEntity[] = []
  for (const entity of [...input.semanticEntities].sort((left, right) =>
    left.id.localeCompare(right.id)
  )) {
    const observationKey = hashCanonical({
      entityId: entity.id,
      kind: "semantic-entity",
    })
    if (entity.applicationId !== input.applicationId) {
      rejections.push(
        rejection(
          "application_mismatch",
          "Semantic entity crosses the active application namespace",
          { observationKey, evidenceIds: entity.evidenceIds }
        )
      )
      continue
    }
    const records = entity.evidenceIds.map((id) => evidenceById.get(id))
    if (records.some((record) => record === undefined)) {
      rejections.push(
        rejection(
          "missing_evidence",
          "Semantic entity references missing evidence",
          {
            observationKey,
            evidenceIds: entity.evidenceIds,
          }
        )
      )
      continue
    }
    const incompatibility = records
      .filter((record): record is LinkEvidenceRecord => record !== undefined)
      .map((record) => evidenceCompatibilityCode(record, input))
      .find((code) => code !== undefined)
    if (incompatibility !== undefined) {
      rejections.push(
        rejection(
          incompatibility,
          "Semantic entity uses incompatible evidence",
          {
            observationKey,
            evidenceIds: entity.evidenceIds,
          }
        )
      )
      continue
    }
    compatible.push(entity)
  }
  return compatible
}

function generateCandidates(
  input: EvidenceLinkingInput,
  evidenceById: ReadonlyMap<string, LinkEvidenceRecord>,
  rejections: EvidenceLinkRejection[]
): EvidenceReviewCandidate[] {
  const entities = compatibleSemanticEntities(input, evidenceById, rejections)
  const sources = entities.filter(
    ({ kind }) =>
      kind === "requirement" || kind === "screen" || kind === "ui_element"
  )
  const targets = entities.filter(
    ({ kind }) =>
      kind === "workflow" || kind === "capability" || kind === "code_symbol"
  )
  const candidates: CandidateWithScore[] = []
  let comparisons = 0

  outer: for (const source of sources) {
    for (const target of targets) {
      comparisons += 1
      if (comparisons > MAX_SEMANTIC_COMPARISONS) break outer
      const relationship = semanticPairRelationship(source, target)
      if (relationship === undefined) continue

      const sourceTerms = normalizedTerms(source)
      const targetTerms = normalizedTerms(target)
      const sharedTerms = sourceTerms.filter((term) =>
        targetTerms.includes(term)
      )
      const similarity = nameSimilarity(source.name, target.name)
      if (sharedTerms.length === 0 && similarity < 0.72) continue

      const evidenceIds = sortedUnique([
        ...source.evidenceIds,
        ...target.evidenceIds,
      ])
      const evidenceTier = sharedTerms.length > 0 ? "C" : "D"
      const explanation =
        evidenceTier === "C"
          ? `Shared normalized capability terms: ${sharedTerms.join(", ")}`
          : "Name similarity only; no shared normalized capability term"
      const candidate = evidenceReviewCandidateSchema.parse({
        schemaVersion: EVIDENCE_LINKING_SCHEMA_VERSION,
        id: createCandidateId(
          input.applicationId,
          source.id,
          relationship,
          target.id
        ),
        applicationId: input.applicationId,
        fromId: source.id,
        relationship,
        toId: target.id,
        evidenceTier,
        evidenceIds,
        normalizedTerms: sharedTerms,
        explanation,
        modelDisposition: "not_requested",
        reviewState: "pending",
        confidentPathEligible: false,
      })
      candidates.push({
        candidate,
        score: evidenceTier === "C" ? 1 + sharedTerms.length : similarity,
      })
    }
  }

  return candidates
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.id.localeCompare(right.candidate.id)
    )
    .slice(0, input.maxCandidates)
    .map(({ candidate }) => candidate)
    .sort((left, right) => left.id.localeCompare(right.id))
}

async function adjudicateCandidates(
  applicationId: EvidenceLinkingInput["applicationId"],
  candidates: readonly EvidenceReviewCandidate[],
  adjudicator: EvidenceCandidateAdjudicator | undefined,
  rejections: EvidenceLinkRejection[],
  signal?: AbortSignal
): Promise<EvidenceReviewCandidate[]> {
  if (candidates.length === 0 || adjudicator === undefined)
    return [...candidates]

  const request = evidenceAdjudicationRequestSchema.parse({
    schemaVersion: EVIDENCE_LINKING_SCHEMA_VERSION,
    applicationId,
    candidates: candidates.map((candidate) => ({
      schemaVersion: candidate.schemaVersion,
      id: candidate.id,
      applicationId: candidate.applicationId,
      fromId: candidate.fromId,
      relationship: candidate.relationship,
      toId: candidate.toId,
      evidenceTier: candidate.evidenceTier,
      evidenceIds: candidate.evidenceIds,
      normalizedTerms: candidate.normalizedTerms,
      explanation: candidate.explanation,
      reviewState: candidate.reviewState,
      confidentPathEligible: candidate.confidentPathEligible,
    })),
  })

  let raw: unknown
  try {
    raw = await adjudicator.adjudicate(request, signal)
  } catch {
    raw = undefined
  }
  const parsed = evidenceAdjudicationResultSchema.safeParse(raw)
  const candidateIds = new Set(candidates.map(({ id }) => id))
  const containsUnknownId =
    parsed.success &&
    parsed.data.decisions.some(
      ({ candidateId }) => !candidateIds.has(candidateId)
    )

  if (!parsed.success || containsUnknownId) {
    rejections.push(
      rejection(
        "model_invalid_output",
        "Candidate adjudicator returned malformed or unknown candidate IDs"
      )
    )
    return candidates.map((candidate) =>
      evidenceReviewCandidateSchema.parse({
        ...candidate,
        modelDisposition: "abstained",
        modelReason: "Invalid structured adjudication output",
      })
    )
  }

  const decisionById = new Map(
    parsed.data.decisions.map((decision) => [decision.candidateId, decision])
  )
  return candidates.map((candidate) => {
    const decision = decisionById.get(candidate.id)
    if (decision === undefined) {
      return evidenceReviewCandidateSchema.parse({
        ...candidate,
        modelDisposition: "abstained",
        modelReason: "Adjudicator did not decide this supplied candidate",
      })
    }
    return evidenceReviewCandidateSchema.parse({
      ...candidate,
      modelDisposition: {
        select: "selected",
        reject: "rejected",
        abstain: "abstained",
      }[decision.decision],
      modelReason: decision.reason,
    })
  })
}

function buildConflict(
  input: EvidenceLinkingInput,
  supports: readonly ValidatedClaim[],
  contradicts: readonly ValidatedClaim[]
): EvidenceLinkConflict {
  const first = supports[0]
  if (first === undefined || contradicts.length === 0) {
    throw new Error("Conflict requires supporting and contradicting claims")
  }
  const evidenceIds = sortedUnique(
    [...supports, ...contradicts].flatMap(({ claim }) => claim.evidenceIds)
  )
  return evidenceLinkConflictSchema.parse({
    id: hashCanonical({
      applicationId: input.applicationId,
      fromId: first.claim.fromId,
      kind: "evidence-link-conflict",
      relationship: first.claim.relationship,
      toId: first.claim.toId,
      version: 1,
    }),
    applicationId: input.applicationId,
    fromId: first.claim.fromId,
    relationship: first.claim.relationship,
    toId: first.claim.toId,
    supportingClaimIds: sortedUnique(supports.map(({ claim }) => claim.id)),
    contradictingClaimIds: sortedUnique(
      contradicts.map(({ claim }) => claim.id)
    ),
    evidenceIds,
    status: "unresolved",
    reviewState: "pending",
    summary: `Conflicting validated claims for ${first.claim.relationship} remain unresolved`,
  })
}

function deduplicateRejections(
  rejections: readonly EvidenceLinkRejection[]
): EvidenceLinkRejection[] {
  return [...new Map(rejections.map((item) => [item.id, item])).values()].sort(
    (left, right) => left.id.localeCompare(right.id)
  )
}

export class EvidenceLinker {
  private readonly adjudicator: EvidenceCandidateAdjudicator | undefined

  constructor(options: EvidenceLinkerOptions = {}) {
    this.adjudicator = options.adjudicator
  }

  async link(
    inputValue: unknown,
    signal?: AbortSignal
  ): Promise<PendingEvidenceLinkBatch> {
    const input = evidenceLinkingInputSchema.parse(inputValue)
    const evidenceById = new Map(
      input.evidence.map((record) => [record.reference.id, record])
    )
    const rejections: EvidenceLinkRejection[] = []
    const claims = [...input.submittedLinks]
    const submittedClaimIds = new Set(input.submittedLinks.map(({ id }) => id))

    for (const record of input.evidence) {
      const incompatibility = evidenceCompatibilityCode(record, input)
      if (incompatibility !== undefined) {
        rejections.push(
          rejection(
            incompatibility,
            `Evidence record is ${incompatibility.replaceAll("_", " ")}`,
            { evidenceIds: [record.reference.id] }
          )
        )
      }
    }

    for (const endpoint of input.apiEndpoints) {
      if (endpoint.applicationId !== input.applicationId) {
        rejections.push(
          rejection(
            "application_mismatch",
            "API endpoint crosses the active application namespace",
            {
              observationKey: hashCanonical({
                endpointId: endpoint.id,
                kind: "api-endpoint-fact",
              }),
            }
          )
        )
      }
    }
    for (const route of input.frontendRoutes) {
      const observationKey = hashCanonical({
        kind: "frontend-route-fact",
        routeId: route.id,
      })
      if (route.applicationId !== input.applicationId) {
        rejections.push(
          rejection(
            "application_mismatch",
            "Frontend route crosses the active application namespace",
            { observationKey }
          )
        )
      } else if (!input.compatibleCommitShas.includes(route.commitSha)) {
        rejections.push(
          rejection(
            "incompatible_commit",
            "Frontend route belongs to an incompatible source commit",
            { observationKey }
          )
        )
      }
    }

    const trustOrder: Record<ExactLinkObservation["kind"], number> = {
      diff_symbol: 1,
      runtime_request: 2,
      frontend_call: 3,
      route_handler: 4,
      source_relationship: 5,
      runtime_route: 6,
      route_component: 7,
    }
    for (const observation of [...input.exactObservations].sort(
      (left, right) =>
        trustOrder[left.kind] - trustOrder[right.kind] ||
        observationIdentity(left).localeCompare(observationIdentity(right))
    )) {
      const generated = exactClaimsForObservation(input, observation)
      claims.push(...generated.claims)
      if (generated.rejection !== undefined) {
        rejections.push(generated.rejection)
      }
    }

    const validated: ValidatedClaim[] = []
    for (const claim of claims) {
      const result = validateClaim(
        claim,
        input,
        evidenceById,
        submittedClaimIds.has(claim.id)
      )
      if ("code" in result) rejections.push(result)
      else validated.push(result)
    }

    const grouped = new Map<string, ValidatedClaim[]>()
    for (const claim of validated) {
      const key = relationshipKey(claim.claim)
      const group = grouped.get(key) ?? []
      group.push(claim)
      grouped.set(key, group)
    }

    const links: EvidenceLink[] = []
    const conflicts: EvidenceLinkConflict[] = []
    for (const group of grouped.values()) {
      const supports = group.filter(
        ({ claim }) => claim.assertion === "supports"
      )
      const contradicts = group.filter(
        ({ claim }) => claim.assertion === "contradicts"
      )
      if (supports.length > 0 && contradicts.length > 0) {
        conflicts.push(buildConflict(input, supports, contradicts))
      } else if (supports.length > 0) {
        links.push(
          linkFromClaims(input.applicationId, input.graphRevision, supports)
        )
      }
    }

    const generatedCandidates = generateCandidates(
      input,
      evidenceById,
      rejections
    )
    const reviewCandidates = await adjudicateCandidates(
      input.applicationId,
      generatedCandidates,
      this.adjudicator,
      rejections,
      signal
    )

    const compatibleEvidence = input.evidence
      .filter(
        (record) => evidenceCompatibilityCode(record, input) === undefined
      )
      .map((record) => ({
        ...record,
        reference: { ...record.reference, status: "validated" as const },
      }))
      .sort((left, right) =>
        left.reference.id.localeCompare(right.reference.id)
      )
    links.sort((left, right) => left.id.localeCompare(right.id))
    conflicts.sort((left, right) => left.id.localeCompare(right.id))
    reviewCandidates.sort((left, right) => left.id.localeCompare(right.id))
    const sortedRejections = deduplicateRejections(rejections)

    const batchWithoutHash = {
      schemaVersion: EVIDENCE_LINKING_SCHEMA_VERSION,
      applicationId: input.applicationId,
      runId: input.runId,
      graphRevision: input.graphRevision,
      status: "pending" as const,
      evidence: compatibleEvidence,
      links,
      reviewCandidates,
      conflicts,
      rejections: sortedRejections,
    }
    return pendingEvidenceLinkBatchSchema.parse({
      ...batchWithoutHash,
      batchHash: hashCanonical(batchWithoutHash),
    })
  }
}

export function createEvidenceLinker(
  options: EvidenceLinkerOptions = {}
): EvidenceLinker {
  return new EvidenceLinker(options)
}
