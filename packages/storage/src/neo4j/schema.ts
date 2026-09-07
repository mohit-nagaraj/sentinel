import {
  entityKindSchema,
  evidenceRelationshipSchema,
  type EntityKind,
} from "@sentinel/contracts"

export const nodeLabelByKind = {
  application: "Application",
  "document-source": "DocumentSource",
  "document-page": "DocumentPage",
  "document-section": "DocumentSection",
  requirement: "Requirement",
  capability: "Capability",
  workflow: "Workflow",
  "flow-step": "FlowStep",
  screen: "Screen",
  "ui-element": "UIElement",
  "frontend-route": "FrontendRoute",
  "code-file": "CodeFile",
  "code-symbol": "CodeSymbol",
  "api-endpoint": "APIEndpoint",
  "domain-entity": "DomainEntity",
  "coverage-assessment": "CoverageAssessment",
  "pull-request": "PullRequest",
} as const satisfies Record<EntityKind, string>

export type NodeLabel = (typeof nodeLabelByKind)[EntityKind]
export type RelationshipType = ReturnType<
  typeof evidenceRelationshipSchema.parse
>

export const relationshipEndpointKinds = {
  HAS_PAGE: { from: ["document-source"], to: ["document-page"] },
  HAS_SECTION: { from: ["document-page"], to: ["document-section"] },
  LINKS_TO: { from: ["document-page"], to: ["document-page"] },
  STATES: { from: ["document-section"], to: ["requirement"] },
  REQUIRES: { from: ["requirement"], to: ["capability"] },
  COVERED_BY: { from: ["requirement"], to: ["workflow"] },
  HAS_STEP: { from: ["workflow"], to: ["flow-step"] },
  NEXT: { from: ["flow-step"], to: ["flow-step"] },
  ON_SCREEN: { from: ["flow-step"], to: ["screen"] },
  ACTS_ON: { from: ["flow-step"], to: ["ui-element"] },
  CONTAINS: { from: ["screen"], to: ["ui-element"] },
  MATCHES_ROUTE: { from: ["screen"], to: ["frontend-route"] },
  RENDERED_BY: {
    from: ["screen", "ui-element"],
    to: ["code-symbol"],
  },
  BINDS: { from: ["ui-element"], to: ["code-symbol"] },
  TRIGGERS_API: { from: ["ui-element"], to: ["api-endpoint"] },
  CALLS_API: { from: ["code-symbol"], to: ["api-endpoint"] },
  HANDLED_BY: { from: ["api-endpoint"], to: ["code-symbol"] },
  CALLS: { from: ["code-symbol"], to: ["code-symbol"] },
  READS: { from: ["code-symbol"], to: ["domain-entity"] },
  WRITES: { from: ["code-symbol"], to: ["domain-entity"] },
  CHANGES: { from: ["pull-request"], to: ["code-symbol"] },
  HAS_ASSESSMENT: {
    from: ["requirement"],
    to: ["coverage-assessment"],
  },
} as const satisfies Record<
  RelationshipType,
  { readonly from: readonly EntityKind[]; readonly to: readonly EntityKind[] }
>

export function resolveNodeLabel(kindInput: unknown): NodeLabel {
  const kind = entityKindSchema.parse(kindInput)
  return nodeLabelByKind[kind]
}

export function resolveRelationshipType(input: unknown): RelationshipType {
  return evidenceRelationshipSchema.parse(input)
}

function toConstraintName(kind: EntityKind): string {
  return `sentinel_${kind.replaceAll("-", "_")}_identity`
}

export const constraintStatements = entityKindSchema.options.map((kind) => {
  const label = resolveNodeLabel(kind)
  return `CREATE CONSTRAINT ${toConstraintName(kind)} IF NOT EXISTS FOR (n:${label}) REQUIRE (n.application_id, n.stable_key) IS UNIQUE`
})

export const relationshipConstraintStatements =
  evidenceRelationshipSchema.options.map((relationship) => {
    const name = `sentinel_rel_${relationship.toLowerCase()}_identity`
    return `CREATE CONSTRAINT ${name} IF NOT EXISTS FOR ()-[r:${relationship}]-() REQUIRE (r.application_id, r.stable_key) IS UNIQUE`
  })
